'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const nativeFs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { createService } = require('../src/service.cjs');

function body()
{
    return { generatedAt: Date.parse('2026-11-17T12:00:00Z'), timezone: 'Asia/Shanghai',
        from: '2026-10-19', to: '2026-11-17', rows: [],
        coverage: { files: 1, failedFiles: 0, skippedRecords: 0, legacyRequests: 0, warnings: [] },
        pricing: { basis: 'claude-client-estimate', asOf: '2026-11-17', source: 'https://platform.claude.com/docs/en/about-claude/pricing' } };
}

async function setup(t)
{
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'daily-usage-service-'));
    const workers = [];
    const service = createService({ claudeHome: root, dataDir: path.join(root, 'data'),
        workerFactory: options =>
        {
            const worker = new EventEmitter();
            worker.options = options;
            worker.postMessage = message => { worker.command = message; };
            worker.terminate = async () => { worker.terminated = true; };
            workers.push(worker);
            return worker;
        }, now: () => body().generatedAt });
    t.after(async () => { await service.dispose(); await fs.rm(root, { recursive: true }); });
    await service.ready;
    return { root, workers, service };
}

async function started(service, workers, options)
{
    const result = service.query(options);
    await new Promise(resolve => setImmediate(resolve));
    return { result, worker: workers.at(-1) };
}

test('cold service exposes stable machine identity without scanning logs', async t =>
{
    const { service, workers } = await setup(t);
    const identity = service.getIdentity();
    assert.match(identity.machineId, /^[0-9a-f-]{36}$/);
    assert.match(identity.publisherId, /^[0-9a-f-]{36}$/);
    identity.machineId = 'changed';
    assert.notEqual(service.getIdentity().machineId, 'changed');
    assert.equal(workers.length, 0);
    assert.equal(service.getState().snapshot, undefined);
});

test('a legacy dollar summary requires update without scanning and is replaced only by an explicit query', async t =>
{
    const { root, workers, service } = await setup(t);
    const identity = service.getIdentity();
    await service.dispose();
    const filename = path.join(root, '.daily-usage/summary.json');
    const legacy = { ...body(), ...identity, schemaVersion: 1, source: 'com.kpk.daily-usage', revision: 1 };
    legacy.pricing.basis = 'standard';
    await fs.writeFile(filename, JSON.stringify(legacy));
    const restarted = createService({ claudeHome: root, dataDir: path.join(root, 'data'),
        workerFactory: options =>
        {
            const worker = new EventEmitter();
            worker.options = options;
            worker.postMessage = () => {};
            worker.terminate = async () => {};
            workers.push(worker);
            return worker;
        }, now: () => body().generatedAt });
    t.after(() => restarted.dispose());
    await restarted.ready;
    assert.equal(workers.length, 0);
    assert.equal(restarted.getState().snapshot, undefined);
    assert.equal(restarted.getState().error, 'snapshot-update-required');
    assert.deepEqual(JSON.parse(await fs.readFile(filename, 'utf8')), legacy);
    const next = await started(restarted, workers);
    next.worker.emit('message', { type: 'result', report: body() });
    assert.equal((await next.result).snapshot.pricing.basis, 'claude-client-estimate');
});

async function bounded(promise, operation)
{
    let timer;
    try
    {
        return await Promise.race([promise, new Promise((resolve, reject) =>
        {
            timer = setTimeout(() => reject(new Error(`Timed out waiting for ${operation}`)), 2500);
        })]);
    }
    finally { clearTimeout(timer); }
}

test('startup and idle never create a collector; each query awaits a fresh terminated worker', async t =>
{
    const { root, workers, service } = await setup(t);
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(workers.length, 0);
    assert.equal(service.getState().status, 'unavailable');
    const first = await started(service, workers);
    let resolved = false;
    first.result.then(() => { resolved = true; });
    assert.equal(resolved, false);
    assert.equal(first.worker.command.type, 'scan');
    assert.deepEqual(first.worker.options.workerData, {
        claudeHome: root, cacheDir: path.join(root, 'data', 'cache') });
    first.worker.emit('message', { type: 'result', report: body() });
    const state = await first.result;
    assert.equal(state.status, 'ok');
    assert.equal(first.worker.terminated, true);
    const report = JSON.parse(await fs.readFile(path.join(root, '.daily-usage/summary.json'), 'utf8'));
    assert.equal(report.source, 'com.kpk.daily-usage');
    assert.equal(report.revision, 1);
    const second = await started(service, workers);
    assert.equal(workers.length, 2);
    second.worker.emit('message', { type: 'result', report: body() });
    assert.equal((await second.result).snapshot.revision, 2);
    const published = await fs.readFile(path.join(root, '.daily-usage/summary.json'), 'utf8');
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(workers.length, 2);
    assert.equal(await fs.readFile(path.join(root, '.daily-usage/summary.json'), 'utf8'), published);
    await service.dispose();
    let created = false;
    const next = createService({ claudeHome: root, dataDir: path.join(root, 'data'),
        workerFactory: () => { created = true; throw new Error('eager-worker'); }, now: () => body().generatedAt });
    t.after(() => next.dispose());
    await next.ready;
    assert.equal(created, false);
    assert.equal(next.getState().snapshot.machineId, report.machineId);
    assert.equal(next.getState().status, 'stale');
});

test('shared subscribers cancel independently and the last cancellation invalidates late results', async t =>
{
    const { root, workers, service } = await setup(t);
    const one = new AbortController();
    const two = new AbortController();
    const first = await started(service, workers, { signal: one.signal });
    const second = service.query({ signal: two.signal });
    await new Promise(resolve => setImmediate(resolve));
    const firstRejected = assert.rejects(first.result, { name: 'AbortError', code: 'ABORT_ERR' });
    one.abort();
    await firstRejected;
    assert.equal(first.worker.terminated, undefined);
    first.worker.emit('message', { type: 'result', report: body() });
    assert.equal((await second).status, 'ok');
    assert.equal(workers.length, 1);
    const last = new AbortController();
    const third = await started(service, workers, { signal: last.signal });
    const thirdRejected = assert.rejects(third.result, { name: 'AbortError' });
    last.abort();
    await thirdRejected;
    assert.equal(third.worker.terminated, true);
    third.worker.emit('message', { type: 'result', report: body() });
    await new Promise(resolve => setTimeout(resolve, 20));
    const published = JSON.parse(await fs.readFile(path.join(root, '.daily-usage/summary.json'), 'utf8'));
    assert.equal(published.revision, 1);
    assert.equal(service.getState().snapshot.revision, 1);
});

test('late cancelled worker messages cannot replace a newer query or its progress', async t =>
{
    const { root, workers, service } = await setup(t);
    const controller = new AbortController();
    const first = await started(service, workers, { signal: controller.signal });
    const rejected = assert.rejects(first.result, { name: 'AbortError' });
    controller.abort();
    await rejected;
    const second = await started(service, workers);
    second.worker.emit('message', { type: 'progress', progress: { files: 2 } });
    first.worker.emit('message', { type: 'progress', progress: { files: 999 } });
    first.worker.emit('message', { type: 'result', report: { ...body(), generatedAt: body().generatedAt - 1000 } });
    first.worker.emit('error', new Error('late-worker-error'));
    first.worker.emit('exit', 1);
    assert.equal(service.getState().status, 'loading');
    assert.deepEqual(service.getState().progress, { files: 2 });
    second.worker.emit('message', { type: 'result', report: body() });
    const state = await second.result;
    assert.equal(state.status, 'ok');
    assert.equal(state.snapshot.revision, 1);
    assert.equal(state.snapshot.generatedAt, body().generatedAt);
    assert.equal(workers.length, 2);
    const published = JSON.parse(await fs.readFile(path.join(root, '.daily-usage/summary.json'), 'utf8'));
    assert.deepEqual(published, state.snapshot);
});

test('invalid results retain the last successful report and terminate the failed worker', async t =>
{
    const { workers, service } = await setup(t);
    const first = await started(service, workers);
    first.worker.emit('message', { type: 'result', report: body() });
    await first.result;
    const second = await started(service, workers);
    second.worker.emit('message', { type: 'result', report: { ...body(), rows: [{ usd: -1 }] } });
    const state = await second.result;
    assert.equal(state.snapshot.revision, 1);
    assert.equal(state.status, 'error');
    assert.equal(second.worker.terminated, true);
});

test('disposal rejects active and future queries without allowing late publication', async t =>
{
    const { root, workers, service } = await setup(t);
    const first = await started(service, workers);
    const rejected = assert.rejects(first.result, { name: 'AbortError' });
    await service.dispose();
    await rejected;
    assert.equal(first.worker.terminated, true);
    first.worker.emit('message', { type: 'result', report: body() });
    await assert.rejects(service.query(), { name: 'AbortError' });
    await assert.rejects(fs.access(path.join(root, '.daily-usage/summary.json')), { code: 'ENOENT' });
});

test('pre-aborted queries do not create workers', async t =>
{
    const { workers, service } = await setup(t);
    await assert.rejects(service.query({ signal: AbortSignal.abort() }), { name: 'AbortError' });
    assert.equal(workers.length, 0);
});

test('cancellation during asynchronous publication preparation leaves no summary or temporary file',
    { timeout: 5000 }, async t =>
{
    const { root, workers, service } = await setup(t);
    const controller = new AbortController();
    const first = await started(service, workers, { signal: controller.signal });
    let prepared;
    let release;
    const preparing = new Promise(resolve => { prepared = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    const writeFile = fs.writeFile;
    t.mock.method(fs, 'writeFile', async (file, ...args) =>
    {
        const result = await writeFile(file, ...args);
        if (path.basename(file).startsWith('.summary.json.'))
        {
            prepared();
            await gate;
        }
        return result;
    });
    first.worker.emit('message', { type: 'result', report: body() });
    try
    {
        await bounded(preparing, 'summary preparation');
        const rejected = assert.rejects(first.result, { name: 'AbortError' });
        controller.abort();
        await rejected;
    }
    finally { release(); }
    await service.dispose();
    const names = await fs.readdir(path.join(root, '.daily-usage'));
    assert.equal(names.includes('summary.json'), false);
    assert.equal(names.some(name => name.startsWith('.summary.json.')), false);
});

test('publication commit cannot yield to cancellation before the summary becomes visible', { timeout: 5000 }, async t =>
{
    const { root, workers, service } = await setup(t);
    const controller = new AbortController();
    const first = await started(service, workers, { signal: controller.signal });
    const summary = path.join(root, '.daily-usage/summary.json');
    const events = [];
    const cancel = () => queueMicrotask(() =>
    {
        events.push('cancelled');
        controller.abort();
    });
    const rename = fs.rename;
    const renameSync = nativeFs.renameSync;
    t.mock.method(fs, 'rename', async (from, to) =>
    {
        if (to !== summary) return rename(from, to);
        cancel();
        await new Promise(resolve => setImmediate(resolve));
        await rename(from, to);
        events.push('committed');
    });
    t.mock.method(nativeFs, 'renameSync', (from, to) =>
    {
        if (to !== summary) return renameSync(from, to);
        cancel();
        renameSync(from, to);
        events.push('committed');
    });
    first.worker.emit('message', { type: 'result', report: body() });
    await bounded(first.result.catch(error => assert.equal(error.name, 'AbortError')), 'summary commit');
    await service.dispose();
    assert.deepEqual(events, ['committed', 'cancelled']);
    assert.equal(JSON.parse(await fs.readFile(summary, 'utf8')).revision, 1);
});

for (const code of ['EPERM', 'EBUSY'])
{
    test(`summary publication recovers once from a Windows ${code} sharing violation`,
        { skip: process.platform !== 'win32', timeout: 5000 }, async t =>
    {
        const { root, workers, service } = await setup(t);
        const summary = path.join(root, '.daily-usage/summary.json');
        const renameSync = nativeFs.renameSync;
        let locked = true;
        t.mock.method(nativeFs, 'renameSync', (from, to) =>
        {
            if (to === summary && locked)
            {
                locked = false;
                throw Object.assign(new Error('sharing-violation'), { code });
            }
            return renameSync(from, to);
        });
        const first = await started(service, workers);
        first.worker.emit('message', { type: 'result', report: body() });
        assert.equal((await bounded(first.result, 'summary retry')).status, 'ok');
        assert.equal(JSON.parse(await fs.readFile(summary, 'utf8')).revision, 1);
        assert.equal((await fs.readdir(path.dirname(summary))).some(name => name.endsWith('.tmp')), false);
    });
}

test('last-subscriber cancellation during a sharing backoff prevents another commit attempt',
    { skip: process.platform !== 'win32', timeout: 5000 }, async t =>
{
    const { root, workers, service } = await setup(t);
    const controller = new AbortController();
    const summary = path.join(root, '.daily-usage/summary.json');
    const renameSync = nativeFs.renameSync;
    let attempts = 0;
    t.mock.method(nativeFs, 'renameSync', (from, to) =>
    {
        if (to !== summary) return renameSync(from, to);
        attempts++;
        queueMicrotask(() => controller.abort());
        throw Object.assign(new Error('sharing-violation'), { code: 'EPERM' });
    });
    const first = await started(service, workers, { signal: controller.signal });
    const rejected = assert.rejects(first.result, { name: 'AbortError' });
    first.worker.emit('message', { type: 'result', report: body() });
    await bounded(rejected, 'backoff cancellation');
    await service.dispose();
    assert.equal(attempts, 1);
    await assert.rejects(fs.access(summary), { code: 'ENOENT' });
    assert.equal((await fs.readdir(path.dirname(summary))).some(name => name.endsWith('.tmp')), false);
});

for (const code of ['EPERM', 'EIO'])
{
    test(`summary ${code} failure is bounded and removes its prepared file`,
        { skip: code === 'EPERM' && process.platform !== 'win32', timeout: 5000 }, async t =>
    {
        const { root, workers, service } = await setup(t);
        const summary = path.join(root, '.daily-usage/summary.json');
        const renameSync = nativeFs.renameSync;
        let attempts = 0;
        t.mock.method(nativeFs, 'renameSync', (from, to) =>
        {
            if (to !== summary) return renameSync(from, to);
            attempts++;
            throw Object.assign(new Error('write-failed'), { code });
        });
        const first = await started(service, workers);
        first.worker.emit('message', { type: 'result', report: body() });
        assert.equal((await bounded(first.result, 'bounded publication failure')).status, 'error');
        assert.equal(attempts, code === 'EPERM' ? 2 : 1);
        assert.equal((await fs.readdir(path.dirname(summary))).some(name => name.endsWith('.tmp')), false);
    });
}

test('worker failures and unexpected exits resolve an error state and allow retry', async t =>
{
    const { workers, service } = await setup(t);
    const first = await started(service, workers);
    first.worker.emit('error', new Error('read-failed'));
    assert.equal((await first.result).error, 'read-failed');
    assert.equal(first.worker.terminated, true);
    const second = await started(service, workers);
    second.worker.emit('exit', 1);
    assert.equal((await second.result).error, 'collector-exited-1');
});

test('real worker publishes a priced native usage row then remains idle', async t =>
{
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'daily-usage-worker-'));
    const timestamp = new Date().toISOString();
    await fs.mkdir(path.join(root, 'projects', 'project'), { recursive: true });
    const file = path.join(root, 'projects', 'project', 'session.jsonl');
    const records = [{ timestamp, type: 'assistant', requestId: 'req-one', message: {
        id: 'msg-one', role: 'assistant', model: 'claude-sonnet-4-5-20250929', usage: {
            input_tokens: 70, cache_read_input_tokens: 20, cache_creation_input_tokens: 10,
            cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 0 }, output_tokens: 30 }
    } }];
    await fs.writeFile(file, records.map(record => JSON.stringify(record)).join('\n') + '\n');
    const service = createService({ claudeHome: root, dataDir: path.join(root, 'data') });
    t.after(async () => { await service.dispose(); await fs.rm(root, { recursive: true }); });
    await service.ready;
    const state = await service.query();
    assert.equal(state.status, 'ok', JSON.stringify(state));
    const row = state.snapshot.rows[0];
    assert.equal(row?.requests, 1);
    assert.equal(row?.inputTokens, 100);
    assert.equal(row?.uncachedInputTokens, 70);
    assert.equal(row?.cachedInputTokens, 20);
    assert.equal(row?.cacheWriteTokens, 10);
    assert.equal(row?.outputTokens, 30);
    assert.equal(row?.usd, 0.0007035);
    const reportFile = path.join(root, '.daily-usage/summary.json');
    const before = await fs.stat(reportFile);
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal((await fs.stat(reportFile)).mtimeMs, before.mtimeMs);
});
