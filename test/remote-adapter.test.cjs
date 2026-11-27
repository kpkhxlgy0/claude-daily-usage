'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createRemoteAdapter } = require('../src/remote-adapter.cjs');
const { createTransport } = require('../src/remote-transport.cjs');
const { deflateSync } = require('node:zlib');
const p = require('../src/remote-protocol.cjs');

const Identity = { machineId: '11111111-1111-4111-8111-111111111111',
    publisherId: '22222222-2222-4222-8222-222222222222' };
const Binding = { bridgeSessionId: 'session_fixture', organizationId: '33333333-3333-4333-8333-333333333333',
    accountId: '44444444-4444-4444-8444-444444444444' };
const Time = Date.UTC(2026, 10, 17);
const V4Key = 'claudepp_daily_usage_capabilities_v4';
const hostId = binding => `${binding.organizationId}:${binding.bridgeSessionId}`;
const copy = value => JSON.parse(JSON.stringify(value));
function reordered(value)
{
    if (Array.isArray(value)) return value.map(reordered);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.keys(value).reverse().map(key => [key, reordered(value[key])]));
}
const flush = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate)
{
    for (let index = 0; index < 100; index++)
    {
        if (predicate()) return;
        await flush();
    }
    assert.fail('fixture did not reach expected state');
}
function deferred()
{
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
function snapshot(revision = 1)
{
    return { schemaVersion: 4, source: 'com.kpk.daily-usage', ...Identity, revision, generatedAt: Time,
        timezone: 'Asia/Shanghai', from: '2026-11-17', to: '2026-11-17', rows: [],
        coverage: { files: 1, failedFiles: 0, skippedRecords: 0, legacyRequests: 0, warnings: [] },
        weekly: null, weeklyHistory: [], weeklyRemainder: { earlier: { requests: 0, usd: 0 },
            unassigned: { requests: 0, usd: 0 } },
        pricing: { basis: 'claude-client-estimate', asOf: '2026-11-17', source: 'fixture' } };
}
function weeklySnapshot()
{
    const value = snapshot();
    value.rows = [{ date: value.to, model: 'claude-opus-4-8', requests: 2, inputTokens: 100,
        uncachedInputTokens: 100, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 10, usd: 0.8,
        unpricedRequests: 0, estimatedRequests: 0 }];
    value.weekly = { startAt: Time - 1000, resetAt: Time + 5000, endAt: Time, startKind: 'reset',
        fullAt: Time - 500, sampleAt: Time, usedPercent: 100, partial: false, afterFull: { requests: 1, usd: 0.3 },
        rows: [{ model: 'claude-opus-4-8', requests: 2, usd: 0.8, unpricedRequests: 0, estimatedRequests: 0 }] };
    value.weeklyHistory = [null, { startAt: Time - 7000, resetAt: Time - 2500, endAt: Time - 2501, startKind: 'inferred',
        fullAt: null, sampleAt: null, usedPercent: null, partial: true,
        afterFull: { requests: 0, usd: 0 }, rows: [] }];
    return value;
}

function hub()
{
    let metadata = { unrelated: { preserve: true } };
    const watchers = new Set();
    const calls = [];
    const held = [];
    let hold = false;
    let getHook;
    let patchHook;
    let notifyHook;
    let reorderReads = false;
    const streams = new Set();
    let sequence = 0;
    function emit(event)
    {
        for (const watcher of watchers) watcher.push(copy(event));
        const native = { sequence_num: ++sequence, payload: { type: 'control_response', response: {
            request_id: p.signalId(event.requestId, event.kind), subtype: event.ok ? 'success' : 'error',
            ...(event.ok ? { response: { mcpServers: [] } } : { error: 'unsupported' }) } } };
        for (const stream of streams)
            stream.enqueue(Buffer.from(`event: client_event\ndata: ${JSON.stringify(native)}\n\n`));
    }
    function transport(name)
    {
        const own = new Set();
        return {
            async get(binding, options)
            {
                calls.push({ name, kind: 'get', binding });
                if (getHook) await getHook(name, options, binding);
                if (options?.signal?.aborted) throw new Error('aborted');
                return { session: { id: binding.bridgeSessionId }, metadata: reorderReads
                    ? reordered(copy(metadata)) : copy(metadata) };
            },
            async patch(binding, operations, options)
            {
                calls.push({ name, kind: 'patch', operations: copy(operations), binding });
                if (options?.signal?.aborted) throw new Error('aborted');
                if (patchHook) await patchHook(name, operations, options);
                const candidate = copy(metadata);
                for (const op of operations)
                {
                    const key = op.path.slice(1);
                    if (op.op === 'test')
                    {
                        if (op.path === '') assert.deepEqual(candidate, op.value);
                        else { assert.ok(Object.hasOwn(candidate, key)); assert.deepEqual(candidate[key], op.value); }
                    }
                    else if (op.op === 'remove') { assert.ok(Object.hasOwn(candidate, key)); delete candidate[key]; }
                    else if (op.op === 'replace') { assert.ok(Object.hasOwn(candidate, key)); candidate[key] = op.value; }
                    else if (op.op === 'add') candidate[key] = op.value;
                    else assert.fail('unexpected operation');
                }
                metadata = candidate;
            },
            async watch(binding, { signal } = {})
            {
                calls.push({ name, kind: 'watch', binding });
                const queue = [];
                let waiter;
                let disposed = false;
                const watcher = {
                    name,
                    push(value) { if (disposed) return; if (waiter) { waiter.resolve(value); waiter = null; } else queue.push(value); },
                    next()
                    {
                        if (disposed) return Promise.reject(new Error('closed'));
                        if (queue.length) return Promise.resolve(queue.shift());
                        assert.equal(waiter, undefined);
                        waiter = deferred();
                        const promise = waiter.promise;
                        promise.finally(() => { waiter = undefined; }).catch(() => {});
                        return promise;
                    },
                    async dispose()
                    {
                        if (disposed) return;
                        disposed = true;
                        watchers.delete(watcher);
                        own.delete(watcher);
                        signal?.removeEventListener('abort', close);
                        waiter?.reject(new Error('closed'));
                    }
                };
                const close = () => { void watcher.dispose(); };
                signal?.addEventListener('abort', close, { once: true });
                watchers.add(watcher);
                own.add(watcher);
                return watcher;
            },
            async notify(binding, requestId, kind, options)
            {
                calls.push({ name, kind: 'notify', requestId, eventKind: kind, binding });
                if (options?.signal?.aborted) throw new Error('aborted');
                if (notifyHook) await notifyHook(name, kind, requestId);
                const event = { requestId, kind, ok: true };
                if (hold) held.push(event);
                else queueMicrotask(() => emit(event));
            },
            async dispose() { await Promise.all([...own].map(value => value.dispose())); }
        };
    }
    function fetch(name)
    {
        const raw = transport(name);
        return async (url, init) =>
        {
            const binding = { bridgeSessionId: new URL(url).pathname.split('/')[4],
                organizationId: init.headers['x-organization-uuid'],
                ...(init.headers['X-Expected-Account'] ? { accountId: init.headers['X-Expected-Account'] } : {}) };
            if (url.includes('/events/stream?'))
            {
                calls.push({ name, kind: 'stream' });
                let controller;
                const stream = new ReadableStream({ start(value) { controller = value; streams.add(value); },
                    cancel() { streams.delete(controller); } });
                return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
            }
            if (url.includes('/events?'))
            {
                calls.push({ name, kind: 'cursor' });
                return Response.json({ data: [], resume_cursor: sequence });
            }
            if (init.method === 'GET')
            {
                const detail = await raw.get(binding, { signal: init.signal });
                return Response.json({ session: { ...detail.session, environment_kind: 'bridge',
                    connection_status: 'connected', organization_uuid: Binding.organizationId,
                    account_id: Binding.accountId, client_metadata: detail.metadata } });
            }
            if (init.method === 'PUT')
            {
                try { await raw.patch(binding, JSON.parse(init.body).client_metadata_patch, { signal: init.signal }); }
                catch (error) { if (error.code === 'ERR_ASSERTION') return new Response('', { status: 409 }); throw error; }
                return Response.json({});
            }
            const payload = JSON.parse(init.body).events[0].payload;
            const event = p.parseSignalId(payload.request_id);
            assert.deepEqual(payload.request, { subtype: 'mcp_status' });
            await raw.notify(binding, event.requestId, event.kind, { signal: init.signal });
            return Response.json({});
        };
    }
    return { transport, fetch, calls, emit, held, get metadata() { return metadata; }, set metadata(value) { metadata = value; },
        hold(value) { hold = value; }, getHook(value) { getHook = value; },
        patchHook(value) { patchHook = value; },
        notifyHook(value) { notifyHook = value; },
        reorderReads(value) { reorderReads = value; },
        disconnect(name) { for (const watcher of watchers) if (watcher.name === name) void watcher.dispose(); },
        release() { for (const event of held.splice(0)) emit(event); }, get watchers() { return watchers; } };
}
function source(initial = [])
{
    let bindings = initial;
    const callbacks = new Set();
    return { async listActiveBindings() { return bindings; },
        subscribe(callback) { callbacks.add(callback); return () => callbacks.delete(callback); },
        change(value) { bindings = value; for (const callback of callbacks) callback(); }, dispose() {} };
}
function fixture(t, options = {})
{
    const network = hub();
    const queries = [];
    const localSource = source([Binding]);
    const service = { ready: Promise.resolve(), getIdentity: () => Identity,
        query({ signal })
        {
            const work = deferred();
            const item = { signal, ...work };
            queries.push(item);
            if (!options.ignoreCancellation) signal.addEventListener('abort', () =>
                work.reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
            return work.promise;
        } };
    const makeTransport = name => options.realTransport
        ? createTransport({ fetch: network.fetch(name), now: () => Time }) : network.transport(name);
    const runner = createRemoteAdapter({ service, transport: makeTransport('runner'), bindingSource: localSource,
        now: () => Time, frameBinding: frame => frame.binding, hostname: options.hostname || (() => 'Remote-PC') });
    const viewer = createRemoteAdapter({ service: { ...service, query() { assert.fail('viewer scan'); } },
        transport: makeTransport('viewer'), bindingSource: source(), now: () => Time,
        frameBinding: frame => frame.binding, nameCache: options.nameCache });
    const frame = { url: 'app://localhost/code/session_fixture', binding: Binding };
    t.after(async () => { await Promise.all([runner.dispose(), viewer.dispose()]); });
    return { network, queries, runner, viewer, frame, localSource };
}

test('viewer discovery is local only, remembers hosts across settings, and isolates frames', async t =>
{
    const network = hub();
    const viewer = createRemoteAdapter({ service: { ready: Promise.resolve(), getIdentity: () => Identity },
        transport: network.transport('viewer'), bindingSource: source(), frameBinding: frame => frame.binding });
    t.after(() => viewer.dispose());
    await viewer.ready;
    const frame = { url: 'app://localhost/code/session_fixture', binding: Binding };
    await viewer.discover(frame);
    frame.binding = { ...Binding, bridgeSessionId: 'session_second' };
    await viewer.discover(frame);
    frame.url = 'app://localhost/settings';
    frame.binding = null;
    await viewer.discover(frame);
    assert.equal(viewer.getHosts(frame).length, 2);
    assert.deepEqual(viewer.getHosts({}), []);
    await flush();
    assert.deepEqual(network.calls, []);
});

test('end-to-end demand watches before writes, lazily scans once, and has zero idle traffic', async t =>
{
    const f = fixture(t);
    await Promise.all([f.runner.ready, f.viewer.ready]);
    assert.equal(f.queries.length, 0);
    assert.equal(f.network.calls[0].kind, 'watch');
    const idle = f.network.calls.length;
    await flush(); await flush();
    assert.equal(f.network.calls.length, idle);
    await f.viewer.discover(f.frame);
    assert.equal(f.network.calls.length, idle);
    const request = f.viewer.query(hostId(Binding), { frame: f.frame });
    await until(() => f.queries.length === 1);
    assert.equal(f.network.calls.filter(value => value.name === 'runner' && value.kind === 'get').length, 2);
    f.queries[0].resolve({ status: 'ok', snapshot: snapshot() });
    const result = await request;
    assert.equal(result.status, 'ok', JSON.stringify(result));
    assert.deepEqual(result.snapshot, snapshot());
    assert.deepEqual(f.network.metadata.unrelated, { preserve: true });
    assert.deepEqual(Object.keys(f.network.metadata).sort(), ['unrelated', p.CapsKey, p.MachineKey, V4Key].sort());
    const calls = f.network.calls.filter(value => value.name === 'viewer');
    const watch = calls.findIndex(value => value.kind === 'watch');
    const write = calls.findIndex(value => value.kind === 'patch');
    assert.ok(watch < write);
    assert.equal(calls.filter(value => value.kind === 'get').length, 2);
    const final = f.network.calls.length;
    await flush(); await flush();
    assert.equal(f.network.calls.length, final);
});

test('a matching v4 remote transfers the entire week, split and history with the native transport', async t =>
{
    const f = fixture(t, { realTransport: true });
    await f.runner.ready;
    assert.deepEqual(f.network.metadata[V4Key], p.makeCapabilities(Identity));
    await f.viewer.discover(f.frame);
    const history = weeklySnapshot();
    const request = f.viewer.query(hostId(Binding), { frame: f.frame });
    await until(() => f.queries.length === 1);
    const marker = Object.values(f.network.metadata).find(value => value?.action === 'query');
    assert.equal(marker.snapshotVersion, 4);
    f.queries[0].resolve({ status: 'ok', snapshot: history });
    assert.deepEqual(await request, { status: 'ok', snapshot: history, progress: null });
    assert.equal(Object.hasOwn(f.network.metadata, p.requestKey(marker.requestId)), false);
    assert.equal(Object.hasOwn(f.network.metadata, p.resultKey(marker.requestId)), false);
});

test('the runner notifies the viewer promptly when a v4 report exceeds the transport limit', async t =>
{
    const { createHash } = require('node:crypto');
    const f = fixture(t, { realTransport: true });
    await f.runner.ready;
    await f.viewer.discover(f.frame);
    const request = f.viewer.query(hostId(Binding), { frame: f.frame });
    await until(() => f.queries.length === 1);
    const large = snapshot();
    large.rows = Array.from({ length: 2400 }, (_, i) => ({
        date: large.to, model: createHash('sha256').update(String(i)).digest('hex'), requests: 1,
        inputTokens: 2, uncachedInputTokens: 2, cachedInputTokens: 0, cacheWriteTokens: 0,
        outputTokens: 1, usd: 2, unpricedRequests: 0, estimatedRequests: 0
    }));
    large.weeklyRemainder.unassigned = { requests: 2400, usd: 4800 };
    f.queries[0].resolve({ status: 'ok', snapshot: large });
    const state = await request;
    assert.equal(state.status, 'unavailable');
    assert.equal(state.error, 'snapshot-too-large');
});

test('a legacy query receives an upgrade response without starting a collector', async t =>
{
    const f = fixture(t, { realTransport: true });
    const old = f.network.transport('old');
    await f.runner.ready;
    const watch = await old.watch(Binding);
    t.after(() => watch.dispose());
    for (const snapshotVersion of [undefined, 2, 3])
    {
        const { metadata } = await old.get(Binding);
        const id = p.createRequestId();
        const marker = p.makeMarker({ requestId: id, publisherId: Identity.publisherId,
            viewerId: Binding.accountId, binding: Binding, now: Time, snapshotVersion });
        await old.patch(Binding, [{ op: 'test', path: '', value: metadata },
            { op: 'add', path: '/' + p.requestKey(id), value: marker },
            { op: 'add', path: '/' + p.resultKey(id), value: null }]);
        await old.notify(Binding, id, 'query');
        assert.equal((await watch.next()).kind, 'query');
        assert.equal((await watch.next()).kind, 'result');
        const { metadata: returned } = await old.get(Binding);
        const response = returned[p.resultKey(id)];
        assert.equal(p.validateResult(response, { requestId: id, now: Time, ...Identity }).ok, true);
        assert.equal(response.error, 'snapshot-update-required');
        assert.equal(Object.hasOwn(response, 'data'), false);
    }
    assert.equal(f.queries.length, 0);
});

test('a new viewer rejects absent or foreign v4 advertisements before watching or writing', async t =>
{
    const f = fixture(t, { realTransport: true });
    await f.runner.ready;
    delete f.network.metadata[V4Key];
    f.network.metadata.claudepp_daily_usage_capabilities_v3 = p.makeCapabilities(Identity);
    await f.viewer.discover(f.frame);
    for (const advertisement of [undefined, p.makeCapabilities({ ...Identity, publisherId: Binding.accountId })])
    {
        if (advertisement) f.network.metadata[V4Key] = advertisement;
        const value = await f.viewer.query(hostId(Binding), { frame: f.frame });
        assert.equal(value.error, 'snapshot-update-required');
        assert.equal(value.snapshot, undefined);
    }
    assert.equal(f.queries.length, 0);
    assert.deepEqual(f.network.calls.filter(call => call.name === 'viewer').map(call => call.kind), ['get', 'get']);
});

test('POST acceptance retains result until delayed native signal and one viewer GET', async t =>
{
    const f = fixture(t);
    await f.runner.ready;
    await f.viewer.discover(f.frame);
    const request = f.viewer.query(hostId(Binding), { frame: f.frame });
    await until(() => f.queries.length === 1);
    f.network.hold(true);
    f.queries[0].resolve({ status: 'ok', snapshot: snapshot() });
    await until(() => f.network.held.some(value => value.kind === 'result'));
    const resultSignal = f.network.held.find(value => value.kind === 'result');
    assert.equal(f.network.metadata[p.resultKey(resultSignal.requestId)].status, 'ok');
    assert.equal(f.network.calls.filter(value => value.name === 'viewer' && value.kind === 'get').length, 1);
    await flush();
    assert.ok(f.network.metadata[p.resultKey(resultSignal.requestId)]);
    f.network.release();
    assert.equal((await request).status, 'ok');
});

test('cancel before query signal tombstones id and prevents late scan', async t =>
{
    const f = fixture(t);
    await f.runner.ready;
    await f.viewer.discover(f.frame);
    f.network.hold(true);
    const controller = new AbortController();
    const request = f.viewer.query(hostId(Binding), { frame: f.frame, signal: controller.signal });
    await until(() => f.network.held.some(value => value.kind === 'query'));
    const query = f.network.held.find(value => value.kind === 'query');
    controller.abort();
    assert.equal((await request).error, 'cancelled');
    f.network.emit({ ...query, kind: 'cancel' });
    await flush();
    f.network.emit(query);
    await flush(); await flush();
    assert.equal(f.queries.length, 0);
    assert.equal(Object.hasOwn(f.network.metadata, p.requestKey(query.requestId)), false);
});

test('cancellation while runner GET is pending cannot start computation', async t =>
{
    const f = fixture(t);
    await f.runner.ready;
    await f.viewer.discover(f.frame);
    const gate = deferred();
    f.network.getHook(name => name === 'runner' ? gate.promise : undefined);
    const controller = new AbortController();
    const request = f.viewer.query(hostId(Binding), { frame: f.frame, signal: controller.signal });
    await until(() => f.network.calls.filter(value => value.name === 'runner' && value.kind === 'get').length === 2);
    controller.abort();
    await request;
    await flush();
    gate.resolve();
    await flush(); await flush();
    assert.equal(f.queries.length, 0);
});

test('irrelevant binding events do not re-advertise or reconnect; removing binding cancels work', async t =>
{
    const f = fixture(t);
    await f.runner.ready;
    const initial = f.network.calls.length;
    f.localSource.change([{ ...Binding }]);
    await flush(); await flush();
    assert.equal(f.network.calls.length, initial);
    await f.viewer.discover(f.frame);
    const controller = new AbortController();
    const request = f.viewer.query(hostId(Binding), { frame: f.frame, signal: controller.signal });
    await until(() => f.queries.length === 1);
    f.localSource.change([]);
    await until(() => f.queries[0].signal.aborted);
    controller.abort();
    await request;
});

test('cached success remains host-isolated when capabilities or results fail', async t =>
{
    const f = fixture(t);
    await f.runner.ready;
    await f.viewer.discover(f.frame);
    const request = f.viewer.query(hostId(Binding), { frame: f.frame });
    await until(() => f.queries.length === 1);
    f.queries[0].resolve({ status: 'ok', snapshot: snapshot() });
    assert.equal((await request).status, 'ok');
    f.network.metadata = { unrelated: true };
    const failed = await f.viewer.query(hostId(Binding), { frame: f.frame });
    assert.equal(failed.status, 'stale');
    assert.deepEqual(failed.snapshot, snapshot());
    assert.equal((await f.viewer.query('other', { frame: f.frame })).snapshot, undefined);
});

test('actual transport and native SSE support concurrent viewers with one bounded reservation CAS retry', async t =>
{
    const f = fixture(t, { realTransport: true });
    await f.runner.ready;
    await f.viewer.discover(f.frame);
    const otherFrame = { ...f.frame };
    await f.viewer.discover(otherFrame);
    const firstController = new AbortController();
    const first = f.viewer.query(hostId(Binding), { frame: f.frame, signal: firstController.signal });
    const second = f.viewer.query(hostId(Binding), { frame: otherFrame });
    await until(() => f.queries.length === 2);
    const reservations = f.network.calls.filter(value => value.name === 'viewer' && value.kind === 'patch'
        && value.operations[0]?.path === '');
    assert.equal(reservations.length, 3, 'two initial writes and exactly one CAS retry');
    firstController.abort();
    assert.equal((await first).error, 'cancelled');
    await until(() => f.queries[0].signal.aborted);
    assert.equal(f.queries[1].signal.aborted, false);
    f.queries[1].resolve({ status: 'ok', snapshot: snapshot() });
    assert.equal((await second).status, 'ok');
    assert.deepEqual(Object.keys(f.network.metadata).sort(), ['unrelated', p.CapsKey, p.MachineKey, V4Key].sort());
    const idle = f.network.calls.length;
    await flush(); await flush();
    assert.equal(f.network.calls.length, idle);
});

test('replay signals never rescan a completed or cancelled request', async t =>
{
    const f = fixture(t);
    await f.runner.ready;
    await f.viewer.discover(f.frame);
    const request = f.viewer.query(hostId(Binding), { frame: f.frame });
    await until(() => f.queries.length === 1);
    const sent = f.network.calls.find(value => value.name === 'viewer' && value.kind === 'notify'
        && value.eventKind === 'query');
    f.queries[0].resolve({ status: 'ok', snapshot: snapshot() });
    assert.equal((await request).status, 'ok');
    for (let index = 0; index < 5; index++) f.network.emit({ requestId: sent.requestId, kind: 'query', ok: true });
    await flush(); await flush();
    assert.equal(f.queries.length, 1);
});

test('legacy remote pricing requires both ends to update without accepting old dollar totals', async t =>
{
    const f = fixture(t);
    await f.runner.ready;
    await f.viewer.discover(f.frame);
    const request = f.viewer.query(hostId(Binding), { frame: f.frame });
    await until(() => f.queries.length === 1);
    f.network.hold(true);
    f.queries[0].resolve({ status: 'ok', snapshot: snapshot() });
    await until(() => f.network.held.some(value => value.kind === 'result'));
    const key = Object.keys(f.network.metadata).find(key => key.startsWith(p.CapsKey + '_result_'));
    const { weeklyRemainder, ...legacy } = { ...snapshot(), schemaVersion: 3 };
    const bytes = Buffer.from(JSON.stringify(legacy));
    f.network.metadata[key].data = { encoding: 'deflate-base64', bytes: bytes.length,
        dataBase64: deflateSync(bytes).toString('base64') };
    f.network.release();
    const rejected = await request;
    assert.equal(rejected.error, 'snapshot-update-required');
    assert.equal(rejected.snapshot, undefined);
});

test('caps identity drift and older snapshots preserve the prior successful timestamp', async t =>
{
    const f = fixture(t);
    await f.runner.ready;
    await f.viewer.discover(f.frame);
    let request = f.viewer.query(hostId(Binding), { frame: f.frame });
    await until(() => f.queries.length === 1);
    f.queries[0].resolve({ status: 'ok', snapshot: snapshot(2) });
    assert.equal((await request).snapshot.revision, 2);
    request = f.viewer.query(hostId(Binding), { frame: f.frame });
    await until(() => f.queries.length === 2);
    f.queries[1].resolve({ status: 'ok', snapshot: snapshot(1) });
    const replay = await request;
    assert.equal(replay.error, 'snapshot-replay');
    assert.equal(replay.snapshot.revision, 2);
    request = f.viewer.query(hostId(Binding), { frame: f.frame });
    await until(() => f.queries.length === 3);
    f.network.hold(true);
    f.queries[2].resolve({ status: 'ok', snapshot: snapshot(3) });
    await until(() => f.network.held.some(value => value.kind === 'result'));
    f.network.metadata[p.CapsKey] = p.makeCapabilities({ ...Identity,
        publisherId: '55555555-5555-4555-8555-555555555555' });
    f.network.release();
    const changed = await request;
    assert.equal(changed.error, 'snapshot-identity');
    assert.equal(changed.snapshot.generatedAt, Time);
    assert.equal(changed.snapshot.revision, 2);
});

test('runner accepts at most eight active requests and cancellation releases each subscriber', async t =>
{
    const f = fixture(t);
    await f.runner.ready;
    await f.viewer.discover(f.frame);
    const controllers = [];
    const requests = [];
    for (let index = 0; index < 9; index++)
    {
        const controller = new AbortController();
        controllers.push(controller);
        requests.push(f.viewer.query(hostId(Binding), { frame: f.frame, signal: controller.signal }));
        await until(() => f.network.calls.filter(value => value.name === 'viewer' && value.kind === 'notify'
            && value.eventKind === 'query').length === index + 1);
        await flush();
    }
    assert.equal(f.queries.length, 8);
    for (const controller of controllers) controller.abort();
    const results = await Promise.all(requests);
    assert.ok(results.every(value => value.error === 'cancelled'));
    await until(() => f.queries.every(value => value.signal.aborted));
});

test('dispose aborts computation and ignores a late result without publishing it', async t =>
{
    const f = fixture(t, { ignoreCancellation: true });
    await f.runner.ready;
    await f.viewer.discover(f.frame);
    const request = f.viewer.query(hostId(Binding), { frame: f.frame });
    await until(() => f.queries.length === 1);
    const stopping = Promise.all([f.viewer.dispose(), f.runner.dispose()]);
    assert.equal((await request).error, 'cancelled');
    await stopping;
    f.queries[0].resolve({ status: 'ok', snapshot: snapshot() });
    await flush(); await flush();
    assert.equal(f.network.calls.filter(value => value.kind === 'notify' && value.eventKind === 'result').length, 0);
    assert.equal(f.network.watchers.size, 0);
});

test('failed listener stays idle, discloses unavailable capability, and retries only on explicit query', async t =>
{
    const f = fixture(t);
    await f.runner.ready;
    await f.viewer.discover(f.frame);
    f.network.disconnect('runner');
    await until(() => !Object.hasOwn(f.network.metadata, p.CapsKey));
    const calls = f.network.calls.length;
    await f.viewer.discover(f.frame);
    await flush(); await flush();
    assert.equal(f.network.calls.length, calls);
    const unavailable = await f.viewer.query(hostId(Binding), { frame: f.frame });
    assert.equal(unavailable.error, 'snapshot-update-required');
    assert.equal(f.queries.length, 0);
    const localFrame = { ...f.frame };
    await f.runner.discover(localFrame);
    const controller = new AbortController();
    const request = f.runner.query(hostId(Binding), { frame: localFrame, signal: controller.signal });
    await until(() => f.queries.length === 1);
    assert.ok(f.network.metadata[p.CapsKey]);
    controller.abort();
    await request;
});

test('failed query notification cancels its reservation without retry or collector work', async t =>
{
    const f = fixture(t);
    await f.runner.ready;
    await f.viewer.discover(f.frame);
    f.network.notifyHook((name, kind) =>
    {
        if (name === 'viewer' && kind === 'query') throw new Error('disconnected');
    });
    const value = await f.viewer.query(hostId(Binding), { frame: f.frame });
    assert.equal(value.error, 'transport');
    assert.equal(f.queries.length, 0);
    assert.equal(f.network.calls.filter(call => call.eventKind === 'query').length, 1);
    assert.deepEqual(Object.keys(f.network.metadata).sort(), ['unrelated', p.CapsKey, p.MachineKey, V4Key].sort());
});

test('matching unsupported native response fails promptly and late foreign results cannot replace state', async t =>
{
    const f = fixture(t);
    await f.runner.ready;
    await f.viewer.discover(f.frame);
    f.network.hold(true);
    const request = f.viewer.query(hostId(Binding), { frame: f.frame });
    await until(() => f.network.held.some(value => value.kind === 'query'));
    const sent = f.network.held.find(value => value.kind === 'query');
    f.network.emit({ requestId: p.createRequestId(), kind: 'result', ok: true });
    f.network.emit({ ...sent, ok: false });
    assert.equal((await request).error, 'transport-unsupported');
    assert.equal(f.queries.length, 0);
    const before = f.network.calls.length;
    f.network.emit({ ...sent, kind: 'result', ok: true });
    await flush(); await flush();
    assert.equal(f.network.calls.length, before);
});

test('native metadata object key reordering preserves identity and unchanged replay semantics', async t =>
{
    const f = fixture(t, { realTransport: true });
    f.network.reorderReads(true);
    await f.runner.ready;
    await f.viewer.discover(f.frame);
    let request = f.viewer.query(hostId(Binding), { frame: f.frame });
    await until(() => f.queries.length === 1);
    f.queries[0].resolve({ status: 'ok', snapshot: snapshot() });
    assert.equal((await request).status, 'ok');
    request = f.viewer.query(hostId(Binding), { frame: f.frame });
    await until(() => f.queries.length === 2);
    f.queries[1].resolve({ status: 'ok', snapshot: reordered(snapshot()) });
    assert.equal((await request).status, 'ok', 'same revision with reordered JSON remains the same snapshot');
    request = f.viewer.query(hostId(Binding), { frame: f.frame });
    await until(() => f.queries.length === 3);
    const changed = snapshot();
    changed.coverage.files++;
    f.queries[2].resolve({ status: 'ok', snapshot: reordered(changed) });
    assert.equal((await request).error, 'snapshot-replay', 'same revision with changed data remains invalid');
});

test('runner advertises hostname and v4 in its existing PATCH and cleans up only owned metadata', async t =>
{
    const f = fixture(t, { realTransport: true });
    await f.runner.ready;
    assert.equal(f.network.metadata[p.MachineKey]?.displayName, 'Remote-PC');
    const patches = f.network.calls.filter(call => call.name === 'runner' && call.kind === 'patch');
    assert.equal(patches.length, 1);
    assert.deepEqual(patches[0].operations.filter(op => op.op === 'add').map(op => op.path).sort(),
        ['/claudepp_daily_usage', '/' + V4Key, '/claudepp_daily_usage_machine']);
    const foreign = p.makeMachine({ ...Identity, publisherId: Binding.accountId }, 'Replacement-PC');
    f.network.metadata[p.MachineKey] = foreign;
    const foreignCaps = p.makeCapabilities(foreign);
    f.network.metadata[V4Key] = foreignCaps;
    await f.runner.dispose();
    assert.deepEqual(f.network.metadata, { unrelated: { preserve: true }, [p.MachineKey]: foreign,
        [V4Key]: foreignCaps });
});

test('host name demand uses one GET, no collector or watch, and has zero idle traffic', async t =>
{
    const writes = [];
    const f = fixture(t, { realTransport: true, nameCache: { get: () => [], set: entries => writes.push(entries) } });
    await f.runner.ready;
    const baseline = f.network.calls.length;
    await f.viewer.discover(f.frame);
    assert.equal(f.viewer.getHosts(f.frame)[0].label, '远程 · session_fixture');
    assert.equal(f.network.calls.length, baseline);
    await f.viewer.refreshHostNames(f.frame);
    assert.equal(f.viewer.getHosts(f.frame)[0].label, '远程 · Remote-PC');
    assert.deepEqual(f.network.calls.slice(baseline).map(call => call.kind), ['get']);
    assert.equal(f.queries.length, 0);
    assert.deepEqual(writes, [[{ hostId: hostId(Binding), machineId: Identity.machineId, displayName: 'Remote-PC' }]]);
    await flush(); await flush();
    assert.equal(f.network.calls.length, baseline + 1);
});

test('old endpoints and malformed names preserve statistics and the last verified machine label', async t =>
{
    const f = fixture(t);
    await f.runner.ready;
    await f.viewer.discover(f.frame);
    await f.viewer.refreshHostNames(f.frame);
    const current = copy(f.network.metadata[p.MachineKey]);
    for (const value of [undefined, { ...current, displayName: 'bad\nname' },
        { ...current, publisherId: Binding.accountId }, { ...current, machineId: Binding.accountId },
        { ...current, displayName: 'forged', sessionTitle: 'private chat' }])
    {
        if (value === undefined) delete f.network.metadata[p.MachineKey];
        else f.network.metadata[p.MachineKey] = value;
        await f.viewer.refreshHostNames(f.frame);
        assert.equal(f.viewer.getHosts(f.frame)[0].label, '远程 · Remote-PC');
    }
    delete f.network.metadata[p.MachineKey];
    const request = f.viewer.query(hostId(Binding), { frame: f.frame });
    await until(() => f.queries.length === 1);
    f.queries[0].resolve({ status: 'ok', snapshot: snapshot() });
    assert.equal((await request).status, 'ok');
    f.network.metadata[p.CapsKey] = p.makeCapabilities({ ...Identity, machineId: Binding.accountId });
    await f.viewer.refreshHostNames(f.frame);
    assert.equal(f.viewer.getHosts(f.frame)[0].label, '远程 · session_fixture');
});

test('persisted names use exact host identity and errors retain only verified labels', async t =>
{
    const writes = [];
    const f = fixture(t, { nameCache: { get: () => [
        { hostId: hostId(Binding), machineId: Identity.machineId, displayName: 'Cached-PC' },
        { hostId: hostId({ ...Binding, bridgeSessionId: 'session_second' }), machineId: Identity.machineId,
            displayName: 'not a hostname', title: 'private chat' },
        { hostId: hostId({ ...Binding, bridgeSessionId: 'cse_third' }), machineId: Identity.machineId,
            displayName: 'Alias-PC' },
        { hostId: hostId({ ...Binding, bridgeSessionId: 'session_fourth' }), machineId: Identity.machineId,
            displayName: 'bad\u0000name' },
        Object.assign(Object.create({ hostId: hostId({ ...Binding, bridgeSessionId: 'session_fifth' }),
            machineId: Identity.machineId, displayName: 'Inherited-PC' }), { title: 'private', chat: 'private', other: true })
    ], set: entries => writes.push(entries) } });
    await f.runner.ready;
    await f.viewer.discover(f.frame);
    for (const bridgeSessionId of ['session_second', 'session_third', 'session_fourth', 'session_fifth'])
    {
        f.frame.binding = { ...Binding, bridgeSessionId };
        await f.viewer.discover(f.frame);
    }
    assert.deepEqual(f.viewer.getHosts(f.frame).map(value => value.label), ['远程 · Cached-PC',
        '远程 · session_second', '远程 · session_third', '远程 · session_fourth', '远程 · session_fifth']);
    f.network.getHook(name => { if (name === 'viewer') throw new Error('offline'); });
    await f.viewer.refreshHostNames(f.frame);
    assert.equal(f.viewer.getHosts(f.frame)[0].label, '远程 · Cached-PC');
    assert.deepEqual(writes, []);
    const other = { binding: { ...Binding, organizationId: Binding.accountId }, url: f.frame.url };
    await f.viewer.discover(other);
    assert.equal(f.viewer.getHosts(other)[0].label, '远程 · session_fixture');
});

function nameViewer(t, get, nameCache)
{
    const viewer = createRemoteAdapter({ service: { ready: Promise.resolve(), getIdentity: () => Identity },
        transport: { get, async dispose() {} }, bindingSource: source(), frameBinding: frame => frame.binding, nameCache });
    t.after(() => viewer.dispose());
    return viewer;
}
const namedDetail = displayName => ({ metadata: { [p.CapsKey]: p.makeCapabilities(Identity),
    [p.MachineKey]: p.makeMachine(Identity, displayName) } });

test('cancelled name refresh stops queued GETs and ignores a late completion after reopen', async t =>
{
    const reads = [];
    const writes = [];
    const viewer = nameViewer(t, (binding, { signal }) =>
    {
        const pending = deferred();
        reads.push({ binding, signal, ...pending });
        return pending.promise;
    }, { get: () => [], set: entries => writes.push(entries) });
    const frame = { url: 'app://localhost/settings', binding: Binding };
    await viewer.discover(frame);
    const controller = new AbortController();
    const old = viewer.refreshHostNames(frame, { signal: controller.signal });
    await until(() => reads.length === 1);
    controller.abort();
    await old;
    assert.equal(reads[0].signal.aborted, true);
    const current = viewer.refreshHostNames(frame);
    await until(() => reads.length === 2);
    reads[1].resolve(namedDetail('New-PC'));
    await current;
    reads[0].resolve(namedDetail('Old-PC'));
    await flush(); await flush();
    assert.equal(viewer.getHosts(frame)[0].label, '远程 · New-PC');
    assert.deepEqual(writes, [[{ hostId: hostId(Binding), machineId: Identity.machineId, displayName: 'New-PC' }]]);
});

test('name refresh snapshots bindings, limits concurrency to four and cancels remaining queue', async t =>
{
    const reads = [];
    const viewer = nameViewer(t, (binding, { signal }) =>
    {
        const pending = deferred();
        reads.push({ binding, signal, ...pending });
        return pending.promise;
    });
    const frame = { url: 'app://localhost/settings' };
    for (let index = 0; index < 9; index++)
    {
        frame.binding = { ...Binding, bridgeSessionId: 'session_' + index };
        await viewer.discover(frame);
    }
    const controller = new AbortController();
    const request = viewer.refreshHostNames(frame, { signal: controller.signal });
    await until(() => reads.length === 4);
    frame.binding = { ...Binding, bridgeSessionId: 'session_later' };
    await viewer.discover(frame);
    reads[0].resolve(namedDetail('First-PC'));
    await until(() => reads.length === 5);
    controller.abort();
    await request;
    assert.ok(reads.every(read => read.signal.aborted));
    for (const read of reads.slice(1)) read.resolve(namedDetail('Late-PC'));
    await flush(); await flush();
    assert.equal(reads.length, 5);
    assert.deepEqual(viewer.getHosts(frame).map(value => value.label), ['远程 · First-PC',
        ...Array.from({ length: 8 }, (_, index) => '远程 · session_' + (index + 1)), '远程 · session_later']);
});

test('cancellation between the GET signal check and worker continuation prevents name cache writes', async t =>
{
    const pending = deferred();
    const writes = [];
    const controller = new AbortController();
    const viewer = nameViewer(t, () => pending.promise, { get: () => [],
        set: entries => writes.push({ entries, aborted: controller.signal.aborted }) });
    const frame = { binding: Binding, url: 'app://localhost/settings' };
    await viewer.discover(frame);
    const request = viewer.refreshHostNames(frame, { signal: controller.signal });
    pending.promise.then(() => queueMicrotask(() => controller.abort()));
    pending.resolve(namedDetail('Cancelled-PC'));
    await request;
    assert.equal(controller.signal.aborted, true);
    assert.deepEqual(writes, []);
    assert.equal(viewer.getHosts(frame)[0].label, '远程 · session_fixture');
});

test('name refresh has one total 3500ms deadline across concurrent request waves', async t =>
{
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    const reads = [];
    const viewer = nameViewer(t, (_binding, { signal }) =>
    {
        const pending = deferred();
        reads.push({ signal, ...pending });
        return pending.promise;
    });
    const frame = { url: 'app://localhost/settings' };
    for (let index = 0; index < 9; index++)
    {
        frame.binding = { ...Binding, bridgeSessionId: 'session_' + index };
        await viewer.discover(frame);
    }
    const request = viewer.refreshHostNames(frame);
    await until(() => reads.length === 4);
    t.mock.timers.tick(3000);
    reads[0].resolve(namedDetail('Within-Deadline'));
    await until(() => reads.length === 5);
    t.mock.timers.tick(500);
    await request;
    assert.equal(reads.length, 5);
    assert.ok(reads.every(read => read.signal.aborted));
    for (const read of reads.slice(1)) read.resolve(namedDetail('Over-Deadline'));
    await flush();
    assert.equal(viewer.getHosts(frame)[1].label, '远程 · session_1');
});

test('newer concurrent refresh wins even when the older refresh is not cancelled', async t =>
{
    const reads = [];
    const viewer = nameViewer(t, () =>
    {
        const pending = deferred(); reads.push(pending); return pending.promise;
    });
    const frame = { binding: Binding, url: 'app://localhost/settings' };
    await viewer.discover(frame);
    const first = viewer.refreshHostNames(frame);
    await until(() => reads.length === 1);
    const second = viewer.refreshHostNames(frame);
    await until(() => reads.length === 2);
    reads[1].resolve(namedDetail('Newer-PC'));
    await second;
    reads[0].resolve(namedDetail('Older-PC'));
    await first;
    assert.equal(viewer.getHosts(frame)[0].label, '远程 · Newer-PC');
});

test('aborted and unknown-frame name demands perform no reads or cache writes', async t =>
{
    const viewer = nameViewer(t, () => assert.fail('unexpected read'));
    const frame = { binding: Binding, url: 'app://localhost/settings' };
    await viewer.discover(frame);
    await viewer.refreshHostNames({}, {});
    const controller = new AbortController(); controller.abort();
    await viewer.refreshHostNames(frame, { signal: controller.signal });
    await viewer.dispose();
    await viewer.refreshHostNames(frame);
});

test('name cache bounds loaded and saved labels without retaining any remote session content', async t =>
{
    const entries = Array.from({ length: 258 }, (_, index) => ({
        hostId: hostId({ ...Binding, bridgeSessionId: 'session_' + index }),
        machineId: Identity.machineId, displayName: 'Cached-' + index }));
    const writes = [];
    const viewer = nameViewer(t, async () => ({ ...namedDetail('New-PC'),
        session: { title: 'private chat', messages: ['private conversation'] } }),
    { get: () => entries, set: value => writes.push(value) });
    const frame = { binding: { ...Binding, bridgeSessionId: 'session_0' }, url: 'app://localhost/settings' };
    await viewer.discover(frame);
    frame.binding = { ...Binding, bridgeSessionId: 'session_257' };
    await viewer.discover(frame);
    assert.deepEqual(viewer.getHosts(frame).map(value => value.label), ['远程 · session_0', '远程 · Cached-257']);
    const other = { binding: Binding, url: frame.url };
    await viewer.discover(other);
    await viewer.refreshHostNames(other);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].length, 256);
    assert.equal(writes[0].some(entry => entry.hostId.endsWith(':session_2')), false);
    assert.deepEqual(writes[0].at(-1), { hostId: hostId(Binding), machineId: Identity.machineId, displayName: 'New-PC' });
    assert.ok(writes[0].every(entry => Object.keys(entry).sort().join(',') === 'displayName,hostId,machineId'));
});

test('adapter disposal settles outstanding name demands even if the transport ignores cancellation', async t =>
{
    const reads = [];
    const writes = [];
    const viewer = nameViewer(t, (_binding, { signal }) =>
    {
        const pending = deferred(); reads.push({ signal, ...pending }); return pending.promise;
    }, { get: () => [], set: entries => writes.push(entries) });
    const frame = { binding: Binding, url: 'app://localhost/settings' };
    await viewer.discover(frame);
    const demand = viewer.refreshHostNames(frame);
    await until(() => reads.length === 1);
    await viewer.dispose();
    await demand;
    assert.equal(reads[0].signal.aborted, true);
    reads[0].resolve(namedDetail('Late-PC'));
    await flush();
    assert.deepEqual(writes, []);
    assert.equal(viewer.getHosts(frame)[0].label, '远程 · session_fixture');
});

test('invalid hostname or prior malformed name metadata never blocks existing statistics capability', async t =>
{
    for (const options of [{ hostname: () => 'bad\nname' }, {}, { hostname: () => { throw new Error('no hostname'); } }])
    {
        const f = fixture(t, { ...options, realTransport: true });
        if (!options.hostname) f.network.metadata[p.MachineKey] = { sessionTitle: 'private chat' };
        await f.runner.ready;
        assert.deepEqual(f.network.metadata[p.CapsKey], p.makeCapabilities(Identity));
        await f.viewer.discover(f.frame);
        const request = f.viewer.query(hostId(Binding), { frame: f.frame });
        await until(() => f.queries.length === 1);
        f.queries[0].resolve({ status: 'ok', snapshot: snapshot() });
        assert.equal((await request).status, 'ok');
    }
});

test('runner advertisement retries one native CAS conflict without losing unrelated metadata or statistics', async t =>
{
    const f = fixture(t, { realTransport: true });
    let changed = false;
    f.network.patchHook((name, operations) =>
    {
        if (name === 'runner' && !changed && operations.some(op => op.path === '/claudepp_daily_usage_machine'))
        {
            changed = true;
            f.network.metadata.unrelated = { preserve: 'new native metadata' };
        }
    });
    await f.runner.ready;
    assert.equal(f.network.calls.filter(call => call.name === 'runner' && call.kind === 'patch'
        && call.operations.some(op => op.op === 'add')).length, 2);
    assert.equal(f.network.calls.filter(call => call.name === 'runner' && call.kind === 'get').length, 2);
    assert.equal(f.network.calls.filter(call => call.name === 'runner' && call.kind === 'stream').length, 1);
    assert.equal(f.network.metadata[p.MachineKey]?.displayName, 'Remote-PC');
    assert.deepEqual(f.network.metadata.unrelated, { preserve: 'new native metadata' });
    await f.viewer.discover(f.frame);
    const request = f.viewer.query(hostId(Binding), { frame: f.frame });
    await until(() => f.queries.length === 1);
    f.queries[0].resolve({ status: 'ok', snapshot: snapshot() });
    assert.equal((await request).status, 'ok');
});

test('runner advertisement never retries arbitrary transport failures and bounds repeated conflicts', async t =>
{
    for (const conflict of [false, true])
    {
        const f = fixture(t, { realTransport: true });
        let attempts = 0;
        f.network.patchHook((name, operations) =>
        {
            if (name !== 'runner' || !operations.some(op => op.op === 'add')) return;
            attempts++;
            if (conflict) f.network.metadata.unrelated = { revision: attempts };
            else throw new Error('offline');
        });
        await f.runner.ready;
        assert.equal(attempts, conflict ? 2 : 1);
        assert.equal(Object.hasOwn(f.network.metadata, p.CapsKey), false);
        const before = f.network.calls.length;
        await flush(); await flush();
        assert.equal(f.network.calls.length, before);
    }
});
