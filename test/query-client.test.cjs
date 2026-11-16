'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createQueryClient } = require('../src/renderer.cjs');

function fixture(t) {
    const sent = [], handlers = new Map();
    const api = { ipc: {
        on(name, fn) { handlers.set(name, fn); return () => handlers.delete(name); },
        send(...args) { sent.push(args); },
        invoke() { assert.fail('Long queries must not use the five-second invoke API'); }
    } };
    const client = createQueryClient(api);
    t.after(() => client.stop());
    return { client, sent, reply: value => handlers.get('query-result')?.(value), handlers };
}

test('query results use a pushed response and reject unrelated request IDs', async t => {
    const f = fixture(t);
    const task = f.client.query('local', { requestId: 'query-one' });
    assert.deepEqual(f.sent, [['query', { hostId: 'local', requestId: 'query-one' }]]);
    f.reply({ requestId: 'other', result: { status: 'error' } });
    f.reply({ requestId: 'query-one', result: { status: 'ok', snapshot: {} } });
    assert.equal((await task).status, 'ok');
    assert.equal(f.client.pendingCount, 0);
});

test('cancel and stop settle pending requests and remove the result listener', async t => {
    const f = fixture(t);
    const first = f.client.query('local', { requestId: 'one' });
    const rejected = assert.rejects(first, { name: 'AbortError' });
    f.client.cancel('one');
    await rejected;
    assert.deepEqual(f.sent.at(-1), ['cancel', { requestId: 'one' }]);
    const second = f.client.query('local', { requestId: 'two' });
    const secondRejected = assert.rejects(second, { name: 'AbortError' });
    f.client.stop();
    await secondRejected;
    assert.equal(f.handlers.size, 0);
    await assert.rejects(f.client.query('local', { requestId: 'three' }), { name: 'AbortError' });
});
