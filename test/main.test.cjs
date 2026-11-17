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
function fixture(t, remoteAdapter)
{
    const ipcMain = new EventEmitter();
    const handlers = new Map();
    ipcMain.handle = (channel, handler) => handlers.set(channel, handler);
    ipcMain.removeHandler = channel => handlers.delete(channel);
    const queries = [];
    let disposed = 0;
    let serviceOptions;
    const service = { ready: Promise.resolve(), query({ signal })
    {
        const pending = deferred();
        queries.push({ signal, ...pending });
        return pending.promise;
    }, dispose() { disposed++; } };
    const api = { manifest: { id: 'com.kpk.daily-usage' }, fs: { dataDir: '/owned/data' },
        log: { info() {} }, ipc: { handle() { throw new Error('SDK query timeout must be bypassed'); } } };
    const main = startMain(api, { ipcMain, serviceFactory: options => { serviceOptions = options; return service; },
        BrowserWindow: { fromWebContents: sender => sender.window }, remoteAdapter });
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
    assert.equal(f.serviceOptions.dataDir, '/owned/data');
    const hosts = await f.invoke('hosts', frame());
    assert.equal(hosts.length, 1);
    assert.equal(hosts[0].hostId, 'local');
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
    const remote = { getHosts: () => [{ hostId: 'runner-1', label: 'Runner', raw: 'private' }],
        discover: async owner => { calls.push(['discover', owner]); },
        query: async (hostId, options) => { calls.push(['query', hostId, options]); return { status: 'ok' }; },
        dispose() { disposed++; } };
    const f = fixture(t, remote);
    const owner = frame();
    assert.deepEqual((await f.invoke('hosts', owner))[1], { hostId: 'runner-1', label: 'Runner' });
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
    assert.equal((await b)[1].label, '远程 · 工作电脑');
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
