'use strict';
const os = require('node:os');
const path = require('node:path');
const { normalizeThreadId, validHostId } = require('./protocol.cjs');
const { withUnverifiedWeeklyOrganization } = require('./service.cjs');

const Prefix = 'claudepp:com.kpk.daily-usage:';
const MaxUsageResponseBytes = 64 * 1024;
const OrganizationReadTimeoutMs = 1000;
const concise = value => typeof value === 'string' && value.length > 0 && value.length <= 512
    && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const unavailable = error => ({ status: 'unavailable', error });

function trusted(event)
{
    try
    {
        const sender = event.sender;
        const frame = event.senderFrame;
        if (!frame || frame !== sender.mainFrame || sender.isDestroyed?.()) return null;
        const url = new URL(frame.url);
        if (url.username || url.password || !(url.origin === 'https://claude.ai'
            || url.protocol === 'app:' && url.host === 'localhost')) return null;
        return { sender, frame, url: frame.url };
    }
    catch { return null; }
}

function profileOwnsSession(session, claudeData)
{
    const sessionData = session?.storagePath;
    return Boolean(sessionData && claudeData && path.isAbsolute(sessionData) && path.isAbsolute(claudeData)
        && !path.relative(claudeData, sessionData));
}

// Read only the active organization UUID from a trusted Claude document's current UI.
function readVisibleOrganization(win)
{
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const { document } = win;
    const body = document.body;
    if (!body || document.visibilityState === 'hidden') return null;
    const organizations = new Set();
    const visited = new Set();
    for (const element of [body, ...Array.from(body.children).slice(0, 20)])
    {
        const key = Object.keys(element).find(name => name.startsWith('__reactContainer$'));
        if (!key) continue;
        const root = element[key];
        const pending = [root?.stateNode?.current ?? root];
        while (pending.length)
        {
            const node = pending.pop();
            if (!node || visited.has(node)) continue;
            visited.add(node);
            if (visited.size > 20000) return null;
            for (const props of [node.memoizedProps, node.memoizedProps?.value])
            {
                const organizationId = props?.activeOrganization?.uuid;
                if (typeof organizationId === 'string' && uuid.test(organizationId))
                    organizations.add(organizationId.toLowerCase());
            }
            if (organizations.size > 1) return null;
            pending.push(node.sibling, node.child);
        }
    }
    return [...organizations][0] ?? null;
}

function trustedWindows(BrowserWindow)
{
    return (BrowserWindow?.getAllWindows?.() || []).flatMap(window =>
    {
        try
        {
            const sender = window.webContents;
            const context = trusted({ sender, senderFrame: sender?.mainFrame });
            return context ? [context] : [];
        }
        catch { return []; }
    });
}

const OrganizationScript = '(' + readVisibleOrganization.toString() + ')(window)';

async function readLocalOrganization(context, BrowserWindow, claudeData, signal)
{
    const { session } = context.sender;
    if (!profileOwnsSession(session, claudeData) || signal?.aborted) return null;
    const frames = [context];
    if (new URL(context.url).protocol === 'app:')
    {
        for (const peer of trustedWindows(BrowserWindow))
        {
            if (peer.sender.session === session && new URL(peer.url).origin === 'https://claude.ai')
                frames.push(peer);
        }
    }
    let timer;
    try
    {
        const organizations = await Promise.race([
            Promise.all(frames.map(async ({ sender, frame, url }) =>
            {
                try
                {
                    const organizationId = normalizeThreadId(await frame.executeJavaScript?.(OrganizationScript));
                    const verified = trusted({ sender, senderFrame: frame });
                    return verified?.url === url && sender.session === session ? organizationId : null;
                }
                catch { return null; }
            })),
            new Promise(resolve => { timer = setTimeout(() => resolve([]), OrganizationReadTimeoutMs); }),
        ]);
        const known = new Set(organizations.filter(Boolean));
        return !signal?.aborted && known.size === 1 ? [...known][0] : null;
    }
    finally { clearTimeout(timer); }
}

function resetReader(BrowserWindow, getDefaultSession, claudeData)
{
    return async function readResetAt(organizationId, { signal, resetSession } = {})
    {
        const org = normalizeThreadId(organizationId);
        if (!org || signal?.aborted) return null;
        let session = resetSession;
        if (!session)
        {
            const sessions = new Set(trustedWindows(BrowserWindow).map(context => context.sender.session)
                .filter(candidate => profileOwnsSession(candidate, claudeData)));
            if (sessions.size === 1) [session] = sessions;
            else if (!sessions.size) session = getDefaultSession();
        }
        if (!profileOwnsSession(session, claudeData) || typeof session?.fetch !== 'function') return null;
        const response = await session.fetch('https://claude.ai/api/organizations/' + org + '/usage', {
            method: 'GET', credentials: 'include', redirect: 'error', cache: 'no-store', signal,
            headers: { Accept: 'application/json' },
        });
        if (!response.ok || !/^application\/json(?:;|$)/i.test(response.headers.get('content-type') || '')
            || !response.body)
        {
            void response.body?.cancel().catch(() => {});
            return response.status === 401 || response.status === 403 ? { accessDenied: true } : null;
        }
        const reader = response.body.getReader();
        const chunks = [];
        let length = 0;
        try
        {
            for (;;)
            {
                const { value, done } = await reader.read();
                if (done) break;
                length += value.byteLength;
                if (length > MaxUsageResponseBytes)
                {
                    void reader.cancel().catch(() => {});
                    return null;
                }
                chunks.push(Buffer.from(value));
            }
        }
        finally { reader.releaseLock(); }
        const weekly = JSON.parse(Buffer.concat(chunks, length).toString('utf8'))?.seven_day;
        if (typeof weekly?.resets_at !== 'string'
            || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(weekly.resets_at))
            return null;
        const resetAt = Date.parse(weekly.resets_at);
        if (!Number.isSafeInteger(resetAt)) return null;
        const percent = weekly.utilization;
        const usedPercent = Number.isFinite(percent) && percent >= 0 && percent <= 100 ? percent : null;
        return { resetAt, usedPercent };
    };
}

function startMain(api, dependencies = {})
{
    const electron = dependencies.ipcMain ? null : require('electron');
    const ipcMain = dependencies.ipcMain || electron.ipcMain;
    const BrowserWindow = dependencies.BrowserWindow || electron?.BrowserWindow;
    const serviceFactory = dependencies.serviceFactory || require('./service.cjs').createService;
    const claudeHome = dependencies.claudeHome
        || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
    const claudeData = dependencies.claudeData ?? electron?.app.getPath('userData');
    const getDefaultSession = dependencies.getDefaultSession || (() => electron?.session.defaultSession);
    const service = serviceFactory({ claudeHome, claudeData, dataDir: api.fs.dataDir,
        readResetAt: resetReader(BrowserWindow, getDefaultSession, claudeData) });
    let remote = dependencies.remoteAdapter;
    if (remote === undefined && electron)
    {
        const transport = require('./remote-transport.cjs').createTransport({
            fetch: (...args) => electron.net.fetch(...args) });
        remote = require('./remote-adapter.cjs').createRemoteAdapter({ service, claudeHome, claudeData, transport,
            nameCache: { get: () => api.storage.get('hostNames', []),
                set: entries => api.storage.set('hostNames', entries) } });
        Promise.resolve(remote.ready).catch(() => api.log.warn('Daily Usage remote listener unavailable'));
    }
    const owners = new Map();
    const discovery = new Map();
    const handlers = [];
    const listeners = [];
    let stopped = false;
    let stopping;

    function current(context)
    {
        if (stopped) return false;
        const candidate = trusted({ sender: context.sender, senderFrame: context.frame });
        return candidate !== null && candidate.url === context.url;
    }

    function release(owner)
    {
        if (owner.queries.size) return;
        for (const remove of owner.hooks) remove();
        owner.hooks.length = 0;
        if (owners.get(owner.frame) === owner) owners.delete(owner.frame);
    }

    function abort(owner)
    {
        for (const controller of owner.queries.values()) controller.abort();
    }

    function ownerFor(context)
    {
        if (owners.has(context.frame)) return owners.get(context.frame);
        const owner = { frame: context.frame, queries: new Map(), hooks: [] };
        const listen = (target, name, handler) =>
        {
            if (typeof target?.on !== 'function') return;
            target.on(name, handler);
            owner.hooks.push(() => target.removeListener(name, handler));
        };
        const cancel = () => abort(owner);
        for (const name of ['destroyed', 'render-process-gone']) listen(context.sender, name, cancel);
        listen(context.sender, 'did-start-navigation', (_event, _url, _inPlace, main) =>
        {
            if (main !== false) cancel();
        });
        const window = BrowserWindow?.fromWebContents(context.sender);
        for (const name of ['hide', 'minimize', 'closed']) listen(window, name, cancel);
        owners.set(context.frame, owner);
        return owner;
    }

    function reply(context, requestId, result)
    {
        if (!current(context)) return;
        try { context.frame.send(Prefix + 'query-result', { requestId, result }); }
        catch { /* 窗口销毁后不再发送结果。 */ }
    }

    async function query(event, payload)
    {
        const context = stopped ? null : trusted(event);
        if (!context || !record(payload) || !normalizeThreadId(payload.requestId)
            || !(payload.hostId === 'local' || validHostId(payload.hostId))
            || Object.keys(payload).some(key => key !== 'hostId' && key !== 'requestId')) return;
        const owner = ownerFor(context);
        if (owner.queries.has(payload.requestId)) return;
        const controller = new AbortController();
        owner.queries.set(payload.requestId, controller);
        let result;
        try
        {
            if (payload.hostId === 'local')
            {
                await service.ready;
                if (controller.signal.aborted) result = unavailable('cancelled');
                else
                {
                    const organizationId = await readLocalOrganization(context, BrowserWindow, claudeData, controller.signal);
                    if (!current(context) || controller.signal.aborted) result = unavailable('cancelled');
                    else result = await service.query({ signal: controller.signal, organizationId,
                        resetSession: context.sender.session });
                    if (organizationId && (result.snapshot?.weekly || result.snapshot?.weeklyHistory?.some(Boolean))
                        && await readLocalOrganization(context, BrowserWindow, claudeData, controller.signal) !== organizationId)
                        result = withUnverifiedWeeklyOrganization(result);
                }
            }
            else if (typeof remote?.query === 'function')
                result = await remote.query(payload.hostId, { signal: controller.signal, frame: context.frame });
            else result = unavailable('snapshot-update-required');
            if (controller.signal.aborted) result = unavailable('cancelled');
        }
        catch (error)
        {
            result = unavailable(controller.signal.aborted || error?.name === 'AbortError' ? 'cancelled' : 'query-failed');
        }
        finally
        {
            owner.queries.delete(payload.requestId);
            release(owner);
        }
        reply(context, payload.requestId, result);
    }

    function on(name, handler)
    {
        const channel = Prefix + name;
        ipcMain.on(channel, handler);
        listeners.push(() => ipcMain.removeListener(channel, handler));
    }

    function handle(name, handler)
    {
        const channel = Prefix + name;
        ipcMain.handle(channel, async (event, payload) =>
        {
            const context = stopped ? null : trusted(event);
            if (!context) return null;
            try
            {
                const value = await handler(context, payload);
                return current(context) ? value : null;
            }
            catch { return null; }
        });
        handlers.push(channel);
    }

    handle('hosts', async (context, payload) =>
    {
        if (payload !== undefined)
        {
            if (!record(payload) || !normalizeThreadId(payload.requestId)
                || Object.keys(payload).length !== 1) return null;
            const owner = ownerFor(context);
            if (owner.queries.has(payload.requestId)) return null;
            const controller = new AbortController();
            owner.queries.set(payload.requestId, controller);
            try { await remote?.refreshHostNames?.(context.frame, { signal: controller.signal }); }
            catch { /* 名称读取失败时继续使用已确认的缓存。 */ }
            finally
            {
                owner.queries.delete(payload.requestId);
                release(owner);
            }
            if (controller.signal.aborted) return null;
        }
        const hosts = [{ hostId: 'local', label: '本机' }];
        let candidates;
        try { candidates = await remote?.getHosts?.(context.frame); }
        catch { return hosts; }
        const seen = new Set(['local']);
        for (const candidate of Array.isArray(candidates) ? candidates.slice(0, 256) : [])
        {
            if (!validHostId(candidate?.hostId) || seen.has(candidate.hostId)) continue;
            seen.add(candidate.hostId);
            hosts.push({ hostId: candidate.hostId,
                label: concise(candidate.label) ? candidate.label : `远程 · ${candidate.hostId}` });
        }
        if (hosts.length === 2) hosts[1].label = '远程';
        return hosts;
    });
    handle('discover', async context =>
    {
        if (typeof remote?.discover !== 'function') return null;
        let pending = discovery.get(context.frame);
        if (!pending)
        {
            pending = Promise.resolve().then(() => current(context) ? remote.discover(context.frame) : null);
            discovery.set(context.frame, pending);
        }
        try { await pending; }
        finally { if (discovery.get(context.frame) === pending) discovery.delete(context.frame); }
        return null;
    });
    on('query', (event, payload) => { void query(event, payload); });
    on('cancel', (event, payload) =>
    {
        const context = stopped ? null : trusted(event);
        if (!context || !record(payload) || !normalizeThreadId(payload.requestId)
            || Object.keys(payload).some(key => key !== 'requestId')) return;
        owners.get(context.frame)?.queries.get(payload.requestId)?.abort();
    });
    api.log.info('Daily Usage main started; on-demand queries, no background polling');
    return { stop()
    {
        if (stopping) return stopping;
        stopped = true;
        for (const remove of listeners) remove();
        for (const channel of handlers) ipcMain.removeHandler(channel);
        for (const owner of [...owners.values()])
        {
            abort(owner);
            owner.queries.clear();
            release(owner);
        }
        discovery.clear();
        stopping = Promise.allSettled([Promise.resolve().then(() => service.dispose()),
            Promise.resolve().then(() => remote?.dispose?.())]).then(() => {});
        return stopping;
    } };
}

module.exports = { startMain, createMain: startMain };
