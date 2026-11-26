'use strict';

const Pricing = Object.freeze({ basis: 'claude-client-estimate', asOf: '2026-11-17',
    source: 'https://platform.claude.com/docs/en/about-claude/pricing' });
const Million = 1000000;
const HaikuLongContextInput = 100000;
const Rates = new Map([
    ['claude-fable-5-2', [8, 40, 0.2]],
    ['claude-mythos-5-2', [8, 40, 0.2]],
    ['claude-fable-5-1', [10, 50, 0.25]],
    ['claude-mythos-5-1', [10, 50, 0.25]],
    ['claude-fable-5', [10, 50, 1]],
    ['claude-mythos-5', [10, 50, 1]],
    ['claude-opus-5-5', [4, 20, 0.2]],
    ['claude-opus-5', [5, 25, 0.5]],
    ['claude-opus-4-8', [5, 25, 0.5]],
    ['claude-opus-4-7', [5, 25, 0.5]],
    ['claude-opus-4-6', [5, 25, 0.5]],
    ['claude-opus-4-5', [5, 25, 0.5]],
    ['claude-opus-4-5-20251101', [5, 25, 0.5]],
    ['claude-sonnet-5-5', [2, 10, 0.1]],
    ['claude-sonnet-5', [2, 10, 0.2]],
    ['claude-sonnet-4-6', [3, 15, 0.3]],
    ['claude-sonnet-4-5', [3, 15, 0.3]],
    ['claude-sonnet-4-5-20250929', [3, 15, 0.3]],
    ['claude-haiku-5-5', [0.1, 0.5, 0.01]],
    ['claude-haiku-4-5', [1, 5, 0.1]],
    ['claude-haiku-4-5-20251001', [1, 5, 0.1]],
]);

function validTokens(value)
{
    return Number.isSafeInteger(value) && value >= 0;
}

function priceRequest({ model, inputTokens, uncachedInputTokens, cachedInputTokens = 0,
    cacheWriteTokens = 0, cacheWrite5mTokens, cacheWrite1hTokens, cacheWriteTtlInvalid = false,
    outputTokens, usageComplete = true } = {}, { baseRates = false } = {})
{
    if (![inputTokens, uncachedInputTokens, cachedInputTokens, cacheWriteTokens, outputTokens].every(validTokens)
        || inputTokens !== uncachedInputTokens + cachedInputTokens + cacheWriteTokens)
    {
        return { usd: 0, unpriced: true, estimated: false, uncachedInputTokens: 0, reasons: ['invalid-usage'] };
    }
    const reasons = [];
    const rate = Rates.get(model);
    if (!rate) return { usd: 0, unpriced: true, estimated: false, uncachedInputTokens, reasons: ['unknown-model'] };
    let [inputRate, outputRate, cachedRate] = rate;
    if (!baseRates && model === 'claude-haiku-5-5' && inputTokens > HaikuLongContextInput)
    {
        inputRate *= 5;
        outputRate *= 5;
        cachedRate *= 5;
    }
    let subtotal = uncachedInputTokens * inputRate + cachedInputTokens * cachedRate + outputTokens * outputRate;
    let estimated = false;
    const write5m = cacheWrite5mTokens ?? 0;
    const write1h = cacheWrite1hTokens ?? 0;
    if (cacheWriteTtlInvalid || !validTokens(write5m) || !validTokens(write1h)
        || write5m + write1h > cacheWriteTokens)
    {
        reasons.push('cache-write-ttl');
    }
    else
    {
        subtotal += inputRate * ((cacheWriteTokens - write1h) * 1.25 + write1h * 2);
        estimated = write5m + write1h < cacheWriteTokens;
    }
    if (!usageComplete) reasons.push('incomplete-usage');
    return { usd: Number((subtotal / Million).toFixed(12)), unpriced: reasons.length > 0, estimated,
        uncachedInputTokens, reasons };
}

module.exports = { priceRequest, Pricing, validTokens };
