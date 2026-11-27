"use strict";

const { randomUUID } = require("node:crypto");
const { inflateSync } = require("node:zlib");
const { MaxSnapshotBytes, normalizeThreadId } = require("./protocol.cjs");
const { signalId, parseSignalId, normalizeBridgeId, validBinding, resultKey, CapsKey, MachineKey,
    CapabilitiesV4Key, FullCycleSnapshotVersion, supportsFullCycleSnapshots, validateCapabilities, validateMachine,
    validateMarker, validateResult } = require("./remote-protocol.cjs");

const MaxBodyBytes = 1024 * 1024;
const MaxFrameChars = 64 * 1024;
const TimeoutMs = 5000;
const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
const fields = (value, keys) => record(value) && Object.keys(value).length === keys.length
    && keys.every(key => Object.hasOwn(value, key));
const failure = (code = "transport") => Object.assign(new Error("Remote Daily Usage " + code), { code });
const sequence = value => Number.isSafeInteger(value) && value >= 0 ? value
    : typeof value === "string" && /^(?:0|[1-9][0-9]*)$/.test(value)
        && Number.isSafeInteger(Number(value)) ? Number(value) : null;

function cancelBody(response) {
    try { Promise.resolve(response?.body?.cancel?.()).catch(() => {}); } catch { /* 已关闭的流无需重试。 */ }
}

function ownedKey(key) {
    if (key === CapsKey) return { kind: "caps" };
    if (key === CapabilitiesV4Key) return { kind: "snapshot-caps" };
    if (key === MachineKey) return { kind: "machine" };
    const match = /^claudepp_daily_usage_(request|result)_([0-9a-f-]{36})$/.exec(key);
    const parsed = match && match[0] === key && parseSignalId(match[2]);
    return parsed?.kind === "query" ? { kind: match[1], requestId: parsed.requestId } : null;
}

function validOwnedValue(key, value, binding, machineId) {
    const owned = ownedKey(key);
    if (!owned) return false;
    if (owned.kind === "caps" || owned.kind === "snapshot-caps") return validateCapabilities(value).ok;
    if (owned.kind === "machine") return record(value) && validateMachine(value, {
        source: value.source, schemaVersion: value.schemaVersion, demandVersion: value.demandVersion,
        machineId: value.machineId, publisherId: value.publisherId }).ok;
    if (!record(value) || value.requestId !== owned.requestId) return false;
    if (owned.kind === "request") return validateMarker(value, { binding, now: value.requestedAt }).ok;
    if (value.status === "ok" && !machineId) {
        const data = value.data;
        if (!record(data) || typeof data.dataBase64 !== "string" || data.dataBase64.length > 87384) return false;
        try {
            const bytes = inflateSync(Buffer.from(data.dataBase64, "base64"), { maxOutputLength: MaxSnapshotBytes });
            machineId = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)).machineId;
        } catch { return false; }
    }
    return validateResult(value, { requestId: owned.requestId, publisherId: value.publisherId,
        machineId, now: value.updatedAt }).ok;
}

function validateOperations(operations, binding) {
    if (!Array.isArray(operations) || operations.length < 2 || operations.length > 32) return false;
    let root;
    let advertisedCaps;
    const compared = new Map();
    const reserved = new Set();
    if (operations.length === 3 && operations[0]?.op === "test" && operations[0].path === ""
        && record(operations[0].value)) {
        const marker = operations.find(value => value?.op === "add"
            && typeof value.path === "string" && ownedKey(value.path.slice(1))?.kind === "request");
        const result = operations.find(value => value?.op === "add" && value.value === null
            && typeof value.path === "string" && ownedKey(value.path.slice(1))?.kind === "result");
        if (marker && result && marker.value?.action === "query" && validOwnedValue(marker.path.slice(1), marker.value, binding)
            && ownedKey(result.path.slice(1)).requestId === marker.value.requestId
            && !Object.hasOwn(operations[0].value, marker.path.slice(1))
            && !Object.hasOwn(operations[0].value, result.path.slice(1))) {
            const capabilities = operations[0].value[CapsKey];
            if (marker.value.snapshotVersion !== FullCycleSnapshotVersion || marker.value.publisherId !== capabilities?.publisherId
                || !supportsFullCycleSnapshots(operations[0].value[CapabilitiesV4Key], capabilities)) return false;
            reserved.add(result.path.slice(1));
        }
    }
    let mutations = 0;
    for (const operation of operations) {
        if (!record(operation) || !["test", "add", "replace", "remove"].includes(operation.op)
            || !fields(operation, operation.op === "remove" ? ["op", "path"] : ["op", "path", "value"])) return false;
        if (operation.path === "") {
            if (operation.op !== "test" || !record(operation.value) || mutations) return false;
            root = operation.value;
            continue;
        }
        if (typeof operation.path !== "string" || !operation.path.startsWith("/")) return false;
        const key = operation.path.slice(1);
        const owned = ownedKey(key);
        if (!owned) return false;
        const markerKey = owned.kind === "result" ? CapsKey + "_request_" + owned.requestId : null;
        const nullComparison = owned.kind === "result" && operation.value === null && compared.has(markerKey);
        if (operation.op === "test") {
            if (!nullComparison && !validOwnedValue(key, operation.value, binding)) return false;
            compared.set(key, operation.value);
            continue;
        }
        if (!compared.has(key) && root === undefined) return false;
        if (root && Object.hasOwn(root, key) && !validOwnedValue(key, root[key], binding)) return false;
        let machineId;
        if (owned.kind === "result" && compared.has(key) && compared.get(key) === null && operation.op !== "remove") {
            const marker = compared.get(markerKey), caps = compared.get(CapsKey);
            if (!marker || marker.action !== "query" || !caps || caps.publisherId !== marker.publisherId
                || operation.value?.publisherId !== marker.publisherId) return false;
            if (operation.value?.status === "ok" && (marker.snapshotVersion !== FullCycleSnapshotVersion
                || !supportsFullCycleSnapshots(compared.get(CapabilitiesV4Key), caps))) return false;
            machineId = caps.machineId;
        }
        if (operation.op !== "remove" && !(operation.value === null && reserved.has(key))) {
            if (!validOwnedValue(key, operation.value, binding, machineId)) return false;
            if (owned.kind === "request" && operation.value.action === "query" && !reserved.has(resultKey(owned.requestId))) return false;
            if (owned.kind === "caps") advertisedCaps = operation.value;
            if (owned.kind === "snapshot-caps"
                && !supportsFullCycleSnapshots(operation.value, advertisedCaps ?? compared.get(CapsKey) ?? root?.[CapsKey]))
                return false;
        }
        mutations++;
    }
    return mutations > 0;
}

function createTransport({ fetch, now = Date.now } = {}) {
    if (typeof fetch !== "function" || typeof now !== "function") throw new TypeError("Authenticated fetch is required");
    const scopes = new Set();
    let disposed = false;

    function scopeFor(signal) {
        if (disposed || signal !== undefined && (typeof signal?.addEventListener !== "function"
            || typeof signal?.removeEventListener !== "function")) throw failure("unavailable");
        const controller = new AbortController();
        const abort = () => controller.abort();
        const scope = { controller, timer: setTimeout(abort, TimeoutMs), finish() {
            clearTimeout(scope.timer);
            signal?.removeEventListener("abort", abort);
            scopes.delete(scope);
        } };
        signal?.addEventListener("abort", abort, { once: true });
        scopes.add(scope);
        if (signal?.aborted) abort();
        return scope;
    }

    function guarded(scope, operation) {
        const signal = scope.controller.signal;
        if (signal.aborted || disposed) return Promise.reject(failure("cancelled"));
        return new Promise((resolve, reject) => {
            const abort = () => { cleanup(); reject(failure("cancelled")); };
            const cleanup = () => signal.removeEventListener("abort", abort);
            signal.addEventListener("abort", abort, { once: true });
            let pending;
            try { pending = operation(); } catch (error) { cleanup(); reject(error); return; }
            Promise.resolve(pending).then(value => {
                cleanup();
                if (signal.aborted || disposed) reject(failure("cancelled"));
                else resolve(value);
            }, () => { cleanup(); reject(failure()); });
        });
    }

    function bound(value) {
        if (!validBinding(value)) throw failure("identity");
        return { bridgeSessionId: normalizeBridgeId(value.bridgeSessionId),
            organizationId: normalizeThreadId(value.organizationId),
            ...(value.accountId !== undefined ? { accountId: normalizeThreadId(value.accountId) } : {}) };
    }

    async function request(scope, binding, suffix = "", method = "GET", body, extraHeaders) {
        const url = "https://claude.ai/v1/code/sessions/" + binding.bridgeSessionId + suffix;
        const headers = { "anthropic-version": "2023-06-01", "anthropic-beta": "ccr-byoc-2025-07-29",
            "anthropic-client-feature": "ccr", "x-organization-uuid": binding.organizationId,
            ...(binding.accountId ? { "X-Expected-Account": binding.accountId } : {}), ...extraHeaders };
        let serialized;
        if (body !== undefined) {
            try { serialized = JSON.stringify(body); } catch { throw failure("invalid"); }
            if (Buffer.byteLength(serialized, "utf8") > MaxBodyBytes) throw failure("size");
            headers["content-type"] = "application/json";
        }
        const response = await guarded(scope, async () => {
            const value = await fetch(url, { method, headers, signal: scope.controller.signal,
                credentials: "include", cache: "no-store", redirect: "error",
                ...(serialized !== undefined ? { body: serialized } : {}) });
            if (scope.controller.signal.aborted || disposed) { cancelBody(value); throw failure("cancelled"); }
            return value;
        });
        if (!response?.ok || response.redirected || response.url && response.url !== url) {
            const conflict = method === "PUT" && [409, 412].includes(response?.status)
                && !response?.redirected && (!response?.url || response.url === url);
            cancelBody(response); throw failure(conflict ? "metadata-conflict" : "transport");
        }
        return response;
    }

    async function readJson(scope, response) {
        const length = response.headers?.get?.("content-length");
        if (length !== null && length !== undefined && /^\d+$/.test(length) && Number(length) > MaxBodyBytes) {
            cancelBody(response); throw failure("size");
        }
        if (typeof response.body?.getReader !== "function") { cancelBody(response); throw failure("invalid"); }
        const reader = response.body.getReader();
        const bytes = Buffer.alloc(MaxBodyBytes);
        let size = 0;
        try {
            while (true) {
                const { value, done } = await guarded(scope, () => reader.read());
                if (done) break;
                if (!(value instanceof Uint8Array) || value.byteLength > MaxBodyBytes - size) throw failure("size");
                bytes.set(value, size); size += value.byteLength;
            }
            return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size)));
        } catch { throw failure("invalid"); }
        finally {
            try { void reader.cancel().catch(() => {}); } catch { /* 流已终止。 */ }
            try { reader.releaseLock(); } catch { /* 待处理读取由取消结束。 */ }
        }
    }

    async function finite(binding, options, operation) {
        const normalized = bound(binding);
        const scope = scopeFor(options?.signal);
        try { return await operation(scope, normalized); }
        finally { scope.controller.abort(); scope.finish(); }
    }

    async function get(binding, options = {}) {
        return finite(binding, options, async (scope, normalized) => {
            const detail = await readJson(scope, await request(scope, normalized));
            const session = detail?.session ?? detail?.response_shape;
            if (!record(detail) || detail.shared || detail.is_shared || !record(session) || session.shared || session.is_shared
                || normalizeBridgeId(session.id) !== normalized.bridgeSessionId
                || !["bridge", "ENVIRONMENT_KIND_BRIDGE"].includes(session.environment_kind)
                || (session.connection_status ?? detail.connection_status) !== "connected") throw failure("identity");
            for (const value of [session.organization_id, session.organization_uuid, detail.organization_id, detail.organization_uuid]) {
                if (value !== undefined && normalizeThreadId(value) !== normalized.organizationId) throw failure("identity");
            }
            if (normalized.accountId) {
                for (const value of [session.account_id, session.account_uuid, detail.account_id, detail.account_uuid]) {
                    if (value !== undefined && normalizeThreadId(value) !== normalized.accountId) throw failure("identity");
                }
            }
            const metadata = Object.hasOwn(session, "client_metadata") ? session.client_metadata
                : Object.hasOwn(detail, "client_metadata") ? detail.client_metadata : {};
            if (!record(metadata)) throw failure("invalid");
            return { session, metadata };
        });
    }

    async function patch(binding, operations, options = {}) {
        const normalized = bound(binding);
        if (!validateOperations(operations, normalized)) throw failure("invalid");
        return finite(normalized, options, async scope => {
            cancelBody(await request(scope, normalized, "", "PUT", { client_metadata_patch: operations }));
        });
    }

    async function notify(binding, id, kind, options = {}) {
        const wire = signalId(id, kind);
        return finite(binding, options, async (scope, normalized) => {
            cancelBody(await request(scope, normalized, "/events", "POST", { events: [{ payload: {
                type: "control_request", uuid: randomUUID(), request_id: wire, request: { subtype: "mcp_status" } } }] }));
        });
    }

    async function watch(binding, options = {}) {
        const normalized = bound(binding);
        if (scopes.size >= 32) throw failure("capacity");
        const scope = scopeFor(options?.signal);
        let reader;
        let stopped;
        let terminal;
        const queue = [], waiting = [];
        const stop = error => {
            if (stopped) return;
            stopped = true; terminal = error ?? failure("cancelled");
            queue.length = 0;
            scope.controller.abort(); scope.finish();
            try { void reader?.cancel().catch(() => {}); } catch { /* 原生流已关闭。 */ }
            for (const pending of waiting.splice(0)) pending.reject(terminal);
        };
        const aborted = () => stop(failure("cancelled"));
        scope.controller.signal.addEventListener("abort", aborted, { once: true });
        try {
            const page = await readJson(scope, await request(scope, normalized, "/events?limit=1&sort_order=desc"));
            if (!record(page) || !Array.isArray(page.data) || page.data.length > 1) throw failure("invalid");
            let cursor = 0;
            for (const event of page.data) {
                const value = sequence(event?.sequence_num);
                if (!record(event) || value === null) throw failure("invalid");
                cursor = value;
            }
            for (const key of ["next_cursor", "resume_cursor"]) {
                if (page[key] === undefined || page[key] === null || page[key] === "") continue;
                const value = sequence(page[key]);
                if (value === null || value < cursor) throw failure("invalid");
                cursor = value;
            }
            const response = await request(scope, normalized, "/events/stream?from_sequence_num=" + cursor,
                "GET", undefined, { "Last-Event-ID": String(cursor), accept: "text/event-stream" });
            if (!/^text\/event-stream(?:\s*;|$)/i.test(response.headers?.get?.("content-type") ?? "")
                || typeof response.body?.getReader !== "function") {
                cancelBody(response); throw failure("unsupported");
            }
            reader = response.body.getReader();
            clearTimeout(scope.timer);
            let line = "", data = "", eventType = "", discarded = false, carriage = false;
            const decoder = new TextDecoder("utf-8", { fatal: true });
            const publish = value => {
                const pending = waiting.shift();
                if (pending) pending.resolve(value);
                else if (queue.length < 128) queue.push(value);
                else stop(failure("capacity"));
            };
            function consumeLine() {
                if (!line) {
                    if (!discarded && eventType === "catch_up_truncated") throw failure("replay");
                    if (!discarded && data && (eventType === "client_event" || eventType === "message" || !eventType)) {
                        let value;
                        try { value = JSON.parse(data); } catch { /* 不保留不属于协议的消息。 */ }
                        const number = sequence(value?.sequence_num);
                        if (record(value) && number !== null && number > cursor) {
                            cursor = number;
                            const payload = value.payload;
                            if (payload?.type === "control_response" && record(payload.response)) {
                                const parsed = parseSignalId(payload.response.request_id);
                                if (parsed) publish({ ...parsed, ok: payload.response.subtype === "success"
                                    && Array.isArray(payload.response.response?.mcpServers) });
                            }
                        }
                    }
                    data = ""; eventType = ""; discarded = false;
                } else if (!discarded) {
                    if (line.startsWith("data:")) {
                        const value = line.slice(5).replace(/^ /, "");
                        if (data.length + value.length + 1 > MaxFrameChars) { discarded = true; data = ""; }
                        else data += (data ? "\n" : "") + value;
                    } else if (line.startsWith("event:")) eventType = line.slice(6).trim();
                }
                line = "";
            }
            async function pump() {
                try {
                    while (!stopped) {
                        const { value, done } = await guarded(scope, () => reader.read());
                        if (done) throw failure("stream-ended");
                        if (!(value instanceof Uint8Array) || value.byteLength > MaxBodyBytes) throw failure("size");
                        const text = decoder.decode(value, { stream: true });
                        for (const character of text) {
                            if (character === "\n" && carriage) { carriage = false; continue; }
                            carriage = character === "\r";
                            if (character === "\n" || carriage) consumeLine();
                            else if (!discarded) {
                                if (line.length + data.length >= MaxFrameChars) { discarded = true; line = "x"; data = ""; }
                                else line += character;
                            } else line = "x";
                            if (stopped) break;
                        }
                    }
                } catch (error) { stop(error?.code ? error : failure()); }
                finally {
                    scope.controller.signal.removeEventListener("abort", aborted);
                    try { reader.releaseLock(); } catch { /* 读取已由取消关闭。 */ }
                }
            }
            void pump();
            if (stopped) throw terminal;
            return { next() {
                if (stopped) return Promise.reject(terminal);
                if (queue.length) return Promise.resolve(queue.shift());
                return new Promise((resolve, reject) => waiting.push({ resolve, reject }));
            }, dispose() { stop(); return Promise.resolve(); } };
        } catch (error) {
            stop(error?.code ? error : failure());
            scope.controller.signal.removeEventListener("abort", aborted);
            throw terminal;
        }
    }

    function dispose() {
        if (disposed) return Promise.resolve();
        disposed = true;
        for (const scope of [...scopes]) { scope.controller.abort(); scope.finish(); }
        return Promise.resolve();
    }

    return { get, patch, watch, notify, dispose };
}

module.exports = { createTransport };
