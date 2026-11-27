'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const os = require('node:os');
const { startMain } = require('../src/main.cjs');

const Prefix = 'claudepp:com.kpk.daily-usage:';
const RequestId = '11111111-1111-4111-8111-111111111111';
function deferred()
{
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}
function frame(url = 'app://localhost/settings')
{
    const replies = [];
    const senderFrame = { url, send: (...args) => replies.push(args) };
    const sender = new EventEmitter();
    sender.mainFrame = senderFrame;
    sender.window = new EventEmitter();
    return { senderFrame, sender, replies };
}
function fixture(t, remoteAdapter, dependencies = {})
{
    const ipcMain = new EventEmitter();
    const handlers = new Map();
    ipcMain.handle = (channel, handler) => handlers.set(channel, handler);
    ipcMain.removeHandler = channel => handlers.delete(channel);
    const queries = [];
    let disposed = 0;
    let serviceOptions;
    const service = { ready: Promise.resolve(), query({ signal, organizationId, resetSession })
    {
        const pending = deferred();
        queries.push({ signal, organizationId, resetSession, ...pending });
        return pending.promise;
    }, dispose() { disposed++; } };
    const api = { manifest: { id: 'com.kpk.daily-usage' }, fs: { dataDir: '/owned/data' },
        log: { info() {} }, ipc: { handle() { throw new Error('SDK query timeout must be bypassed'); } } };
    const main = startMain(api, { ipcMain, serviceFactory: options => { serviceOptions = options; return service; },
        BrowserWindow: { fromWebContents: sender => sender.window }, remoteAdapter, claudeData: '/desktop/user-data', ...dependencies });
    t.after(() => main.stop());
    const send = (name, event, payload) => ipcMain.emit(Prefix + name, event, payload);
    const invoke = (name, event, payload) => handlers.get(Prefix + name)(event, payload);
    return { main, ipcMain, handlers, serviceOptions, queries, send, invoke, get disposed() { return disposed; } };
}
const flush = () => new Promise(resolve => setImmediate(resolve));

test('startup registers event queries but does no scan or remote work', async t =>
{
    let remoteCalls = 0;
    const f = fixture(t, { getHosts() { remoteCalls++; return []; }, discover() { remoteCalls++; } });
    await flush();
    assert.equal(f.queries.length, 0);
    assert.equal(remoteCalls, 0);
    assert.equal(f.handlers.has(Prefix + 'query'), false);
    assert.equal(f.ipcMain.listenerCount(Prefix + 'query'), 1);
    assert.equal(f.serviceOptions.claudeHome, process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'));
    assert.equal(f.serviceOptions.claudeData, '/desktop/user-data');
    assert.equal(f.serviceOptions.dataDir, '/owned/data');
    const hosts = await f.invoke('hosts', frame());
    assert.equal(hosts.length, 1);
    assert.equal(hosts[0].hostId, 'local');
    assert.equal(hosts[0].label, '本机');
});

test('pending queries use pushed replies and retain ownership until completion', async t =>
{
    const f = fixture(t);
    const owner = frame('https://claude.ai/code/session_example');
    f.send('query', owner, { hostId: 'local', requestId: RequestId });
    await flush();
    assert.equal(f.queries.length, 1);
    assert.equal(owner.replies.length, 0);
    const result = { status: 'ok', snapshot: { revision: 1 } };
    f.queries[0].resolve(result);
    await flush();
    assert.deepEqual(owner.replies, [[Prefix + 'query-result', { requestId: RequestId, result }]]);
    assert.equal(owner.sender.listenerCount('destroyed'), 0);
    assert.equal(owner.sender.window.listenerCount('hide'), 0);
});

test('subframes, untrusted origins and malformed payloads cannot start queries', async t =>
{
    const f = fixture(t);
    const allowed = frame();
    const badEvents = [null, {}, { sender: allowed.sender },
        { sender: allowed.sender, senderFrame: { ...allowed.senderFrame } },
        ...['http://claude.ai', 'https://claude.ai.evil.test', 'https://claude.ai:444',
            'https://user:password@claude.ai', 'app://localhost:123', 'app://localhost.evil.test',
            'app://user:password@localhost', 'file:///settings'].map(url => frame(url))];
    for (const event of badEvents)
    {
        f.send('query', event, { hostId: 'local', requestId: RequestId });
        assert.equal(await f.invoke('hosts', event), null);
        assert.equal(await f.invoke('discover', event), null);
    }
    for (const payload of [null, [], { hostId: 'local', requestId: 'bad' },
        { hostId: '../host\n', requestId: RequestId }, { hostId: 'local', requestId: RequestId, extra: 'private' }])
        f.send('query', allowed, payload);
    await flush();
    assert.equal(f.queries.length, 0);
});

test('same request ID belongs independently to each frame and duplicate sends do not steal it', async t =>
{
    const f = fixture(t);
    const one = frame();
    const two = frame();
    const request = { hostId: 'local', requestId: RequestId };
    f.send('query', one, request);
    f.send('query', one, request);
    f.send('query', two, request);
    await flush();
    assert.equal(f.queries.length, 2);
    f.send('cancel', one, { requestId: RequestId });
    assert.equal(f.queries[0].signal.aborted, true);
    assert.equal(f.queries[1].signal.aborted, false);
    assert.equal(one.replies.length, 0);
    f.queries[0].resolve({ status: 'ok' });
    f.queries[1].resolve({ status: 'ok' });
    await flush();
    assert.equal(one.replies[0][1].result.error, 'cancelled');
    assert.equal(two.replies[0][1].result.status, 'ok');
});

for (const eventName of ['hide', 'minimize', 'closed', 'destroyed', 'render-process-gone', 'did-start-navigation'])
    test(`${eventName} aborts frame-owned requests and stop removes owned handlers`, async t =>
    {
        const f = fixture(t);
        const owner = frame();
        f.send('query', owner, { hostId: 'local', requestId: RequestId });
        await flush();
        const target = ['hide', 'minimize', 'closed'].includes(eventName) ? owner.sender.window : owner.sender;
        target.emit(eventName, {}, 'https://claude.ai/next', false, true);
        assert.equal(f.queries[0].signal.aborted, true);
        await f.main.stop();
        assert.equal(f.disposed, 1);
        assert.equal(f.handlers.size, 0);
        assert.equal(f.ipcMain.listenerCount(Prefix + 'query'), 0);
        assert.equal(f.ipcMain.listenerCount(Prefix + 'cancel'), 0);
        assert.equal(owner.sender.listenerCount('destroyed'), 0);
        f.queries[0].resolve({ status: 'ok' });
        await flush();
        assert.equal(owner.replies.length, 0);
    });

test('navigation races and replaced main frames suppress late replies', async t =>
{
    const f = fixture(t);
    for (const replace of [owner => { owner.senderFrame.url = 'https://claude.ai/other'; },
        owner => { owner.sender.mainFrame = { url: owner.senderFrame.url }; }])
    {
        const owner = frame();
        f.send('query', owner, { hostId: 'local', requestId: RequestId });
        await flush();
        replace(owner);
        f.queries.at(-1).resolve({ status: 'ok' });
        await flush();
        assert.equal(owner.replies.length, 0);
    }
});

test('remote adapter receives only explicit discovery and owned requests; unknown transport stays unavailable', async t =>
{
    const calls = [];
    let disposed = 0;
    const candidates = [{ hostId: 'runner-1', label: 'Runner', raw: 'private' }];
    const remote = { getHosts: () => candidates,
        discover: async owner => { calls.push(['discover', owner]); },
        query: async (hostId, options) => { calls.push(['query', hostId, options]); return { status: 'ok' }; },
        dispose() { disposed++; } };
    const f = fixture(t, remote);
    const owner = frame();
    assert.deepEqual((await f.invoke('hosts', owner))[1], { hostId: 'runner-1', label: '远程' });
    candidates.push({ hostId: 'runner-1', label: 'Duplicate' }, { hostId: 'invalid\n', label: 'Invalid' });
    assert.equal((await f.invoke('hosts', owner))[1].label, '远程');
    candidates.push({ hostId: 'runner-2', label: 'Other' });
    assert.deepEqual(await f.invoke('hosts', owner), [{ hostId: 'local', label: '本机' },
        { hostId: 'runner-1', label: 'Runner' }, { hostId: 'runner-2', label: 'Other' }]);
    await f.invoke('discover', owner);
    f.send('query', owner, { hostId: 'runner-1', requestId: RequestId });
    await flush();
    assert.equal(f.queries.length, 0);
    assert.equal(calls[0][1], owner.senderFrame);
    assert.equal(calls[1][1], 'runner-1');
    assert.equal(calls[1][2].frame, owner.senderFrame);
    assert.equal(calls[1][2].signal.aborted, false);
    assert.equal(owner.replies[0][1].result.status, 'ok');
    await f.main.stop();
    assert.equal(disposed, 1);
    const local = fixture(t);
    const unknown = frame();
    local.send('query', unknown, { hostId: 'missing', requestId: RequestId });
    await flush();
    assert.equal(local.queries.length, 0);
    assert.equal(unknown.replies[0][1].result.status, 'unavailable');
});

test('stop before queued discovery prevents deferred remote work', async t =>
{
    let discoveries = 0;
    const f = fixture(t, { discover() { discoveries++; } });
    const pending = f.invoke('discover', frame());
    await f.main.stop();
    await pending;
    assert.equal(discoveries, 0);
});

test('host-name demand is cancellable per frame and never starts a collector', async t =>
{
    const calls = [];
    const f = fixture(t, { getHosts: () => [{ hostId: 'runner', label: '远程 · 工作电脑' }],
        refreshHostNames(owner, { signal })
        {
            const pending = deferred();
            calls.push({ owner, signal, ...pending });
            return pending.promise;
        } });
    const one = frame();
    const two = frame();
    await f.invoke('hosts', one);
    assert.equal(calls.length, 0, 'Legacy/cache-only list does no name lookup');
    const a = f.invoke('hosts', one, { requestId: RequestId });
    const b = f.invoke('hosts', two, { requestId: RequestId });
    await flush();
    assert.equal(calls.length, 2);
    assert.equal(f.queries.length, 0);
    f.send('cancel', one, { requestId: RequestId });
    assert.equal(calls[0].signal.aborted, true);
    assert.equal(calls[1].signal.aborted, false);
    calls[0].resolve(); calls[1].resolve();
    assert.equal(await a, null);
    assert.equal((await b)[1].label, '远程');
    assert.equal(two.sender.window.listenerCount('hide'), 0);
});

test('host-name requests reject malformed demand and stop on window hide', async t =>
{
    let active;
    const f = fixture(t, { getHosts: () => [], refreshHostNames(_frame, { signal })
    {
        const pending = deferred(); active = { signal, ...pending }; return pending.promise;
    } });
    const owner = frame();
    for (const payload of [{}, { requestId: 'bad' }, { requestId: RequestId, extra: true }])
        assert.equal(await f.invoke('hosts', owner, payload), null);
    assert.equal(active, undefined);
    const pending = f.invoke('hosts', owner, { requestId: RequestId });
    await flush();
    owner.sender.window.emit('hide');
    assert.equal(active.signal.aborted, true);
    active.resolve();
    assert.equal(await pending, null);
});

test('official reset requests use the trusted Electron session and fixed usage endpoint', async t =>
{
    const request = [];
    const resetAt = '2026-12-02T18:00:00.000Z';
    const options = {
        remoteAdapter: {},
        BrowserWindow: { fromWebContents: sender => sender.window, getAllWindows: () =>
            [{ webContents: frame('https://untrusted.example/').sender }, { webContents: remoteWindow.sender }] }
    };
    const remoteWindow = frame('https://claude.ai/settings/usage');
    remoteWindow.sender.session = { storagePath: '/desktop/user-data', async fetch(url, init)
    {
        request.push([url, init]);
        return new Response(JSON.stringify({ seven_day: { resets_at: resetAt, utilization: 14 },
            account: { private: 'ignore' } }), { headers: { 'Content-Type': 'application/json' } });
    } };
    const f = fixture(t, options.remoteAdapter, options);
    assert.equal(request.length, 0);
    const readResetAt = f.serviceOptions.readResetAt;
    assert.equal(typeof readResetAt, 'function');
    const org = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const signal = new AbortController().signal;
    const result = await readResetAt(org, { signal });
    assert.deepEqual(result, { resetAt: Date.parse(resetAt), usedPercent: 14 });
    assert.deepEqual(request, [[`https://claude.ai/api/organizations/${org}/usage`, {
        method: 'GET', credentials: 'include', redirect: 'error', cache: 'no-store', signal,
        headers: { Accept: 'application/json' },
    }]]);
    assert.equal(await readResetAt('../usage', { signal }), null);
    assert.equal(request.length, 1);
});

test('runner anchor acquisition skips ambiguous profiles and honors an owned matching session', async t =>
{
    const calls = [];
    const one = frame('https://claude.ai/settings/usage');
    const two = frame('https://claude.ai/code/session_other');
    for (const owner of [one, two])
    {
        owner.sender.session = { storagePath: '/desktop/user-data', async fetch()
        {
            calls.push(owner);
            return new Response(JSON.stringify({ seven_day: { resets_at: '2026-12-02T18:00:00.000Z' } }),
                { headers: { 'Content-Type': 'application/json' } });
        } };
    }
    const f = fixture(t, {}, { BrowserWindow: { getAllWindows: () =>
        [one, two].map(owner => ({ webContents: owner.sender })) } });
    const readResetAt = f.serviceOptions.readResetAt;
    const org = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    assert.equal(await readResetAt(org), null);
    assert.deepEqual(calls, []);
    assert.deepEqual(await readResetAt(org, { resetSession: two.sender.session }), {
        resetAt: Date.parse('2026-12-02T18:00:00.000Z'), usedPercent: null,
    });
    assert.deepEqual(calls, [two]);
});

test('a windowless runner reads from its own default persistent Electron profile', async t =>
{
    const dataPath = path.resolve(os.tmpdir(), 'daily-usage-test-profile');
    let profileChecks = 0;
    let requests = 0;
    const defaultSession = { storagePath: dataPath, async fetch()
    {
        requests++;
        return new Response(JSON.stringify({ seven_day: { resets_at: '2026-12-02T18:00:00.000Z', utilization: 12 } }),
            { headers: { 'Content-Type': 'application/json' } });
    } };
    const f = fixture(t, {}, { claudeData: dataPath, getDefaultSession()
    {
        profileChecks++;
        return defaultSession;
    } });
    assert.equal(profileChecks, 0);
    const org = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    assert.equal((await f.serviceOptions.readResetAt(org)).usedPercent, 12);
    defaultSession.storagePath = path.join(dataPath, 'other-profile');
    assert.equal(await f.serviceOptions.readResetAt(org), null);
    assert.equal(requests, 1);
});

test('local demand retains the verified native organization and refuses an unrelated Electron profile', async t =>
{
    const profile = path.resolve(os.tmpdir(), 'daily-usage-local-profile');
    const org = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const local = frame('https://claude.ai/epitaxy');
    local.sender.session = { storagePath: profile };
    local.senderFrame.executeJavaScript = async () => org;
    const unrelated = frame();
    unrelated.sender.session = { storagePath: path.join(profile, 'Partitions', 'other') };
    unrelated.senderFrame.executeJavaScript = async () => org;
    const f = fixture(t, {}, { claudeData: profile });
    f.send('query', local, { hostId: 'local', requestId: RequestId });
    f.send('query', unrelated, { hostId: 'local', requestId: RequestId });
    await flush();
    assert.deepEqual(f.queries.map(query => query.organizationId).sort(), [org, null].sort());
    assert.equal(f.queries.find(query => query.organizationId === org).resetSession, local.sender.session);
});

test('a local account change while a scan is pending redacts its weekly result', async t =>
{
    const profile = path.resolve(os.tmpdir(), 'daily-usage-switch-profile');
    const owner = frame('https://claude.ai/epitaxy');
    owner.sender.session = { storagePath: profile };
    let currentOrg = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    owner.senderFrame.executeJavaScript = async () => currentOrg;
    const f = fixture(t, {}, { claudeData: profile });
    f.send('query', owner, { hostId: 'local', requestId: RequestId });
    await flush();
    currentOrg = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    f.queries[0].resolve({ status: 'ok', snapshot: { rows: [{ requests: 1, usd: 0.01 }], weekly: { private: true },
        weeklyHistory: [], weeklyRemainder: { earlier: { requests: 0, usd: 0 }, unassigned: { requests: 0, usd: 0 } } } });
    await flush();
    const result = owner.replies[0][1].result;
    assert.equal(result.status, 'ok');
    assert.equal(result.weeklyStatus, 'organization-unverified');
    assert.equal(result.snapshot.weekly, null);
    assert.deepEqual(result.snapshot.weeklyRemainder.unassigned, { requests: 1, usd: 0.01 });
});
