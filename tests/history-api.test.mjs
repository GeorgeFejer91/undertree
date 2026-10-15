import test from 'node:test';
import assert from 'node:assert/strict';

let serial = 0;
test('History uses the exact existing native owner promise and never reconnects a retired page', async t => {
  const previous = { isTauri: globalThis.isTauri, window: globalThis.window }; t.after(() => Object.assign(globalThis, previous));
  const calls = []; let retired = false, release;
  const connected = new Promise(resolve => { release = resolve; });
  globalThis.isTauri = true;
  globalThis.window = { __TAURI_INTERNALS__: { invoke: async (command, args) => {
    calls.push({ command, args });
    if (command === 'editor_connect') { await connected; return { protocolVersion: 1, ownerId: 'existing-page-owner' }; }
    if (retired) throw { code: 'stale_session' };
    return command === 'history_query' ? { kind: 'list', result: {} } : {};
  } } };
  const api = await import(`../modules/frontend/review-api.js?history-api=${serial++}`);
  const query = Object.freeze({ action: 'list', projectId: 'project', namespaceId: null, observedRoot: Object.freeze({ dev: '18446744073709551615', ino: '9007199254740993' }), sourceId: null, cursor: null });
  const owner = api.editorOwnerId(), history = api.historyRequest(query), other = api.editorRequest({ action: 'editor_poll' });
  release(); assert.equal(await owner, 'existing-page-owner'); await Promise.all([history, other]);
  assert.equal(calls.filter(call => call.command === 'editor_connect').length, 1);
  assert.deepEqual(calls.find(call => call.command === 'history_query').args, { ownerId: 'existing-page-owner', query });
  retired = true; await assert.rejects(api.historyRequest(query), error => error.code === 'stale_session');
  assert.equal(await api.editorOwnerId(), 'existing-page-owner'); assert.equal(calls.filter(call => call.command === 'editor_connect').length, 1);
});

test('standalone History refuses before owner connection, fetch or native dispatch', async t => {
  const previous = Object.fromEntries(['isTauri', 'window', 'location', 'sessionStorage', 'history', 'fetch'].map(key => [key, globalThis[key]])); t.after(() => Object.assign(globalThis, previous));
  let operations = 0; globalThis.isTauri = false;
  globalThis.window = { __TAURI_INTERNALS__: { invoke: () => { operations += 1; } } };
  globalThis.location = new URL('http://127.0.0.1/manuscript.html'); globalThis.sessionStorage = { getItem: () => '', setItem: () => {} }; globalThis.history = { replaceState: () => {} };
  globalThis.fetch = () => { operations += 1; throw Error('No History HTTP route'); };
  const api = await import(`../modules/frontend/review-api.js?history-browser=${serial++}`);
  await assert.rejects(api.historyRequest({ action: 'list' }), error => error.code === 'desktop_required'); assert.equal(operations, 0);
});
