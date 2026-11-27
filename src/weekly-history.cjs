'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');

const WeekMs = 7 * 24 * 60 * 60 * 1000;
const MaxHistoryBytes = 4 * 1024 * 1024;
const MaxHistorySamples = 20000;
const MaxPreviousWeeks = 3;
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
    if (!last?.org) return null;
    const boundary = samples.findLastIndex(sample => sample.org !== last.org);
    return { organizationId: last.org, samples: samples.slice(boundary + 1).filter(sample => sample.percent !== undefined),
        currentEligible: last.percent !== undefined && generatedAt - last.at < WeekMs
            && (boundary < 0 || generatedAt - samples[boundary].at >= WeekMs) };
}

function prependHistory(history, latest, minMissing, maxMissing)
{
    const missing = Array(Math.min(MaxPreviousWeeks, minMissing)).fill(null);
    return (minMissing === maxMissing ? [...missing, latest, ...history] : [...missing, null])
        .slice(0, MaxPreviousWeeks);
}

function observedWindows(samples, generatedAt)
{
    let startAt;
    let earliestStartAt;
    let sampleAt;
    let fullAt;
    let usedPercent;
    let previousAt;
    let possibleReset;
    let resetLowCeiling;
    let historical;
    let history = [];
    for (const { at, percent } of samples)
    {
        if (previousAt === undefined || at - previousAt >= WeekMs)
        {
            // 长缺口无法确认上一段观测对应第几个历史周期。
            if (previousAt !== undefined) history = [null];
            startAt = earliestStartAt = at;
            fullAt = null;
            usedPercent = percent;
            possibleReset = undefined;
            resetLowCeiling = undefined;
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
            // 同一低值区间内的再次下降只修正本轮的观测起点。
            const refinesReset = resetLowCeiling !== undefined && usedPercent <= resetLowCeiling
                && possibleReset.at - earliestStartAt < WeekMs;
            if (!refinesReset)
            {
                // 确认前的最后一个高值可能已经落在没有观察到重置的周期中。
                const minMissed = Math.floor((sampleAt - startAt) / WeekMs);
                const maxMissed = Math.floor((sampleAt - earliestStartAt) / WeekMs);
                history = prependHistory(history, historical, minMissed, maxMissed);
                earliestStartAt = possibleReset.at >= latestExpiry
                    ? Math.max(sampleAt, earliestStartAt + WeekMs) : sampleAt;
                resetLowCeiling = Math.max(possibleReset.percent, usedPercent * ResetLowFraction);
            }
            startAt = possibleReset.at;
            fullAt = null;
            historical = { startAt, startKind: 'observed', fullAt, usedPercent: possibleReset.percent,
                sampleAt: startAt, endAt: startAt, partial: true };
        }
        possibleReset = undefined;
        usedPercent = percent;
        sampleAt = at;
        if (percent === FullPercent && fullAt === null) fullAt = at;
        // 历史金额只累计到最早可能重置前的最后一个可信样本。
        if (at - earliestStartAt < WeekMs)
        {
            historical = fullAt === startAt ? null : { startAt, startKind: 'observed', fullAt, usedPercent,
                sampleAt, endAt: sampleAt, partial: true };
        }
    }
    // 重置可能发生在最后一个可信旧样本之后。原周期在最早可能的下次重置之后不再有效。
    if (generatedAt - earliestStartAt >= WeekMs)
    {
        // 只有确认过重置的周期具有可用于定位历史的起点上下界。
        if (resetLowCeiling === undefined || generatedAt - startAt < WeekMs) return { window: null, history: [] };
        const minElapsed = Math.floor((generatedAt - startAt) / WeekMs);
        const maxElapsed = Math.floor((generatedAt - earliestStartAt) / WeekMs);
        if (possibleReset)
        {
            // 已到期区间内未确认的低值不改变已知的历史位置。
            const expiryOffset = Math.floor((possibleReset.at - earliestStartAt) / WeekMs) * WeekMs;
            if (minElapsed !== maxElapsed || expiryOffset < WeekMs || possibleReset.at > startAt + expiryOffset)
            {
                return { window: null, history: [] };
            }
        }
        return { window: null, history: prependHistory(history, historical, minElapsed - 1, maxElapsed - 1) };
    }
    if (possibleReset) return { window: null, history: [] };
    const window = sampleAt !== previousAt || fullAt === startAt ? null
        : { startAt, startKind: 'observed', fullAt, usedPercent, sampleAt };
    return { window, history };
}

async function readWeeklyWindows(claudeData, generatedAt)
{
    if (typeof claudeData !== 'string' || !path.isAbsolute(claudeData)) return null;
    try
    {
        const selected = selectSamples(await readHistory(claudeData), generatedAt);
        if (!selected?.samples.length) return null;
        const { organizationId, samples, currentEligible } = selected;
        const { window, history } = observedWindows(samples, generatedAt);
        const current = currentEligible ? window : null;
        return { organizationId: current || history.some(Boolean) ? organizationId : undefined,
            window: current, history };
    }
    catch { return null; }
}

module.exports = { readWeeklyWindows };
