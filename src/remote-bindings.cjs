'use strict';

const fs = require('node:fs/promises');
const nativeFs = require('node:fs');
const path = require('node:path');
const { createSnapshotBindingAccess } = require('./vendor/session-stats/snapshot-bindings.cjs');
const { createCliWorkspaceResolver } = require('./vendor/session-stats/cli-workspace.cjs');

function bindingKey(binding)
{
    return JSON.stringify(['accountId', 'organizationId', 'localSessionId', 'cliSessionId', 'bridgeSessionId',
        'metadataFile', 'workspaceRoot', 'workspaceEvidence'].map(key => binding[key] ?? null));
}

function createRemoteBindings({ claudeHome, claudeData, resolveWorkspace, bindingAccess,
    watch = nativeFs.watch } = {})
{
    const resolver = resolveWorkspace || createCliWorkspaceResolver({ claudeHome });
    const access = bindingAccess || createSnapshotBindingAccess();
    const subscribers = new Set();
    const watchers = new Map();
    let stopped = false;
    let queued = false;
    let pending;

    function changed()
    {
        if (stopped || queued) return;
        queued = true;
        setImmediate(() =>
        {
            queued = false;
            if (!stopped) for (const subscriber of subscribers) subscriber();
        });
    }

    async function watchDirectories()
    {
        const wanted = new Set();
        async function add(directory, depth)
        {
            if (wanted.size >= 512 || typeof directory !== 'string' || !path.isAbsolute(directory)) return;
            try
            {
                const info = await fs.lstat(directory);
                if (!info.isDirectory() || info.isSymbolicLink()) return;
                wanted.add(directory);
                if (!depth) return;
                const children = await fs.readdir(directory, { withFileTypes: true });
                for (const child of children)
                    if (child.isDirectory() && !child.isSymbolicLink()) await add(path.join(directory, child.name), depth - 1);
            }
            catch { /* 目录创建事件将触发下一次身份发现。 */ }
        }
        await add(claudeHome, 0);
        if (claudeHome) await add(path.join(claudeHome, 'sessions'), 0);
        await add(claudeData, 0);
        if (claudeData) await add(path.join(claudeData, 'claude-code-sessions'), 2);
        if (stopped) return;
        for (const [directory, watcher] of watchers)
            if (!wanted.has(directory)) { watcher.close(); watchers.delete(directory); }
        for (const directory of wanted)
        {
            if (watchers.has(directory)) continue;
            try
            {
                const watcher = watch(directory, { persistent: false }, (_kind, name) =>
                {
                    if (directory === claudeHome && name && String(name) !== 'sessions') return;
                    if (directory === claudeData && name && String(name) !== 'claude-code-sessions') return;
                    changed();
                });
                watcher.on('error', () =>
                {
                    watcher.close();
                    if (watchers.get(directory) === watcher) watchers.delete(directory);
                    changed();
                });
                watchers.set(directory, watcher);
            }
            catch { /* 不轮询；下次目录事件或显式查询时再试。 */ }
        }
    }

    async function list()
    {
        await watchDirectories();
        if (stopped || typeof resolver.listActiveSessions !== 'function') return [];
        const active = await resolver.listActiveSessions();
        if (stopped || !active.length) return [];
        const localIds = [...new Set(active.map(value => value.localSessionId))];
        const bindings = await access.discoverSnapshotBindings(claudeData,
            { resolveWorkspace: resolver, onlyLocalSessionIds: localIds });
        if (stopped) return [];
        return bindings.filter(binding => typeof binding.workspaceEvidence === 'string'
            && active.some(value => value.localSessionId === binding.localSessionId
                && value.cliSessionId === binding.cliSessionId && (!value.bridgeSessionId
                    || value.bridgeSessionId.replace(/^cse_/, 'session_') === binding.bridgeSessionId)));
    }

    return {
        listActiveBindings()
        {
            if (stopped) return Promise.resolve([]);
            if (!pending) pending = list().finally(() => { pending = null; });
            return pending;
        },
        subscribe(callback)
        {
            if (!stopped) subscribers.add(callback);
            return () => subscribers.delete(callback);
        },
        dispose()
        {
            if (stopped) return;
            stopped = true;
            subscribers.clear();
            for (const watcher of watchers.values()) watcher.close();
            watchers.clear();
            resolver.dispose?.();
            access.dispose?.();
        }
    };
}

module.exports = { createRemoteBindings, bindingKey };
