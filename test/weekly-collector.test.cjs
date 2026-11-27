'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createCollector } = require('../src/collector.cjs');
const { createService } = require('../src/service.cjs');

const Start = Date.parse('2026-11-25T18:00:00Z');
const Hour = 60 * 60 * 1000;
const Week = 168 * Hour;
const Sonnet = 'claude-sonnet-5-5';
const Haiku = 'claude-haiku-5-5';
const OrgA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OrgB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const at = hour => Start + hour * Hour;

function response(id, hour, model = Sonnet, usage = {})
{
    return { type: 'assistant', timestamp: new Date(at(hour)).toISOString(),
        requestId: 'request-' + id, message: { role: 'assistant', id, model,
            usage: { input_tokens: 10, cache_read_input_tokens: 20, cache_creation_input_tokens: 30,
                cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 20 },
                output_tokens: 40, ...usage } } };
}

function sample(hour, percent, org = OrgA)
{
    return { t: at(hour), org, u: { sd: percent, fh: 100, so: 100 } };
}

function anchor(hour = 168, observedHour = 20, percent = 10)
{
    return { resetAt: at(hour), observedAt: at(observedHour), usedPercent: percent };
}

async function setup(t, { hour = 24, samples, responses = [] } = {})
{
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-weekly-test-'));
    const claudeHome = path.join(root, 'cli');
    const claudeData = path.join(root, 'desktop');
    const dataDir = path.join(root, 'tweak-data');
    const projects = path.join(claudeHome, 'projects');
    const history = path.join(claudeData, 'plan-usage-history.json');
    const collector = createCollector({ claudeHome, claudeData, cacheDir: path.join(dataDir, 'cache'),
        now: () => at(hour) });
    t.after(async () => { await collector.dispose(); await fs.rm(root, { recursive: true }); });
    await fs.mkdir(projects, { recursive: true });
    await fs.mkdir(claudeData);
    await fs.writeFile(path.join(projects, 'session.jsonl'), responses.map(JSON.stringify).join('\n') + '\n');
    if (samples) await fs.writeFile(history, JSON.stringify({ version: 2, samples }));
    return { claudeHome, claudeData, collector, history, dataDir };
}

const scan = async (collector, anchors = [anchor()], organizationId = OrgA) =>
    (await collector.scanWithContext({ organizationId, anchors })).report;
const requests = rows => rows.reduce((sum, row) => sum + row.requests, 0);

test('full weeks keep later replies and use exactly the daily Standard model cost', async t =>
{
    const first = response('first', 0);
    const { collector } = await setup(t, { samples: [sample(2, 40), sample(4, 100), sample(6, 100)],
        responses: [response('before', -0.25), first, first, response('exact-full', 4),
            response('after-full', 19, Haiku, {
                input_tokens: 100000, cache_creation: { ephemeral_1h_input_tokens: 20 },
            }), response('at-now', 24, 'new-model'), response('future-same-day', 24.25)] });
    const report = await scan(collector, [anchor(168, 20, 100)]);
    assert.deepEqual(report.weekly, { startAt: Start, resetAt: at(168), endAt: at(24), startKind: 'reset',
        sampleAt: at(20), fullAt: at(4), usedPercent: 100, partial: false, afterFull: { requests: 2, usd: 0.05012725 },
        rows: [
            { model: Haiku, requests: 1, usd: 0.05012725, unpricedRequests: 0, estimatedRequests: 1 },
            { model: Sonnet, requests: 2, usd: 0.001054, unpricedRequests: 0, estimatedRequests: 0 },
            { model: 'new-model', requests: 1, usd: 0, unpricedRequests: 1, estimatedRequests: 0 },
        ] });
    assert.equal(requests(report.rows), 5);
    assert.deepEqual(report.weeklyRemainder, { earlier: { requests: 0, usd: 0 },
        unassigned: { requests: 1, usd: 0.000527 } });
});

test('anchored cadence recovers the last three whole weeks across missing weekdays and marks an extra zero', async t =>
{
    const { collector } = await setup(t, { samples: [
        sample(-673, 98), sample(-671, 0), sample(-592, 26), sample(-475, 0), sample(-337, 34),
        sample(-327, 0), sample(-324, 13), sample(-323.75, 0), sample(-253, 18),
        sample(-152, 24), sample(-29, 67), sample(18, 3), sample(22, 14),
    ], responses: [
        response('earlier', -520), response('old-start', -504), response('near-end', -336.01),
        response('extra-zero-week-start', -336), response('outside-sample-days', -170),
        response('prior-week-start', -168), response('prior-week-end', -0.01), response('current', 0),
    ] });
    const report = await scan(collector);
    assert.deepEqual(report.weeklyHistory.map(week => [week.startAt, week.resetAt, week.endAt, week.startKind,
        week.partial, requests(week.rows)]), [-168, -336, -504].map((hour, index) =>
        [at(hour), at(hour) + Week, at(hour) + Week - 1, 'inferred', index === 1, 2]));
    assert.deepEqual(report.weeklyRemainder, { earlier: { requests: 1, usd: 0.000527 },
        unassigned: { requests: 0, usd: 0 } });
    assert.equal(requests(report.rows), 8);
});

test('a corroborated week without quota samples still accounts for requests', async t =>
{
    const { collector } = await setup(t, { samples: [
        sample(-337, 98), sample(-335, 0), sample(-169, 40), sample(2, 2),
    ], responses: [response('no-period-samples', -41)] });
    const report = await scan(collector);
    assert.deepEqual(report.weeklyHistory.map(week => [week.startAt, week.sampleAt, week.usedPercent, week.rows.length]),
        [[at(-168), null, null, 1], [at(-336), at(-169), 40, 0]]);
});

test('native percentages alone leave retained replies unassigned', async t =>
{
    const { collector } = await setup(t, { samples: [sample(-3, 90), sample(1, 0), sample(4, 20)],
        responses: [response('before', -0.25), response('after', 3)] });
    const report = await collector.scan();
    assert.equal(report.weekly, null);
    assert.deepEqual(report.weeklyHistory, []);
    assert.deepEqual(report.weeklyRemainder, { earlier: { requests: 0, usd: 0 },
        unassigned: { requests: 2, usd: 0.001054 } });
});

test('anchors from another organization and cycles crossing a switch leave replies unassigned', async t =>
{
    const { collector } = await setup(t, { samples: [sample(-30, 90), sample(1, 0, OrgB), sample(4, 20, OrgB)],
        responses: [response('old-org', 0), response('new-org', 3)] });
    for (const org of [OrgA, OrgB])
    {
        const report = await scan(collector, [anchor()], org);
        assert.equal(report.weekly, null);
        assert.deepEqual(report.weeklyHistory, []);
        assert.equal(report.weeklyRemainder.unassigned.requests, 2);
    }
});

test('an expired official anchor preserves the completed week but needs evidence to infer a current period', async t =>
{
    const { collector } = await setup(t, { hour: 172, samples: [sample(2, 20), sample(165, 60)],
        responses: [response('past', 167), response('unproven-current', 170)] });
    const report = await scan(collector);
    assert.equal(report.weekly, null);
    assert.equal(report.weeklyHistory[0]?.resetAt, at(168));
    assert.equal(report.weeklyHistory[0]?.endAt, at(168) - 1);
    assert.equal(report.weeklyHistory[0]?.rows[0]?.requests, 1);
    assert.equal(report.weeklyRemainder.unassigned.requests, 1);
});

test('a changed official cadence does not stretch previous history onto the new phase', async t =>
{
    const { collector } = await setup(t, { samples: [sample(-500, 12), sample(-170, 88), sample(-160, 3), sample(1, 8)],
        responses: [response('unsupported-period', -130), response('current', 5)] });
    const report = await scan(collector, [anchor(-160, -200, 75), anchor()]);
    assert.equal(report.weekly?.rows[0]?.requests, 1);
    assert.deepEqual(report.weeklyHistory, []);
    assert.equal(report.weeklyRemainder.unassigned.requests, 1);
});

test('missing or malformed native history leaves daily statistics available', async t =>
{
    const { collector, history } = await setup(t, { responses: [response('daily', 1)] });
    for (const contents of [null, '{broken', JSON.stringify({ version: 1, samples: [sample(0, 0)] }),
        JSON.stringify({ version: 2, samples: Array(20001).fill(sample(0, 0)) }),
        JSON.stringify({ version: 2, samples: [sample(0, 0)], padding: 'x'.repeat(4 * 1024 * 1024) })])
    {
        if (contents !== null) await fs.writeFile(history, contents);
        const report = await scan(collector);
        assert.equal(report.weekly, null);
        assert.equal(requests(report.rows), 1);
        assert.equal(report.weeklyRemainder.unassigned.requests, 1);
    }
});

test('runner first acquires its native organization anchor on demand, then reuses it offline', async t =>
{
    const settings = await setup(t, { samples: [sample(2, 5), sample(5, 11)],
        responses: [response('priced', 1)] });
    const calls = [];
    const options = { claudeHome: settings.claudeHome, claudeData: settings.claudeData, dataDir: settings.dataDir,
        now: () => at(24), readResetAt(organizationId, { signal })
        {
            calls.push({ organizationId, signal });
            return { resetAt: at(168), usedPercent: 13 };
        } };
    const online = createService(options);
    t.after(() => online.dispose());
    await online.ready;
    assert.equal(calls.length, 0);
    const state = await online.query({ organizationId: OrgA });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].organizationId, OrgA);
    assert.equal(state.status, 'ok', JSON.stringify(state));
    assert.equal(state.snapshot.schemaVersion, 4);
    assert.equal(state.snapshot.weekly?.usedPercent, 13);
    assert.equal(state.snapshot.weekly?.rows[0]?.requests, 1);
    await online.dispose();
    const offline = createService({ ...options, readResetAt() { throw new Error('offline'); } });
    t.after(() => offline.dispose());
    assert.deepEqual((await offline.query({ organizationId: OrgA })).snapshot.weekly, state.snapshot.weekly);
    const foreign = await offline.query({ organizationId: OrgB });
    assert.equal(foreign.snapshot.weekly, null);
    assert.deepEqual(foreign.snapshot.weeklyHistory, []);
    assert.deepEqual(foreign.snapshot.weeklyRemainder, { earlier: { requests: 0, usd: 0 },
        unassigned: { requests: 1, usd: 0.000527 } });
    const summary = await fs.readFile(path.join(settings.claudeHome, '.daily-usage', 'summary.json'), 'utf8');
    assert.equal(summary.includes(OrgA), false);
});

test('a foreign-only runner query cannot acquire an anchor for either organization', async t =>
{
    const options = await setup(t, { samples: [sample(2, 5)], responses: [response('known', 1)] });
    let calls = 0;
    const service = createService({ ...options, now: () => at(24), readResetAt() { calls++; } });
    t.after(() => service.dispose());
    const { status, snapshot } = await service.query({ organizationId: OrgB });
    assert.equal(status, 'ok');
    assert.equal(calls, 0);
    assert.equal(snapshot.weekly, null);
    assert.equal(snapshot.weeklyRemainder.unassigned.requests, 1);
});

test('a stalled usage request times out, then publishes daily usage with the timestamp unassigned', async t =>
{
    const options = await setup(t, { samples: [sample(2, 5)], responses: [response('priced', 1)] });
    let authSignal;
    const service = createService({ ...options, now: () => at(24), resetTimeoutMs: 25,
        readResetAt(_organizationId, { signal })
        {
            authSignal = signal;
            return new Promise(() => {});
        } });
    t.after(() => service.dispose());
    const { status, snapshot } = await service.query();
    assert.equal(authSignal?.aborted, true);
    assert.equal(status, 'ok');
    assert.equal(snapshot.weeklyRemainder.unassigned.requests, 1);
});

test('cancelling the last waiter cancels usage acquisition and discards a late reset anchor', async t =>
{
    const options = await setup(t, { samples: [sample(2, 5)], responses: [response('priced', 1)] });
    let signal;
    let finish;
    let started;
    const reading = new Promise(resolve => { started = resolve; });
    const service = createService({ ...options, now: () => at(24), readResetAt(_organizationId, context)
    {
        signal = context.signal;
        started();
        return new Promise(resolve => { finish = resolve; });
    } });
    t.after(() => service.dispose());
    const controller = new AbortController();
    const result = assert.rejects(service.query({ signal: controller.signal }), { name: 'AbortError' });
    await reading;
    controller.abort();
    await result;
    assert.equal(signal.aborted, true);
    finish({ resetAt: at(168), usedPercent: 13 });
    await service.dispose();
    const offline = createService({ ...options, now: () => at(24) });
    t.after(() => offline.dispose());
    const state = await offline.query();
    assert.equal(state.snapshot.weekly, null);
});

test('repeated acquisitions of the current reset preserve older phases and the first full sample', async t =>
{
    const options = await setup(t, { samples: [sample(-150, 15), sample(-30, 65), sample(5, 90)] });
    let hour = -140;
    let nextReset = 0;
    let percent = 15;
    const service = createService({ ...options, now: () => at(hour), readResetAt()
    {
        return { resetAt: at(nextReset), usedPercent: percent };
    } });
    t.after(() => service.dispose());
    await service.query();
    nextReset = 168;
    for (hour = 8, percent = 100; hour <= 17; hour++) await service.query();
    const { snapshot } = service.getState();
    assert.equal(snapshot.weekly?.fullAt, at(8));
    assert.equal(snapshot.weekly?.sampleAt, at(17));
    assert.equal(snapshot.weeklyHistory[0]?.resetAt, Start);
});

test('the scoped usage request stops when only a foreign subscriber remains', async t =>
{
    const options = await setup(t, { samples: [sample(2, 5)], responses: [response('priced', 1)] });
    let resetSignal;
    let started;
    const reading = new Promise(resolve => { started = resolve; });
    const service = createService({ ...options, now: () => at(24), readResetAt(_org, { signal })
    {
        resetSignal = signal;
        started();
        return new Promise(() => {});
    } });
    t.after(() => service.dispose());
    const controller = new AbortController();
    const matching = assert.rejects(service.query({ organizationId: OrgA, signal: controller.signal }),
        { name: 'AbortError' });
    const foreign = service.query({ organizationId: OrgB });
    await reading;
    controller.abort();
    await matching;
    assert.equal(resetSignal.aborted, true);
    assert.equal((await foreign).snapshot.weeklyRemainder.unassigned.requests, 1);
});

test('a confirmed next reset leaves the cycle inferred and partial if an internal reset is plausible', async t =>
{
    const { collector } = await setup(t, { samples: [sample(1, 0), sample(2, 13), sample(4, 0), sample(6, 2)],
        responses: [response('before-dip', 3), response('after-dip', 5)] });
    const { weekly } = await scan(collector);
    assert.equal(weekly.startAt, Start);
    assert.equal(weekly.resetAt, Start + Week);
    assert.equal(weekly.rows[0].requests, 2);
    assert.equal(weekly.startKind, 'inferred');
    assert.equal(weekly.partial, true);
});

test('CLI reads only saved anchors for the explicitly selected Desktop profile and organization', async t =>
{
    const options = await setup(t, { samples: [sample(2, 5)], responses: [response('priced', 1)] });
    const now = Date.now();
    const expected = now + Hour;
    await fs.writeFile(options.history, JSON.stringify({ version: 2, samples: [
        { ...sample(0, 5), t: now - Hour },
    ] }));
    const service = createService({ ...options, readResetAt() { return { resetAt: expected, usedPercent: 12 }; } });
    t.after(() => service.dispose());
    const online = await service.query();
    assert.equal(online.status, 'ok');
    assert.equal(online.snapshot.weekly?.resetAt, expected);
    await service.dispose();
    const script = path.join(__dirname, '..', 'scripts', 'report.cjs');
    const args = [script, '--home', options.claudeHome, '--cache', path.join(options.dataDir, 'cli-cache'),
        '--desktop-data', options.claudeData, '--data-dir', options.dataDir];
    const run = async () => JSON.parse((await promisify(execFile)(process.execPath, args)).stdout);
    assert.equal((await run()).weekly?.resetAt, expected);

    const other = path.join(path.dirname(options.claudeData), 'other');
    await fs.mkdir(other);
    await fs.copyFile(options.history, path.join(other, 'plan-usage-history.json'));
    args[args.indexOf('--desktop-data') + 1] = other;
    assert.equal((await run()).weekly, null);
    args[args.indexOf('--desktop-data') + 1] = options.claudeData;
    await fs.writeFile(options.history, JSON.stringify({ version: 2, samples: [
        { ...sample(0, 5, OrgB), t: now - Hour },
    ] }));
    assert.equal((await run()).weekly, null);
});

test('earlier totals never absorb requests from before the current organization', async t =>
{
    const { collector } = await setup(t, { samples: [
        sample(-580, 98, OrgB), sample(-530, 0), sample(-510, 92), sample(-500, 0), sample(-1, 70), sample(1, 3),
    ], responses: [response('prior-org', -540), response('earlier-same-org', -515), response('oldest-shown', -504)] });
    const report = await scan(collector);
    assert.equal(report.weeklyHistory[2]?.rows[0]?.requests, 1);
    assert.deepEqual(report.weeklyRemainder, { earlier: { requests: 1, usd: 0.000527 },
        unassigned: { requests: 1, usd: 0.000527 } });
});

test('verified local org changes neither reuse nor refresh the old native organization anchors', async t =>
{
    const options = await setup(t, { samples: [sample(2, 5)], responses: [response('priced', 1)] });
    const requested = [];
    const service = createService({ ...options, now: () => at(24), readResetAt(organizationId)
    {
        requested.push(organizationId);
        return { resetAt: at(168), usedPercent: 12 };
    } });
    t.after(() => service.dispose());
    assert.ok((await service.query({ organizationId: OrgA })).snapshot.weekly);
    const { snapshot, weeklyStatus } = await service.query({ organizationId: OrgB });
    assert.equal(weeklyStatus, 'organization-unverified');
    assert.equal(snapshot.weekly, null);
    assert.equal(snapshot.weeklyRemainder.unassigned.requests, 1);
    assert.deepEqual(requested, [OrgA]);
    assert.equal(service.getState().snapshot.weekly, null);
});

test('explicit authorization denial discards the saved reset unlike an offline failure', async t =>
{
    const options = await setup(t, { samples: [sample(2, 5)], responses: [response('priced', 1)] });
    let answer = { resetAt: at(168), usedPercent: 12 };
    const service = createService({ ...options, now: () => at(24), readResetAt() { return answer; } });
    t.after(() => service.dispose());
    assert.ok((await service.query({ organizationId: OrgA })).snapshot.weekly);
    answer = { accessDenied: true };
    const denied = await service.query({ organizationId: OrgA });
    assert.equal(denied.weeklyStatus, 'access-denied');
    assert.equal(denied.snapshot.weekly, null);
    answer = null;
    assert.equal((await service.query({ organizationId: OrgA })).snapshot.weekly, null);
});
