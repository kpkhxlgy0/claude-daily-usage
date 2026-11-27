'use strict';

const fs = require('node:fs/promises');
const nativeFs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Worker } = require('node:worker_threads');
const { setTimeout: delay } = require('node:timers/promises');
const { validateSnapshot, MaxSnapshotBytes, normalizeThreadId } = require('./protocol.cjs');
const { loadWeeklyContext, validResetAnchor, ResetToleranceMs, MaxResetAnchors } = require('./weekly-history.cjs');

const SharingRetryMs = 25;
const ResetRequestTimeoutMs = 2500;

async function ensureDirectory(directory)
{
    await fs.mkdir(directory, { recursive: true });
    const info = await fs.lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('unsafe-data-directory');
    return info;
}

async function readJson(file, maxBytes = MaxSnapshotBytes)
{
    const info = await fs.lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > maxBytes) throw new Error('unsafe-data-file');
    const bytes = await fs.readFile(file);
    if (bytes.length > maxBytes) throw new Error('data-too-large');
    return JSON.parse(bytes.toString('utf8'));
}

async function atomicWrite(file, value, active = () => true, signal)
{
    const directory = path.dirname(file);
    const before = await ensureDirectory(directory);
    const temp = path.join(directory, `.${path.basename(file)}.${randomUUID()}.tmp`);
    try
    {
        await fs.writeFile(temp, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
        let retried = false;
        for (;;)
        {
            const after = await fs.lstat(directory);
            if (after.isSymbolicLink() || before.ino !== after.ino || before.dev !== after.dev)
                throw new Error('data-directory-changed');
            if (!active()) return;
            try
            {
                // 最终判定与原子提交不让出事件循环；提交后的取消不撤销已发布文件。
                nativeFs.renameSync(temp, file);
                break;
            }
            catch (error)
            {
                if (retried || process.platform !== 'win32' || !['EPERM', 'EBUSY'].includes(error.code)) throw error;
                retried = true;
                await delay(SharingRetryMs, undefined, { signal });
            }
        }
    }
    finally
    {
        await fs.unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
}

function abortError()
{
    return Object.assign(new Error('Daily Usage query cancelled'), { name: 'AbortError', code: 'ABORT_ERR' });
}

function unassignedRemainder(rows)
{
    const unassigned = { requests: 0, usd: 0 };
    for (const row of Array.isArray(rows) ? rows : [])
    {
        unassigned.requests += row?.requests;
        unassigned.usd += row?.usd;
    }
    unassigned.usd = Number(unassigned.usd.toFixed(12));
    return { earlier: { requests: 0, usd: 0 }, unassigned };
}

function withUnverifiedWeeklyOrganization(state)
{
    if (!state.snapshot) return state;
    return { ...state, weeklyStatus: 'organization-unverified',
        snapshot: { ...state.snapshot, weekly: null, weeklyHistory: [],
            weeklyRemainder: unassignedRemainder(state.snapshot.rows) } };
}

async function requestReset(readResetAt, organizationId, resetSession, ownerSignal, timeoutMs)
{
    const timeout = new AbortController();
    const signal = AbortSignal.any([ownerSignal, timeout.signal]);
    if (signal.aborted) return null;
    const timer = setTimeout(() => timeout.abort(), timeoutMs);
    let cancelled;
    try
    {
        const abort = new Promise(resolve =>
        {
            cancelled = () => resolve(null);
            signal.addEventListener('abort', cancelled, { once: true });
        });
        const response = await Promise.race([readResetAt(organizationId, { signal, resetSession }), abort]);
        return signal.aborted ? null : response;
    }
    catch { return null; }
    finally
    {
        clearTimeout(timer);
        signal.removeEventListener('abort', cancelled);
    }
}

function createService({ claudeHome, claudeData, dataDir, now = Date.now,
    readResetAt, resetTimeoutMs = ResetRequestTimeoutMs,
    workerFactory = options => new Worker(path.join(__dirname, 'worker.cjs'), options) })
{
    const directory = path.join(claudeHome, '.daily-usage');
    const reportFile = path.join(directory, 'summary.json');
    const publisherId = randomUUID();
    const lifetime = new AbortController();
    const pending = new Set();
    const terminations = new Set();
    const preparations = new Set();
    let machineId;
    let revision = 0;
    let stopped = false;
    let current;
    let initializationError;
    let state = { status: 'unavailable', progress: null };
    let snapshotOrganizationId;
    let publishing = Promise.resolve();
    let disposal;

    function terminate(job)
    {
        if (job.termination) return job.termination;
        job.termination = Promise.resolve(job.worker?.terminate()).catch(() => {});
        terminations.add(job.termination);
        job.termination.finally(() => terminations.delete(job.termination));
        return job.termination;
    }

    const active = job => !stopped && current === job && job.subscribers.size > 0;
    const wantsWeekly = (subscriber, organizationId) => subscriber.organizationId === undefined
        || subscriber.organizationId === organizationId;

    function subscriberState({ organizationId })
    {
        if (organizationId === undefined || !state.snapshot
            || organizationId !== null && organizationId === snapshotOrganizationId) return state;
        return withUnverifiedWeeklyOrganization(state);
    }

    function settle(subscriber, error, value)
    {
        if (subscriber.settled) return;
        subscriber.settled = true;
        pending.delete(subscriber);
        subscriber.signal?.removeEventListener('abort', subscriber.abort);
        if (error) subscriber.reject(error);
        else subscriber.resolve(value);
    }

    function abandon(job)
    {
        if (current !== job) return;
        current = null;
        job.controller?.abort();
        state = { ...state, status: state.snapshot ? 'stale' : 'unavailable', progress: null };
        terminate(job);
    }

    async function complete(job, error, snapshot, weeklyOrganizationId, weeklyStatus)
    {
        if (!active(job)) return;
        await terminate(job);
        if (!active(job)) return;
        current = null;
        if (error)
            state = { ...state, status: 'error', error: String(error.message || error).slice(0, 180), progress: null };
        else
        {
            revision++;
            state = { status: 'ok', snapshot, progress: null, ...(weeklyStatus ? { weeklyStatus } : {}) };
            snapshotOrganizationId = normalizeThreadId(weeklyOrganizationId);
        }
        for (const subscriber of job.subscribers) settle(subscriber, null, subscriberState(subscriber));
        job.subscribers.clear();
    }

    async function prepareWeekly(job)
    {
        const saved = await loadWeeklyContext({ claudeHome, claudeData, dataDir, generatedAt: now(),
            allowOrganization: organizationId => [...job.subscribers].some(subscriber => wantsWeekly(subscriber, organizationId)) });
        if (!saved || !active(job)) return null;
        const { organizationId, anchorFile } = saved;
        let { anchors } = saved;
        let accessDenied = false;
        const eligible = [...job.subscribers].filter(subscriber => wantsWeekly(subscriber, organizationId));
        if (active(job) && eligible.length && typeof readResetAt === 'function')
        {
            const sessions = new Set(eligible.map(subscriber => subscriber.resetSession).filter(Boolean));
            const controller = new AbortController();
            job.reset = { organizationId, controller };
            const requested = () => active(job) && !controller.signal.aborted;
            const response = await requestReset(readResetAt, organizationId,
                sessions.size === 1 ? [...sessions][0] : undefined, controller.signal, resetTimeoutMs);
            const observedAt = now();
            const anchor = response && { resetAt: response.resetAt, observedAt, usedPercent: response.usedPercent ?? null };
            if (requested() && response?.accessDenied)
            {
                accessDenied = true;
                anchors = [];
                await atomicWrite(anchorFile, { version: 1, organizationId, anchors }, requested,
                    controller.signal).catch(() => {});
            }
            else if (requested() && validResetAnchor(anchor, observedAt))
            {
                const latest = anchors.at(-1);
                let nextAnchors;
                if (latest && Math.abs(latest.resetAt - anchor.resetAt) <= ResetToleranceMs
                    && latest.resetAt > observedAt)
                {
                    // 同一轮回复的毫秒差异不重新划分已归属的请求。
                    anchor.resetAt = latest.resetAt;
                    anchor.firstFullAt = latest.firstFullAt ?? (latest.usedPercent === 100 ? latest.observedAt : null);
                    if (!validResetAnchor(anchor, observedAt)) anchor.firstFullAt = null;
                    nextAnchors = [...anchors.slice(0, -1), anchor];
                }
                else nextAnchors = [...anchors, anchor].slice(-MaxResetAnchors);
                await atomicWrite(anchorFile, { version: 1, organizationId, anchors: nextAnchors }, requested,
                    controller.signal).catch(() => {});
                if (requested()) anchors = nextAnchors;
            }
            job.reset = null;
        }
        return { organizationId, anchors, accessDenied };
    }

    function start(job)
    {
        job.controller = new AbortController();
        state = { ...state, status: 'loading', error: null, progress: null };
        const prepared = prepareWeekly(job).then(weekly => collect(job, weekly),
            error => complete(job, error));
        preparations.add(prepared);
        prepared.finally(() => preparations.delete(prepared));
    }

    function collect(job, weekly)
    {
        if (!active(job)) return;
        try
        {
            job.worker = workerFactory({ workerData: { claudeHome, cacheDir: path.join(dataDir, 'cache'),
                ...(claudeData ? { claudeData } : {}) } });
            job.worker.on('message', message =>
            {
                if (!active(job) || job.finished) return;
                if (message?.type === 'progress') state = { ...state, progress: message.progress };
                else if (message?.type === 'error')
                {
                    job.finished = true;
                    void complete(job, message.error || 'collector-failed');
                }
                else if (message?.type === 'result')
                {
                    job.finished = true;
                    publishing = publishing.then(async () =>
                    {
                        if (!active(job)) return;
                        const snapshot = { weekly: null, weeklyHistory: [],
                            weeklyRemainder: unassignedRemainder(message.report?.rows), ...message.report,
                            schemaVersion: 4, source: 'com.kpk.daily-usage', machineId, publisherId,
                            revision: revision + 1 };
                        const checked = validateSnapshot(snapshot, { now: now(), minVersion: 4 });
                        if (!checked.ok) throw new Error(checked.reason === 'size' ? 'snapshot-too-large' : 'invalid-report');
                        await atomicWrite(reportFile, snapshot, () => active(job), job.controller.signal);
                        await complete(job, null, snapshot, message.weeklyOrganizationId ?? weekly?.organizationId,
                            weekly?.accessDenied ? 'access-denied' : undefined);
                    }).catch(error => complete(job, error));
                }
            });
            job.worker.on('error', error =>
            {
                if (!active(job) || job.finished) return;
                job.finished = true;
                void complete(job, error);
            });
            job.worker.on('exit', code =>
            {
                if (!active(job) || job.finished) return;
                job.finished = true;
                void complete(job, `collector-exited-${code}`);
            });
            job.worker.postMessage({ type: 'scan', weekly: { ...weekly, generatedAt: now() } });
        }
        catch (error)
        {
            job.finished = true;
            void complete(job, error);
        }
    }

    const ready = (async () =>
    {
        await ensureDirectory(directory);
        await ensureDirectory(dataDir);
        const identityFile = path.join(directory, 'machine.json');
        try
        {
            const value = await readJson(identityFile, 1024);
            if (!normalizeThreadId(value.machineId)) throw new Error('invalid-machine-identity');
            machineId = value.machineId;
        }
        catch (error)
        {
            if (error.code !== 'ENOENT') throw error;
            machineId = randomUUID();
            await atomicWrite(identityFile, { machineId }, () => !stopped, lifetime.signal);
        }
        try
        {
            const previous = await readJson(reportFile);
            const checked = validateSnapshot(previous, { now: now(), minVersion: 4 });
            if (previous.machineId === machineId)
            {
                if (checked.ok) state = { status: 'stale', snapshot: previous, progress: null };
                else if (checked.reason === 'update-required')
                    state = { status: 'unavailable', error: 'snapshot-update-required', progress: null };
            }
        }
        catch { /* 缓存损坏时仅在查询时重新统计，不改写原始日志。 */ }
    })().catch(error =>
    {
        initializationError = error;
        state = { status: 'error', error: String(error.message || error).slice(0, 180), progress: null };
    });

    return {
        ready,
        getIdentity: () => machineId ? { machineId, publisherId } : null,
        getState: () => state,
        query({ signal, organizationId, resetSession } = {})
        {
            if (stopped || signal?.aborted) return Promise.reject(abortError());
            return new Promise((resolve, reject) =>
            {
                const subscriber = { resolve, reject, signal, resetSession,
                    organizationId: organizationId === undefined ? undefined : normalizeThreadId(organizationId) };
                subscriber.abort = () =>
                {
                    settle(subscriber, abortError());
                    const job = subscriber.job;
                    if (!job) return;
                    job.subscribers.delete(subscriber);
                    if (job.reset && ![...job.subscribers].some(next => wantsWeekly(next, job.reset.organizationId)))
                        job.reset.controller.abort();
                    if (!job.subscribers.size) abandon(job);
                };
                pending.add(subscriber);
                signal?.addEventListener('abort', subscriber.abort, { once: true });
                ready.then(() =>
                {
                    if (subscriber.settled) return;
                    if (stopped || signal?.aborted) return subscriber.abort();
                    if (initializationError) return settle(subscriber, null, subscriberState(subscriber));
                    const job = current || { subscribers: new Set() };
                    subscriber.job = job;
                    job.subscribers.add(subscriber);
                    if (!current)
                    {
                        current = job;
                        start(job);
                    }
                });
            });
        },
        dispose()
        {
            if (disposal) return disposal;
            stopped = true;
            lifetime.abort();
            for (const subscriber of [...pending]) subscriber.abort();
            disposal = (async () =>
            {
                await ready;
                await Promise.all([...preparations]);
                await publishing;
                await Promise.all([...terminations]);
            })();
            return disposal;
        }
    };
}

module.exports = { createService, withUnverifiedWeeklyOrganization };
