'use strict';

const { createHash } = require('node:crypto');
const { validTokens } = require('./pricing.cjs');

const MaxRecordBytes = 1024 * 1024;
const SessionPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UsageFields = ['uncachedInputTokens', 'cachedInputTokens', 'cacheWriteTokens', 'outputTokens',
    'cacheWrite5mTokens', 'cacheWrite1hTokens'];

function isRecord(value)
{
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function identifier(value)
{
    return typeof value === 'string' && value.length > 0 && value.length <= 256
        && /^[a-zA-Z0-9_.:+/-]+$/.test(value)
        ? createHash('sha256').update(value).digest('hex') : null;
}

function sessionIdentifier(value)
{
    return typeof value === 'string' && SessionPattern.test(value) ? identifier(value.toLowerCase()) : null;
}

function normalizeUsage(value)
{
    const usage = isRecord(value) ? value : {};
    const cache = isRecord(usage.cache_creation) ? usage.cache_creation : {};
    const count = value => validTokens(value) ? value : null;
    const result = { uncachedInputTokens: count(usage.input_tokens),
        cachedInputTokens: count(usage.cache_read_input_tokens),
        cacheWriteTokens: count(usage.cache_creation_input_tokens), outputTokens: count(usage.output_tokens),
        cacheWrite5mTokens: count(cache.ephemeral_5m_input_tokens),
        cacheWrite1hTokens: count(cache.ephemeral_1h_input_tokens) };
    result.usageComplete = UsageFields.slice(0, 4).every(key => result[key] !== null);
    const total = (result.uncachedInputTokens ?? 0) + (result.cachedInputTokens ?? 0)
        + (result.cacheWriteTokens ?? 0);
    result.inputTokens = validTokens(total) ? total : 0;
    if (!validTokens(total))
    {
        result.usageComplete = false;
        result.uncachedInputTokens = null;
        result.cachedInputTokens = null;
        result.cacheWriteTokens = null;
    }
    return result;
}

function createLogParser({ sourceId, minTimestamp = -Infinity } = {})
{
    const events = [];
    let skippedRecords = 0;
    let oversizedRecords = 0;
    let pieces = [];
    let size = 0;
    let discarding = false;
    let finished = false;

    function record(buffer)
    {
        if (!buffer.length || !buffer.toString('utf8').trim()) return;
        let value;
        try { value = JSON.parse(buffer.toString('utf8')); }
        catch { skippedRecords++; return; }
        if (!isRecord(value) || value.type !== 'assistant' || !isRecord(value.message)
            || value.message.role !== 'assistant' || value.isMeta || value.isCompactSummary
            || value.isSynthetic || value.isApiErrorMessage || value.message.model === '<synthetic>') return;
        const timestamp = typeof value.timestamp === 'string' ? Date.parse(value.timestamp) : NaN;
        const messageId = identifier(value.message.id);
        const requestId = identifier(value.requestId);
        if (!Number.isFinite(timestamp) || Math.abs(timestamp) >= 8.64e15 - 86400000 || (!messageId && !requestId))
        {
            skippedRecords++;
            return;
        }
        if (timestamp < minTimestamp) return;
        const rawModel = value.message.model;
        const model = typeof rawModel === 'string' && rawModel.length <= 128
            && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/.test(rawModel) ? rawModel : 'unknown';
        const inherited = Object.hasOwn(value, 'forkedFrom');
        const origin = inherited && isRecord(value.forkedFrom) ? value.forkedFrom : {};
        events.push({ messageId, requestId, timestamp, model, inherited,
            sessionId: sessionIdentifier(value.sessionId), recordId: identifier(value.uuid),
            originSessionId: sessionIdentifier(origin.sessionId), originRecordId: identifier(origin.messageUuid),
            ...normalizeUsage(value.message.usage) });
    }

    function segment(buffer, terminated)
    {
        if (!discarding)
        {
            if (size + buffer.length > MaxRecordBytes)
            {
                discarding = true;
                pieces = [];
                size = 0;
                skippedRecords++;
                oversizedRecords++;
            }
            else if (buffer.length)
            {
                pieces.push(buffer);
                size += buffer.length;
            }
        }
        if (!terminated) return;
        if (!discarding) record(pieces.length === 1 ? pieces[0] : Buffer.concat(pieces, size));
        pieces = [];
        size = 0;
        discarding = false;
    }

    return {
        onChunk(chunk)
        {
            if (finished) throw new Error('Usage parser already finished');
            if (!Buffer.isBuffer(chunk)) chunk = Buffer.from(chunk);
            let from = 0;
            while (from < chunk.length)
            {
                const end = chunk.indexOf(10, from);
                if (end < 0) { segment(chunk.subarray(from), false); break; }
                segment(chunk.subarray(from, end), true);
                from = end + 1;
            }
        },
        finish()
        {
            if (!finished) segment(Buffer.alloc(0), true);
            finished = true;
            return { sourceId, events, skippedRecords, oversizedRecords };
        },
    };
}

module.exports = { createLogParser, normalizeUsage, UsageFields };
