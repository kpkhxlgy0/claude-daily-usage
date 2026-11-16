'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createRemoteAdapter } = require('../src/remote-adapter.cjs');
const { createTransport } = require('../src/remote-transport.cjs');
const p = require('../src/remote-protocol.cjs');

const Identity = { machineId: '11111111-1111-4111-8111-111111111111',
    publisherId: '22222222-2222-4222-8222-222222222222' };
const Binding = { bridgeSessionId: 'session_fixture', organizationId: '33333333-3333-4333-8333-333333333333',
    accountId: '44444444-4444-4444-8444-444444444444' };
const Time = Date.UTC(2026, 10, 17);
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
    return { schemaVersion: 1, source: 'com.kpk.daily-usage', ...Identity, revision, generatedAt: Time,
        timezone: 'Asia/Shanghai', from: '2026-11-17', to: '2026-11-17', rows: [],
        coverage: { files: 1, failedFiles: 0, skippedRecords: 0, legacyRequests: 0, warnings: [] },
        pricing: { basis: 'standard', asOf: '2026-11-17', source: 'fixture' } };
}
function hub()
{
    let metadata = { unrelated: { preserve: true } };
    const watchers = new Set();
    const calls = [];
    const held = [];
    let hold = false;
    let getHook;
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
                if (getHook) await getHook(name, options);
                if (options?.signal?.aborted) throw new Error('aborted');
                return { session: { id: binding.bridgeSessionId }, metadata: reorderReads
                    ? reordered(copy(metadata)) : copy(metadata) };
            },
            async patch(binding, operations, options)
            {
                calls.push({ name, kind: 'patch', operations: copy(operations), binding });
                if (options?.signal?.aborted) throw new Error('aborted');
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
        now: () => Time, frameBinding: frame => frame.binding });
    const viewer = createRemoteAdapter({ service: { ...service, query() { assert.fail('viewer scan'); } },
        transport: makeTransport('viewer'), bindingSource: source(), now: () => Time,
        frameBinding: frame => frame.binding });
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
    assert.deepEqual(Object.keys(f.network.metadata).sort(), ['unrelated', p.CapsKey].sort());
    const calls = f.network.calls.filter(value => value.name === 'viewer');
    const watch = calls.findIndex(value => value.kind === 'watch');
    const write = calls.findIndex(value => value.kind === 'patch');
    assert.ok(watch < write);
    assert.equal(calls.filter(value => value.kind === 'get').length, 2);
    const final = f.network.calls.length;
    await flush(); await flush();
    assert.equal(f.network.calls.length, final);
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
    assert.deepEqual(Object.keys(f.network.metadata).sort(), ['unrelated', p.CapsKey].sort());
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
    assert.deepEqual(Object.keys(f.network.metadata).sort(), ['unrelated', p.CapsKey].sort());
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
