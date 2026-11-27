"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createTransport } = require("../src/remote-transport.cjs");
const { makeMarker, makeCapabilities, makeResult, requestKey, resultKey, CapsKey, CapabilitiesV4Key } =
    require("../src/remote-protocol.cjs");

const Now = 1794873600000;
const Request = "d411ea01-1111-4111-8111-111111111111";
const Publisher = "22222222-2222-4222-8222-222222222222";
const Machine = "33333333-3333-4333-8333-333333333333";
const Organization = "55555555-5555-4555-8555-555555555555";
const binding = { bridgeSessionId: "session_test", organizationId: Organization, accountId: Publisher };
const base = "https://claude.ai/v1/code/sessions/session_test";
const marker = () => makeMarker({ requestId: Request, publisherId: Publisher, viewerId: Machine, binding, now: Now, snapshotVersion: 4 });
const caps = () => makeCapabilities({ machineId: Machine, publisherId: Publisher });
const tick = () => new Promise(resolve => setImmediate(resolve));

test("machine metadata writes allow only the exact owned key and strict CAS value", async t => {
    const f = fixture(); t.after(() => f.transport.dispose());
    const path = "/claudepp_daily_usage_machine";
    const value = { source: "com.kpk.daily-usage", schemaVersion: 1, demandVersion: 1,
        machineId: Machine, publisherId: Publisher, displayName: "workstation" };
    const operations = [{ op: "test", path: "", value: {} },
        { op: "add", path: "/claudepp_daily_usage", value: caps() }, { op: "add", path, value }];
    await f.transport.patch(binding, operations);
    assert.deepEqual(JSON.parse(f.calls[0].init.body), { client_metadata_patch: operations });
    await f.transport.patch(binding, [{ op: "test", path, value }, { op: "remove", path }]);
    for (const changed of [{ path: path + "/nested", value }, { path: path + "\n", value },
        { path, value: { ...value, displayName: "bad\nname" } }, { path, value: { ...value, chat: "private" } },
        { path, value: { ...value, machineId: "invalid" } }]) {
        const count = f.calls.length;
        await assert.rejects(f.transport.patch(binding, [{ op: "test", path: "", value: {} },
            { op: "add", ...changed }]));
        assert.equal(f.calls.length, count);
    }
});
function detail(change = {}, metadata = { sibling: { untouched: true } }) {
    return { session: { id: "cse_test", environment_kind: "bridge", connection_status: "connected",
        organization_uuid: Organization, client_metadata: metadata, ...change } };
}
function nativeFrame(id = Request, sequence = 51, response = { mcpServers: [{ private: "not retained" }] }) {
    return { sequence_num: sequence, event_id: "opaque-native-id", source: "cli", payload: {
        type: "control_response", response: { subtype: "success", request_id: id, response } } };
}
function fixture(options = {}) {
    const calls = [];
    let controller, cancelled = 0, started = false;
    const stream = new ReadableStream({ start(value) { controller = value; },
        pull() { started = true; }, cancel() { cancelled++; } }, { highWaterMark: 0 });
    const fetch = async (url, init) => {
        calls.push({ url, init });
        if (options.fetch) {
            const value = await options.fetch(url, init);
            if (value !== undefined) return value;
        }
        if (url.endsWith("/events?limit=1&sort_order=desc")) {
            return Response.json({ data: [{ sequence_num: 50, payload: { type: "assistant", private: "ignored" } }] });
        }
        if (url.includes("/events/stream?")) {
            return new Response(stream, { headers: { "content-type": "text/event-stream" } });
        }
        if (init.method === "GET") return Response.json(options.detail ?? detail());
        return Response.json({});
    };
    const transport = createTransport({ fetch, now: () => Now });
    const text = value => controller.enqueue(Buffer.from(value));
    return { transport, calls, text, emit(value, event = "client_event") {
        text(`event: ${event}\r\ndata: ${JSON.stringify(value)}\r\n\r\n`);
    }, fail() { controller.error(new Error("native private stream failure")); }, close() { controller.close(); },
    cancelled: () => cancelled, started: () => started };
}

test("detail reads validate the authenticated unshared connected bridge and fixed account headers", async t => {
    const f = fixture(); t.after(() => f.transport.dispose());
    assert.deepEqual((await f.transport.get(binding)).metadata, { sibling: { untouched: true } });
    const { url, init } = f.calls[0];
    assert.equal(url, base);
    assert.equal(init.credentials, "include");
    assert.equal(init.redirect, "error");
    assert.equal(init.headers["x-organization-uuid"], Organization);
    assert.equal(init.headers["X-Expected-Account"], Publisher);
    assert.equal(init.headers["anthropic-version"], "2023-06-01");
    for (const change of [{ id: "session_other" }, { shared: true }, { is_shared: true },
        { environment_kind: "cloud" }, { connection_status: "disconnected" },
        { organization_uuid: Machine }, { account_id: Machine }, { client_metadata: [] }, { client_metadata: null }]) {
        const bad = fixture({ detail: detail(change) });
        await assert.rejects(bad.transport.get(binding)); await bad.transport.dispose();
    }
    for (const value of [{ ...binding, bridgeSessionId: "session_../other" }, { ...binding, organizationId: "bad" }]) {
        const before = f.calls.length;
        await assert.rejects(f.transport.get(value));
        assert.equal(f.calls.length, before);
    }
});

test("detail bodies are bounded while native identity wrapper variations are accepted", async t => {
    for (const body of ["x".repeat(1024 * 1024 + 1), "not json", JSON.stringify({ ...detail(), is_shared: true })]) {
        const f = fixture({ fetch: () => new Response(body) }); t.after(() => f.transport.dispose());
        await assert.rejects(f.transport.get(binding));
    }
    const session = detail().session;
    const f = fixture({ detail: { response_shape: session } }); t.after(() => f.transport.dispose());
    assert.equal((await f.transport.get(binding)).session.id, "cse_test");
    const malformed = fixture({ detail: { session: "invalid", response_shape: session } });
    t.after(() => malformed.transport.dispose());
    await assert.rejects(malformed.transport.get(binding));
    const redirected = fixture({ fetch: () => ({ ok: true, redirected: true, body: { cancel: async () => {} } }) });
    t.after(() => redirected.transport.dispose());
    await assert.rejects(redirected.transport.get(binding));
});

test("metadata writes require CAS ownership and cannot mutate root or foreign keys", async t => {
    const f = fixture(); t.after(() => f.transport.dispose());
    const key = requestKey(Request), value = marker();
    const operations = [{ op: "test", path: "", value: { sibling: { untouched: true },
        [CapsKey]: caps(), [CapabilitiesV4Key]: caps() } },
        { op: "add", path: "/" + key, value }, { op: "add", path: "/" + resultKey(Request), value: null }];
    await f.transport.patch(binding, operations);
    assert.equal(f.calls[0].url, base);
    assert.equal(f.calls[0].init.method, "PUT");
    assert.deepEqual(JSON.parse(f.calls[0].init.body), { client_metadata_patch: operations });
    await f.transport.patch(binding, [{ op: "test", path: "/" + key, value }, { op: "remove", path: "/" + key }]);
    await f.transport.patch(binding, [{ op: "test", path: "", value: {} },
        { op: "add", path: "/claudepp_daily_usage", value: caps() }]);
    const bad = [[], [{ op: "add", path: "/" + key, value }],
        [{ op: "test", path: "", value: {} }, { op: "add", path: "/foreign", value }],
        [{ op: "test", path: "", value: {} }, { op: "add", path: "", value: {} }],
        [{ op: "test", path: "", value: {} }, { op: "add", path: "/" + key + "/nested", value }],
        [{ op: "test", path: "", value: {} }, { op: "add", path: "/" + key + "\n", value }],
        [{ op: "test", path: "", value: {} }, { op: "add", path: "/" + key, value: { ...value, chat: "private" } }],
        [{ op: "test", path: "", value: {} }, { op: "copy", from: "/foreign", path: "/" + key }],
        [{ op: "test", path: "/foreign", value: {} }, { op: "add", path: "/" + key, value }]];
    for (const operations of bad) {
        const before = f.calls.length;
        await assert.rejects(f.transport.patch(binding, operations));
        assert.equal(f.calls.length, before);
    }
});

test("result reservation is atomic with its absent query marker and result writes compare all ownership", async t => {
    const f = fixture(); t.after(() => f.transport.dispose());
    const key = requestKey(Request), result = "claudepp_daily_usage_result_" + Request;
    await f.transport.patch(binding, [{ op: "test", path: "", value: { sibling: "preserved", [CapsKey]: caps(), [CapabilitiesV4Key]: caps() } },
        { op: "add", path: "/" + key, value: marker() }, { op: "add", path: "/" + result, value: null }]);
    const before = f.calls.length;
    for (const operations of [
        [{ op: "test", path: "", value: {} }, { op: "add", path: "/" + result, value: null }],
        [{ op: "test", path: "", value: { [result]: null } },
            { op: "add", path: "/" + key, value: marker() }, { op: "add", path: "/" + result, value: null }],
        [{ op: "test", path: "/" + result, value: null }, { op: "remove", path: "/" + result }]
    ]) await assert.rejects(f.transport.patch(binding, operations));
    assert.equal(f.calls.length, before);
    await f.transport.patch(binding, [{ op: "test", path: "/" + key, value: marker() },
        { op: "test", path: "/claudepp_daily_usage", value: caps() },
        { op: "test", path: "/" + result, value: null }, { op: "remove", path: "/" + result }]);
});

test("v4 negotiation rejects unbound capabilities and results for another machine", async t => {
    const f = fixture(); t.after(() => f.transport.dispose());
    const own = caps();
    const foreign = makeCapabilities({ machineId: Organization, publisherId: Publisher });
    const weeklyMarker = makeMarker({ ...marker(), binding, now: Now, snapshotVersion: 4 });
    const request = "/" + requestKey(Request), result = "/" + resultKey(Request);
    const root = value => ({ op: "test", path: "", value });
    const version4 = "/" + CapabilitiesV4Key;
    const reserve = value => [root(value), { op: "add", path: request, value: weeklyMarker },
        { op: "add", path: result, value: null }];
    const snapshot = { source: "com.kpk.daily-usage", schemaVersion: 4, machineId: Organization,
        publisherId: Publisher, revision: 1, generatedAt: Now, timezone: "Asia/Shanghai",
        from: "2026-11-17", to: "2026-11-17", rows: [], weekly: null, weeklyHistory: [], weeklyRemainder: { earlier: { requests: 0, usd: 0 },
            unassigned: { requests: 0, usd: 0 } },
        coverage: { files: 1, failedFiles: 0, skippedRecords: 0, legacyRequests: 0, warnings: [] },
        pricing: { basis: "claude-client-estimate", asOf: "2026-11-17", source: "fixture" } };
    const publish = resultSnapshot => [{ op: "test", path: request, value: weeklyMarker },
        { op: "test", path: "/" + CapsKey, value: own }, { op: "test", path: version4, value: own },
        { op: "test", path: result, value: null }, { op: "replace", path: result, value: makeResult({
            requestId: Request, publisherId: Publisher, expiresAt: Now + 300000, status: "ok",
            now: Now, snapshotVersion: 4, snapshot: resultSnapshot }) }];
    for (const operations of [
        [root({ [CapsKey]: own }), { op: "add", path: version4, value: foreign }],
        reserve({ [CapsKey]: own }), reserve({ [CapsKey]: own, [CapabilitiesV4Key]: foreign }),
        reserve({ [CapsKey]: own, [CapabilitiesV4Key]: own }).slice(0, 2),
        reserve({ [CapsKey]: own, [CapabilitiesV4Key]: own }).map(operation => operation.path === request
            ? { ...operation, value: { ...weeklyMarker, snapshotVersion: 3 } } : operation),
        publish(snapshot),
    ]) await assert.rejects(f.transport.patch(binding, operations), { code: "invalid" });
    assert.equal(f.calls.length, 0);
    await f.transport.patch(binding, reserve({ [CapsKey]: own, [CapabilitiesV4Key]: own }));
    await f.transport.patch(binding, publish({ ...snapshot, machineId: Machine }));
    assert.equal(f.calls.length, 2);
});

test("only CAS conflicts receive the metadata-conflict code and no HTTP failure retries", async t => {
    for (const [status, code] of [[409, "metadata-conflict"], [412, "metadata-conflict"], [403, "transport"], [500, "transport"]]) {
        const f = fixture({ fetch: () => new Response("private upstream body", { status }) });
        t.after(() => f.transport.dispose());
        await assert.rejects(f.transport.patch(binding, [{ op: "test", path: "", value: {} },
            { op: "add", path: "/claudepp_daily_usage", value: caps() }]), error => error.code === code);
        assert.equal(f.calls.length, 1);
    }
});

test("native notifications emit only read-only mcp_status with the exact ownership UUID", async t => {
    const f = fixture(); t.after(() => f.transport.dispose());
    await f.transport.notify(binding, Request, "cancel");
    const { url, init } = f.calls[0];
    assert.equal(url, base + "/events");
    assert.equal(init.method, "POST");
    const body = JSON.parse(init.body);
    assert.equal(body.events.length, 1);
    const payload = body.events[0].payload;
    assert.equal(payload.type, "control_request");
    assert.match(payload.uuid, /^[0-9a-f-]{36}$/);
    assert.equal(payload.request_id, "d411ea03-1111-4111-8111-111111111111");
    assert.deepEqual(payload.request, { subtype: "mcp_status" });
    await assert.rejects(f.transport.notify(binding, Publisher, "query"));
});

test("watch establishes the current cursor and begins reading before metadata or notification writes", async t => {
    const f = fixture(); t.after(() => f.transport.dispose());
    const watch = await f.transport.watch(binding);
    assert.equal(f.started(), true);
    assert.equal(f.calls.length, 2);
    assert.equal(f.calls[0].url, base + "/events?limit=1&sort_order=desc");
    assert.equal(f.calls[1].url, base + "/events/stream?from_sequence_num=50");
    assert.equal(f.calls[1].init.headers["Last-Event-ID"], "50");
    const waiting = watch.next();
    f.emit(nativeFrame());
    assert.deepEqual(await waiting, { requestId: Request, kind: "query", ok: true });
    await tick();
    assert.equal(f.calls.length, 2);
    await watch.dispose();
    assert.equal(f.cancelled(), 1);
});

test("bounded SSE parser ignores chat, foreign IDs, historical replay and malformed frames", async t => {
    const f = fixture(); t.after(() => f.transport.dispose());
    const watch = await f.transport.watch(binding);
    let received = false;
    const next = watch.next().then(value => { received = true; return value; });
    f.emit(nativeFrame(Request, 50));
    f.emit(nativeFrame(Publisher));
    f.emit({ sequence_num: 52, payload: { type: "assistant", content: "private chat" } });
    f.text("event: client_event\ndata: not-json\n\n");
    f.text("event: client_event\ndata: " + "x".repeat(200000) + "\n\n");
    await tick();
    assert.equal(received, false);
    const wire = "event: client_event\r\ndata: " + JSON.stringify(nativeFrame(
        "d411ea02-1111-4111-8111-111111111111", 53)) + "\r\n\r\n";
    f.text(wire.slice(0, 31)); f.text(wire.slice(31, 117)); f.text(wire.slice(117));
    assert.deepEqual(await next, { requestId: Request, kind: "result", ok: true });
    assert.equal(f.calls.length, 2);
});

test("matching unsupported or malformed native successes fail the signal without polling", async t => {
    const f = fixture(); t.after(() => f.transport.dispose());
    const watch = await f.transport.watch(binding);
    f.emit(nativeFrame(Request, 51, {}));
    assert.deepEqual(await watch.next(), { requestId: Request, kind: "query", ok: false });
    const error = nativeFrame("d411ea03-1111-4111-8111-111111111111", 52);
    error.payload.response = { request_id: error.payload.response.request_id, subtype: "error", error: "private" };
    f.emit(error);
    assert.deepEqual(await watch.next(), { requestId: Request, kind: "cancel", ok: false });
    assert.equal(f.calls.length, 2);
});

test("stream cancellation and transport disposal immediately unblock pending next with no reconnect", async t => {
    for (const action of ["abort", "dispose", "transport", "end", "failure"]) {
        const f = fixture(); t.after(() => f.transport.dispose());
        const controller = new AbortController();
        const watch = await f.transport.watch(binding, { signal: controller.signal });
        const waiting = assert.rejects(watch.next());
        if (action === "abort") controller.abort();
        if (action === "dispose") await watch.dispose();
        if (action === "transport") await f.transport.dispose();
        if (action === "end") f.close();
        if (action === "failure") f.fail();
        await waiting; await assert.rejects(watch.next());
        await tick();
        assert.equal(f.calls.length, 2);
    }
});

test("invalid cursor pages and non-SSE responses fail before the handle is returned", async t => {
    for (const page of [{}, { data: [{ sequence_num: "bad" }] }, { data: [], resume_cursor: -1 },
        { data: [{ sequence_num: 10 }], resume_cursor: 9 }]) {
        const f = fixture({ fetch: url => url.includes("limit=1") ? Response.json(page) : undefined });
        t.after(() => f.transport.dispose());
        await assert.rejects(f.transport.watch(binding));
        assert.equal(f.calls.length, 1);
    }
    const f = fixture({ fetch: url => url.includes("/stream?") ? Response.json({}) : undefined });
    t.after(() => f.transport.dispose());
    await assert.rejects(f.transport.watch(binding));
});

test("finite operations respect abort even when an injected fetch ignores its signal", async t => {
    const f = fixture({ fetch: () => new Promise(() => {}) }); t.after(() => f.transport.dispose());
    const controller = new AbortController();
    const waiting = assert.rejects(f.transport.get(binding, { signal: controller.signal }));
    controller.abort();
    await waiting;
    await f.transport.dispose();
    await assert.rejects(f.transport.get(binding));
});

test("idle watches have no deadline or recurring traffic while finite reads have a bounded deadline", async t => {
    t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    const f = fixture(); t.after(() => f.transport.dispose());
    const watch = await f.transport.watch(binding);
    t.mock.timers.tick(600000);
    assert.equal(f.calls.length, 2);
    f.emit(nativeFrame());
    assert.deepEqual(await watch.next(), { requestId: Request, kind: "query", ok: true });
    const hanging = fixture({ fetch: () => new Promise(() => {}) });
    t.after(() => hanging.transport.dispose());
    const waiting = assert.rejects(hanging.transport.get(binding));
    t.mock.timers.tick(5000);
    await waiting;
});
