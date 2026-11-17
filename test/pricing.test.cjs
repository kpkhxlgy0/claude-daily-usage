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
        { usd: 74.2, unpriced: false, estimated: false, uncachedInputTokens: 1000000, reasons: [] });
    assert.equal(priceRequest(request('claude-opus-5-5')).usd, 37.2);
    assert.equal(priceRequest(request('claude-sonnet-5-5')).usd, 18.6);
    assert.equal(priceRequest(request('claude-sonnet-5')).usd, 18.7);
    assert.equal(Pricing.asOf, '2026-11-17');
    assert.equal(Pricing.basis, 'claude-client-estimate');
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

test('missing TTL uses five-minute writes and flags an estimate without losing known subtotal', () =>
{
    const result = priceRequest(request('claude-sonnet-5-5',
        { cacheWrite5mTokens: null, cacheWrite1hTokens: null }));
    assert.equal(result.usd, 17.1);
    assert.equal(result.unpriced, false);
    assert.equal(result.estimated, true);
    assert.deepEqual(result.reasons, []);
    assert.equal(priceRequest(request('claude-sonnet-5-5', { usageComplete: false })).unpriced, true);
    assert.deepEqual(priceRequest(request('claude-sonnet-5-5', { inputTokens: -1 })).reasons,
        ['invalid-usage']);
});

function writes(changes = {})
{
    return request('claude-opus-5-5', { inputTokens: 1000, uncachedInputTokens: 0, cachedInputTokens: 0,
        cacheWriteTokens: 1000, cacheWrite5mTokens: undefined, cacheWrite1hTokens: undefined,
        outputTokens: 0, ...changes });
}

test('underfilled native Opus5.5 TTL data prices the remainder at five minutes', () =>
{
    const result = priceRequest(writes({ inputTokens: 4231, cacheWriteTokens: 4231,
        cacheWrite5mTokens: 2706, cacheWrite1hTokens: 0 }));
    assert.equal(result.usd, 0.021155);
    assert.equal(result.estimated, true);
    assert.equal(result.unpriced, false);
});

test('complete TTL coverage is exact even when the unused bucket is absent', () =>
{
    for (const [changes, usd] of [
        [{ cacheWrite5mTokens: 600, cacheWrite1hTokens: 400 }, 0.0062],
        [{ cacheWrite5mTokens: 1000 }, 0.005],
        [{ cacheWrite1hTokens: 1000 }, 0.008],
    ])
    {
        const result = priceRequest(writes(changes));
        assert.equal(result.usd, usd);
        assert.equal(result.estimated, false);
        assert.equal(result.unpriced, false);
    }
});

test('missing and underfilled TTL buckets retain only reported one-hour writes', () =>
{
    for (const [changes, usd] of [
        [{}, 0.005],
        [{ cacheWrite5mTokens: 600 }, 0.005],
        [{ cacheWrite1hTokens: 400 }, 0.0062],
        [{ cacheWrite5mTokens: 100, cacheWrite1hTokens: 400 }, 0.0062],
        [{ cacheWrite5mTokens: null, cacheWrite1hTokens: null }, 0.005],
    ])
    {
        const result = priceRequest(writes(changes));
        assert.equal(result.usd, usd);
        assert.equal(result.estimated, true);
        assert.equal(result.unpriced, false);
    }
});

test('malformed and overfilled TTL never become an estimate and retain other priced usage', () =>
{
    for (const changes of [
        { cacheWrite5mTokens: -1 }, { cacheWrite1hTokens: 0.5 }, { cacheWrite5mTokens: Infinity },
        { cacheWrite1hTokens: NaN }, { cacheWrite5mTokens: '600' }, { cacheWrite1hTokens: false },
        { cacheWrite5mTokens: 600, cacheWrite1hTokens: 401 }, { cacheWrite1hTokens: 1001 },
        { cacheWriteTtlInvalid: true },
    ])
    {
        const result = priceRequest(writes({ inputTokens: 1030, uncachedInputTokens: 10,
            cachedInputTokens: 20, outputTokens: 30, ...changes }));
        assert.equal(result.usd, 0.000644);
        assert.equal(result.unpriced, true);
        assert.equal(result.estimated, false);
        assert.deepEqual(result.reasons, ['cache-write-ttl']);
    }
    assert.equal(priceRequest(writes({ inputTokens: 0, cacheWriteTokens: 0, cacheWrite5mTokens: 1 })).unpriced,
        true);
    assert.equal(priceRequest(writes({ model: 'unknown' })).estimated, false);
});
