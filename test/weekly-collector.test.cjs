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

const Start = Date.parse('2026-11-20T06:00:00Z');
const Hour = 60 * 60 * 1000;
const Week = 168 * Hour;
const Sonnet = 'claude-sonnet-5-5';
const Haiku = 'claude-haiku-5-5';
const OrgA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OrgB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function response(id, hour, model = Sonnet, usage = {})
{
    return { type: 'assistant', timestamp: new Date(Start + hour * Hour).toISOString(),
        requestId: 'request-' + id, message: { role: 'assistant', id, model,
            usage: { input_tokens: 10, cache_read_input_tokens: 20, cache_creation_input_tokens: 30,
                cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 20 },
                output_tokens: 40, ...usage } } };
}

function sample(hour, percent, org = OrgA)
{
    return { t: Start + hour * Hour, org, u: { sd: percent, fh: 100, so: 100 } };
}

async function setup(t, { hour = 8, samples, responses = [] } = {})
{
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-weekly-test-'));
    const claudeHome = path.join(root, 'cli');
    const claudeData = path.join(root, 'desktop');
    const projects = path.join(claudeHome, 'projects');
    const history = path.join(claudeData, 'plan-usage-history.json');
    const collector = createCollector({ claudeHome, claudeData, cacheDir: path.join(root, 'cache'),
        now: () => Start + hour * Hour });
    t.after(async () => { await collector.dispose(); await fs.rm(root, { recursive: true }); });
    await fs.mkdir(projects, { recursive: true });
    await fs.mkdir(claudeData);
    await fs.writeFile(path.join(projects, 'session.jsonl'), responses.map(JSON.stringify).join('\n') + '\n');
    if (samples) await fs.writeFile(history, JSON.stringify({ version: 2, samples }));
    return { root, claudeHome, claudeData, collector, history };
}

test('unfinished weekly rows include local replies through generatedAt, separately from daily rows', async t =>
{
    const first = response('first', 0);
    const { collector } = await setup(t, { samples: [sample(0, 3), sample(3, 20)], responses: [
        response('before', -0.25), first, first, response('after-sample', 5, Haiku, {
            input_tokens: 100000, cache_creation: { ephemeral_1h_input_tokens: 20 },
        }), response('inclusive-end', 8, 'new-model'), response('future', 8.25),
    ] });
    const report = await collector.scan();
    assert.deepEqual(report.weekly, { startAt: Start, startKind: 'observed', sampleAt: Start + 3 * Hour,
        fullAt: null, usedPercent: 20, rows: [
            { model: Haiku, requests: 1, baseUsd: 0.01002545, usd: 0.05012725,
                unpricedRequests: 0, estimatedRequests: 1 },
            { model: Sonnet, requests: 1, baseUsd: 0.000527, usd: 0.000527,
                unpricedRequests: 0, estimatedRequests: 0 },
            { model: 'new-model', requests: 1, baseUsd: 0, usd: 0, unpricedRequests: 1, estimatedRequests: 0 },
        ] });
    assert.equal(report.rows.find(row => row.model === Sonnet).requests, 3);
});

test('a full weekly window ends inclusively at the first observed 100 percent', async t =>
{
    const { collector } = await setup(t, { samples: [sample(0, 0), sample(2, 80), sample(4, 100), sample(6, 100)],
        responses: [response('within', 3), response('inclusive', 4), response('over', 4.25),
            response('after-repeat', 7)] });
    assert.deepEqual((await collector.scan()).weekly, { startAt: Start, startKind: 'observed',
        sampleAt: Start + 6 * Hour, fullAt: Start + 4 * Hour, usedPercent: 100, rows: [
            { model: Sonnet, requests: 2, baseUsd: 0.001054, usd: 0.001054,
                unpricedRequests: 0, estimatedRequests: 0 },
        ] });
});

test('the next observed period excludes replies from the preceding full period', async t =>
{
    const { collector } = await setup(t, { samples: [
        sample(-162, 0), sample(-3, 100), sample(0, 0), sample(1, 0), sample(0.5, 100), sample(3, 5),
    ], responses: [response('previous', -4), response('new', 0.25), response('another', 4)] });
    const weekly = (await collector.scan()).weekly;
    assert.equal(weekly.startAt, Start);
    assert.equal(weekly.startKind, 'observed');
    assert.equal(weekly.fullAt, null);
    assert.equal(weekly.usedPercent, 5);
    assert.equal(weekly.rows[0].requests, 2);
});

test('three completed cycles use separate request ranges through each trusted cutoff', async t =>
{
    const { collector } = await setup(t, { samples: [
        sample(-610, 4), sample(-465, 72), sample(-460, 0), sample(-459, 1), sample(-354, 100), sample(-315, 100),
        sample(-300, 0), sample(-299, 2), sample(-170, 80), sample(-155, 0), sample(-154, 3), sample(-8, 60),
        sample(0, 0), sample(2, 8),
    ], responses: [response('too-old', -465), response('old-start', -460), response('first-full', -354),
        response('after-full', -353), response('middle-start', -300), response('newer-start', -155),
        response('safe-end', -8), response('uncertain', -7), response('newer-start', 0), response('current', 0)] });
    const { report, weeklyOrganizationId } = await collector.scanWithContext();
    assert.equal(weeklyOrganizationId, OrgA);
    assert.deepEqual(report.weeklyHistory.map(week => [week.startAt, week.sampleAt, week.endAt, week.fullAt,
        week.usedPercent, week.partial, week.rows[0].requests]), [
        [Start - 155 * Hour, Start - 8 * Hour, Start - 8 * Hour, null, 60, true, 2],
        [Start - 300 * Hour, Start - 170 * Hour, Start - 170 * Hour, null, 80, true, 1],
        [Start - 460 * Hour, Start - 315 * Hour, Start - 315 * Hour, Start - 354 * Hour, 100, true, 2],
    ]);
    assert.equal(report.weekly.rows[0].requests, 1);
    assert.equal(report.rows.reduce((sum, row) => sum + row.requests, 0), 9);
});

test('an expired cycle does not absorb observations from an unconfirmed intervening cycle', async t =>
{
    const { collector } = await setup(t, { samples: [
        sample(-470, 2), sample(-340, 80), sample(-330, 0), sample(-329, 3), sample(-175, 40),
        sample(-148, 42), sample(-15, 90), sample(-3, 0), sample(-2, 1),
    ], responses: [response('old-safe', -175), response('old-uncertain', -174.5), response('intervening', -148),
        response('current-start', -3)] });
    const { weekly, weeklyHistory } = await collector.scan();
    assert.equal(weekly?.startAt, Start - 3 * Hour);
    assert.equal(weeklyHistory[0], null);
    assert.equal(weeklyHistory[1].startAt, Start - 330 * Hour);
    assert.equal(weeklyHistory[1].endAt, Start - 175 * Hour);
    assert.equal(weeklyHistory[1].usedPercent, 40);
    assert.equal(weeklyHistory[1].rows[0].requests, 1);
});

test('an extended sampling gap leaves the prior slot unassigned', async t =>
{
    const { collector } = await setup(t, { samples: [
        sample(-480, 10), sample(-350, 80), sample(-332, 0), sample(-331, 2), sample(-200, 100),
        sample(0, 10), sample(2, 12),
    ], responses: [response('before-gap', -201), response('within-gap', -20), response('current', 0)] });
    const { weekly, weeklyHistory } = await collector.scan();
    assert.equal(weekly?.startAt, Start);
    assert.equal(weekly.rows[0].requests, 1);
    assert.deepEqual(weeklyHistory, [null]);
});

test('overlapping expiry bounds leave an uncertain history position empty', async t =>
{
    const { collector } = await setup(t, { samples: [
        sample(-320, 2), sample(-180, 80), sample(-160, 0), sample(-159, 2), sample(-20, 45),
        sample(0, 60), sample(1, 0), sample(2, 5),
    ] });
    const { weekly, weeklyHistory } = await collector.scan();
    assert.equal(weekly?.startAt, Start + Hour);
    assert.deepEqual(weeklyHistory, [null]);
});

test('definitely elapsed weeks shift confirmed periods into their proven historical slots', async t =>
{
    const samples = [sample(-320, 2), sample(-175, 75), sample(-168, 0), sample(-167, 5), sample(-8, 60),
        sample(0, 0), sample(2, 7), sample(120, 100), sample(149, 100), sample(165, 100)];
    const responses = [response('at-full', 120), response('after-full', 121), response('late-sample', 165),
        response('past-retention', -800), response('past-retention', 119), response('future', 600)];
    for (const [hour, index] of [[170, 0], [340, 1], [510, 2]])
    {
        const { collector } = await setup(t, { hour, samples, responses });
        const { report, weeklyOrganizationId } = await collector.scanWithContext();
        assert.equal(report.weekly, null);
        assert.equal(weeklyOrganizationId, OrgA);
        const starts = [Start, Start - Week, Start - 320 * Hour];
        assert.deepEqual(report.weeklyHistory.map(week => week?.startAt ?? null),
            [...Array(index).fill(null), ...starts.slice(0, 3 - index)]);
        const week = report.weeklyHistory[index];
        assert.equal(week.sampleAt, Start + 149 * Hour);
        assert.equal(week.endAt, Start + 149 * Hour);
        assert.equal(week.fullAt, Start + 120 * Hour);
        assert.equal(week.rows[0].requests, 1);
        assert.equal(report.rows.reduce((sum, row) => sum + row.requests, 0), 3);
    }
});

test('queries between possible expiry times leave historical positions unassigned', async t =>
{
    const samples = [sample(-140, 2), sample(-8, 60), sample(0, 0), sample(2, 7), sample(120, 30), sample(162, 35)];
    for (const hour of [164, 332])
    {
        const { collector } = await setup(t, { hour, samples });
        const { report, weeklyOrganizationId } = await collector.scanWithContext();
        assert.equal(report.weekly, null);
        assert.equal(report.weeklyHistory.some(Boolean), false);
        assert.equal(weeklyOrganizationId, undefined);
    }
});

test('a pending drop within the expiry bounds preserves already proven historical positions', async t =>
{
    const { collector } = await setup(t, { hour: 170, samples: [
        sample(-140, 2), sample(-8, 60), sample(0, 0), sample(2, 7), sample(120, 30), sample(166, 0),
    ], responses: [response('old-safe', 120), response('pending-drop', 166)] });
    const { report, weeklyOrganizationId } = await collector.scanWithContext();
    assert.equal(report.weekly, null);
    assert.equal(weeklyOrganizationId, OrgA);
    assert.deepEqual(report.weeklyHistory.map(week => week.startAt), [Start, Start - 140 * Hour]);
    assert.equal(report.weeklyHistory[0].usedPercent, 30);
    assert.equal(report.weeklyHistory[0].endAt, Start + 120 * Hour);
    assert.equal(report.weeklyHistory[0].rows[0].requests, 1);
    assert.equal(report.rows.reduce((sum, row) => sum + row.requests, 0), 2);
});

test('a pending drop leaves positions empty when the reset count may change', async t =>
{
    for (const [hour, dropAt] of [[170, 159], [170, 169], [164, 162], [332, 166]])
    {
        const { collector } = await setup(t, { hour, samples: [
            sample(-140, 2), sample(-8, 60), sample(0, 0), sample(2, 7), sample(120, 30), sample(dropAt, 0),
        ] });
        const { weekly, weeklyHistory } = await collector.scan();
        assert.equal(weekly, null);
        assert.equal(weeklyHistory.some(Boolean), false);
    }
});

test('elapsed time alone cannot place an unbounded post-gap window', async t =>
{
    const { collector } = await setup(t, { hour: 170, samples: [sample(-200, 85), sample(0, 40), sample(2, 60)] });
    const { weekly, weeklyHistory } = await collector.scan();
    assert.equal(weekly, null);
    assert.equal(weeklyHistory.some(Boolean), false);
});

test('a second confirmed dip in the same low band does not create an extra quota cycle', async t =>
{
    const { collector } = await setup(t, { samples: [
        sample(-520, 2), sample(-470, 60), sample(-270, 0), sample(-130, 35), sample(-120, 10),
        sample(-119.5, 10), sample(-116, 0), sample(-115, 0), sample(-50, 45), sample(0, 0), sample(2, 7),
    ] });
    const { weekly, weeklyHistory } = await collector.scan();
    assert.equal(weekly?.startAt, Start);
    assert.deepEqual(weeklyHistory.map(week => week?.startAt ?? null), [Start - 116 * Hour,
        Start - 270 * Hour, null]);
    assert.equal(weeklyHistory[1].usedPercent, 35);
    assert.equal(weeklyHistory[1].endAt, Start - 130 * Hour);
});

test('same-organization history is available with an unavailable current percentage', async t =>
{
    const { collector } = await setup(t, { samples: [
        sample(-144, 5), sample(-8, 70), sample(0, 0), sample(2, 7), sample(4, undefined),
    ] });
    const { report, weeklyOrganizationId } = await collector.scanWithContext();
    assert.equal(report.weekly, null);
    assert.equal(report.weeklyHistory.length, 1);
    assert.equal(report.weeklyHistory[0].usedPercent, 70);
    assert.equal(weeklyOrganizationId, OrgA);
});

test('a switch to a different organization drops the former organization’s completed cycles', async t =>
{
    const { collector } = await setup(t, { samples: [
        sample(-460, 10), sample(-335, 70), sample(-320, 0), sample(-319, 5), sample(-158, 75),
        sample(-155, 2, OrgB), sample(-154, 3, OrgB), sample(-5, 20, OrgB),
        sample(0, 0, OrgB), sample(2, 4, OrgB),
    ] });
    const { report, weeklyOrganizationId } = await collector.scanWithContext();
    assert.equal(report.weekly, null);
    assert.deepEqual(report.weeklyHistory.map(week => week?.startAt ?? null), [Start - 155 * Hour]);
    assert.equal(weeklyOrganizationId, OrgB);
});

test('an isolated drop followed by recovery preserves the original first 100 percent sample', async t =>
{
    const { collector } = await setup(t, { samples: [
        sample(0, 0), sample(2, 95), sample(3, 100), sample(4, 5), sample(4, 5),
        sample(5, 100), sample(6, 0), sample(6, 0), sample(7, 100),
    ] });
    const weekly = (await collector.scan()).weekly;
    assert.equal(weekly.startAt, Start);
    assert.equal(weekly.fullAt, Start + 3 * Hour);
    assert.equal(weekly.sampleAt, Start + 7 * Hour);
});

test('a lone possible reset after full usage cannot report that old full window as current', async t =>
{
    for (const percent of [0, 5])
    {
        const { collector } = await setup(t, { samples: [sample(0, 0), sample(5, 100),
            sample(7, percent), sample(7, percent)] });
        assert.equal((await collector.scan()).weekly, null);
    }
});

test('confirmed nonzero low samples after a steep drop start a new observed week', async t =>
{
    for (const [peak, first, latest] of [[100, 5, 8], [81, 3, 7]])
    {
        const { collector } = await setup(t, { samples: [
            sample(-166, 2), sample(-24, peak), sample(-2, peak), sample(0, first), sample(2, latest),
        ], responses: [response('previous-window', -1), response('observed-boundary', 0), response('later', 3)] });
        const weekly = (await collector.scan()).weekly;
        assert.equal(weekly?.startAt, Start);
        assert.equal(weekly.startKind, 'observed');
        assert.equal(weekly.fullAt, null);
        assert.equal(weekly.usedPercent, latest);
        assert.equal(weekly.rows[0].requests, 2);
    }
});

test('a small downward fluctuation with a follow-up cannot establish a new week', async t =>
{
    const { collector } = await setup(t, { samples: [sample(0, 0), sample(1, 100), sample(2, 88), sample(3, 90)] });
    assert.equal((await collector.scan()).weekly, null);
});

test('after the latest possible expiry, two lower readings start the next observed period even above half', async t =>
{
    const { collector } = await setup(t, { hour: 173, samples: [
        sample(0, 0), sample(150, 100), sample(165, 100), sample(168, 60), sample(170, 65),
    ], responses: [response('old', 167), response('new', 168)] });
    const weekly = (await collector.scan()).weekly;
    assert.equal(weekly?.startAt, Start + Week);
    assert.equal(weekly.startKind, 'observed');
    assert.equal(weekly.fullAt, null);
    assert.equal(weekly.usedPercent, 65);
    assert.equal(weekly.rows[0].requests, 1);
});

test('a pre-expiry outlier does not establish the first sample of the recovered period', async t =>
{
    const { collector } = await setup(t, { hour: 173, samples: [
        sample(0, 0), sample(150, 100), sample(166, 45), sample(168, 60), sample(171, 65),
    ] });
    assert.equal((await collector.scan()).weekly?.startAt, Start + Week);
});

test('a recovered period does not inherit a stale cutoff from a much older peak sample', async t =>
{
    const { collector } = await setup(t, { hour: 173, samples: [
        sample(0, 0), sample(3, 100), sample(166, 80), sample(168, 60), sample(171, 65),
    ] });
    assert.equal((await collector.scan()).weekly?.startAt, Start + Week);
});

test('separated low observations do not corroborate each other across an intervening high sample', async t =>
{
    const { collector } = await setup(t, { samples: [
        sample(0, 0), sample(1, 100), sample(2, 5), sample(3, 70), sample(4, 8),
    ] });
    assert.equal((await collector.scan()).weekly, null);
});

test('a known reset gap cannot carry an old 100 percent result into the next possible week', async t =>
{
    const samples = [sample(-170, 80), sample(-165, 90), sample(-159, 0), sample(-158, 1),
        sample(-80, 100), sample(2, 100)];
    const earlier = await setup(t, { samples, hour: 2 });
    const later = await setup(t, { samples, hour: 5 });
    assert.equal((await earlier.collector.scan()).weekly?.fullAt, Start - 80 * Hour);
    assert.equal((await later.collector.scan()).weekly, null);
});

test('a week without a sample discards the old range and starts from the new observation', async t =>
{
    const { collector } = await setup(t, { samples: [
        sample(-180, 1), sample(-170, 100), sample(0, 10), sample(3, 20),
    ], responses: [response('unknown-window', -0.5), response('observed', 1)] });
    const weekly = (await collector.scan()).weekly;
    assert.equal(weekly.startAt, Start);
    assert.equal(weekly.fullAt, null);
    assert.equal(weekly.rows[0].requests, 1);
});

test('repeated full or zero samples cannot keep an observed window current for a second week', async t =>
{
    for (const percent of [0, 100])
    {
        const { collector } = await setup(t, { hour: Week / Hour + 3,
            samples: [sample(0, 0), sample(2, percent), sample(80, percent), sample(168, percent)] });
        assert.equal((await collector.scan()).weekly, null);
    }
});

test('weekly range is unavailable when current history cannot attribute a single organization', async t =>
{
    const { collector } = await setup(t, { samples: [sample(0, 5), sample(1, undefined, 'another-organization'),
        sample(3, 40)] });
    assert.equal((await collector.scan()).weekly, null);
});

test('unsupported, missing or over-limit history leaves daily statistics available', async t =>
{
    const { collector, history } = await setup(t, { responses: [response('daily', 1)] });
    for (const contents of [null, '{broken', JSON.stringify({ version: 1, samples: [sample(0, 0)] }),
        JSON.stringify({ version: 2, samples: [sample(0, undefined)] }),
        JSON.stringify({ version: 2, samples: [sample(0, 100), sample(1, 100)] }),
        JSON.stringify({ version: 2, samples: Array(20001).fill(sample(0, 0)) }),
        JSON.stringify({ version: 2, samples: [sample(0, 0)], padding: 'x'.repeat(4 * 1024 * 1024) })])
    {
        if (contents !== null) await fs.writeFile(history, contents);
        const report = await collector.scan();
        assert.equal(report.weekly, null);
        assert.equal(report.rows[0].requests, 1);
    }
});

test('a real worker reads history from Desktop userData independently of CLI logs', async t =>
{
    const { root, claudeHome, claudeData, history } = await setup(t);
    const startAt = Date.now() - Hour;
    await fs.writeFile(history, JSON.stringify({ version: 2, samples: [
        { ...sample(0, 0), t: startAt }, { ...sample(0, 12), t: startAt + Hour / 2 },
    ] }));
    const service = createService({ claudeHome, claudeData, dataDir: path.join(root, 'worker-data') });
    t.after(() => service.dispose());
    const state = await service.query();
    assert.equal(state.status, 'ok', JSON.stringify(state));
    assert.deepEqual(state.snapshot.weekly, { startAt, startKind: 'observed', fullAt: null,
        sampleAt: startAt + Hour / 2, usedPercent: 12, rows: [] });
});

test('shared worker results scope weekly usage to the requesting organization without persisting its identity', async t =>
{
    const { root, claudeHome, claudeData, history } = await setup(t);
    const startAt = Date.now() - Hour;
    const live = response('local', 0);
    live.timestamp = new Date(startAt + 10000).toISOString();
    await fs.writeFile(path.join(claudeHome, 'projects', 'session.jsonl'), JSON.stringify(live) + '\n');
    await fs.writeFile(history, JSON.stringify({ version: 2, samples: [{ ...sample(0, 12), t: startAt }] }));
    const dataDir = path.join(root, 'worker-data');
    const service = createService({ claudeHome, claudeData, dataDir });
    t.after(() => service.dispose());
    const [local, matching, foreign] = await Promise.all([
        service.query(), service.query({ organizationId: OrgA.toUpperCase() }), service.query({ organizationId: OrgB }),
    ]);
    assert.equal(local.status, 'ok');
    assert.equal(local.snapshot.weekly?.usedPercent, 12);
    assert.equal(local.snapshot.rows[0].requests, 1);
    assert.deepEqual(matching.snapshot, local.snapshot);
    assert.deepEqual(foreign.snapshot, { ...local.snapshot, weekly: null });
    const saved = await fs.readFile(path.join(claudeHome, '.daily-usage', 'summary.json'), 'utf8');
    assert.deepEqual(JSON.parse(saved), local.snapshot);
    assert.equal(saved.includes(OrgA), false);
    assert.equal(saved.includes('weeklyOrganizationId'), false);
    await service.dispose();
    const restarted = createService({ claudeHome, claudeData, dataDir,
        workerFactory() { throw new Error('worker-unavailable'); } });
    t.after(() => restarted.dispose());
    const cached = await restarted.query({ organizationId: OrgA });
    assert.equal(cached.status, 'error');
    assert.deepEqual(cached.snapshot, { ...local.snapshot, weekly: null });
    assert.equal(restarted.getState().snapshot.weekly.usedPercent, 12);
});

test('report CLI accepts a separate explicit Desktop userData directory', async t =>
{
    const { root, claudeHome, claudeData, history } = await setup(t);
    const startAt = Date.now() - Hour;
    await fs.writeFile(history, JSON.stringify({ version: 2, samples: [{ ...sample(0, 12), t: startAt }] }));
    const script = path.join(__dirname, '..', 'scripts', 'report.cjs');
    const { stdout } = await promisify(execFile)(process.execPath, [script, '--home', claudeHome,
        '--cache', path.join(root, 'cli-cache'), '--desktop-data', claudeData]);
    assert.deepEqual(JSON.parse(stdout).weekly, { startAt, startKind: 'observed', fullAt: null,
        sampleAt: startAt, usedPercent: 12, rows: [] });
});
