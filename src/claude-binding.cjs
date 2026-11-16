'use strict';

// 此只读函数复用 Session Stats 的可见会话身份检查，可安全序列化到所属页面。
function readVisibleRemoteBinding(win)
{
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    let url;
    try { url = new URL(win.location.href); }
    catch { return null; }
    if (url.username || url.password || !(url.origin === 'https://claude.ai'
        || url.protocol === 'app:' && url.hostname === 'localhost' && !url.port)) return null;
    const route = /^\/(?:epitaxy|code)\/(session_[A-Za-z0-9_-]{1,128})\/?$/.exec(url.pathname);
    if (!route || win.document.visibilityState === 'hidden') return null;
    const editors = [...win.document.querySelectorAll(
        '.ProseMirror[contenteditable], [contenteditable="true"][role="textbox"], textarea')]
        .filter(node => node.getClientRects().length
            && !node.closest('[data-pane-root][data-perf-screen="tasks"]')
            && !node.closest('[hidden],[inert],[aria-hidden="true"],dialog,[role="dialog"],[role="menu"]'));
    if (editors.length !== 1) return null;
    const organizations = new Set();
    for (let dom = editors[0], level = 0; dom && level < 12; dom = dom.parentElement, level++)
    {
        const key = Object.keys(dom).find(name => name.startsWith('__reactFiber$'));
        if (!key) continue;
        let fiber = dom[key];
        let top = fiber;
        const roots = new Set();
        for (let depth = 0; top?.return && depth < 512 && !roots.has(top); depth++)
        {
            roots.add(top);
            top = top.return;
        }
        if (top?.stateNode?.current && top.stateNode.current !== top) fiber = fiber?.alternate;
        const visited = new Set();
        for (let node = fiber, depth = 0; node && depth < 512 && !visited.has(node); node = node.return, depth++)
        {
            visited.add(node);
            for (const value of [node.memoizedProps, node.memoizedProps?.value])
            {
                const organizationId = value?.activeOrganization?.uuid;
                if (typeof organizationId === 'string' && uuid.test(organizationId))
                    organizations.add(organizationId.toLowerCase());
            }
        }
        break;
    }
    if (organizations.size !== 1) return null;
    return { bridgeSessionId: route[1], organizationId: [...organizations][0] };
}

const FrameBindingScript = `(${readVisibleRemoteBinding.toString()})(window)`;

async function readFrameBinding(frame)
{
    if (typeof frame?.executeJavaScript !== 'function') return null;
    try { return await frame.executeJavaScript(FrameBindingScript); }
    catch { return null; }
}

module.exports = { readVisibleRemoteBinding, readFrameBinding, FrameBindingScript };
