"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { deflateSync } = require("node:zlib");
const protocol = require("../src/remote-protocol.cjs");

const Now = Date.parse("2026-11-17T00:00:00Z");
const Request = "d411ea01-1111-4111-8111-111111111111";
const Publisher = "22222222-2222-4222-8222-222222222222";
const Machine = "33333333-3333-4333-8333-333333333333";
const Viewer = "44444444-4444-4444-8444-444444444444";
const binding = { bridgeSessionId: "session_test", organizationId: "55555555-5555-4555-8555-555555555555" };
const options = { requestId: Request, publisherId: Publisher, viewerId: Viewer, binding, now: Now };
const expected = { requestId: Request, publisherId: Publisher, machineId: Machine, now: Now };
function snapshot() {
    return { schemaVersion: 1, source: "com.kpk.daily-usage", machineId: Machine, publisherId: Publisher,
        revision: 1, generatedAt: Now, timezone: "Asia/Shanghai", from: "2026-10-19", to: "2026-11-17",
        rows: [], coverage: { files: 0, failedFiles: 0, skippedRecords: 0, legacyRequests: 0, warnings: [] },
        pricing: { basis: "claude-client-estimate", asOf: "2026-11-17", source: "https://platform.claude.com/docs/en/about-claude/pricing" } };
}
function result(status = "ok", overrides = {}) {
    return protocol.makeResult({ requestId: Request, publisherId: Publisher, expiresAt: Now + 300000,
        status, snapshot: snapshot(), error: "unavailable", now: Now, ...overrides });
}

test("legacy remote dollars require update only after payload and identity validation", () => {
    const value = result();
    const legacy = snapshot();
    legacy.pricing.basis = "standard";
    const encode = snapshot => {
        const bytes = Buffer.from(JSON.stringify(snapshot));
        return { encoding: "deflate-base64", bytes: bytes.length,
            dataBase64: deflateSync(bytes).toString("base64") };
    };
    value.data = encode(legacy);
    assert.deepEqual(protocol.validateResult(value, expected), { ok: false, reason: "update-required" });
    assert.deepEqual(protocol.validateResult(value, { ...expected, machineId: Viewer }),
        { ok: false, reason: "identity" });
    value.data = encode({ ...legacy, messages: ["private"] });
    assert.deepEqual(protocol.validateResult(value, expected), { ok: false, reason: "invalid" });
});

test("remote aggregation preserves estimated request counts and partial pricing coverage", () => {
    const estimated = snapshot();
    estimated.rows = [{ date: "2026-11-17", model: "claude-opus-5-5", requests: 2, inputTokens: 4231,
        uncachedInputTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 4231, outputTokens: 0,
        usd: 0.021155, unpricedRequests: 1, estimatedRequests: 1 }];
    estimated.coverage.warnings = ["1 次请求的缓存写入时长未完整覆盖，未知部分按 5 分钟价格估算。"];
    const checked = protocol.validateResult(result("ok", { snapshot: estimated }), expected);
    assert.equal(checked.ok, true);
    assert.equal(checked.snapshot.rows[0].estimatedRequests, 1);
    assert.equal(checked.snapshot.rows[0].unpricedRequests, 1);
    assert.equal(checked.snapshot.rows[0].usd, 0.021155);
    assert.deepEqual(checked.snapshot.coverage.warnings, estimated.coverage.warnings);
});

test("machine names are separate bounded metadata tied to current capabilities", () => {
    const identity = { machineId: Machine, publisherId: Publisher };
    const caps = protocol.makeCapabilities(identity);
    assert.equal(protocol.MachineKey, "claudepp_daily_usage_machine");
    const value = protocol.makeMachine(identity, "  工作站 <desktop>  ");
    assert.deepEqual(value, { source: "com.kpk.daily-usage", schemaVersion: 1, demandVersion: 1,
        ...identity, displayName: "工作站 <desktop>" });
    assert.deepEqual(protocol.validateMachine(value, caps), { ok: true });
    assert.equal(protocol.validateMachine({ ...value, displayName: "x".repeat(256) }, caps).ok, true);
    for (const displayName of ["", "  ", "x".repeat(257), "bad\nname", "bad\u0000name", "bad\u0085name", null]) {
        assert.throws(() => protocol.makeMachine(identity, displayName));
        assert.equal(protocol.validateMachine({ ...value, displayName }, caps).ok, false);
    }
    for (const changed of [{ ...value, displayName: " untrimmed " }, { ...value, title: "private chat" },
        { ...value, machineId: Viewer }, { ...value, publisherId: Viewer }, { ...value, schemaVersion: 2 }, null]) {
        assert.equal(protocol.validateMachine(changed, caps).ok, false);
    }
    assert.equal(protocol.validateMachine(value).ok, false);
    assert.equal(protocol.validateMachine(value, { ...caps, title: "chat" }).ok, false);
    assert.equal(protocol.validateCapabilities({ ...caps, displayName: "host" }).ok, false);
});

test("signal IDs preserve UUID ownership and decode only the three owned prefixes", () => {
    assert.match(protocol.createRequestId(), /^d411ea01-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    for (const [kind, prefix] of [["query", "d411ea01"], ["result", "d411ea02"], ["cancel", "d411ea03"]]) {
        const wire = `${prefix}-1111-4111-8111-111111111111`;
        assert.equal(protocol.signalId(Request, kind), wire);
        assert.deepEqual(protocol.parseSignalId(wire), { requestId: Request, kind });
    }
    for (const value of [Publisher, Request + "\n", "d411ea01-not-a-uuid", null]) {
        assert.equal(protocol.parseSignalId(value), null);
    }
    assert.throws(() => protocol.signalId(Publisher, "query"));
    assert.throws(() => protocol.signalId(Request, "tools/call"));
    assert.equal(protocol.requestKey(Request), "claudepp_daily_usage_request_" + Request);
    assert.equal(protocol.resultKey(Request), "claudepp_daily_usage_result_" + Request);
    assert.throws(() => protocol.requestKey(Request + "/foreign"));
});

test("bindings normalize native IDs without allowing URL or pointer injection", () => {
    assert.equal(protocol.normalizeBridgeId("cse_Test_123-abc"), "session_Test_123-abc");
    assert.equal(protocol.validBinding({ ...binding, bridgeSessionId: "cse_test", accountId: Publisher }), true);
    for (const bridgeSessionId of ["session_../other", "https://claude.ai/session_test", "session_test\n", "session_"]) {
        assert.equal(protocol.normalizeBridgeId(bridgeSessionId), null);
        assert.equal(protocol.validBinding({ ...binding, bridgeSessionId }), false);
    }
    assert.equal(protocol.validBinding({ ...binding, organizationId: "org" }), false);
    assert.equal(protocol.validBinding({ ...binding, accountId: "account" }), false);
});

test("capabilities and markers have exact fields and bind demand to one publisher and bridge", () => {
    const caps = protocol.makeCapabilities({ machineId: Machine, publisherId: Publisher });
    assert.deepEqual(caps, { source: "com.kpk.daily-usage", schemaVersion: 1, demandVersion: 1,
        machineId: Machine, publisherId: Publisher });
    assert.deepEqual(protocol.validateCapabilities(caps), { ok: true });
    assert.equal(protocol.validateCapabilities({ ...caps, messages: [] }).ok, false);
    const marker = protocol.makeMarker(options);
    assert.deepEqual(marker, { source: "com.kpk.daily-usage", schemaVersion: 1, demandVersion: 1,
        requestId: Request, publisherId: Publisher, viewerId: Viewer, ...binding,
        action: "query", sequence: 1, requestedAt: Now, expiresAt: Now + 300000 });
    assert.deepEqual(protocol.validateMarker(marker, { binding, now: Now }), { ok: true });
    const cancelled = protocol.makeMarker({ ...options, now: Now + 10000 }, "cancel", marker);
    assert.deepEqual(cancelled, { ...marker, action: "cancel", sequence: 2 });
    assert.throws(() => protocol.makeMarker({ ...options, viewerId: Machine }, "cancel", marker));
    assert.throws(() => protocol.makeMarker(options, "cancel", cancelled));
    for (const change of [{ sequence: 2 }, { publisherId: "bad" }, { viewerId: "bad" }, { extra: "private" },
        { requestedAt: Now + 5001 }, { expiresAt: Now }, { expiresAt: Now + 300001 },
        { bridgeSessionId: "session_other" }, { organizationId: Publisher }]) {
        assert.equal(protocol.validateMarker({ ...marker, ...change }, { binding, now: Now }).ok, false,
            JSON.stringify(change));
    }
    assert.equal(protocol.validateMarker(marker, { binding, now: Now + 300000 }).ok, false);
    assert.equal(protocol.validateMarker(marker, { binding: { ...binding, bridgeSessionId: "cse_test" }, now: Now }).ok, true);
});

test("results round-trip only validated aggregates with exact machine and publisher identity", () => {
    const value = result();
    assert.equal(value.data.encoding, "deflate-base64");
    assert.equal(value.data.bytes, Buffer.byteLength(JSON.stringify(snapshot())));
    assert.deepEqual(protocol.validateResult(value, expected), { ok: true, snapshot: snapshot() });
    assert.equal(protocol.validateResult(value, { ...expected, machineId: Viewer }).reason, "identity");
    assert.equal(protocol.validateResult(value, { ...expected, publisherId: Viewer }).ok, false);
    assert.equal(protocol.validateResult(value, { ...expected, requestId: protocol.createRequestId() }).ok, false);
    assert.equal(protocol.validateResult(value, { ...expected, now: Now + 300000 }).ok, false);
    assert.equal(protocol.validateResult({ ...value, raw: "private" }, expected).ok, false);
    assert.equal(protocol.validateResult({ ...value, updatedAt: Now + 5001 }, expected).ok, false);
    assert.equal(protocol.validateResult({ ...value, expiresAt: Now + 305001 }, expected).ok, false);
    assert.throws(() => result("ok", { snapshot: { ...snapshot(), messages: ["private"] } }));
    for (const status of ["error", "cancelled"]) {
        const terminal = result(status);
        assert.deepEqual(protocol.validateResult(terminal, expected), { ok: true });
        assert.equal(Object.hasOwn(terminal, "data"), false);
    }
    assert.throws(() => result("running"));
    assert.throws(() => result("error", { error: "private exception text\n" }));
});

test("version 2 is an exact, optional marker field that survives cancellation", () => {
    const marker = protocol.makeMarker({ ...options, snapshotVersion: 2 });
    assert.equal(marker.snapshotVersion, 2);
    assert.equal(protocol.validateMarker(marker, { binding, now: Now }).ok, true);
    assert.deepEqual(protocol.makeMarker(options, "cancel", marker), { ...marker, action: "cancel", sequence: 2 });
    const history = protocol.makeMarker({ ...options, snapshotVersion: 3 });
    assert.equal(protocol.makeMarker(options, "cancel", history).snapshotVersion, 3);
    for (const value of [undefined, null, 1, 4, "2"]) {
        assert.equal(protocol.validateMarker({ ...marker, snapshotVersion: value }, { binding, now: Now }).ok, false);
    }
});

test("five-second machine clock skew keeps the original deadline while rejecting larger future skew", () => {
    const marker = protocol.makeMarker(options);
    for (const offset of [-5000, 5000]) {
        assert.equal(protocol.validateMarker(marker, { binding, now: Now + offset }).ok, true);
        const value = result("ok", { now: Now + offset });
        assert.equal(value.expiresAt, Now + 300000);
        assert.equal(protocol.validateResult(value, expected).ok, true);
    }
    assert.equal(protocol.validateMarker(marker, { binding, now: Now - 5001 }).ok, false);
    assert.throws(() => result("ok", { now: Now - 5001 }));
    const future = result("ok", { now: Now + 5001, snapshot: { ...snapshot(), generatedAt: Now } });
    assert.equal(protocol.validateResult(future, expected).ok, false);
});

test("oversized history projects to the current week and an oversized daily report returns a terminal error", () => {
    const { createHash } = require("node:crypto");
    const models = Array.from({ length: 2400 }, (_, i) => createHash("sha256").update(String(i)).digest("hex"));
    const base = snapshot();
    const period = { startAt: Now - 8000, startKind: "inferred", sampleAt: Now - 5000, fullAt: null,
        usedPercent: 40, endAt: Now - 3000, partial: false, rows: models.map(model =>
            ({ model, requests: 1, baseUsd: 4, usd: 4, unpricedRequests: 0, estimatedRequests: 0 })) };
    const current = { ...base, schemaVersion: 2, weekly: null };
    const history = { ...current, schemaVersion: 3, weeklyHistory: [period] };
    const fromRunner = value => result("ok", { snapshot: value, snapshotVersion: 3 });
    const fits = protocol.validateResult(fromRunner(history), { ...expected, snapshotVersion: 3 });
    assert.deepEqual(fits, { ok: true, snapshot: current });
    assert.equal(history.weeklyHistory[0].rows.length, models.length);
    const rows = models.map(model => ({ date: base.to, model, requests: 1, inputTokens: 1,
        uncachedInputTokens: 1, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 1,
        usd: 4, unpricedRequests: 0, estimatedRequests: 0 }));
    const rejected = fromRunner({ ...history, rows });
    assert.equal(rejected.status, "error");
    assert.equal(rejected.error, "snapshot-too-large");
    assert.equal(protocol.validateResult(rejected, expected).ok, true);
});

test("compressed aggregates reject invalid base64, inflated bombs and incorrect byte counts", () => {
    const value = result();
    const corruptions = [
        { ...value.data, dataBase64: value.data.dataBase64 + "\n" },
        { ...value.data, bytes: value.data.bytes + 1 },
        { ...value.data, encoding: "json" },
        { ...value.data, dataBase64: Buffer.alloc(65537).toString("base64") },
        { ...value.data, dataBase64: deflateSync(Buffer.alloc(2 * 1024 * 1024 + 1)).toString("base64"),
            bytes: 2 * 1024 * 1024 + 1 },
        { ...value.data, dataBase64: Buffer.from("invalid compressed data").toString("base64") },
        { ...value.data, dataBase64: Buffer.concat([Buffer.from(value.data.dataBase64, "base64"),
            Buffer.from("trailing compressed garbage")]).toString("base64") },
        { ...value.data, rawText: "private" }
    ];
    for (const data of corruptions) assert.equal(protocol.validateResult({ ...value, data }, expected).ok, false);
    const bytes = Buffer.from(JSON.stringify({ ...snapshot(), machineId: Viewer }));
    assert.equal(protocol.validateResult({ ...value, data: { encoding: "deflate-base64", bytes: bytes.length,
        dataBase64: deflateSync(bytes).toString("base64") } }, expected).reason, "identity");
});
