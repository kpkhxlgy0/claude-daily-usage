'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');

const WeekMs = 7 * 24 * 60 * 60 * 1000;
const MaxHistoryBytes = 4 * 1024 * 1024;
const MaxHistorySamples = 20000;
const FullPercent = 100;
const ResetLowFraction = 0.5;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

async function readHistory(claudeData)
{
    const filename = path.join(claudeData, 'plan-usage-history.json');
    const file = await fs.lstat(filename);
    if (!file.isFile() || !file.size || file.size > MaxHistoryBytes) return null;
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

function selectSamples(data, generatedAt)
{
    if (data?.version !== 2 || !Array.isArray(data.samples) || data.samples.length > MaxHistorySamples) return null;
    const samples = [];
    for (const sample of data.samples)
    {
        if (!record(sample) || !Number.isSafeInteger(sample.t) || sample.t <= 0) return null;
        const at = sample.t;
        const previous = samples.at(-1);
        // Desktop 按观察顺序追加。回拨的时间戳不能改变已观察到的周期。
        if (at > generatedAt || at < previous?.at) continue;
        const { org, u } = sample;
        if (!(org === null || typeof org === 'string' && org.length > 0 && org.length <= 256)
            || !record(u)) return null;
        const percent = u.sd;
        if (percent !== undefined && (!Number.isFinite(percent) || percent < 0 || percent > FullPercent)) return null;
        if (at === previous?.at)
        {
            if (org !== previous.org || percent !== previous.percent) return null;
            continue;
        }
        samples.push({ at, org, percent });
    }
    const last = samples.at(-1);
    if (!last?.org || last.percent === undefined || generatedAt - last.at >= WeekMs) return null;
    const boundary = samples.findLastIndex(sample => sample.org !== last.org);
    if (boundary >= 0 && generatedAt - samples[boundary].at < WeekMs) return null;
    return samples.slice(boundary + 1).filter(sample => sample.percent !== undefined);
}

function observedWindow(samples, generatedAt)
{
    let startAt;
    let earliestStartAt;
    let sampleAt;
    let fullAt;
    let usedPercent;
    let previousAt;
    let possibleReset;
    for (const { at, percent } of samples)
    {
        if (previousAt === undefined || at - previousAt >= WeekMs)
        {
            startAt = earliestStartAt = at;
            fullAt = null;
            usedPercent = percent;
            possibleReset = undefined;
        }
        previousAt = at;
        if (percent < usedPercent)
        {
            // 最晚到期前只采用有归零或明显下降证据的样本。
            const latestExpiry = startAt + WeekMs;
            const earlyEvidence = percent === 0 || percent <= usedPercent * ResetLowFraction
                && (possibleReset?.percent === 0 || earliestStartAt === startAt || at - earliestStartAt >= WeekMs);
            if (!earlyEvidence && at < latestExpiry)
            {
                possibleReset = undefined;
                continue;
            }
            if (!possibleReset || percent < possibleReset.percent
                || (!earlyEvidence && possibleReset.at < latestExpiry))
            {
                possibleReset = { at, percent };
                continue;
            }
            earliestStartAt = possibleReset.at >= latestExpiry ? Math.max(sampleAt, earliestStartAt + WeekMs) : sampleAt;
            startAt = possibleReset.at;
            fullAt = null;
        }
        possibleReset = undefined;
        usedPercent = percent;
        sampleAt = at;
        if (percent === FullPercent && fullAt === null) fullAt = at;
    }
    // 重置可能发生在最后一个可信旧样本之后。原周期在最早可能的下次重置之后不再有效。
    if (sampleAt !== previousAt || fullAt === startAt || generatedAt - earliestStartAt >= WeekMs) return null;
    return { startAt, startKind: 'observed', fullAt, usedPercent, sampleAt };
}

async function readWeeklyWindow(claudeData, generatedAt)
{
    if (typeof claudeData !== 'string' || !path.isAbsolute(claudeData)) return null;
    try
    {
        const samples = selectSamples(await readHistory(claudeData), generatedAt);
        const window = samples && observedWindow(samples, generatedAt);
        return window ? { organizationId: samples.at(-1).org, window } : null;
    }
    catch { return null; }
}

module.exports = { readWeeklyWindow };
