"use strict";

const { randomUUID } = require("node:crypto");
const { deflateSync, inflateSync } = require("node:zlib");
const { normalizeThreadId, snapshotForPeer, validateSnapshot, MaxSnapshotBytes, FutureSkewMs } = require("./protocol.cjs");

const Source = "com.kpk.daily-usage";
const CapsKey = "claudepp_daily_usage";
const CapabilitiesV2Key = "claudepp_daily_usage_capabilities_v2";
const CapabilitiesV3Key = "claudepp_daily_usage_capabilities_v3";
const MachineKey = "claudepp_daily_usage_machine";
const WeeklySnapshotVersion = 2;
const HistorySnapshotVersion = 3;
const MaxDemandMs = 300000;
const MaxCompressedBytes = 64 * 1024;
const Prefixes = { query: "d411ea01", result: "d411ea02", cancel: "d411ea03" };
const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const fields = (value, keys) => record(value) && Object.keys(value).length === keys.length
    && keys.every(key => Object.hasOwn(value, key));
const version = value => value.source === Source && value.schemaVersion === 1 && value.demandVersion === 1;
const invalid = reason => ({ ok: false, reason });
const base = () => ({ source: Source, schemaVersion: 1, demandVersion: 1 });
const uuid = value => normalizeThreadId(value) === value;
const requestId = value => uuid(value) && value.startsWith(Prefixes.query + "-");

function createRequestId() {
    return Prefixes.query + randomUUID().slice(8);
}

function signalId(id, kind) {
    if (!requestId(id) || !Object.hasOwn(Prefixes, kind)) throw new TypeError("Invalid Daily Usage signal");
    return Prefixes[kind] + id.slice(8);
}

function parseSignalId(value) {
    const normalized = normalizeThreadId(value);
    if (!normalized) return null;
    const kind = Object.keys(Prefixes).find(key => normalized.startsWith(Prefixes[key] + "-"));
    return kind ? { requestId: Prefixes.query + normalized.slice(8), kind } : null;
}

function normalizeBridgeId(value) {
    const match = typeof value === "string" && /^(?:cse_|session_)([A-Za-z0-9_-]{1,128})$/.exec(value);
    return match && match[0] === value ? "session_" + match[1] : null;
}

function validBinding(value) {
    return record(value) && Boolean(normalizeBridgeId(value.bridgeSessionId))
        && Boolean(normalizeThreadId(value.organizationId))
        && (value.accountId === undefined || Boolean(normalizeThreadId(value.accountId)));
}

function requestKey(id) {
    if (!requestId(id)) throw new TypeError("Invalid Daily Usage request ID");
    return CapsKey + "_request_" + id;
}

function resultKey(id) {
    if (!requestId(id)) throw new TypeError("Invalid Daily Usage request ID");
    return CapsKey + "_result_" + id;
}

function makeCapabilities(identity) {
    const value = { ...base(), machineId: identity?.machineId, publisherId: identity?.publisherId };
    if (!validateCapabilities(value).ok) throw new TypeError("Invalid Daily Usage identity");
    return value;
}

function validateCapabilities(value) {
    return fields(value, ["source", "schemaVersion", "demandVersion", "machineId", "publisherId"])
        && version(value) && uuid(value.machineId) && uuid(value.publisherId) ? { ok: true } : invalid("invalid");
}

function snapshotCapabilityKey(version) {
    if (version === HistorySnapshotVersion) return CapabilitiesV3Key;
    if (version === WeeklySnapshotVersion) return CapabilitiesV2Key;
}

function supportsWeeklySnapshots(advertisement, capabilities) {
    return validateCapabilities(advertisement).ok && validateCapabilities(capabilities).ok
        && advertisement.machineId === capabilities.machineId && advertisement.publisherId === capabilities.publisherId;
}

function normalizeMachineName(value) {
    if (typeof value !== "string" || /\p{Cc}/u.test(value)) return null;
    const name = value.trim();
    return name.length > 0 && name.length <= 256 ? name : null;
}

function makeMachine(identity, displayName) {
    const caps = makeCapabilities(identity);
    const name = normalizeMachineName(displayName);
    if (!name) throw new TypeError("Invalid Daily Usage machine name");
    return { ...caps, displayName: name };
}

function validateMachine(value, capabilities) {
    return validateCapabilities(capabilities).ok
        && fields(value, ["source", "schemaVersion", "demandVersion", "machineId", "publisherId", "displayName"])
        && version(value) && value.machineId === capabilities.machineId && value.publisherId === capabilities.publisherId
        && typeof value.displayName === "string" && normalizeMachineName(value.displayName) === value.displayName
        ? { ok: true } : invalid("invalid");
}

function makeMarker(options, action = "query", original) {
    if (!record(options) || !validBinding(options.binding) || !integer(options.now)
        || !requestId(options.requestId) || !uuid(options.publisherId) || !uuid(options.viewerId)) {
        throw new TypeError("Invalid Daily Usage marker");
    }
    const { binding, now, requestId: id, publisherId, viewerId, snapshotVersion } = options;
    const bridgeSessionId = normalizeBridgeId(binding.bridgeSessionId);
    const organizationId = normalizeThreadId(binding.organizationId);
    if (action === "cancel") {
        if (!validateMarker(original, { binding, now: original?.requestedAt }).ok || original.action !== "query"
            || original.requestId !== id || original.publisherId !== publisherId || original.viewerId !== viewerId) {
            throw new TypeError("Cancellation requires its original Daily Usage marker");
        }
        return { ...original, action: "cancel", sequence: 2 };
    }
    if (action !== "query" || !Number.isSafeInteger(now + MaxDemandMs)
        || snapshotVersion !== undefined && !snapshotCapabilityKey(snapshotVersion)) {
        throw new TypeError("Invalid Daily Usage marker");
    }
    return { ...base(), requestId: id, publisherId, viewerId, bridgeSessionId, organizationId,
        action, sequence: 1, requestedAt: now, expiresAt: now + MaxDemandMs,
        ...(snapshotVersion !== undefined ? { snapshotVersion } : {}) };
}

function validateMarker(value, options = {}) {
    if (!record(options)) return invalid("invalid");
    const { binding, now = Date.now() } = options;
    const keys = ["source", "schemaVersion", "demandVersion", "requestId", "publisherId", "viewerId",
        "bridgeSessionId", "organizationId", "action", "sequence", "requestedAt", "expiresAt"];
    if (snapshotCapabilityKey(value?.snapshotVersion)) keys.push("snapshotVersion");
    if (!validBinding(binding) || !integer(now)
        || !fields(value, keys)
        || !version(value) || !requestId(value.requestId) || !uuid(value.publisherId) || !uuid(value.viewerId)
        || value.bridgeSessionId !== normalizeBridgeId(binding.bridgeSessionId)
        || value.organizationId !== normalizeThreadId(binding.organizationId)
        || !(value.action === "query" && value.sequence === 1 || value.action === "cancel" && value.sequence === 2)
        || !integer(value.requestedAt) || !integer(value.expiresAt) || value.expiresAt <= value.requestedAt
        || value.expiresAt - value.requestedAt > MaxDemandMs || value.requestedAt - now > FutureSkewMs
        || value.expiresAt <= now) return invalid("invalid");
    return { ok: true };
}

function makeResult(options) {
    if (!record(options)) throw new TypeError("Invalid Daily Usage result");
    const { requestId: id, publisherId, expiresAt, status, snapshot, snapshotVersion, error,
        now = Date.now() } = options;
    const value = { ...base(), requestId: id, publisherId, updatedAt: now, expiresAt, status };
    if (status === "ok") {
        if (!validateSnapshot(snapshot, { now }).ok || snapshot.publisherId !== publisherId) {
            throw new TypeError("Invalid Daily Usage snapshot");
        }
        let projected = snapshotForPeer(snapshot, snapshotVersion);
        for (;;) {
            const bytes = Buffer.from(JSON.stringify(projected), "utf8");
            const compressed = deflateSync(bytes);
            if (compressed.length <= MaxCompressedBytes) {
                value.data = { encoding: "deflate-base64", bytes: bytes.length, dataBase64: compressed.toString("base64") };
                break;
            }
            if (projected.schemaVersion === 1) {
                value.status = "error";
                value.error = "snapshot-too-large";
                break;
            }
            projected = snapshotForPeer(projected, projected.schemaVersion - 1);
        }
    } else if (status === "error") value.error = error;
    if (!validateResult(value, { requestId: id, publisherId, machineId: snapshot?.machineId, snapshotVersion, now }).ok) {
        throw new TypeError("Invalid Daily Usage result");
    }
    return value;
}

function validateResult(value, options = {}) {
    if (!record(options)) return invalid("invalid");
    const { requestId: id, publisherId, machineId, snapshotVersion, now = Date.now() } = options;
    const keys = ["source", "schemaVersion", "demandVersion", "requestId", "publisherId", "updatedAt", "expiresAt", "status"];
    if (value?.status === "ok") keys.push("data");
    if (value?.status === "error") keys.push("error");
    if (!integer(now) || !requestId(id) || !uuid(publisherId) || !fields(value, keys) || !version(value)
        || value.requestId !== id || value.publisherId !== publisherId || !integer(value.updatedAt)
        || !integer(value.expiresAt) || value.expiresAt <= value.updatedAt
        || value.expiresAt - value.updatedAt > MaxDemandMs + FutureSkewMs || value.expiresAt <= now
        || !["ok", "error", "cancelled"].includes(value.status)) return invalid("invalid");
    if (value.updatedAt - now > FutureSkewMs) return invalid("future");
    if (value.status === "error" && (typeof value.error !== "string"
        || !/^[a-z][a-z0-9-]{0,63}$/.test(value.error) || value.error.endsWith("\n"))) return invalid("invalid");
    if (value.status !== "ok") return { ok: true };
    const data = value.data;
    if (!uuid(machineId) || !fields(data, ["encoding", "bytes", "dataBase64"]) || data.encoding !== "deflate-base64"
        || !integer(data.bytes) || data.bytes === 0 || data.bytes > MaxSnapshotBytes
        || typeof data.dataBase64 !== "string" || data.dataBase64.length > Math.ceil(MaxCompressedBytes / 3) * 4
        || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data.dataBase64)) {
        return invalid("invalid");
    }
    try {
        const compressed = Buffer.from(data.dataBase64, "base64");
        if (!compressed.length || compressed.length > MaxCompressedBytes
            || compressed.toString("base64") !== data.dataBase64) return invalid("invalid");
        const inflated = inflateSync(compressed, { maxOutputLength: MaxSnapshotBytes, info: true });
        const bytes = inflated.buffer;
        if (inflated.engine.bytesWritten !== compressed.length || bytes.length !== data.bytes) return invalid("invalid");
        const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        const snapshot = JSON.parse(text);
        const checked = validateSnapshot(snapshot, { now });
        if (!checked.ok && checked.reason !== "update-required") return checked;
        if (snapshot.machineId !== machineId || snapshot.publisherId !== publisherId) return invalid("identity");
        if (snapshot.schemaVersion > (snapshotCapabilityKey(snapshotVersion) ? snapshotVersion : 1))
            return invalid("invalid");
        if (!checked.ok) return checked;
        return { ok: true, snapshot };
    } catch { return invalid("invalid"); }
}

module.exports = { createRequestId, signalId, parseSignalId, normalizeBridgeId, validBinding, CapsKey, MachineKey,
    CapabilitiesV2Key, CapabilitiesV3Key, WeeklySnapshotVersion, HistorySnapshotVersion, snapshotCapabilityKey,
    supportsWeeklySnapshots, normalizeMachineName, makeMachine, validateMachine,
    requestKey, resultKey, makeCapabilities, makeMarker, validateMarker, validateCapabilities, makeResult,
    validateResult, MaxDemandMs };
