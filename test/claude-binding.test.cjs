'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { readVisibleRemoteBinding, readFrameBinding, FrameBindingScript } = require('../src/claude-binding.cjs');

const Org = '11111111-1111-4111-8111-111111111111';
function fixture()
{
    const fiber = { memoizedProps: { value: { activeOrganization: { uuid: Org } } } };
    const editor = { getClientRects: () => [{}], closest: () => null, __reactFiber$fixture: fiber };
    return { location: { href: 'app://localhost/code/session_fixture' },
        document: { visibilityState: 'visible', querySelectorAll: () => [editor] }, editor, fiber };
}

test('reads only a visible verified route and unambiguous active organization', () =>
{
    const win = fixture();
    assert.deepEqual(readVisibleRemoteBinding(win), { bridgeSessionId: 'session_fixture', organizationId: Org });
    win.location.href = 'https://claude.ai/epitaxy/session_fixture';
    assert.equal(readVisibleRemoteBinding(win).organizationId, Org);
    win.document.visibilityState = 'hidden';
    assert.equal(readVisibleRemoteBinding(win), null);
    win.document.visibilityState = 'visible';
    win.fiber.return = { memoizedProps: { activeOrganization: { uuid: '22222222-2222-4222-8222-222222222222' } } };
    assert.equal(readVisibleRemoteBinding(win), null);
});

test('rejects arbitrary URLs, local/settings routes, hidden panes and ambiguous editors', () =>
{
    const win = fixture();
    for (const href of ['https://evil.example/code/session_fixture', 'https://user@claude.ai/code/session_fixture',
        'app://localhost:80/code/session_fixture', 'app://localhost/settings', 'app://localhost/code/local_id'])
    {
        win.location.href = href;
        assert.equal(readVisibleRemoteBinding(win), null);
    }
    win.location.href = 'app://localhost/code/session_fixture';
    win.editor.closest = () => ({});
    assert.equal(readVisibleRemoteBinding(win), null);
    win.editor.closest = () => null;
    win.document.querySelectorAll = () => [win.editor, win.editor];
    assert.equal(readVisibleRemoteBinding(win), null);
});

test('serialized frame reader uses no renderer payload, fetch or external imports', async () =>
{
    const win = fixture();
    win.fetch = () => assert.fail('identity discovery must not use network');
    const frame = { executeJavaScript: script => vm.runInNewContext(script, { window: win, URL }) };
    assert.equal(FrameBindingScript.includes('require('), false);
    assert.equal((await readFrameBinding(frame)).bridgeSessionId, 'session_fixture');
    assert.equal(await readFrameBinding({ executeJavaScript() { throw new Error('frame gone'); } }), null);
});
