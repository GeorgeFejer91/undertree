import test from 'node:test';
import assert from 'node:assert/strict';

test('a native page connects once and cannot reacquire ownership after retirement', async t => {
  const previous = { isTauri: globalThis.isTauri, window: globalThis.window };
  t.after(() => Object.assign(globalThis, previous));
  const calls = []; let retired = false; const expectedRoot = { dev: '18446744073709551615', ino: '9007199254740993' };
  globalThis.isTauri = true;
  globalThis.window = { __TAURI_INTERNALS__: { invoke: async (command, args) => {
    calls.push({ command, args });
    if (command === 'editor_connect') return { protocolVersion: 1, ownerId: 'page-epoch' };
    if (retired) throw { code: 'stale_session' };
    return { protocolVersion: 1, requests: [] };
  } } };
  const api = await import(`../modules/frontend/review-api.js?native-epoch=${Date.now()}`);
  const operation = { action: 'save', project: 'project', path: 'main.typ', sourceEpoch: 2, expectedRoot: { dev: '18446744073709551615', ino: '9007199254740993' }, revision: 'revision', content: 'dirty text' };
  await Promise.all([api.reviewRequest(operation), api.editorRequest({ action: 'editor_poll' }), api.controlRequest({ action: 'control_poll' }), api.chooseImportFiles('project', 'assets', expectedRoot), api.importRequest({ action: 'import_status', requestId: 'request' }), api.prepareProjectExport('project', expectedRoot), api.chooseProjectExportDestination('archive', 'download'), api.projectExportRequest({ action: 'export_status', requestId: 'download' }), api.wordCountTypstText('count', 'supplied dirty text')]);
  assert.equal(calls.filter(call => call.command === 'editor_connect').length, 1);
  assert.deepEqual(calls.find(call => call.command === 'review_action').args, { operation, ownerId: 'page-epoch' });
  assert.equal(calls.filter(call => call.command === 'editor_operation').every(call => call.args.ownerId === 'page-epoch'), true);
  assert.equal(calls.find(call => call.command === 'control_operation').args.ownerId, 'page-epoch', 'app controls share the existing page owner');
  assert.deepEqual(calls.find(call => call.command === 'choose_import_files').args, { ownerId: 'page-epoch', project: 'project', parent: 'assets', expectedRoot });
  assert.equal(calls.find(call => call.command === 'import_operation').args.ownerId, 'page-epoch');
  assert.deepEqual(calls.find(call => call.command === 'prepare_project_export').args, { ownerId: 'page-epoch', project: 'project', expectedRoot });
  assert.deepEqual(calls.find(call => call.command === 'choose_project_export_destination').args, { ownerId: 'page-epoch', exportId: 'archive', requestId: 'download' });
  assert.deepEqual(calls.find(call => call.command === 'project_export_operation').args, { ownerId: 'page-epoch', operation: { action: 'export_status', requestId: 'download' } });
  assert.deepEqual(calls.find(call => call.command === 'word_count_typst_text').args, { request: { ownerId: 'page-epoch', requestId: 'count', source: 'supplied dirty text' } });
  retired = true;
  await assert.rejects(api.reviewRequest(operation), error => error.code === 'stale_session');
  await assert.rejects(api.editorRequest({ action: 'editor_poll' }), error => error.code === 'stale_session');
  await assert.rejects(api.controlRequest({ action: 'control_poll' }), error => error.code === 'stale_session');
  await assert.rejects(api.chooseImportFiles('project', '', expectedRoot), error => error.code === 'stale_session');
  await assert.rejects(api.importRequest({ action: 'import_status', requestId: 'request' }), error => error.code === 'stale_session');
  await assert.rejects(api.prepareProjectExport('project', expectedRoot), error => error.code === 'stale_session');
  await assert.rejects(api.chooseProjectExportDestination('archive', 'download'), error => error.code === 'stale_session');
  await assert.rejects(api.projectExportRequest({ action: 'export_status', requestId: 'download' }), error => error.code === 'stale_session');
  await assert.rejects(api.wordCountTypstText('count', 'supplied dirty text'), error => error.code === 'stale_session');
  assert.equal(calls.filter(call => call.command === 'editor_connect').length, 1, 'an old page cannot rotate the current native owner');
});
test('an initial native connection failure can retry without dispatching an ownerless operation', async t => {
  const previous = { isTauri: globalThis.isTauri, window: globalThis.window };
  t.after(() => Object.assign(globalThis, previous));
  let attempts = 0, operations = 0;
  globalThis.isTauri = true;
  globalThis.window = { __TAURI_INTERNALS__: { invoke: async (command, args) => {
    if (command === 'editor_connect') { attempts += 1; if (attempts === 1) throw { code: 'busy' }; return { protocolVersion: 1, ownerId: 'retry-epoch' }; }
    operations += 1; assert.equal(args.ownerId, 'retry-epoch'); return {};
  } } };
  const api = await import(`../modules/frontend/review-api.js?native-retry=${Date.now()}`);
  await assert.rejects(api.editorRequest({ action: 'editor_poll' }), error => error.code === 'busy');
  assert.equal(operations, 0); await api.editorRequest({ action: 'editor_poll' }); assert.equal(attempts, 2); assert.equal(operations, 1);
});
test('standalone browser import and project download refuse before connecting an owner or sending file data', async t => {
  const previous = Object.fromEntries(['isTauri', 'window', 'location', 'sessionStorage', 'history', 'fetch'].map(key => [key, globalThis[key]]));
  t.after(() => Object.assign(globalThis, previous));
  let network = 0, ipc = 0;
  globalThis.isTauri = false;
  globalThis.window = { __TAURI_INTERNALS__: { invoke: () => { ipc += 1; } } };
  globalThis.location = new URL('http://127.0.0.1/manuscript.html');
  globalThis.sessionStorage = { getItem: () => '', setItem: () => {} }; globalThis.history = { replaceState: () => {} };
  globalThis.fetch = () => { network += 1; throw new Error('Unexpected browser file route'); };
  const api = await import(`../modules/frontend/review-api.js?browser-import=${Date.now()}`);
  await assert.rejects(api.chooseImportFiles('project', 'assets'), error => error.code === 'desktop_required');
  await assert.rejects(api.importRequest({ action: 'import_files', selectionId: 'selection', requestId: 'request' }), error => error.code === 'desktop_required');
  await assert.rejects(api.prepareProjectExport('project'), error => error.code === 'desktop_required');
  await assert.rejects(api.chooseProjectExportDestination('archive', 'download'), error => error.code === 'desktop_required');
  await assert.rejects(api.projectExportRequest({ action: 'export_status', requestId: 'download' }), error => error.code === 'desktop_required');
  await assert.rejects(api.wordCountTypstText('count', 'supplied dirty text'), error => error.code === 'desktop_required');
  assert.equal(network, 0); assert.equal(ipc, 0);
});

test('native review captures provided root strings before waiting for its initial owner, without injecting a root into reads', async t => {
  const previous = { isTauri: globalThis.isTauri, window: globalThis.window }; t.after(() => Object.assign(globalThis, previous));
  let release; const connected = new Promise(resolve => { release = resolve; }), calls = [];
  globalThis.isTauri = true;
  globalThis.window = { __TAURI_INTERNALS__: { invoke: async (command, args) => {
    if (command === 'editor_connect') { await connected; return { protocolVersion: 1, ownerId: 'captured-owner' }; }
    calls.push({ command, args }); return {};
  } } };
  const api = await import(`../modules/frontend/review-api.js?root-capture=${Date.now()}`);
  const expectedRoot = { dev: '18446744073709551615', ino: '9007199254740993' }, operation = { action: 'open', project: 'project', path: 'main.typ', sourceEpoch: 2, expectedRoot };
  const opening = api.reviewRequest(operation); expectedRoot.ino = '9007199254740994'; release(); await opening;
  assert.deepEqual(calls[0].args.operation.expectedRoot, { dev: '18446744073709551615', ino: '9007199254740993' });
  assert.equal(Object.isFrozen(calls[0].args.operation.expectedRoot), true); assert.equal(calls[0].args.ownerId, 'captured-owner');
  await api.reviewRequest({ action: 'review', project: 'project', path: 'main.typ' }); assert.equal(Object.hasOwn(calls[1].args.operation, 'expectedRoot'), false);
  await assert.rejects(api.reviewRequest({ ...operation, expectedRoot: { dev: '01', ino: '2' } }), error => error.code === 'format'); assert.equal(calls.length, 2);
});

test('native picker and ZIP preparation freeze required inventory root before awaiting their shared owner', async t => {
  const previous = { isTauri: globalThis.isTauri, window: globalThis.window }; t.after(() => Object.assign(globalThis, previous));
  const calls = []; let release; const gate = new Promise(resolve => { release = resolve; });
  globalThis.isTauri = true; globalThis.window = { __TAURI_INTERNALS__: { invoke: async (command, args) => {
    calls.push({ command, args }); if (command === 'editor_connect') { await gate; return { protocolVersion: 1, ownerId: 'rooted-owner' }; } return {};
  } } };
  const api = await import(`../modules/frontend/review-api.js?file-root=${Date.now()}`);
  for (const root of [undefined, null, { dev: '01', ino: '2' }, { dev: '1', ino: 2 }]) {
    await assert.rejects(api.chooseImportFiles('project', 'assets', root), error => error.code === 'format');
    await assert.rejects(api.prepareProjectExport('project', root), error => error.code === 'format');
  }
  assert.equal(calls.length, 0, 'there is no rootless native fallback or owner connection for invalid intent');
  const expectedRoot = { dev: '18446744073709551615', ino: '9007199254740993' }, original = { ...expectedRoot };
  const picker = api.chooseImportFiles('project', 'assets', expectedRoot), archive = api.prepareProjectExport('project', expectedRoot);
  expectedRoot.ino = '9007199254740994'; release(); await Promise.all([picker, archive]);
  assert.equal(calls.filter(call => call.command === 'editor_connect').length, 1);
  for (const command of ['choose_import_files', 'prepare_project_export']) {
    const args = calls.find(call => call.command === command).args;
    assert.deepEqual(args.expectedRoot, original); assert.equal(Object.isFrozen(args.expectedRoot), true); assert.equal(args.ownerId, 'rooted-owner'); assert.equal(Object.hasOwn(args, 'sourceEpoch'), false);
  }
});
