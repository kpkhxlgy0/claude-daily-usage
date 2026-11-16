'use strict';
const os = require('node:os');
const path = require('node:path');
const { normalizeThreadId, validHostId } = require('./protocol.cjs');

const Prefix = 'claudepp:com.kpk.daily-usage:';
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

function startMain(api, dependencies = {})
{
    const electron = dependencies.ipcMain ? null : require('electron');
    const ipcMain = dependencies.ipcMain || electron.ipcMain;
    const BrowserWindow = dependencies.BrowserWindow || electron?.BrowserWindow;
    const serviceFactory = dependencies.serviceFactory || require('./service.cjs').createService;
    const claudeHome = dependencies.claudeHome
        || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
    const service = serviceFactory({ claudeHome, dataDir: api.fs.dataDir });
    let remote = dependencies.remoteAdapter;
    if (remote === undefined && electron)
    {
        const transport = require('./remote-transport.cjs').createTransport({
            fetch: (...args) => electron.net.fetch(...args) });
        remote = require('./remote-adapter.cjs').createRemoteAdapter({ service, claudeHome,
            claudeData: electron.app.getPath('userData'), transport });
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
                else result = await service.query({ signal: controller.signal });
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
        ipcMain.handle(channel, async event =>
        {
            const context = stopped ? null : trusted(event);
            if (!context) return null;
            try
            {
                const value = await handler(context);
                return current(context) ? value : null;
            }
            catch { return null; }
        });
        handlers.push(channel);
    }

    handle('hosts', async context =>
    {
        const hosts = [{ hostId: 'local', label: `本机 · ${os.hostname()}` }];
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
