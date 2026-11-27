'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { createLogParser, UsageFields } = require('./log-parser.cjs');
const { priceRequest, Pricing, validTokens } = require('./pricing.cjs');
const { readWeeklyWindows } = require('./weekly-history.cjs');

const DayMs = 24 * 60 * 60 * 1000;
const BeijingOffsetMs = 8 * 60 * 60 * 1000;
const RetentionDays = 30;
const CacheVersion = 2;
const MaxForkDepth = 32;

function beijingDate(timestamp)
{
    return new Date(timestamp + BeijingOffsetMs).toISOString().slice(0, 10);
}

function digest(value)
{
    return createHash('sha256').update(value).digest('hex');
}

function fingerprint(stat)
{
    return ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs', 'birthtimeMs'].map(key => stat[key]).join(':');
}

function validCachedData(data, sourceId)
{
    const identity = value => value === null || typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
    return data && data.sourceId === sourceId && validTokens(data.skippedRecords)
        && validTokens(data.oversizedRecords) && Array.isArray(data.events) && data.events.every(event => event
            && identity(event.messageId) && identity(event.requestId) && (event.messageId || event.requestId)
            && typeof event.inherited === 'boolean' && identity(event.sessionId) && identity(event.recordId)
            && identity(event.originSessionId) && identity(event.originRecordId)
            && Number.isFinite(event.timestamp) && Math.abs(event.timestamp) < 8.64e15 - DayMs
            && typeof event.model === 'string' && event.model.length <= 128
            && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/.test(event.model)
            && UsageFields.every(key => event[key] === null || validTokens(event[key]))
            && (event.cacheWriteTtlInvalid === undefined || typeof event.cacheWriteTtlInvalid === 'boolean')
            && validTokens(event.inputTokens) && typeof event.usageComplete === 'boolean');
}

function resolveTimestamps(events)
{
    const records = new Map();
    const timestamps = new Map();
    const proofFields = ['messageId', 'requestId', 'timestamp', 'model', 'inherited',
        'originSessionId', 'originRecordId', 'cacheWriteTtlInvalid', ...UsageFields];
    for (const event of events)
    {
        if (!event.sessionId || !event.recordId) continue;
        const key = event.sessionId + ':' + event.recordId;
        if (!records.has(key)) records.set(key, event);
        else
        {
            const previous = records.get(key);
            if (previous && proofFields.some(field => previous[field] !== event[field])) records.set(key, null);
        }
    }
    function original(event, visiting = new Set())
    {
        if (!event.inherited) return event.timestamp;
        if (timestamps.has(event)) return timestamps.get(event);
        if (!event.sessionId || !event.recordId || !event.originSessionId || !event.originRecordId
            || visiting.size >= MaxForkDepth || visiting.has(event)) return null;
        const ancestor = records.get(event.originSessionId + ':' + event.originRecordId);
        if (!ancestor || event.model !== ancestor.model
            || Boolean(event.cacheWriteTtlInvalid) !== Boolean(ancestor.cacheWriteTtlInvalid)
            || UsageFields.some(field => event[field] !== ancestor[field])) return null;
        const sameResponse = event.messageId && ancestor.messageId ? event.messageId === ancestor.messageId
            : event.requestId && ancestor.requestId && event.requestId === ancestor.requestId;
        if (!sameResponse || event.requestId && ancestor.requestId && event.requestId !== ancestor.requestId)
        {
            return null;
        }
        visiting.add(event);
        const timestamp = original(ancestor, visiting);
        visiting.delete(event);
        timestamps.set(event, timestamp);
        return timestamp;
    }
    for (const event of events) timestamps.set(event, original(event));
    return timestamps;
}

function mergeResponse(target, event)
{
    if (event.cacheWriteTtlInvalid) target.cacheWriteTtlInvalid = true;
    if (event.timestamp !== null)
        target.timestamp = target.timestamp === null ? event.timestamp : Math.min(target.timestamp, event.timestamp);
    let less = false;
    let greater = false;
    for (const key of UsageFields)
    {
        if (target[key] === null || event[key] === null) continue;
        less ||= event[key] < target[key];
        greater ||= event[key] > target[key];
    }
    const modelConflict = target.model !== 'unknown' && event.model !== 'unknown' && target.model !== event.model;
    if (less && greater || modelConflict)
    {
        target.conflicts = (target.conflicts || 0) + 1;
        target.conflicted = true;
        return;
    }
    if (target.model === 'unknown') target.model = event.model;
    for (const key of UsageFields)
    {
        if (event[key] !== null && (target[key] === null || event[key] > target[key])) target[key] = event[key];
    }
}

function createCollector({ claudeHome, claudeData, cacheDir, now = Date.now, onProgress } = {})
{
    if (typeof claudeHome !== 'string' || !claudeHome) throw new TypeError('claudeHome is required');
    if (typeof now !== 'function') throw new TypeError('now must be a clock function');
    const projects = path.join(claudeHome, 'projects');
    const usageCacheDir = path.join(cacheDir || path.join(claudeHome, '.daily-usage'), 'usage-cache');
    const memory = new Map();
    const activeStreams = new Set();
    let pending = Promise.resolve();
    let disposed = false;

    function checkActive()
    {
        if (disposed) throw Object.assign(new Error('Daily Usage collector is disposed'),
            { code: 'ERR_DAILY_USAGE_DISPOSED' });
    }

    function progress(phase, coverage, processedFiles = 0)
    {
        if (typeof onProgress === 'function') onProgress({ phase, files: coverage.files, processedFiles,
            parsedFiles: coverage.parsedFiles, cachedFiles: coverage.cachedFiles, failedFiles: coverage.failedFiles });
    }

    async function discover(coverage)
    {
        const sources = [];
        async function walk(directory)
        {
            checkActive();
            let entries;
            try
            {
                const stat = await fs.lstat(directory);
                if (!stat.isDirectory() || stat.isSymbolicLink()) return;
                entries = await fs.readdir(directory, { withFileTypes: true });
            }
            catch (error)
            {
                if (error.code !== 'ENOENT') coverage.discoveryErrors++;
                return;
            }
            entries.sort((left, right) => left.name.localeCompare(right.name));
            for (const entry of entries)
            {
                checkActive();
                const filename = path.join(directory, entry.name);
                if (entry.isDirectory()) await walk(filename);
                else if (entry.isFile() && /\.jsonl$/i.test(entry.name))
                {
                    try
                    {
                        const stat = await fs.lstat(filename);
                        if (stat.isFile() && !stat.isSymbolicLink()) sources.push({ filename, stat });
                    }
                    catch { coverage.discoveryErrors++; }
                }
            }
        }
        await walk(projects);
        return sources;
    }

    async function readSource(source, coverage)
    {
        const key = digest(path.relative(claudeHome, source.filename));
        const sourceId = 'file-' + key;
        const cacheFile = path.join(usageCacheDir, key + '.json');
        const version = fingerprint(source.stat);
        let cached = memory.get(key);
        if (!cached)
        {
            try { cached = JSON.parse(await fs.readFile(cacheFile, 'utf8')); }
            catch { /* 缓存损坏只影响性能，原始日志仍为唯一数据源。 */ }
        }
        if (cached && cached.schemaVersion === CacheVersion && cached.version === version
            && validCachedData(cached.data, sourceId))
        {
            memory.set(key, cached);
            coverage.cachedFiles++;
            return cached.data;
        }
        const parser = createLogParser({ sourceId });
        const handle = await fs.open(source.filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
        let stat;
        let after;
        try
        {
            checkActive();
            stat = await handle.stat();
            if (!stat.isFile() || fingerprint(stat) !== version)
                throw new Error('Usage source changed during discovery');
            if (stat.size)
            {
                const stream = handle.createReadStream({ start: 0, end: stat.size - 1, autoClose: false,
                    highWaterMark: 64 * 1024 });
                activeStreams.add(stream);
                try
                {
                    for await (const chunk of stream) { checkActive(); parser.onChunk(chunk); }
                }
                finally { activeStreams.delete(stream); }
            }
            after = await handle.stat();
        }
        finally { await handle.close(); }
        checkActive();
        const data = parser.finish();
        coverage.parsedFiles++;
        if (fingerprint(after) !== fingerprint(stat)) return data;
        cached = { schemaVersion: CacheVersion, version, data };
        memory.set(key, cached);
        let temporary;
        try
        {
            await fs.mkdir(usageCacheDir, { recursive: true });
            temporary = cacheFile + '.' + randomUUID() + '.tmp';
            await fs.writeFile(temporary, JSON.stringify(cached), { mode: 0o600 });
            checkActive();
            await fs.rename(temporary, cacheFile);
            temporary = null;
        }
        catch (error)
        {
            if (disposed) throw error;
            coverage.cacheErrors++;
        }
        finally { if (temporary) await fs.unlink(temporary).catch(() => {}); }
        return data;
    }

    async function scanSources()
    {
        checkActive();
        const generatedAt = now();
        if (!Number.isFinite(generatedAt) || Math.abs(generatedAt) >= 8.64e15 - DayMs)
            throw new TypeError('Clock returned an invalid timestamp');
        const to = beijingDate(generatedAt);
        const cutoff = Date.parse(to + 'T00:00:00+08:00') - (RetentionDays - 1) * DayMs;
        const from = beijingDate(cutoff);
        const coverage = { files: 0, failedFiles: 0, skippedRecords: 0, legacyRequests: 0, warnings: [],
            parsedFiles: 0, cachedFiles: 0, duplicateRequests: 0, conflictingRequests: 0,
            discoveryErrors: 0, cacheErrors: 0, oversizedRecords: 0, incompleteRequests: 0, ambiguousRequests: 0,
            overflowRequests: 0, unresolvedInheritedRequests: 0 };
        progress('discovering', coverage);
        const [sources, weeklyWindows] = await Promise.all([
            discover(coverage), readWeeklyWindows(claudeData, generatedAt),
        ]);
        const weeklyPeriods = [weeklyWindows?.window, ...(weeklyWindows?.history || [])].map(window => window
            ? { window, endAt: window.fullAt ?? window.endAt ?? generatedAt, rows: new Map() } : null);
        coverage.files = sources.length;
        const events = [];
        let processedFiles = 0;
        progress('scanning', coverage);
        for (const source of sources)
        {
            checkActive();
            try
            {
                const data = await readSource(source, coverage);
                for (const event of data.events) events.push(event);
                coverage.skippedRecords += data.skippedRecords;
                coverage.oversizedRecords += data.oversizedRecords;
            }
            catch
            {
                checkActive();
                coverage.failedFiles++;
            }
            progress('scanning', coverage, ++processedFiles);
        }
        checkActive();
        const timestamps = resolveTimestamps(events);
        const aliases = new Map();
        for (const event of events)
        {
            if (!event.messageId || !event.requestId) continue;
            const ids = aliases.get(event.requestId) || new Set();
            ids.add(event.messageId);
            aliases.set(event.requestId, ids);
        }
        const responses = new Map();
        const ambiguous = new Set();
        for (const observed of events)
        {
            const event = { ...observed, timestamp: timestamps.get(observed) };
            const ids = aliases.get(event.requestId);
            if (!event.messageId && ids && ids.size > 1)
            {
                ambiguous.add(event.requestId);
                continue;
            }
            const messageId = event.messageId || ids && ids.values().next().value;
            const key = messageId ? 'message:' + messageId : 'request:' + event.requestId;
            if (responses.has(key))
            {
                coverage.duplicateRequests++;
                mergeResponse(responses.get(key), event);
            }
            else responses.set(key, { ...event });
        }
        coverage.ambiguousRequests = ambiguous.size;
        coverage.skippedRecords += ambiguous.size;
        const rows = new Map();
        let unpricedRequests = 0;
        let estimatedRequests = 0;
        for (const event of responses.values())
        {
            if (event.timestamp === null)
            {
                coverage.unresolvedInheritedRequests++;
                coverage.skippedRecords++;
                continue;
            }
            const date = beijingDate(event.timestamp);
            if (date < from || date > to) continue;
            coverage.conflictingRequests += event.conflicts || 0;
            const weeklyPeriod = weeklyPeriods.find(period => period && event.timestamp >= period.window.startAt
                && event.timestamp <= period.endAt);
            const usageComplete = UsageFields.slice(0, 4).every(key => event[key] !== null);
            if (!usageComplete) coverage.incompleteRequests++;
            const usage = { ...event, usageComplete: usageComplete && !event.conflicted,
                uncachedInputTokens: event.uncachedInputTokens ?? 0, cachedInputTokens: event.cachedInputTokens ?? 0,
                cacheWriteTokens: event.cacheWriteTokens ?? 0, outputTokens: event.outputTokens ?? 0 };
            usage.inputTokens = usage.uncachedInputTokens + usage.cachedInputTokens + usage.cacheWriteTokens;
            const price = priceRequest(usage);
            if (weeklyPeriod)
            {
                const weeklyRows = weeklyPeriod.rows;
                let row = weeklyRows.get(event.model);
                if (!row)
                {
                    row = { model: event.model, requests: 0, baseUsd: 0, usd: 0,
                        unpricedRequests: 0, estimatedRequests: 0 };
                    weeklyRows.set(event.model, row);
                }
                row.requests++;
                row.baseUsd += priceRequest(usage, { baseRates: true }).usd;
                row.usd += price.usd;
                if (price.unpriced) row.unpricedRequests++;
                if (price.estimated) row.estimatedRequests++;
            }
            const key = date + ':' + event.model;
            let row = rows.get(key);
            if (!row)
            {
                row = { date, model: event.model, requests: 0, inputTokens: 0, uncachedInputTokens: 0,
                    cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 0, unpricedRequests: 0,
                    estimatedRequests: 0, usd: 0 };
                rows.set(key, row);
            }
            const countFields = ['inputTokens', 'uncachedInputTokens', 'cachedInputTokens', 'cacheWriteTokens',
                'outputTokens'];
            if (countFields.some(field => !validTokens(row[field] + usage[field])))
            {
                coverage.overflowRequests++;
                coverage.skippedRecords++;
                continue;
            }
            row.requests++;
            for (const field of countFields) row[field] += usage[field];
            row.usd += price.usd;
            if (price.unpriced) { row.unpricedRequests++; unpricedRequests++; }
            if (price.estimated) { row.estimatedRequests++; estimatedRequests++; }
        }
        if (coverage.failedFiles) coverage.warnings.push(`有 ${coverage.failedFiles} 个用量文件读取失败。`);
        if (coverage.discoveryErrors) coverage.warnings.push(`有 ${coverage.discoveryErrors} 处历史目录无法读取。`);
        if (coverage.skippedRecords) coverage.warnings.push(`跳过 ${coverage.skippedRecords} 条不完整记录，统计覆盖不全。`);
        if (coverage.oversizedRecords) coverage.warnings.push(`${coverage.oversizedRecords} 条记录超过 1 MiB 上限。`);
        if (coverage.conflictingRequests) coverage.warnings.push('重复响应的用量或模型冲突，已保留可确认用量并标记金额不完整。');
        if (coverage.ambiguousRequests) coverage.warnings.push('部分请求标识对应多个响应，无法归属的记录已排除。');
        if (coverage.incompleteRequests) coverage.warnings.push(`${coverage.incompleteRequests} 次请求缺少完整 token 用量。`);
        if (coverage.unresolvedInheritedRequests)
            coverage.warnings.push(`${coverage.unresolvedInheritedRequests} 次继承响应缺少可确认的原始日期，已排除日期统计。`);
        if (coverage.overflowRequests) coverage.warnings.push(`${coverage.overflowRequests} 次请求超出安全统计范围，已排除。`);
        if (unpricedRequests) coverage.warnings.push(`${unpricedRequests} 次请求有未定价部分；美元仅含可定价用量。`);
        if (estimatedRequests)
            coverage.warnings.push(`${estimatedRequests} 次请求的缓存写入时长未完整覆盖，未知部分按 5 分钟价格估算。`);
        if (coverage.cacheErrors) coverage.warnings.push('用量缓存写入失败，仍显示已读取的统计。');
        const result = [...rows.values()].sort((left, right) => right.date.localeCompare(left.date)
            || left.model.localeCompare(right.model));
        for (const row of result) row.usd = Number(row.usd.toFixed(12));
        const [weekly, ...weeklyHistory] = weeklyPeriods.map(period =>
        {
            if (!period) return null;
            const rows = [...period.rows.values()].sort((left, right) => left.model.localeCompare(right.model));
            for (const row of rows)
            {
                row.baseUsd = Number(row.baseUsd.toFixed(12));
                row.usd = Number(row.usd.toFixed(12));
            }
            return { ...period.window, rows };
        });
        progress('complete', coverage, processedFiles);
        const report = { generatedAt, timezone: 'Asia/Shanghai', from, to, rows: result, coverage,
            pricing: { ...Pricing }, weekly, weeklyHistory };
        return { report, weeklyOrganizationId: weeklyWindows?.organizationId };
    }

    function scanWithContext()
    {
        const operation = pending.then(scanSources);
        pending = operation.catch(() => {});
        return operation;
    }

    return {
        async scan() { return (await scanWithContext()).report; },
        scanWithContext,
        async dispose()
        {
            disposed = true;
            for (const stream of activeStreams) stream.destroy();
            await pending;
            memory.clear();
        },
    };
}

module.exports = { createCollector };
