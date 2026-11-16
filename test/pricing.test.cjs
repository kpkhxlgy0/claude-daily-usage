'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { priceRequest, Pricing } = require('../src/pricing.cjs');

function request(model, changes = {})
{
    return { model, inputTokens: 4000000, uncachedInputTokens: 1000000, cachedInputTokens: 1000000,
        cacheWriteTokens: 2000000, cacheWrite5mTokens: 1000000, cacheWrite1hTokens: 1000000,
        outputTokens: 1000000, usageComplete: true, ...changes };
}

test('prices native cache writes separately from ordinary input and reads', () =>
{
    assert.deepEqual(priceRequest(request('claude-fable-5-2')),
        { usd: 74.2, unpriced: false, uncachedInputTokens: 1000000, reasons: [] });
    assert.equal(priceRequest(request('claude-opus-5-5')).usd, 37.2);
    assert.equal(priceRequest(request('claude-sonnet-5-5')).usd, 18.6);
    assert.equal(priceRequest(request('claude-sonnet-5')).usd, 18.7);
    assert.equal(Pricing.asOf, '2026-11-17');
    assert.equal(Pricing.basis, 'standard');
});

test('recognizes only verified exact model IDs and historical aliases', () =>
{
    assert.equal(priceRequest(request('claude-haiku-4-5-20251001')).usd, 9.35);
    assert.equal(priceRequest(request('claude-haiku-4-5')).usd, 9.35);
    for (const model of ['claude-opus-5-5-future', 'opus', 'claude-haiku-4-5-20990101', 'unknown'])
    {
        const result = priceRequest(request(model));
        assert.equal(result.usd, 0);
        assert.deepEqual(result.reasons, ['unknown-model']);
        assert.equal(result.unpriced, true);
    }
});

test('Haiku5.5 threshold counts all input including cache reads and writes', () =>
{
    assert.equal(priceRequest(request('claude-haiku-5-5', { inputTokens: 100000,
        uncachedInputTokens: 10000, cachedInputTokens: 90000, cacheWriteTokens: 0,
        cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, outputTokens: 1000000 })).usd, 0.5019);
    assert.equal(priceRequest(request('claude-haiku-5-5', { inputTokens: 100001,
        uncachedInputTokens: 10001, cachedInputTokens: 90000, cacheWriteTokens: 0,
        cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, outputTokens: 1000000 })).usd, 2.5095005);
});

test('keeps known subtotal with an explicit coverage gap for unknown write TTL or missing usage', () =>
{
    const result = priceRequest(request('claude-sonnet-5-5',
        { cacheWrite5mTokens: null, cacheWrite1hTokens: null }));
    assert.equal(result.usd, 12.1);
    assert.equal(result.unpriced, true);
    assert.deepEqual(result.reasons, ['cache-write-ttl']);
    assert.equal(priceRequest(request('claude-sonnet-5-5', { usageComplete: false })).unpriced, true);
    assert.deepEqual(priceRequest(request('claude-sonnet-5-5', { inputTokens: -1 })).reasons,
        ['invalid-usage']);
});
