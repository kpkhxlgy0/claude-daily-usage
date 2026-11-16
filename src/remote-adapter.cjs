'use strict';

const { randomUUID } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const protocol = require('./remote-protocol.cjs');
const { createRemoteBindings, bindingKey } = require('./remote-bindings.cjs');
const { readFrameBinding } = require('./claude-binding.cjs');

const CleanupMs = 2000;
const MaxActive = 8;
const MaxRecords = 4096;
const failure = code => Object.assign(new Error(code), { code });
const aborted = () => Object.assign(failure('cancelled'), { name: 'AbortError' });
const hostKey = binding => `${binding.organizationId}:${binding.bridgeSessionId}`;
const equal = isDeepStrictEqual;
const ownedPath = key => '/' + key;

function createRemoteAdapter({ service, claudeHome, claudeData, transport, now = Date.now,
    bindingSource, frameBinding = readFrameBinding })
{
    const source = bindingSource || createRemoteBindings({ claudeHome, claudeData });
    const runners = new Map();
    const frames = new WeakMap();
    const cache = new Map();
    const accepted = new Map();
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
            if (runner.capabilities) await removeValue(runner.binding, protocol.CapsKey,
                runner.capabilities, signal).catch(() => {});
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
            try { value = await step(service.query({ signal: controller.signal }), controller.signal); }
            catch (error)
            {
                if (controller.signal.aborted || error?.name === 'AbortError') return;
                value = { status: 'error' };
            }
            check(controller.signal);
            if (runners.get(runner.key) !== runner || now() >= marker.expiresAt) return;
            const result = protocol.makeResult({ requestId, publisherId: identity.publisherId,
                expiresAt: marker.expiresAt, now: now(), status: value?.status === 'ok' ? 'ok' : 'error',
                ...(value?.status === 'ok' ? { snapshot: value.snapshot } : { error: 'source-unavailable' }) });
            const key = protocol.resultKey(requestId);
            if (detail.metadata[key] !== null) return;
            await step(transport.patch(runner.binding, [
                { op: 'test', path: ownedPath(protocol.requestKey(requestId)), value: marker },
                { op: 'test', path: ownedPath(protocol.CapsKey), value: runner.capabilities },
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
            await cleanupScope(signal => runner.capabilities
                ? removeValue(runner.binding, protocol.CapsKey, runner.capabilities, signal) : Promise.resolve());
        }
    }

    async function connect(runner)
    {
        try
        {
            const signal = runner.controller.signal;
            runner.watch = await step(transport.watch(runner.binding, { signal }), signal);
            check(signal);
            const detail = await step(transport.get(runner.binding, { signal }), signal);
            const value = protocol.makeCapabilities(identity);
            const previous = detail.metadata[protocol.CapsKey];
            const operations = Object.hasOwn(detail.metadata, protocol.CapsKey)
                ? [{ op: 'test', path: ownedPath(protocol.CapsKey), value: previous }]
                : [{ op: 'test', path: '', value: detail.metadata }];
            operations.push({ op: 'add', path: ownedPath(protocol.CapsKey), value });
            runner.capabilities = value;
            await step(transport.patch(runner.binding, operations, { signal }), signal);
            check(signal);
            runner.failed = false;
            runner.listening = track(listen(runner));
        }
        catch
        {
            runner.failed = true;
            await runner.watch?.dispose().catch(() => {});
            await cleanupScope(signal => runner.capabilities
                ? removeValue(runner.binding, protocol.CapsKey, runner.capabilities, signal) : Promise.resolve());
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
            marker = protocol.makeMarker({ requestId: protocol.createRequestId(), publisherId: caps.publisherId,
                viewerId, binding, now: now() });
            const key = protocol.requestKey(marker.requestId);
            const resultKey = protocol.resultKey(marker.requestId);
            for (let attempt = 0; ; attempt++)
            {
                if (Object.hasOwn(detail.metadata, key) || Object.hasOwn(detail.metadata, resultKey))
                    throw failure('request-conflict');
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
                publisherId: caps.publisherId, machineId: caps.machineId, now: now() });
            if (!parsed.ok) throw failure('snapshot-invalid');
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
                label: `远程 · ${value.binding.bridgeSessionId}` })) : [];
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
