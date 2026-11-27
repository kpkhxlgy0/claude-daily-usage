'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { normalizeThreadId } = require('./protocol.cjs');

const WeekMs = 7 * 24 * 60 * 60 * 1000;
const MaxHistoryBytes = 4 * 1024 * 1024;
const MaxHistorySamples = 20000;
const MaxResetAnchors = 8;
const MaxPreviousWeeks = 3;
const FullPercent = 100;
const ResetLowFraction = 0.5;
const MaxResetSampleGapMs = 48 * 60 * 60 * 1000;
const ResetToleranceMs = 1000;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

async function readBoundedJson(filename, maxBytes)
{
    const file = await fs.lstat(filename);
    if (!file.isFile() || !file.size || file.size > maxBytes) return null;
    const handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    try
    {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.dev !== file.dev || stat.ino !== file.ino || stat.size !== file.size) return null;
        const buffer = Buffer.alloc(stat.size);
        let offset = 0;
        while (offset < buffer.length)
        {
            const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
            if (!bytesRead) return null;
            offset += bytesRead;
        }
        const after = await handle.stat();
        if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) return null;
        return JSON.parse(buffer.toString('utf8'));
    }
    finally { await handle.close(); }
}

async function readWeeklySamples(claudeData, generatedAt)
{
    if (typeof claudeData !== 'string' || !path.isAbsolute(claudeData)) return null;
    try
    {
        const data = await readBoundedJson(path.join(claudeData, 'plan-usage-history.json'), MaxHistoryBytes);
        if (data?.version !== 2 || !Array.isArray(data.samples) || data.samples.length > MaxHistorySamples) return null;
        const samples = [];
        for (const sample of data.samples)
        {
            if (!record(sample) || !Number.isSafeInteger(sample.t) || sample.t <= 0) return null;
            const at = sample.t;
            const previous = samples.at(-1);
            if (at > generatedAt || at < previous?.at) continue;
            const { org, u } = sample;
            if (!(org === null || typeof org === 'string' && org.length > 0 && org.length <= 256)
                || !record(u)) return null;
            const organizationId = normalizeThreadId(org);
            const percent = u.sd;
            if (percent !== undefined && (!Number.isFinite(percent) || percent < 0 || percent > FullPercent))
                return null;
            if (at === previous?.at)
            {
                if (organizationId !== previous.organizationId || percent !== previous.percent) return null;
                continue;
            }
            samples.push({ at, organizationId, percent });
        }
        const organizationId = samples.at(-1)?.organizationId;
        if (!organizationId) return null;
        const lastSwitch = samples.findLastIndex(sample => sample.organizationId !== organizationId);
        const selected = samples.slice(lastSwitch + 1);
        return { organizationId, since: lastSwitch < 0 ? 0 : selected[0].at,
            samples: selected.filter(sample => sample.percent !== undefined) };
    }
    catch { return null; }
}

function validResetAnchor(anchor, generatedAt)
{
    return record(anchor) && Number.isSafeInteger(anchor.resetAt) && Number.isSafeInteger(anchor.observedAt)
        && anchor.observedAt > 0 && anchor.observedAt <= generatedAt
        && anchor.resetAt > anchor.observedAt && anchor.resetAt - anchor.observedAt <= WeekMs + ResetToleranceMs
        && (anchor.usedPercent === null
            || Number.isFinite(anchor.usedPercent) && anchor.usedPercent >= 0 && anchor.usedPercent <= FullPercent)
        && (anchor.firstFullAt == null || Number.isSafeInteger(anchor.firstFullAt)
            && anchor.firstFullAt >= anchor.resetAt - WeekMs && anchor.firstFullAt <= anchor.observedAt);
}

function scopedPath(filepath)
{
    const resolved = path.resolve(filepath);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

async function loadWeeklyContext({ claudeHome, claudeData, dataDir, generatedAt, allowOrganization = () => true })
{
    if (!dataDir || !path.isAbsolute(dataDir)) return null;
    const selected = await readWeeklySamples(claudeData, generatedAt);
    if (!selected) return null;
    const { organizationId, since } = selected;
    if (!allowOrganization(organizationId)) return null;
    const scope = [organizationId, scopedPath(claudeData), scopedPath(claudeHome)];
    const identity = createHash('sha256').update(JSON.stringify(scope)).digest('hex');
    const anchorFile = path.join(dataDir, 'weekly-reset-' + identity + '.json');
    let anchors = [];
    try
    {
        const directory = await fs.lstat(dataDir);
        if (!directory.isDirectory() || directory.isSymbolicLink()) return null;
        const saved = await readBoundedJson(anchorFile, 8192);
        if (saved?.version === 1 && saved.organizationId === organizationId && Array.isArray(saved.anchors)
            && saved.anchors.length <= MaxResetAnchors)
            anchors = saved.anchors.filter(anchor => validResetAnchor(anchor, generatedAt) && anchor.observedAt >= since);
    }
    catch { /* 没有已验证的磁盘锚点。 */ }
    return { organizationId, anchorFile, anchors };
}

function resetDrops(samples)
{
    const drops = [];
    for (let index = 1; index < samples.length; index++)
    {
        const before = samples[index - 1];
        const after = samples[index];
        if (before.percent > 0 && after.percent <= before.percent * ResetLowFraction
            && after.at - before.at <= MaxResetSampleGapMs) drops.push({ after: before.at, by: after.at });
    }
    return drops;
}

async function readWeeklyWindows(claudeData, generatedAt, context)
{
    if (!context?.organizationId || !Array.isArray(context.anchors) || !context.anchors.length) return null;
    const selected = await readWeeklySamples(claudeData, generatedAt);
    if (!selected || selected.organizationId !== context.organizationId) return null;
    const anchors = context.anchors.filter(anchor => validResetAnchor(anchor, generatedAt)
        && anchor.observedAt >= selected.since).sort((left, right) => left.observedAt - right.observedAt);
    const latest = anchors.at(-1);
    if (!latest) return null;

    const phase = latest.resetAt;
    const closestBoundary = at => phase + Math.round((at - phase) / WeekMs) * WeekMs;
    const lastDifferentPhase = anchors.findLastIndex(anchor => Math.abs(anchor.resetAt - closestBoundary(anchor.resetAt))
        > ResetToleranceMs);
    const samePhase = anchors.slice(lastDifferentPhase + 1);
    const knownResets = new Set(samePhase.map(anchor => closestBoundary(anchor.resetAt)));
    const drops = resetDrops(selected.samples);
    const evidence = [...knownResets].map(at => at - WeekMs);
    // 采样无法给出精确重置时刻。与官方相位重合的下降区间可佐证前后两端之间的完整周。
    const phaseChangeCutoff = anchors[lastDifferentPhase]?.resetAt ?? 0;
    for (const drop of drops)
    {
        const boundary = closestBoundary(drop.by);
        if (drop.after >= phaseChangeCutoff && drop.after < boundary && boundary <= drop.by)
            evidence.push(boundary);
    }

    const firstSupportedStart = Math.min(...evidence);
    const lastSupportedStart = Math.max(...evidence);
    const currentStart = phase + Math.floor((generatedAt - phase) / WeekMs) * WeekMs;
    const samples = [...selected.samples];
    for (const anchor of samePhase)
    {
        if (anchor.firstFullAt != null) samples.push({ at: anchor.firstFullAt, percent: FullPercent });
        if (anchor.usedPercent !== null) samples.push({ at: anchor.observedAt, percent: anchor.usedPercent });
    }
    samples.sort((left, right) => left.at - right.at);
    const periods = Array.from({ length: MaxPreviousWeeks + 1 }, (_, index) =>
    {
        const startAt = currentStart - index * WeekMs;
        if (startAt < Math.max(firstSupportedStart, selected.since, phaseChangeCutoff)
            || startAt > lastSupportedStart) return null;
        const resetAt = startAt + WeekMs;
        const endAt = Math.min(resetAt - 1, generatedAt);
        const within = samples.filter(sample => sample.at >= startAt && sample.at <= endAt);
        const last = within.at(-1);
        const fullAt = within.find(sample => sample.percent === FullPercent)?.at ?? null;
        const anomaly = drops.some(drop => drop.after >= startAt && drop.by < resetAt);
        return { startAt, resetAt, endAt,
            startKind: !anomaly && (knownResets.has(resetAt) || knownResets.has(startAt)) ? 'reset' : 'inferred',
            sampleAt: last?.at ?? null, usedPercent: last?.percent ?? null, fullAt, partial: anomaly || !last };
    });
    const [window, ...history] = periods;
    const earlierBefore = history[MaxPreviousWeeks - 1]?.startAt;
    while (history.length && history.at(-1) === null) history.pop();
    if (!window && !history.some(Boolean)) return null;
    return { organizationId: selected.organizationId, window, history, earlierBefore,
        earlierSince: Math.max(selected.since, phaseChangeCutoff) };
}

module.exports = { loadWeeklyContext, readWeeklyWindows, validResetAnchor, ResetToleranceMs, MaxResetAnchors };
