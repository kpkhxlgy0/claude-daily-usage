'use strict';

const { randomUUID } = require('node:crypto');
const { hostname: readHostname } = require('node:os');
const { isDeepStrictEqual } = require('node:util');
const { normalizeThreadId } = require('./protocol.cjs');
const protocol = require('./remote-protocol.cjs');
const { createRemoteBindings, bindingKey } = require('./remote-bindings.cjs');
const { readFrameBinding } = require('./claude-binding.cjs');

const CleanupMs = 2000;
const MaxActive = 8;
const MaxRecords = 4096;
const MaxHostNames = 256;
const NameRefreshMs = 3500;
const NameConcurrency = 4;
const failure = code => Object.assign(new Error(code), { code });
const aborted = () => Object.assign(failure('cancelled'), { name: 'AbortError' });
const hostKey = binding => `${binding.organizationId}:${binding.bridgeSessionId}`;
const equal = isDeepStrictEqual;
const ownedPath = key => '/' + key;

function createRemoteAdapter({ service, claudeHome, claudeData, transport, now = Date.now,
    bindingSource, frameBinding = readFrameBinding, hostname = readHostname, nameCache })
{
    const source = bindingSource || createRemoteBindings({ claudeHome, claudeData });
    const runners = new Map();
    const frames = new WeakMap();
    const cache = new Map();
    const accepted = new Map();
    const names = new Map();
    const nameGenerations = new Map();
    const callers = new Set();
    const tasks = new Set();
    const lifetime = new AbortController();
    const viewerId = randomUUID();
    let identity;
    let stopped = false;
    let refreshing;
    let refreshAgain = false;
    let refreshQueued = false;
    let disposal;

    try
    {
        const entries = nameCache?.get();
        if (Array.isArray(entries)) for (const entry of entries.slice(-MaxHostNames))
        {
            if (!entry || typeof entry !== 'object' || Array.isArray(entry)
                || Object.keys(entry).length !== 3
                || !['hostId', 'machineId', 'displayName'].every(key => Object.hasOwn(entry, key))
                || typeof entry.hostId !== 'string') continue;
            const [organizationId, bridgeSessionId, extra] = entry.hostId.split(':');
            if (extra !== undefined || !organizationId || normalizeThreadId(organizationId) !== organizationId
                || !bridgeSessionId || protocol.normalizeBridgeId(bridgeSessionId) !== bridgeSessionId
                || !entry.machineId || normalizeThreadId(entry.machineId) !== entry.machineId
                || !entry.displayName || protocol.normalizeMachineName(entry.displayName) !== entry.displayName) continue;
            names.set(entry.hostId, { machineId: entry.machineId, displayName: entry.displayName });
        }
    }
    catch { /* 缓存损坏不影响统计查询。 */ }

    function track(promise)
    {
        tasks.add(promise);
        promise.finally(() => tasks.delete(promise)).catch(() => {});
        return promise;
    }

    function check(signal)
    {
        if (stopped || signal?.aborted) throw aborted();
    }

    async function step(promise, signal)
    {
        check(signal);
        let abort;
        const cancellation = new Promise((_resolve, reject) =>
        {
            abort = () => reject(aborted());
            signal?.addEventListener('abort', abort, { once: true });
        });
        try
        {
            const value = await Promise.race([promise, cancellation]);
            check(signal);
            return value;
        }
        finally { signal?.removeEventListener('abort', abort); }
    }

    async function cleanupScope(callback)
    {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), CleanupMs);
        timer.unref?.();
        try { await callback(controller.signal); }
        catch { /* 独立清理失败后由请求有效期保护，不重试或轮询。 */ }
        finally { clearTimeout(timer); }
    }

    async function removeValue(binding, key, value, signal)
    {
        await transport.patch(binding, [{ op: 'test', path: ownedPath(key), value },
            { op: 'remove', path: ownedPath(key) }], { signal });
    }

    async function removeAdvertisement(runner, signal)
    {
        if (runner.capabilitiesV2) await removeValue(runner.binding, protocol.CapabilitiesV2Key,
            runner.capabilitiesV2, signal).catch(() => {});
        if (runner.capabilities) await removeValue(runner.binding, protocol.CapsKey,
            runner.capabilities, signal).catch(() => {});
        if (runner.machine) await removeValue(runner.binding, protocol.MachineKey,
            runner.machine, signal).catch(() => {});
    }

    function sweep(runner)
    {
        for (const [id, entry] of runner.records)
            if (!entry.active && entry.expiresAt < now()) runner.records.delete(id);
    }

    async function prune(runner, metadata, signal)
    {
        const operations = [];
        for (const [key, value] of Object.entries(metadata))
        {
            if (value?.publisherId !== identity.publisherId || value.source !== 'com.kpk.daily-usage'
                || !Number.isSafeInteger(value.expiresAt) || value.expiresAt >= now()) continue;
            let owned = false;
            try { owned = key === protocol.requestKey(value.requestId) || key === protocol.resultKey(value.requestId); }
            catch { /* 仅清理当前协议的自有键。 */ }
            if (owned)
            {
                const extra = [{ op: 'test', path: ownedPath(key), value }];
                if (key === protocol.requestKey(value.requestId)
                    && metadata[protocol.resultKey(value.requestId)] === null)
                    extra.push({ op: 'test', path: ownedPath(protocol.resultKey(value.requestId)), value: null },
                        { op: 'remove', path: ownedPath(protocol.resultKey(value.requestId)) });
                extra.push({ op: 'remove', path: ownedPath(key) });
                if (operations.length + extra.length > 32) break;
                operations.push(...extra);
            }
        }
        if (operations.length) await transport.patch(runner.binding, operations, { signal }).catch(() => {});
        sweep(runner);
    }

    async function stopRunner(runner, cleanupResults = true)
    {
        runner.controller.abort();
        for (const entry of runner.records.values()) entry.controller?.abort();
        await runner.watch?.dispose().catch(() => {});
        await runner.listening?.catch(() => {});
        await cleanupScope(async signal =>
        {
            await removeAdvertisement(runner, signal);
            for (const [id, entry] of runner.records)
                if (cleanupResults && entry.result) await removeValue(runner.binding, protocol.resultKey(id), entry.result, signal)
                    .catch(() => {});
        });
    }

    async function receiveQuery(runner, requestId)
    {
        sweep(runner);
        if (runner.records.has(requestId) || runner.records.size >= MaxRecords) return;
        let active = 0;
        for (const state of runners.values())
            for (const entry of state.records.values()) if (entry.active) active++;
        if (active >= MaxActive) return;
        const controller = new AbortController();
        const entry = { active: true, controller, expiresAt: now() + protocol.MaxDemandMs };
        runner.records.set(requestId, entry);
        const close = () => controller.abort();
        runner.controller.signal.addEventListener('abort', close, { once: true });
        let timer;
        try
        {
            await refresh(false);
            if (runners.get(runner.key) !== runner) return;
            const detail = await step(transport.get(runner.binding, { signal: controller.signal }), controller.signal);
            const marker = detail.metadata[protocol.requestKey(requestId)];
            const caps = detail.metadata[protocol.CapsKey];
            if (!protocol.validateCapabilities(caps).ok || !equal(caps, runner.capabilities)
                || !protocol.validateMarker(marker, { binding: runner.binding, now: now() }).ok
                || marker.requestId !== requestId || marker.publisherId !== identity.publisherId
                || marker.action !== 'query' || marker.sequence !== 1) return;
            entry.marker = marker;
            entry.expiresAt = marker.expiresAt;
            await prune(runner, detail.metadata, controller.signal);
            check(controller.signal);
            timer = setTimeout(close, Math.max(1, Math.min(protocol.MaxDemandMs, marker.expiresAt - now())));
            timer.unref?.();
            let value;
            try
            {
                value = await step(service.query({ signal: controller.signal,
                    organizationId: runner.binding.organizationId }), controller.signal);
            }
            catch (error)
            {
                if (controller.signal.aborted || error?.name === 'AbortError') return;
                value = { status: 'error' };
            }
            check(controller.signal);
            if (runners.get(runner.key) !== runner || now() >= marker.expiresAt) return;
            const capabilitiesV2 = detail.metadata[protocol.CapabilitiesV2Key];
            const weekly = marker.snapshotVersion === protocol.WeeklySnapshotVersion
                && protocol.supportsWeeklySnapshots(capabilitiesV2, caps);
            const result = protocol.makeResult({ requestId, publisherId: identity.publisherId,
                expiresAt: marker.expiresAt, now: now(), status: value?.status === 'ok' ? 'ok' : 'error',
                ...(weekly ? { snapshotVersion: marker.snapshotVersion } : {}),
                ...(value?.status === 'ok' ? { snapshot: value.snapshot } : { error: 'source-unavailable' }) });
            const key = protocol.resultKey(requestId);
            if (detail.metadata[key] !== null) return;
            await step(transport.patch(runner.binding, [
                { op: 'test', path: ownedPath(protocol.requestKey(requestId)), value: marker },
                { op: 'test', path: ownedPath(protocol.CapsKey), value: runner.capabilities },
                ...(weekly ? [{ op: 'test', path: ownedPath(protocol.CapabilitiesV2Key), value: capabilitiesV2 }] : []),
                { op: 'test', path: ownedPath(key), value: null },
                { op: 'replace', path: ownedPath(key), value: result }
            ], { signal: controller.signal }), controller.signal);
            entry.result = result;
            check(controller.signal);
            await step(transport.notify(runner.binding, requestId, 'result', { signal: controller.signal }),
                controller.signal);
            // POST 接受并不代表查看者已收到 SSE；保留结果直到查看者读取并清理。
        }
        catch { /* 单次请求失败不会触发重连、日志泄漏或后台重试。 */ }
        finally
        {
            clearTimeout(timer);
            runner.controller.signal.removeEventListener('abort', close);
            entry.active = false;
            entry.controller = null;
        }
    }

    function receiveCancel(runner, requestId)
    {
        sweep(runner);
        const entry = runner.records.get(requestId);
        if (entry) entry.controller?.abort();
        else if (runner.records.size < MaxRecords)
            runner.records.set(requestId, { active: false, expiresAt: now() + protocol.MaxDemandMs });
    }

    async function listen(runner)
    {
        try
        {
            for (;;)
            {
                const signal = await runner.watch.next();
                if (stopped || runner.controller.signal.aborted || runners.get(runner.key) !== runner) return;
                if (!protocol.parseSignalId(protocol.signalId(signal.requestId, signal.kind))) continue;
                if (signal.kind === 'cancel') receiveCancel(runner, signal.requestId);
                else if (signal.kind === 'query' && signal.ok) track(receiveQuery(runner, signal.requestId));
            }
        }
        catch
        {
            if (runner.controller.signal.aborted) return;
            runner.failed = true;
            for (const entry of runner.records.values()) entry.controller?.abort();
            await runner.watch?.dispose().catch(() => {});
            await cleanupScope(signal => removeAdvertisement(runner, signal));
        }
    }

    async function connect(runner)
    {
        try
        {
            const signal = runner.controller.signal;
            runner.watch = await step(transport.watch(runner.binding, { signal }), signal);
            check(signal);
            let detail = await step(transport.get(runner.binding, { signal }), signal);
            const value = protocol.makeCapabilities(identity);
            runner.capabilities = value;
            for (let attempt = 0; ; attempt++)
            {
                const operations = [{ op: 'test', path: '', value: detail.metadata },
                    { op: 'add', path: ownedPath(protocol.CapsKey), value }];
                runner.capabilitiesV2 = null;
                const previousV2 = detail.metadata[protocol.CapabilitiesV2Key];
                if (!Object.hasOwn(detail.metadata, protocol.CapabilitiesV2Key)
                    || protocol.validateCapabilities(previousV2).ok)
                {
                    runner.capabilitiesV2 = value;
                    operations.push({ op: 'add', path: ownedPath(protocol.CapabilitiesV2Key), value });
                }
                let machine;
                try
                {
                    const previous = detail.metadata[protocol.MachineKey];
                    if (!Object.hasOwn(detail.metadata, protocol.MachineKey)
                        || protocol.validateMachine(previous, protocol.makeCapabilities(previous)).ok)
                    {
                        machine = protocol.makeMachine(identity, hostname());
                        operations.push({ op: 'add', path: ownedPath(protocol.MachineKey), value: machine });
                    }
                }
                catch { /* 无效主机名或旧元数据不得阻断原有统计能力。 */ }
                runner.machine = machine;
                try { await step(transport.patch(runner.binding, operations, { signal }), signal); break; }
                catch (error)
                {
                    if (attempt || error?.code !== 'metadata-conflict') throw error;
                    detail = await step(transport.get(runner.binding, { signal }), signal);
                }
            }
            check(signal);
            runner.failed = false;
            runner.listening = track(listen(runner));
        }
        catch
        {
            runner.failed = true;
            await runner.watch?.dispose().catch(() => {});
            await cleanupScope(signal => removeAdvertisement(runner, signal));
        }
    }

    async function listBindings()
    {
        const values = typeof source === 'function' ? await source() : await source.listActiveBindings();
        return Array.isArray(values) ? values.filter(protocol.validBinding) : [];
    }

    async function refresh(retry)
    {
        if (stopped || !identity) return;
        if (refreshing)
        {
            refreshAgain = true;
            return refreshing;
        }
        refreshing = (async () =>
        {
            do
            {
                refreshAgain = false;
                const bindings = await listBindings().catch(() => []);
                if (stopped) return;
                const selected = new Map(bindings.map(binding => [bindingKey(binding), binding]));
                for (const [key, runner] of runners)
                    if (!selected.has(key))
                    {
                        runners.delete(key);
                        await stopRunner(runner);
                    }
                for (const [key, binding] of selected)
                {
                    let runner = runners.get(key);
                    if (runner && (!retry || !runner.failed)) continue;
                    const records = runner?.records || new Map();
                    if (runner) { runners.delete(key); await stopRunner(runner, false); }
                    runner = { key, binding, controller: new AbortController(), records, failed: false };
                    runners.set(key, runner);
                    await connect(runner);
                }
            } while (refreshAgain && !stopped);
        })().finally(() => { refreshing = null; });
        return refreshing;
    }

    function bindingChanged()
    {
        if (stopped || refreshQueued) return;
        refreshQueued = true;
        queueMicrotask(() =>
        {
            refreshQueued = false;
            if (!stopped) track(refresh(true));
        });
    }

    const unsubscribe = source.subscribe?.(bindingChanged);
    const ready = Promise.resolve(service.ready).then(async () =>
    {
        if (stopped) return;
        identity = service.getIdentity();
        protocol.makeCapabilities(identity);
        await refresh(false);
    }).catch(() => {});

    function unavailable(hostId, error)
    {
        const previous = cache.get(hostId);
        return { ...(previous || {}), status: previous?.snapshot ? 'stale' : 'unavailable', error, progress: null };
    }

    function acceptName(hostId, metadata)
    {
        const caps = metadata?.[protocol.CapsKey];
        if (!protocol.validateCapabilities(caps).ok) return;
        const previous = names.get(hostId);
        const machine = metadata[protocol.MachineKey];
        if (protocol.validateMachine(machine, caps).ok)
        {
            if (previous?.machineId === machine.machineId && previous.displayName === machine.displayName) return;
            names.delete(hostId);
            if (names.size >= MaxHostNames) names.delete(names.keys().next().value);
            names.set(hostId, { machineId: machine.machineId, displayName: machine.displayName });
        }
        else if (previous && previous.machineId !== caps.machineId) names.delete(hostId);
        else return;
        try
        {
            Promise.resolve(nameCache?.set([...names].map(([hostId, value]) => ({ hostId, ...value }))))
                .catch(() => {});
        }
        catch { /* 本地缓存不可写时仍保留当前页面名称。 */ }
    }

    async function refreshHostNames(frame, { signal } = {})
    {
        if (stopped || signal?.aborted) return;
        const selected = frame && frames.get(frame);
        if (!selected?.size) return;
        const bindings = [...selected].map(([hostId, value]) => ({ hostId, binding: { ...value.binding } }));
        const generation = Symbol();
        for (const { hostId } of bindings) nameGenerations.set(hostId, generation);
        const controller = new AbortController();
        const stop = () => controller.abort();
        signal?.addEventListener('abort', stop, { once: true });
        lifetime.signal.addEventListener('abort', stop, { once: true });
        callers.add(controller);
        const timer = setTimeout(stop, NameRefreshMs);
        timer.unref?.();
        let index = 0;
        async function worker()
        {
            while (!stopped && !controller.signal.aborted && index < bindings.length)
            {
                const { hostId, binding } = bindings[index++];
                try
                {
                    const detail = await step(transport.get(binding, { signal: controller.signal }), controller.signal);
                    check(controller.signal);
                    if (nameGenerations.get(hostId) === generation) acceptName(hostId, detail?.metadata);
                }
                catch { /* 离线、旧端点和取消都保留已验证的名称，不重试。 */ }
            }
        }
        try { await Promise.all(Array.from({ length: Math.min(NameConcurrency, bindings.length) }, worker)); }
        finally
        {
            clearTimeout(timer);
            stop();
            signal?.removeEventListener('abort', stop);
            lifetime.signal.removeEventListener('abort', stop);
            callers.delete(controller);
            for (const { hostId } of bindings)
                if (nameGenerations.get(hostId) === generation) nameGenerations.delete(hostId);
        }
    }

    async function query(hostId, { signal, frame } = {})
    {
        const selected = frame && frames.get(frame)?.get(hostId);
        if (stopped || signal?.aborted) return unavailable(hostId, 'cancelled');
        if (!selected) return unavailable(hostId, 'host-unavailable');
        const binding = selected.binding;
        const controller = new AbortController();
        const stop = () => controller.abort();
        signal?.addEventListener('abort', stop, { once: true });
        lifetime.signal.addEventListener('abort', stop, { once: true });
        callers.add(controller);
        let watch;
        let marker;
        let received;
        let write;
        let advertised = false;
        let success = false;
        const timer = setTimeout(stop, protocol.MaxDemandMs);
        timer.unref?.();
        try
        {
            await step(ready, controller.signal);
            await step(refresh(true), controller.signal);
            let detail = await step(transport.get(binding, { signal: controller.signal }), controller.signal);
            const caps = detail.metadata[protocol.CapsKey];
            if (!protocol.validateCapabilities(caps).ok) throw failure('snapshot-update-required');
            watch = await step(transport.watch(binding, { signal: controller.signal }), controller.signal);
            const requestId = protocol.createRequestId();
            const key = protocol.requestKey(requestId);
            const resultKey = protocol.resultKey(requestId);
            for (let attempt = 0; ; attempt++)
            {
                if (Object.hasOwn(detail.metadata, key) || Object.hasOwn(detail.metadata, resultKey))
                    throw failure('request-conflict');
                const weekly = protocol.supportsWeeklySnapshots(detail.metadata[protocol.CapabilitiesV2Key], caps);
                marker = protocol.makeMarker({ requestId, publisherId: caps.publisherId,
                    viewerId, binding, now: now(), ...(weekly ? { snapshotVersion: protocol.WeeklySnapshotVersion } : {}) });
                write = transport.patch(binding, [{ op: 'test', path: '', value: detail.metadata },
                    { op: 'add', path: ownedPath(key), value: marker },
                    { op: 'add', path: ownedPath(resultKey), value: null }], { signal: controller.signal });
                try { await step(write, controller.signal); break; }
                catch (error)
                {
                    if (attempt || error?.code !== 'metadata-conflict') throw error;
                    detail = await step(transport.get(binding, { signal: controller.signal }), controller.signal);
                    if (!equal(detail.metadata[protocol.CapsKey], caps)) throw failure('snapshot-identity');
                }
            }
            advertised = true;
            await step(transport.notify(binding, marker.requestId, 'query', { signal: controller.signal }),
                controller.signal);
            for (;;)
            {
                const event = await step(watch.next(), controller.signal);
                if (event.requestId !== marker.requestId) continue;
                if (!event.ok) throw failure('transport-unsupported');
                if (event.kind !== 'result') continue;
                break;
            }
            const response = await step(transport.get(binding, { signal: controller.signal }), controller.signal);
            if (!equal(response.metadata[protocol.CapsKey], caps)) throw failure('snapshot-identity');
            received = response.metadata[protocol.resultKey(marker.requestId)];
            const parsed = protocol.validateResult(received, { requestId: marker.requestId,
                publisherId: caps.publisherId, machineId: caps.machineId, snapshotVersion: marker.snapshotVersion,
                now: now() });
            if (!parsed.ok) throw failure(parsed.reason === 'update-required'
                ? 'snapshot-update-required' : 'snapshot-invalid');
            if (received.status !== 'ok') throw failure(received.status === 'cancelled' ? 'cancelled' : 'source-unavailable');
            check(controller.signal);
            const history = accepted.get(hostId);
            const previous = history?.snapshot;
            if (previous?.publisherId === parsed.snapshot.publisherId
                && (parsed.snapshot.revision < previous.revision || parsed.snapshot.generatedAt < previous.generatedAt
                    || parsed.snapshot.revision === previous.revision && !equal(parsed.snapshot, previous)))
                throw failure('snapshot-replay');
            if (previous && previous.publisherId !== parsed.snapshot.publisherId)
            {
                if (history.retired.has(parsed.snapshot.publisherId)
                    || parsed.snapshot.generatedAt <= previous.generatedAt || history.retired.size >= 32)
                    throw failure('snapshot-replay');
                history.retired.add(previous.publisherId);
            }
            const value = { status: 'ok', snapshot: parsed.snapshot, progress: null };
            accepted.set(hostId, { snapshot: parsed.snapshot, retired: history?.retired || new Set() });
            cache.set(hostId, value);
            success = true;
            return value;
        }
        catch (error)
        {
            return unavailable(hostId, controller.signal.aborted || error?.name === 'AbortError'
                ? 'cancelled' : typeof error?.code === 'string' ? error.code : 'transport');
        }
        finally
        {
            clearTimeout(timer);
            signal?.removeEventListener('abort', stop);
            lifetime.signal.removeEventListener('abort', stop);
            callers.delete(controller);
            await watch?.dispose().catch(() => {});
            if (marker) await cleanupScope(async cleanupSignal =>
            {
                // 被取消的 PATCH 可能已被服务端接受；等待它退出后再做独立 CAS 清理。
                if (write) await Promise.race([write.catch(() => {}), new Promise(resolve =>
                {
                    if (cleanupSignal.aborted) resolve();
                    else cleanupSignal.addEventListener('abort', resolve, { once: true });
                })]);
                if (cleanupSignal.aborted) return;
                let current = marker;
                if (!success)
                {
                    const cancel = protocol.makeMarker({ requestId: marker.requestId,
                        publisherId: marker.publisherId, viewerId, binding, now: now() }, 'cancel', marker);
                    try
                    {
                        await transport.patch(binding, [{ op: 'test', path: ownedPath(protocol.requestKey(marker.requestId)),
                            value: marker }, { op: 'replace', path: ownedPath(protocol.requestKey(marker.requestId)),
                            value: cancel }], { signal: cleanupSignal });
                        current = cancel;
                    }
                    catch { /* 原请求未发布或已由其他所有者清理。 */ }
                    if (advertised || current !== marker)
                        await transport.notify(binding, marker.requestId, 'cancel', { signal: cleanupSignal }).catch(() => {});
                }
                if (!received)
                {
                    try
                    {
                        await transport.patch(binding, [
                            { op: 'test', path: ownedPath(protocol.requestKey(marker.requestId)), value: current },
                            { op: 'test', path: ownedPath(protocol.resultKey(marker.requestId)), value: null },
                            { op: 'remove', path: ownedPath(protocol.resultKey(marker.requestId)) },
                            { op: 'remove', path: ownedPath(protocol.requestKey(marker.requestId)) }
                        ], { signal: cleanupSignal });
                        return;
                    }
                    catch { /* 已完成结果不属于空占位，不得覆盖或盲删。 */ }
                }
                await removeValue(binding, protocol.requestKey(marker.requestId), current, cleanupSignal).catch(() => {});
                if (received) await removeValue(binding, protocol.resultKey(marker.requestId), received, cleanupSignal)
                    .catch(() => {});
            });
        }
    }

    return {
        ready,
        getHosts(frame)
        {
            const selected = frame && frames.get(frame);
            return selected ? [...selected.values()].map(value => ({ hostId: hostKey(value.binding),
                label: `远程 · ${names.get(hostKey(value.binding))?.displayName || value.binding.bridgeSessionId}` })) : [];
        },
        async discover(frame)
        {
            if (stopped || !frame || typeof frame !== 'object') return;
            const url = frame.url;
            const binding = await frameBinding(frame);
            if (stopped || frame.url !== url) return;
            if (!protocol.validBinding(binding)) return;
            let selected = frames.get(frame);
            if (!selected) { selected = new Map(); frames.set(frame, selected); }
            const normalized = { bridgeSessionId: protocol.normalizeBridgeId(binding.bridgeSessionId),
                organizationId: binding.organizationId.toLowerCase() };
            const key = hostKey(normalized);
            if (selected.size >= 256 && !selected.has(key)) selected.delete(selected.keys().next().value);
            selected.set(key, { binding: normalized, url });
        },
        query: (hostId, options) => track(query(hostId, options)),
        refreshHostNames: (frame, options) => track(refreshHostNames(frame, options)),
        dispose()
        {
            if (disposal) return disposal;
            stopped = true;
            lifetime.abort();
            for (const controller of callers) controller.abort();
            unsubscribe?.();
            source.dispose?.();
            disposal = (async () =>
            {
                await ready;
                if (refreshing) await refreshing;
                await Promise.allSettled([...runners.values()].map(stopRunner));
                runners.clear();
                await Promise.allSettled([...tasks]);
                await transport.dispose();
            })();
            return disposal;
        }
    };
}

module.exports = { createRemoteAdapter };
