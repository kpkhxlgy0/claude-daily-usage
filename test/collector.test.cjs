'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createCollector } = require('../src/collector.cjs');

function response(id, changes = {})
{
    return { type: 'assistant', timestamp: '2026-11-17T02:00:00Z', requestId: 'request-' + id,
        message: { role: 'assistant', id, model: 'claude-sonnet-5-5',
            content: [{ type: 'text', text: 'PRIVATE-CONTENT' }], usage: { input_tokens: 10,
                cache_read_input_tokens: 20, cache_creation_input_tokens: 30, output_tokens: 40,
                cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 20 } } }, ...changes };
}

const SourceSession = '11111111-1111-4111-8111-111111111111';
const ChildSession = '22222222-2222-4222-8222-222222222222';
const NestedSession = '33333333-3333-4333-8333-333333333333';

function inheritedResponse(source, sessionId, uuid)
{
    return { ...source, sessionId, uuid, timestamp: '2026-11-17T02:00:00Z',
        forkedFrom: { sessionId: source.sessionId, messageUuid: source.uuid } };
}

async function setup(t)
{
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-daily-test-'));
    const claudeHome = path.join(root, 'claude');
    const cacheDir = path.join(root, 'cache');
    const projects = path.join(claudeHome, 'projects');
    await fs.mkdir(projects, { recursive: true });
    const collector = createCollector({ claudeHome, cacheDir, now: () => Date.parse('2026-11-17T04:00:00Z') });
    t.after(async () => { await collector.dispose(); await fs.rm(root, { recursive: true, force: true }); });
    return { root, claudeHome, cacheDir, projects, collector,
        async write(file, rows)
        {
            const target = path.join(projects, file);
            await fs.mkdir(path.dirname(target), { recursive: true });
            await fs.writeFile(target, rows.map(JSON.stringify).join('\n') + '\n');
            return target;
        } };
}

test('does no startup work and globally deduplicates copied streamed responses including subagents', async t =>
{
    const fixture = await setup(t);
    await assert.rejects(fs.stat(fixture.cacheDir), { code: 'ENOENT' });
    const partial = response('msg-1');
    partial.message.usage.output_tokens = 4;
    const full = response('msg-1');
    await fixture.write('project/main.jsonl', [partial, full]);
    await fixture.write('project/fork/subagents/agent.jsonl', [full, response('msg-2', { isSidechain: true })]);
    const report = await fixture.collector.scan();
    assert.equal(report.rows.length, 1);
    assert.deepEqual(report.rows[0], { date: '2026-11-17', model: 'claude-sonnet-5-5', requests: 2,
        inputTokens: 120, uncachedInputTokens: 20, cachedInputTokens: 40, cacheWriteTokens: 60,
        outputTokens: 80, unpricedRequests: 0, estimatedRequests: 0, usd: 0.001054 });
    assert.equal(report.coverage.duplicateRequests, 2);
    assert.equal(report.coverage.conflictingRequests, 0);
    assert.equal(report.timezone, 'Asia/Shanghai');
    assert.equal(report.from, '2026-10-19');
    const files = await fs.readdir(path.join(fixture.cacheDir, 'usage-cache'));
    const cached = (await Promise.all(files.map(name => fs.readFile(path.join(fixture.cacheDir,
        'usage-cache', name), 'utf8')))).join('');
    for (const value of ['PRIVATE-CONTENT', fixture.projects, 'msg-1', 'request-msg-1'])
        assert.equal(cached.includes(value), false);
});

test('request aliases absorb fallback records but never merge distinct response IDs', async t =>
{
    const fixture = await setup(t);
    const fallback = response('fallback', { requestId: 'alias' });
    delete fallback.message.id;
    const first = response('one', { requestId: 'alias' });
    const second = response('two', { requestId: 'alias' });
    await fixture.write('a.jsonl', [fallback, first]);
    let report = await fixture.collector.scan();
    assert.equal(report.rows[0].requests, 1);
    await fixture.write('b.jsonl', [second]);
    report = await fixture.collector.scan();
    assert.equal(report.rows[0].requests, 2);
    assert.equal(report.coverage.ambiguousRequests, 1);
    assert.ok(report.coverage.warnings.length);
});

test('filters thirty Beijing calendar days after global response deduplication', async t =>
{
    const fixture = await setup(t);
    await fixture.write('dates.jsonl', [response('old', { timestamp: '2026-10-18T15:59:59Z' }),
        response('first', { timestamp: '2026-10-18T16:00:00Z' }),
        response('last', { timestamp: '2026-11-17T15:59:59Z' }),
        response('future', { timestamp: '2026-11-17T16:00:00Z' })]);
    const report = await fixture.collector.scan();
    assert.deepEqual(report.rows.map(row => [row.date, row.requests]), [['2026-11-17', 1], ['2026-10-19', 1]]);
});

test('unchanged files reuse disk cache and changed/deleted files refresh only on scan', async t =>
{
    const fixture = await setup(t);
    const file = await fixture.write('main.jsonl', [response('one')]);
    const first = await fixture.collector.scan();
    assert.equal(first.coverage.parsedFiles, 1);
    assert.equal((await fixture.collector.scan()).coverage.cachedFiles, 1);
    const other = createCollector({ claudeHome: fixture.claudeHome, cacheDir: fixture.cacheDir,
        now: () => Date.parse('2026-11-17T04:00:00Z') });
    t.after(() => other.dispose());
    assert.equal((await other.scan()).coverage.cachedFiles, 1);
    await fs.appendFile(file, JSON.stringify(response('two')) + '\n');
    const changed = await fixture.collector.scan();
    assert.equal(changed.rows[0].requests, 2);
    assert.equal(changed.coverage.parsedFiles, 1);
    await fs.unlink(file);
    assert.deepEqual((await fixture.collector.scan()).rows, []);
});

test('missing usage, inconsistent snapshots and unknown models preserve tokens and visible coverage gaps', async t =>
{
    const fixture = await setup(t);
    const missing = response('missing');
    delete missing.message.usage;
    const unknown = response('unknown');
    unknown.message.model = 'claude-future';
    const conflict = response('conflict');
    conflict.message.usage.input_tokens = 9;
    conflict.message.usage.output_tokens = 41;
    await fixture.write('main.jsonl', [response('conflict'), conflict, missing, unknown]);
    const report = await fixture.collector.scan();
    assert.equal(report.coverage.conflictingRequests, 1);
    assert.equal(report.coverage.incompleteRequests, 1);
    assert.equal(report.rows.reduce((sum, row) => sum + row.requests, 0), 3);
    assert.equal(report.rows.find(row => row.model === 'claude-future').unpricedRequests, 1);
    assert.ok(report.coverage.warnings.length >= 2);
});

test('ignores links, tolerates corrupt cache and malformed source records, and rejects disposed scans', async t =>
{
    const fixture = await setup(t);
    const file = await fixture.write('main.jsonl', [response('one')]);
    try { await fs.symlink(file, path.join(fixture.projects, 'linked.jsonl')); }
    catch (error) { if (!['EPERM', 'EACCES'].includes(error.code)) throw error; }
    await fs.appendFile(file, '{bad}\n');
    let report = await fixture.collector.scan();
    assert.equal(report.coverage.files, 1);
    assert.equal(report.coverage.skippedRecords, 1);
    const files = await fs.readdir(path.join(fixture.cacheDir, 'usage-cache'));
    await fs.writeFile(path.join(fixture.cacheDir, 'usage-cache', files[0]), 'broken');
    const other = createCollector({ claudeHome: fixture.claudeHome, cacheDir: fixture.cacheDir,
        now: () => Date.parse('2026-11-17T04:00:00Z') });
    t.after(() => other.dispose());
    report = await other.scan();
    assert.equal(report.coverage.parsedFiles, 1);
    assert.equal(report.rows[0].requests, 1);
    await other.dispose();
    await assert.rejects(other.scan(), { code: 'ERR_DAILY_USAGE_DISPOSED' });
});

test('unsafe aggregate totals leave other requests visible with an explicit coverage gap', async t =>
{
    const fixture = await setup(t);
    const huge = response('huge');
    huge.message.usage.input_tokens = Number.MAX_SAFE_INTEGER - 100;
    await fixture.write('main.jsonl', [huge, response('small'), response('another')]);
    const report = await fixture.collector.scan();
    assert.equal(report.rows[0].requests, 1);
    assert.equal(report.coverage.overflowRequests, 2);
    assert.ok(report.coverage.warnings.length);
    assert.equal(Number.isSafeInteger(report.rows[0].inputTokens), true);
});

test('a replay after the window starts cannot move an older billed response into the window', async t =>
{
    const fixture = await setup(t);
    await fixture.write('a.jsonl', [response('replay', { timestamp: '2026-10-18T15:59:59Z' })]);
    await fixture.write('b/subagents/agent.jsonl', [response('replay'), response('new')]);
    const report = await fixture.collector.scan();
    assert.equal(report.rows[0].requests, 1);
    assert.equal(report.coverage.duplicateRequests, 1);
});

test('conflicts wholly outside the displayed date range do not mark current requests incomplete', async t =>
{
    const fixture = await setup(t);
    const previous = response('old', { timestamp: '2026-10-18T15:59:59Z' });
    const conflict = response('old', { timestamp: '2026-10-18T15:59:59Z' });
    conflict.message.usage.input_tokens = 9;
    conflict.message.usage.output_tokens = 41;
    await fixture.write('main.jsonl', [previous, conflict, response('current')]);
    const report = await fixture.collector.scan();
    assert.equal(report.coverage.conflictingRequests, 0);
    assert.deepEqual(report.coverage.warnings, []);
});

test('deleting a fork ancestor cannot move inherited billing into today through a warm cache', async t =>
{
    const fixture = await setup(t);
    const source = response('inherited', { sessionId: SourceSession, uuid: 'source-response',
        timestamp: '2026-10-18T15:59:59Z' });
    const sourceFile = await fixture.write('source.jsonl', [source]);
    await fixture.write('child.jsonl', [inheritedResponse(source, ChildSession, 'child-response')]);
    const initial = await fixture.collector.scan();
    assert.deepEqual(initial.rows, []);
    assert.deepEqual(initial.coverage.warnings, []);
    await fs.unlink(sourceFile);
    const missing = await fixture.collector.scan();
    assert.equal(missing.coverage.cachedFiles, 1);
    assert.deepEqual(missing.rows, []);
    assert.equal(missing.coverage.unresolvedInheritedRequests, 1);
    assert.equal(missing.coverage.skippedRecords, 1);
    assert.ok(missing.coverage.warnings.length);
});

test('missing inherited timing leaves valid new post-fork requests visible and resolves when source returns', async t =>
{
    const fixture = await setup(t);
    const source = response('inherited', { sessionId: SourceSession, uuid: 'source-response',
        timestamp: '2026-10-18T15:59:59Z' });
    await fixture.write('child.jsonl', [inheritedResponse(source, ChildSession, 'child-response'),
        response('new-post-fork', { sessionId: ChildSession, uuid: 'new-response' })]);
    const missing = await fixture.collector.scan();
    assert.equal(missing.rows[0].requests, 1);
    assert.equal(missing.rows[0].usd, 0.000527);
    assert.equal(missing.coverage.unresolvedInheritedRequests, 1);
    await fixture.write('source.jsonl', [source]);
    const restored = await fixture.collector.scan();
    assert.equal(restored.rows[0].requests, 1);
    assert.equal(restored.coverage.unresolvedInheritedRequests, 0);
    assert.deepEqual(restored.coverage.warnings, []);
});

test('native nested forks use a present original date and never treat an intermediate copy as original', async t =>
{
    const fixture = await setup(t);
    const source = response('inherited', { sessionId: SourceSession, uuid: 'source-response',
        timestamp: '2026-11-10T02:00:00Z' });
    const child = inheritedResponse(source, ChildSession, 'child-response');
    const sourceFile = await fixture.write('source.jsonl', [source]);
    await fixture.write('child.jsonl', [child]);
    await fixture.write('nested.jsonl', [inheritedResponse(child, NestedSession, 'nested-response')]);
    const present = await fixture.collector.scan();
    assert.deepEqual(present.rows.map(row => [row.date, row.requests]), [['2026-11-10', 1]]);
    assert.equal(present.coverage.unresolvedInheritedRequests, 0);
    await fs.unlink(sourceFile);
    const missing = await fixture.collector.scan();
    assert.deepEqual(missing.rows, []);
    assert.equal(missing.coverage.unresolvedInheritedRequests, 1);
});

test('malformed fork provenance and caches predating provenance stay explicit timing gaps', async t =>
{
    const fixture = await setup(t);
    await fixture.write('child.jsonl', [response('inherited', { sessionId: ChildSession, uuid: 'child-response',
        forkedFrom: { sessionId: '../outside', messageUuid: 'source-response' } })]);
    await fixture.collector.scan();
    const directory = path.join(fixture.cacheDir, 'usage-cache');
    const [name] = await fs.readdir(directory);
    const filename = path.join(directory, name);
    const old = JSON.parse(await fs.readFile(filename, 'utf8'));
    old.schemaVersion = 1;
    for (const event of old.data.events)
    {
        for (const key of ['inherited', 'sessionId', 'recordId', 'originSessionId', 'originRecordId']) delete event[key];
    }
    await fs.writeFile(filename, JSON.stringify(old));
    const restarted = createCollector({ claudeHome: fixture.claudeHome, cacheDir: fixture.cacheDir,
        now: () => Date.parse('2026-11-17T04:00:00Z') });
    t.after(() => restarted.dispose());
    const report = await restarted.scan();
    assert.equal(report.coverage.parsedFiles, 1);
    assert.equal(report.coverage.cachedFiles, 0);
    assert.deepEqual(report.rows, []);
    assert.equal(report.coverage.unresolvedInheritedRequests, 1);
    assert.ok(report.coverage.warnings.length);
});

test('disposing during discovery prevents a source read and leaves no cache directory', async t =>
{
    const fixture = await setup(t);
    await fixture.write('main.jsonl', [response('one')]);
    let disposal;
    const collector = createCollector({ claudeHome: fixture.claudeHome, cacheDir: fixture.cacheDir,
        onProgress(value) { if (value.phase === 'scanning') disposal ||= collector.dispose(); } });
    await assert.rejects(collector.scan(), { code: 'ERR_DAILY_USAGE_DISPOSED' });
    await disposal;
    await assert.rejects(fs.stat(fixture.cacheDir), { code: 'ENOENT' });
});
