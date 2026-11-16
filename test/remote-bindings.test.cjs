'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { createRemoteBindings, bindingKey } = require('../src/remote-bindings.cjs');
const { createCliWorkspaceResolver } = require('../src/vendor/session-stats/cli-workspace.cjs');

const Account = '11111111-1111-4111-8111-111111111111';
const Org = '22222222-2222-4222-8222-222222222222';
const Local = 'local_33333333-3333-4333-8333-333333333333';
const Cli = '44444444-4444-4444-8444-444444444444';
const flush = () => new Promise(resolve => setImmediate(resolve));

async function fixture(t, temporaryRoot = os.tmpdir())
{
    // CI 的 TEMP 可能经过目录联接；生产身份检查要求规范目录，测试也使用真实路径。
    const root = await fs.realpath(await fs.mkdtemp(path.join(temporaryRoot, 'daily-usage-binding-')));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const claudeHome = path.join(root, 'home');
    const claudeData = path.join(root, 'desktop');
    const workspace = path.join(root, 'workspace');
    const organization = path.join(claudeData, 'claude-code-sessions', Account, Org);
    await Promise.all([fs.mkdir(path.join(claudeHome, 'sessions'), { recursive: true }),
        fs.mkdir(organization, { recursive: true }), fs.mkdir(workspace)]);
    const registry = path.join(claudeHome, 'sessions', '12345.json');
    const metadata = path.join(organization, Local + '.json');
    const row = { pid: 12345, sessionId: Cli, hostSessionId: Local, bridgeSessionId: 'session_fixture',
        accountId: Account, organizationId: Org, cwd: workspace, procStart: '123456789',
        pidDomain: 'win32:fixture', startedAt: 1, kind: 'cli', entrypoint: 'remote-control' };
    const record = { sessionId: Local, cliSessionId: Cli, bridgeSessionIds: ['cse_fixture'],
        cwd: workspace, remoteControlUserEnabled: true };
    await Promise.all([fs.writeFile(registry, JSON.stringify(row)), fs.writeFile(metadata, JSON.stringify(record))]);
    let processIdentity = { alive: true, procStart: row.procStart };
    const resolver = createCliWorkspaceResolver({ claudeHome, platform: 'win32', hostname: 'fixture',
        processCacheMs: 0, getProcessIdentities: async pids => new Map(pids.map(pid => [pid, processIdentity])) });
    const watches = new Map();
    const bindingSource = createRemoteBindings({ claudeHome, claudeData, resolveWorkspace: resolver,
        watch(directory, _options, callback)
        {
            const watcher = new EventEmitter();
            watcher.close = () => { if (watches.get(directory)?.watcher === watcher) watches.delete(directory); };
            watches.set(directory, { watcher, callback });
            return watcher;
        } });
    t.after(() => bindingSource.dispose());
    return { bindingSource, claudeHome, claudeData, registry, metadata, row, record, resolver, watches,
        process(value) { processIdentity = value; } };
}

test('active binding requires matching PID start, local CLI, bridge, account and organization', async t =>
{
    const f = await fixture(t);
    const found = await f.bindingSource.listActiveBindings();
    assert.equal(found.length, 1);
    assert.equal(found[0].bridgeSessionId, 'session_fixture');
    assert.equal(found[0].accountId, Account);
    assert.equal(found[0].organizationId, Org);
    assert.equal(typeof found[0].workspaceEvidence, 'string');
    f.process({ alive: true, procStart: 'reused-pid' });
    assert.deepEqual(await f.bindingSource.listActiveBindings(), []);
    f.process({ alive: true, procStart: f.row.procStart });
    await fs.writeFile(f.registry, JSON.stringify({ ...f.row, organizationId: Account }));
    f.resolver.clearCache();
    assert.deepEqual(await f.bindingSource.listActiveBindings(), []);
});

test('metadata archive and conflicting CLI identity exclude the receiver', async t =>
{
    const f = await fixture(t);
    assert.equal((await f.bindingSource.listActiveBindings()).length, 1);
    await fs.writeFile(f.metadata, JSON.stringify({ ...f.record, isArchived: true }));
    assert.deepEqual(await f.bindingSource.listActiveBindings(), []);
    await fs.writeFile(f.metadata, JSON.stringify({ ...f.record, cliSessionId: Account }));
    assert.deepEqual(await f.bindingSource.listActiveBindings(), []);
});

test('directory events coalesce, ignore owned home outputs, and dispose native watchers', async t =>
{
    const f = await fixture(t);
    await f.bindingSource.listActiveBindings();
    let changes = 0;
    const unsubscribe = f.bindingSource.subscribe(() => { changes++; });
    const home = f.watches.get(f.claudeHome);
    home.callback('change', '.daily-usage');
    await flush();
    assert.equal(changes, 0);
    home.callback('rename', 'sessions');
    home.callback('rename', 'sessions');
    f.watches.get(path.dirname(f.metadata)).callback('change', path.basename(f.metadata));
    await flush();
    assert.equal(changes, 1);
    unsubscribe();
    f.bindingSource.dispose();
    assert.equal(f.watches.size, 0);
    assert.deepEqual(await f.bindingSource.listActiveBindings(), []);
});

test('semantic binding key excludes irrelevant metadata timestamps', () =>
{
    const binding = { bridgeSessionId: 'session_fixture', organizationId: Org, accountId: Account,
        localSessionId: Local, cliSessionId: Cli, metadataFile: '/metadata', workspaceRoot: '/work',
        workspaceEvidence: 'verified' };
    assert.equal(bindingKey(binding), bindingKey({ ...binding, mtime: 999, lastAssistantUuid: Account }));
    assert.notEqual(bindingKey(binding), bindingKey({ ...binding, workspaceEvidence: 'new-pid' }));
});

test('temporary-root aliases are canonicalized before constructing verified binding fixtures', async t =>
{
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'daily-usage-binding-alias-')));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const target = path.join(root, 'target');
    const alias = path.join(root, 'alias');
    await fs.mkdir(target);
    await fs.symlink(target, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const f = await fixture(t, alias);
    assert.equal(f.claudeHome.startsWith(target + path.sep), true);
    assert.equal((await f.bindingSource.listActiveBindings()).length, 1);
});
