'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createLogParser, normalizeUsage } = require('../src/log-parser.cjs');

function row(changes = {})
{
    return { type: 'assistant', timestamp: '2026-11-16T16:00:00Z', requestId: 'req-1',
        message: { role: 'assistant', id: 'msg-1', model: 'claude-sonnet-5-5',
            content: [{ type: 'text', text: 'PRIVATE CHAT BODY' }], usage: { input_tokens: 2,
                cache_read_input_tokens: 3, cache_creation_input_tokens: 9, output_tokens: 7,
                cache_creation: { ephemeral_5m_input_tokens: 4, ephemeral_1h_input_tokens: 5 } } }, ...changes };
}

test('normalizes Claude ordinary input as exclusive of cache tokens', () =>
{
    const usage = normalizeUsage(row().message.usage);
    assert.equal(usage.inputTokens, 14);
    assert.equal(usage.uncachedInputTokens, 2);
    assert.equal(usage.cacheWrite5mTokens, 4);
    assert.equal(usage.cacheWrite1hTokens, 5);
    assert.equal(usage.usageComplete, true);
    assert.equal(normalizeUsage(null).usageComplete, false);
});

test('streams split UTF8 buffers, includes subagents and emits sanitized metadata only', () =>
{
    const parser = createLogParser({ sourceId: 'file-1' });
    const input = Buffer.from(JSON.stringify(row({ isSidechain: true, agentId: 'private-agent' })) + '\r\n');
    for (let offset = 0; offset < input.length; offset += 7) parser.onChunk(input.subarray(offset, offset + 7));
    const data = parser.finish();
    assert.equal(data.events.length, 1);
    assert.equal(data.events[0].inputTokens, 14);
    assert.equal(data.events[0].timestamp, Date.parse('2026-11-16T16:00:00Z'));
    const serialized = JSON.stringify(data);
    for (const secret of ['PRIVATE CHAT BODY', 'private-agent', 'msg-1', 'req-1', 'content'])
        assert.equal(serialized.includes(secret), false);
});

test('preserves hashed native fork provenance without storing raw session or row identities', () =>
{
    const parser = createLogParser({ sourceId: 'file-1' });
    const sourceSession = '11111111-1111-4111-8111-111111111111';
    const childSession = '22222222-2222-4222-8222-222222222222';
    parser.onChunk(Buffer.from(JSON.stringify(row({ sessionId: childSession, uuid: 'child-row',
        forkedFrom: { sessionId: sourceSession, messageUuid: 'source-row' } }))));
    const data = parser.finish();
    assert.equal(data.events[0].inherited, true);
    for (const field of ['sessionId', 'recordId', 'originSessionId', 'originRecordId'])
        assert.match(data.events[0][field], /^[a-f0-9]{64}$/);
    const serialized = JSON.stringify(data);
    for (const value of [sourceSession, childSession, 'child-row', 'source-row'])
        assert.equal(serialized.includes(value), false);
});

test('retains missing usage for coverage and excludes synthetic and user records', () =>
{
    const parser = createLogParser({ sourceId: 'file-1' });
    const missing = row();
    delete missing.message.usage;
    parser.onChunk(Buffer.from([missing, row({ isSynthetic: true }), row({ isApiErrorMessage: true }),
        { type: 'user', message: { role: 'user' } }].map(JSON.stringify).join('\n')));
    const data = parser.finish();
    assert.equal(data.events.length, 1);
    assert.equal(data.events[0].usageComplete, false);
});

test('recovers after malformed and oversize lines, including a truncated tail', () =>
{
    const parser = createLogParser({ sourceId: 'file-1' });
    parser.onChunk(Buffer.from('{bad}\n'));
    for (let index = 0; index < 17; index++) parser.onChunk(Buffer.alloc(65536, 120));
    parser.onChunk(Buffer.from('\n' + JSON.stringify(row()) + '\n{"type":'));
    const data = parser.finish();
    assert.equal(data.events.length, 1);
    assert.equal(data.oversizedRecords, 1);
    assert.equal(data.skippedRecords, 3);
});

test('missing IDs, invalid timestamps and invalid tokens are visible coverage gaps', () =>
{
    const parser = createLogParser({ sourceId: 'file-1' });
    const noId = row({ requestId: undefined });
    delete noId.message.id;
    const invalid = row();
    invalid.message.usage.output_tokens = -10;
    parser.onChunk(Buffer.from([noId, row({ timestamp: 'bad' }), invalid].map(JSON.stringify).join('\n')));
    const data = parser.finish();
    assert.equal(data.skippedRecords, 2);
    assert.equal(data.events.length, 1);
    assert.equal(data.events[0].usageComplete, false);
    assert.equal(data.events[0].outputTokens, null);
});
