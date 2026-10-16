import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { NativeFileMove, assertMoveEndpointsClosed, moveGeneration, nativeFileMoveCommands } from '../modules/frontend/file-move.js';

const project = '33333333-3333-4333-8333-333333333333';
const id = value => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
const root = { dev: '18446744073709551615', ino: '9007199254740993' };
const content = '= Saved source\r\nSecond 😀 passage.\r\n';
const hash = value => createHash('sha256').update(value).digest('hex');
const input = { project, from: 'chapters/a.typ', to: 'chapters/b.typ', sourceEpoch: 4, expectedRoot: root };
const witness = () => ({ path: input.from, content, review: { revision: hash(content) }, sourceEpoch: 4, expectedRoot: root, sidecarRevision: hash('raw unknown fields and formatting') });
const request = (n = 1, generation = '0') => ({ generation, requestId: id(n), ...input, revision: hash(content), sidecarRevision: witness().sidecarRevision });
const receipt = (request, status = 'prepared') => ({ ...request, moveId: id(1000 + Number(request.requestId.slice(-6))), destinationEpoch: 0, reservedSourceEpoch: 5, reservedDestinationEpoch: 1, expiresAt: 1900000000000, bundle: [{ member: 'source', bytes: Buffer.byteLength(content), sha256: hash(content) }], mainBefore: input.from, mainAfter: input.to, mainDocument: status === 'moved' ? input.to : null, status, error: null });
class MemoryStorage {
  value = null; events = []; failWrite = false; failReadback = false;
  getItem() { this.events.push('read'); return this.failReadback && this.value !== null ? 'different bytes' : this.value; }
  setItem(key, value) { this.events.push('write'); if (this.failWrite) throw Error('full'); this.value = value; }
}
function fixture(options = {}) {
  const storage = options.storage || new MemoryStorage(), calls = [], sessions = [], state = { generation: '0', moves: [], next: 0, refresh: [] };
  const api = {
    async prepare(value) { calls.push({ prepare: structuredClone(value), persisted: storage.value }); const result = receipt(value); state.moves.push(result); if (options.prepare) return options.prepare(value, result, state); return result; },
    async request(operation) {
      calls.push(structuredClone(operation)); if (options.operation) { const result = await options.operation(operation, state); if (result !== undefined) return result; }
      if (operation.action === 'move_list') return { generation: state.generation, moves: structuredClone(state.moves) };
      if (operation.generation !== state.generation) throw { code: 'move_generation_stale', message: 'Old generation.' };
      if (operation.action === 'move_retire_terminal') { const result = { retiredGeneration: state.generation, generation: String(BigInt(state.generation) + 1n), retiredCount: state.moves.length }; state.generation = result.generation; state.moves = []; return result; }
      const found = state.moves.find(value => value.requestId === operation.requestId);
      if (!found) return { generation: state.generation, requestId: operation.requestId, status: 'unknown' };
      if (operation.action === 'move_commit' || operation.action === 'move_reconcile') { found.status = 'moved'; found.mainDocument = input.to; }
      if (operation.action === 'move_cancel') found.status = 'cancelled';
      return structuredClone(found);
    },
  };
  const controller = new NativeFileMove({ ...api, observe: options.observe || (async () => witness()), sessions: () => sessions, canStart: options.canStart || (() => {}), refresh: async (...args) => state.refresh.push(args), onChange: options.onChange, storage, requestId: () => id(++state.next) });
  return { controller, state, storage, calls, sessions };
}
const start = async options => { const value = fixture(options); await value.controller.discover(); return value; };

test('generation remains an opaque exact canonical decimal string', () => {
  for (const value of ['0', '1', '9007199254740993', '18446744073709551615']) assert.equal(moveGeneration(value), value);
  for (const value of [undefined, null, 0, 1, '-1', '+1', ' 1', '1 ', '01', '', '18446744073709551616', '100000000000000000000']) assert.throws(() => moveGeneration(value), { code: 'format' });
});
test('endpoint guard includes inactive, dirty and retired-epoch tabs without changing them', () => {
  for (const path of [input.from, input.to]) {
    const session = Object.freeze({ project, path, sourceEpoch: 123, expectedRoot: { dev: '9', ino: '9' }, active: false, dirty: true, content: 'Draft kept.', save() { throw Error('No save'); }, close() { throw Error('No close'); } });
    assert.throws(() => assertMoveEndpointsClosed([session], project, input.from, input.to), { code: 'busy' }); assert.equal(session.content, 'Draft kept.');
  }
  assert.doesNotThrow(() => assertMoveEndpointsClosed([{ project: id(90), path: input.from }, { project, path: 'other.typ', dirty: true }], project, input.from, input.to));
});
test('actual native command adapter obtains current owner for every typed call and denies browser/unknown fields', async () => {
  const calls = []; let owner = 0;
  const api = nativeFileMoveCommands(async (name, args) => calls.push({ name, args }), async () => `actual-owner-${++owner}`, true);
  await api.prepare(request()); await api.request({ action: 'move_list' }); await api.request({ action: 'move_status', generation: '0', requestId: id(1) });
  assert.deepEqual(calls.map(row => [row.name, row.args.ownerId]), [['prepare_file_move', 'actual-owner-1'], ['file_move_operation', 'actual-owner-2'], ['file_move_operation', 'actual-owner-3']]);
  assert.deepEqual(calls[1].args.operation, { action: 'move_list' });
  assert.throws(() => api.request({ action: 'move_status', requestId: id(1) }), { code: 'format' });
  assert.throws(() => api.request({ action: 'move_list', generation: '0' }), { code: 'format' });
  assert.throws(() => api.request({ action: 'save', generation: '0' }), { code: 'format' });
  const disabled = nativeFileMoveCommands(() => { throw Error('No IPC'); }, () => 'invented', false);
  await assert.rejects(disabled.request({ action: 'move_list' }), { code: 'desktop_required' });
});
test('startup discovers all durable statuses with pure List and no reconciliation', async () => {
  const f = fixture(); f.state.moves = [receipt(request(5), 'pending'), receipt(request(6), 'recovery_required'), receipt(request(7), 'moved')];
  await f.controller.discover(); assert.equal(f.controller.ready, true); assert.equal(f.controller.records.size, 3); assert.ok(f.controller.pendingCount >= 2); assert.deepEqual(f.calls, [{ action: 'move_list' }]); assert.deepEqual(f.state.refresh, [[]]);
});
test('Prepare hashes real UTF8 Review witness and persists generation/UUID before native submission', async () => {
  const f = await start(); await f.controller.prepare(input);
  assert.equal(f.controller.current.phase, 'prepared'); const submitted = f.calls.find(row => row.prepare);
  assert.equal(submitted.prepare.revision, hash(content)); assert.equal(submitted.prepare.sidecarRevision, witness().sidecarRevision); assert.deepEqual(submitted.prepare.expectedRoot, root);
  const retained = JSON.parse(submitted.persisted).intents[0]; assert.equal(retained.request.generation, '0'); assert.equal(retained.request.requestId, submitted.prepare.requestId); assert.equal(Object.hasOwn(retained.request, 'content'), false);
  assert.equal(f.calls.some(row => ['open', 'save', 'editor_commit', 'move_reconcile'].includes(row.action)), false);
});
test('explicit null raw sidecar proof is retained without treating Review.revision as sidecar bytes', async () => {
  const f = await start({ observe: async () => ({ ...witness(), sidecarRevision: null }) }); await f.controller.prepare(input);
  assert.equal(f.calls.find(row => row.prepare).prepare.sidecarRevision, null); assert.equal(f.controller.current.phase, 'prepared');
});
for (const [name, change] of [
  ['missing raw sidecar key', value => { delete value.sidecarRevision; }],
  ['wrong source digest', value => { value.review.revision = 'a'.repeat(64); }],
  ['wrong root', value => { value.expectedRoot = { dev: '1', ino: '2' }; }],
  ['wrong epoch', value => { value.sourceEpoch++; }],
  ['wrong path', value => { value.path = 'other.typ'; }],
]) test(`Prepare refuses ${name} without any native producer`, async () => {
  const f = await start({ observe: async () => { const value = witness(); change(value); return value; } }); await f.controller.prepare(input);
  assert.equal(f.calls.some(row => row.prepare), false); assert.equal(f.controller.current.status, 'not_submitted');
});
test('an endpoint opened during the Review observation blocks Prepare, including an inactive tab', async () => {
  const f = fixture({ observe: async () => { f.sessions.push({ project, path: input.to, active: false }); return witness(); } }); await f.controller.discover(); await f.controller.prepare(input); assert.equal(f.calls.some(row => row.prepare), false);
});
for (const mode of ['failWrite', 'failReadback']) test(`storage ${mode} prevents Prepare before IPC`, async () => {
  const f = await start(); f.storage[mode] = true; await f.controller.prepare(input); assert.equal(f.calls.some(row => row.prepare), false); assert.ok(f.controller.storageProblem);
});
test('lost Prepare acknowledgement retains exact identity and unknown Status never retries or clears guard', async () => {
  const f = await start({ prepare: async (value, result, state) => { state.moves = []; throw Error('Acknowledgement lost.'); } }); await f.controller.prepare(input);
  const prior = structuredClone(f.controller.current.request); await f.controller.act('move_status');
  assert.deepEqual(f.controller.current.request, prior); assert.ok(f.controller.pendingCount); assert.equal(f.calls.filter(row => row.prepare).length, 1); assert.equal(f.calls.some(row => row.action === 'move_reconcile'), false);
});
test('a lost preparation reply can be checked and committed only by a deliberate current-page action', async () => {
  const f = await start({ prepare: async () => { throw Error('Lost'); } }); await f.controller.prepare(input); await f.controller.act('move_status');
  assert.equal(f.controller.current.phase, 'prepared'); assert.equal(f.calls.some(row => row.action === 'move_commit'), false);
  await f.controller.act('move_commit'); assert.equal(f.controller.current.status, 'moved'); assert.equal(f.controller.pendingCount, 0); assert.deepEqual(f.state.refresh, [[]]);
});
test('an inactive destination tab opened after Prepare blocks Commit without a save or close', async () => {
  const f = await start(); await f.controller.prepare(input); f.sessions.push({ project, path: input.to, active: false, dirty: true });
  await assert.rejects(f.controller.act('move_commit'), { code: 'busy' }); assert.equal(f.calls.some(row => row.action === 'move_commit'), false);
});
test('a lost Commit is not retried even when observational Status still says Prepared', async () => {
  const f = await start({ operation: async operation => { if (operation.action === 'move_commit') throw Error('Lost commit'); } }); await f.controller.prepare(input); await f.controller.act('move_commit'); await f.controller.act('move_status');
  assert.equal(f.controller.current.phase, 'unconfirmed'); await assert.rejects(f.controller.act('move_commit'), { code: 'busy' }); assert.equal(f.calls.filter(row => row.action === 'move_commit').length, 1);
  await f.controller.act('move_cancel'); assert.equal(f.controller.current.status, 'cancelled');
});
test('accepted reconciliation is explicit and Status never performs it', async () => {
  const f = fixture(); f.state.moves = [receipt(request(9), 'recovery_required')]; await f.controller.discover(); await f.controller.act('move_status');
  assert.equal(f.calls.some(row => row.action === 'move_reconcile'), false); await f.controller.act('move_reconcile'); assert.equal(f.controller.current.status, 'moved'); assert.equal(f.calls.filter(row => row.action === 'move_reconcile').length, 1);
});
test('reloaded Prepared capture does not inherit current-page Commit or Cancel authority', async () => {
  const f = await start(); await f.controller.prepare(input); const next = fixture({ storage: f.storage }); next.state.moves = structuredClone(f.state.moves); await next.controller.discover();
  await assert.rejects(next.controller.act('move_commit'), { code: 'busy' }); await assert.rejects(next.controller.act('move_cancel'), { code: 'busy' });
});
test('typed stale generation is never turned into unknown, relabelled or retried', async () => {
  const f = await start(); await f.controller.prepare(input); f.state.generation = '1'; f.state.moves = []; const before = structuredClone(f.controller.current.request);
  await f.controller.act('move_status'); assert.equal(f.controller.current.phase, 'stale_generation'); assert.deepEqual(f.controller.current.request, before); assert.equal(f.controller.ready, false); assert.ok(f.controller.pendingCount);
  await f.controller.discover(); assert.equal(f.controller.generation, '1'); assert.equal(f.controller.pendingCount, 0); assert.equal(f.calls.filter(row => row.prepare).length, 1); assert.deepEqual(f.state.refresh, [[]]);
});
test('64 terminal receipts remain full until explicit maintenance and pure discovery of a new generation', async () => {
  const f = fixture(); f.state.moves = Array.from({ length: 64 }, (_, index) => receipt(request(index + 1), 'moved')); await f.controller.discover();
  await assert.rejects(f.controller.prepare(input), error => error.message.includes('Completion and inspection do not free')); await f.controller.discover(); assert.equal(f.controller.canPrepare, false);
  await assert.rejects(f.controller.retire(false), { code: 'confirmation' }); assert.equal(f.calls.some(row => row.action === 'move_retire_terminal'), false);
  await f.controller.retire(true); assert.equal(f.controller.ready, false); assert.ok(f.controller.pendingCount); assert.equal(f.controller.generation, '0');
  await f.controller.discover(); assert.equal(f.controller.generation, '1'); assert.equal(f.controller.retainedCount, 0); assert.equal(f.controller.canPrepare, true);
  await f.controller.prepare(input); assert.equal(f.calls.findLast(row => row.prepare).prepare.generation, '1');
});
test('lost maintenance acknowledgement requires List before an explicit retry with the same generation', async () => {
  const f = await start({ operation: async operation => { if (operation.action === 'move_retire_terminal') throw Error('Lost retirement'); } }); await f.controller.retire(true);
  assert.equal(f.controller.ready, false); await assert.rejects(f.controller.retire(true), { code: 'busy' }); assert.equal(f.calls.filter(row => row.action === 'move_retire_terminal').length, 1);
  await f.controller.discover(); assert.equal(f.controller.maintenance.generation, '0'); await f.controller.retire(true); assert.deepEqual(f.calls.filter(row => row.action === 'move_retire_terminal'), [{ action: 'move_retire_terminal', generation: '0' }, { action: 'move_retire_terminal', generation: '0' }]);
});
test('an explicit empty rotation releases unknown old intents without claiming moved or cancelled paths', async () => {
  const f = await start({ prepare: async (value, result, state) => { state.moves = []; throw Error('Lost'); } }); await f.controller.prepare(input); await f.controller.act('move_status'); await f.controller.retire(true);
  await f.controller.discover(); assert.equal(f.controller.generation, '1'); assert.equal(f.controller.pendingCount, 0); assert.equal(f.calls.filter(row => row.prepare).length, 1); assert.equal(f.calls.some(row => row.action === 'move_reconcile'), false); assert.deepEqual(f.state.refresh, [[]]);
});
test('move_maintenance from List preserves the unresolved guard and never initiates reconciliation', async () => {
  let maintenance = true; const f = fixture({ operation: async operation => { if (operation.action === 'move_list' && maintenance) throw { code: 'move_maintenance', message: 'Journal pending.' }; } }); await f.controller.discover(); assert.ok(f.controller.pendingCount); assert.equal(f.controller.ready, false);
  maintenance = false; await f.controller.discover(); assert.equal(f.controller.pendingCount, 0); assert.deepEqual(f.calls, [{ action: 'move_list' }, { action: 'move_list' }]);
});
test('corrupt persisted storage is preserved and cannot silently become an empty request store', async () => {
  const storage = new MemoryStorage(); storage.value = '{broken'; const f = fixture({ storage }); await f.controller.discover(); assert.ok(f.controller.storageProblem); assert.equal(storage.value, '{broken'); assert.equal(f.controller.canPrepare, false);
});
test('malformed/mismatched native receipt retains guard and does not refresh or replay', async () => {
  const f = await start({ prepare: async (value, result) => ({ ...result, sidecarRevision: null }) }); await f.controller.prepare(input); assert.ok(f.controller.pendingCount); assert.equal(f.controller.current.phase, 'unconfirmed'); assert.deepEqual(f.state.refresh, []); assert.equal(f.calls.filter(row => row.prepare).length, 1);
});
for (const to of ['../b.typ', '/b.typ', 'chapters//b.typ', 'chapters/b.html', 'chapters/b.tex', input.from]) test(`invalid destination ${to} cannot cause any producer`, async () => {
  const f = await start(); await assert.rejects(f.controller.prepare({ ...input, to }), { code: 'format' }); assert.equal(f.calls.some(row => row.prepare), false);
});

test('Commit storage failure prevents IPC and leaves the unused preparation visibly retained', async () => {
  const f = await start(); await f.controller.prepare(input); f.storage.failWrite = true;
  await assert.rejects(f.controller.act('move_commit'), { code: 'move_storage' });
  assert.equal(f.calls.some(row => row.action === 'move_commit'), false); assert.equal(f.controller.current.commitSubmitted, false); assert.equal(f.controller.current.phase, 'prepared'); assert.ok(f.controller.pendingCount); assert.ok(f.controller.storageProblem);
});
test('retirement storage failure prevents IPC and does not invent a native maintenance decision', async () => {
  const f = await start(); f.storage.failWrite = true;
  await assert.rejects(f.controller.retire(true), { code: 'move_storage' });
  assert.equal(f.calls.some(row => row.action === 'move_retire_terminal'), false); assert.equal(f.controller.maintenance, null); assert.ok(f.controller.storageProblem); assert.equal(f.controller.canPrepare, false);
});
test('a not-submitted draft cannot be checked as an invented request identity', async () => {
  const f = await start({ observe: async () => { throw Error('Unavailable'); } }); await f.controller.prepare(input);
  await assert.rejects(f.controller.act('move_status'), { code: 'format' }); assert.equal(f.calls.some(row => row.action === 'move_status'), false);
});

// Execute the actual production adapter callbacks; no copied Move branches are used here.
const { readFile } = await import('node:fs/promises');
const { Script, createContext } = await import('node:vm');
const { sourceEpoch, sourceRoot, sourceRootsEqual } = await import('../modules/frontend/review-session.js');
const manuscript = await readFile(new URL('../src/manuscript.js', import.meta.url), 'utf8');
function section(start, end) {
  assert.equal(manuscript.split(start).length, 2, `unique production start: ${start}`);
  const value = manuscript.slice(manuscript.indexOf(start), manuscript.indexOf(end, manuscript.indexOf(start)));
  assert.ok(value.length > 0, `production section exists: ${end}`); return value;
}
function adapter({ native = true } = {}) {
  const actions = [], ipc = [], refreshes = [], tree = [{ dataset: { path: input.from, sourceEpoch: String(input.sourceEpoch) } }], folders = [{ dataset: { path: 'chapters' } }];
  const select = { value: project, children: [], replaceChildren(...children) { this.children = children; }, append(value) { this.children.push(value); }, get firstChild() { return this.children[0]; } };
  const files = { dataset: { project }, querySelectorAll: name => name === '.file-button' ? tree : folders, replaceChildren() { tree.length = 0; } };
  const nodes = new Map([['project-select', select], ['manuscript-files', files]]);
  let config;
  const sandbox = {
    sourceEpoch, sourceRoot, sourceRootsEqual, nativeFileMoveCommands, nativeReview: native,
    NativeFileMove: class { constructor(options) { config = options; } },
    $: name => { assert.ok(nodes.has(name), `known DOM target ${name}`); return nodes.get(name); },
    element: (tag, textContent) => ({ tag, textContent }),
    nativeResult: [{ id: project, name: 'Current approved project', mainDocument: 'today.typ' }], projects: [{ id: project, name: 'Old project label', mainDocument: input.from }],
    request: async operation => { actions.push(structuredClone(operation)); return sandbox.nativeResult; },
    invoke: async (name, args) => { ipc.push({ name, args }); return { typed: true }; }, editorOwnerId: async () => 'actual-native-owner',
    fileActivity: async callback => { actions.push('activity'); return callback(); },
    sessions: new Map(), active: null, windowClosing: false, view: null, navigationIntent: 4, fileInventoryGeneration: 7, fileMove: null,
    inventoryRoot: () => ({ expectedRoot: root }), navigationCurrent: (intent, selected) => intent === sandbox.navigationIntent && selected === select.value,
    currentProject: () => sandbox.projects.find(value => value.id === select.value),
    renderProjectExport: () => refreshes.push('export-ui'), renderReview: () => refreshes.push('review-ui'), renderFileMove: () => refreshes.push('move-ui'),
    loadFiles: async intent => refreshes.push({ readTree: true, intent, selected: select.value }),
  };
  const context = createContext(sandbox);
  new Script(section('function assertMoveTree(binding)', 'function chooseMoveSource()') + '\nglobalThis.adapterFunctions = { assertMoveTree, refreshMoveMetadata };').runInContext(context);
  new Script(section('function publicationPath(', 'function publicationCurrent(')).runInContext(context);
  return { config, sandbox, actions, ipc, refreshes, tree, folders, select, context };
}
test('actual manuscript native adapter uses nonrecovering rooted Review and actual-owner typed IPC only', async () => {
  const f = adapter(); await f.config.observe(input);
  assert.deepEqual(f.actions, [{ action: 'review', project, path: input.from, sourceEpoch: 4, expectedRoot: root }]);
  await f.config.prepare(request()); await f.config.request({ action: 'move_list' });
  assert.deepEqual(f.ipc.map(call => [call.name, call.args.ownerId]), [['prepare_file_move', 'actual-native-owner'], ['file_move_operation', 'actual-native-owner']]);
  assert.deepEqual(f.actions.slice(1), ['activity', 'activity']); assert.equal(f.actions.some(value => ['open', 'save', 'editor_commit', 'sync'].includes(value.action)), false);
});
test('actual manuscript browser startup creates no Move controller or native authority', () => {
  const f = adapter({ native: false }); assert.equal(f.config, undefined); assert.equal(f.sandbox.fileMove, null); assert.deepEqual(f.ipc, []); assert.deepEqual(f.actions, []);
});
test('actual manuscript preparation guard binds current rooted tree, epoch, parent and composition', () => {
  const f = adapter(); assert.doesNotThrow(() => f.config.canStart(input));
  for (const patch of [{ project: id(88) }, { expectedRoot: { dev: '1', ino: '2' } }, { sourceEpoch: 9 }, { to: 'missing/b.typ' }]) assert.throws(() => f.config.canStart({ ...input, ...patch }));
  f.sandbox.view = { compositionStarted: true }; assert.throws(() => f.config.canStart(input), { code: 'busy' });
  assert.deepEqual(f.actions, []); assert.deepEqual(f.ipc, []);
});
test('actual historical-Moved refresh uses current metadata without Save/Open/navigation or historical main adoption', async () => {
  const f = adapter(); const dirty = Object.freeze({ project, path: 'unrelated.typ', dirty: true, content: 'Keep my draft.' }); f.sandbox.sessions.set('other', dirty);
  await f.config.refresh({ mainAfter: 'historical.typ', mainDocument: 'historical.typ', project: id(88) });
  assert.deepEqual(f.actions, [{ action: 'projects' }]); assert.equal(f.sandbox.projects[0].mainDocument, 'today.typ'); assert.equal(f.select.value, project); assert.equal(f.sandbox.navigationIntent, 4); assert.equal(dirty.content, 'Keep my draft.');
  assert.deepEqual(f.refreshes, ['export-ui', 'review-ui', { readTree: true, intent: 4, selected: project }]); assert.deepEqual(f.ipc, []);
});
test('actual metadata refresh abandons a stale navigation context without switching to receipt project', async () => {
  const f = adapter(); f.sandbox.request = async operation => { f.actions.push(operation); f.select.value = id(99); return f.sandbox.nativeResult; };
  await f.config.refresh(); assert.equal(f.sandbox.projects[0].mainDocument, input.from); assert.equal(f.select.value, id(99)); assert.deepEqual(f.refreshes, []);
});
test('actual affected-path Open guard runs before recovering Open or an unrelated dirty-buffer flush', async () => {
  const f = adapter(); f.sandbox.fileMove = { blocks: (p, path) => p === project && [input.from, input.to].includes(path) };
  new Script(section('async function openFile(', 'async function loadFiles(') + '\nglobalThis.actualOpenFile = openFile;').runInContext(f.context);
  for (const path of [input.from, input.to]) await assert.rejects(f.sandbox.actualOpenFile(path, project, 4, { expectedRoot: root }), { code: 'busy' });
  assert.equal(f.sandbox.navigationIntent, 4); assert.deepEqual(f.actions, []); assert.deepEqual(f.ipc, []);
});
test('actual App and native window-close guards include unresolved Move before any buffer Save', async () => {
  const f = adapter(); Object.assign(f.sandbox, { active: null, localRequests: 0, localRequestsVersion: 0, fileImport: { pendingCount: 0 }, projectExport: { pendingCount: 0 }, fileMove: { pendingCount: 1 }, windowChrome: null,
    status() {}, setWindowClosing() {}, localNoSaveClose: () => false, saveSession: () => { throw Error('No implicit Save'); }, setupWindowChrome: async options => options });
  new Script(section('function controlContext()', 'function controlPreparation(')).runInContext(f.context);
  const closeSetup = section('windowChrome = await setupWindowChrome({', 'observeReviewText(document.body);');
  await new Script(`(async () => { ${closeSetup} })()`).runInContext(f.context);
  assert.equal(f.sandbox.controlContext().pending, 1); assert.equal(f.sandbox.windowChrome.canClose(), false); await assert.rejects(f.sandbox.windowChrome.beforeClose(), error => error.message.includes('pending local operations'));
  assert.deepEqual(f.actions, []); assert.deepEqual(f.ipc, []);
});
test('actual modal close and Escape keep unresolved request identity and perform no native operation', () => {
  const nodes = new Map(), calls = []; const pending = { generation: '7', requestId: id(90), status: 'unknown' };
  for (const name of ['file-move-close', 'file-move-dialog']) nodes.set(name, { listeners: {}, addEventListener(type, callback) { this.listeners[type] = callback; }, close() { calls.push('presentation-close'); } });
  const context = createContext({ $: name => nodes.get(name), moveReturnFocus: null, fileMove: { current: pending, pendingCount: 1 }, task: value => value });
  new Script(section("$('file-move-close').onclick", 'for (const button of document.querySelectorAll(\'[data-command="move-source"]\'))')).runInContext(context);
  nodes.get('file-move-close').onclick(); nodes.get('file-move-dialog').listeners.cancel({ preventDefault() { calls.push('prevent-default'); } });
  assert.deepEqual(calls, ['presentation-close', 'prevent-default', 'presentation-close']); assert.equal(context.fileMove.pendingCount, 1); assert.equal(context.fileMove.current, pending);
});

test('native recovery-required receipt preserves its actual actionable error details', async () => {
  const f = fixture(); f.state.moves = [{ ...receipt(request(9), 'recovery_required'), error: { code: 'move_conflict', message: 'Destination bytes changed; replacement was preserved.' } }];
  await f.controller.discover(); assert.ok(f.controller.current.message.includes('Destination bytes changed; replacement was preserved.')); assert.ok(f.controller.pendingCount); assert.deepEqual(f.calls, [{ action: 'move_list' }]);
});
function dialogAdapter(overrides = {}) {
  const html = awaitHtml;
  const nodes = new Map([...html.matchAll(/\bid="([^"]+)"/g)].map(([, id]) => [id, {
    id, value: '', textContent: '', hidden: false, disabled: false, checked: false, attributes: {}, children: [],
    setAttribute(name, value) { this.attributes[name] = value; }, replaceChildren(...children) { this.children = children; }, append(value) { this.children.push(value); }, get firstChild() { return this.children[0]; },
  }]));
  const controller = { current: null, records: new Map(), canPrepare: true, busy: false, ready: true, storageProblem: '', retainedCount: 0, message: '', ...overrides };
  const document = { activeElement: null, body: {}, hasFocus: () => true };
  const sandbox = { document, $: id => { assert.ok(nodes.has(id), `real HTML contains adapter target ${id}`); return nodes.get(id); }, fileMove: controller, moveDraft: { ...input }, projects: [{ id: project, name: 'Current project' }], element: (tag, textContent) => ({ tag, textContent }), task: callback => callback };
  const context = createContext(sandbox); new Script(section('function renderFileMove()', 'function openFileMove(') + '\nrenderFileMove();').runInContext(context);
  return { nodes, controller, context, sandbox };
}
const awaitHtml = await readFile(new URL('../manuscript.html', import.meta.url), 'utf8');
test('actual dialog makes full64 capacity visible and keeps explicit maintenance confirmation unchecked', () => {
  const f = dialogAdapter({ retainedCount: 64, canPrepare: false }); assert.ok(f.nodes.get('file-move-status').textContent.includes('All 64 Move receipt slots are full')); assert.ok(f.nodes.get('file-move-status').textContent.includes('offline capacity is limited'));
  assert.equal(f.nodes.get('file-move-prepare').disabled, true); assert.equal(f.nodes.get('file-move-retire-confirm').checked, false); assert.equal(f.nodes.get('file-move-retire').disabled, true);
});
test('actual dialog does not present a failed pre-IPC storage draft as a submitted Move', () => {
  const f = dialogAdapter({ current: { request: request(), status: 'not_submitted', phase: 'not_submitted' }, storageProblem: 'Storage failed', canPrepare: false });
  assert.equal(f.nodes.get('file-move-draft').hidden, false); assert.equal(f.nodes.get('file-move-status-check').hidden, true); assert.equal(f.nodes.get('file-move-request-detail').hidden, true); assert.ok(f.nodes.get('file-move-status').textContent.includes('Storage failed'));
});
test('actual dialog validation errors remain visible in the modal without any native producer', async () => {
  let native = 0; const f = dialogAdapter({ prepare: async () => { throw { code: 'format', message: 'Choose distinct source and destination paths.' }; } }); f.sandbox.startMoveDraft = () => {}; f.sandbox.renderFileMove = f.context.renderFileMove;
  f.sandbox.fileMove.act = () => { native++; }; f.sandbox.fileMove.retire = () => { native++; }; f.sandbox.fileMove.discover = () => { native++; };
  new Script(section('function moveAction(callback)', "$('file-move-close').onclick")).runInContext(f.context);
  await f.nodes.get('file-move-prepare').onclick(); assert.ok(f.nodes.get('file-move-status').textContent.includes('Choose distinct source and destination paths.')); assert.equal(native, 0);
});
test('actual startup observational discovery still occurs after optional Connections refresh fails', async () => {
  const calls = [];
  const context = createContext({ task: callback => async () => { try { await callback(); } catch { calls.push('ordinary-startup-error-shown'); } }, loadProjects: async () => calls.push('projects'), renderReview: () => calls.push('review-ui'), connections: { refresh: async () => { throw Error('Unavailable'); } }, fileMove: { discover: async () => calls.push('move-list') } });
  await new Script(`(async () => { ${section('await task(async () => { await loadProjects()', 'appControls = new McpControlBridge(')} })()`).runInContext(context);
  assert.deepEqual(calls, ['projects', 'review-ui', 'ordinary-startup-error-shown', 'move-list']);
});

test('prior-owner native inventory does not grow persisted local producer intents or adopt ownership', async () => {
  const storage = new MemoryStorage(); storage.value = JSON.stringify({ version: 1, intents: Array.from({ length: 64 }, (_, index) => ({ request: request(index + 100), moveId: null, commitSubmitted: false })), retirement: null });
  const f = fixture({ storage }); f.state.moves = [receipt(request(1), 'pending'), receipt(request(2), 'recovery_required')]; await f.controller.discover();
  assert.equal(f.controller.records.size, 66); assert.equal(f.controller.intents.size, 64); assert.equal(JSON.parse(storage.value).intents.length, 64); assert.equal(f.controller.records.get(`0:${id(1)}`).owned, false); assert.ok(f.controller.pendingCount);
  assert.deepEqual(f.calls, [{ action: 'move_list' }]);
});

test('actual dialog Close restores focus to the visible menu trigger after responsive reflow', () => {
  const calls = [], nodes = new Map(); const trigger = visible => ({ getClientRects: () => visible ? [{}] : [], focus: options => calls.push({ visible, options }) });
  const original = trigger(false), desktop = trigger(false), mobile = trigger(true);
  for (const name of ['file-move-close', 'file-move-dialog']) nodes.set(name, { listeners: {}, addEventListener(type, callback) { this.listeners[type] = callback; }, close() {} });
  nodes.set('menu-file-toggle', desktop); nodes.set('workspace-menu', { querySelector: () => mobile });
  const context = createContext({ $: name => nodes.get(name), moveReturnFocus: original });
  new Script(section("$('file-move-close').onclick", 'for (const button of document.querySelectorAll(\'[data-command="move-source"]\'))')).runInContext(context);
  nodes.get('file-move-dialog').listeners.close(); assert.equal(calls.length, 1); assert.equal(calls[0].visible, true); assert.equal(calls[0].options.preventScroll, true); assert.equal(context.moveReturnFocus, null);
});

function publicationAdapter({ activeProject = project, pdfProject = activeProject, pdfPath = 'main.typ', pdfRoot = { expectedRoot: root } } = {}) {
  const f = adapter(), title = { title: 'Compile main.typ', hidden: false }, label = { textContent: 'Current PDF · 2 pages', dataset: { state: 'current' }, classList: { toggle() {} } }, diagnosticStatus = { textContent: 'Prior native report.' }, diagnosticButtons = [{ disabled: false }];
  const base$ = f.sandbox.$;
  f.sandbox.$ = name => ({ 'typst-compile': title, 'typst-preview-status': label, 'compile-report-status': diagnosticStatus, 'compile-diagnostics': { querySelectorAll: () => diagnosticButtons } }[name] || base$(name));
  const session = Object.freeze({ project: activeProject, path: 'unrelated.typ', sourceEpoch: 4, expectedRoot: root, dirty: true, content: 'Keep current unsaved text.', editorState: Object.freeze({ selection: 'unchanged' }) });
  const pdfBytes = new Uint8Array([7, 8, 9]), pdf = Object.freeze({ numPages: 2 }), loadingTask = Object.freeze({ destroy() { throw Error('Do not clear the last good PDF.'); } });
  Object.assign(f.sandbox, { active: session, projects: [{ id: project, name: 'Current project', mainDocument: 'main.typ' }], pdfBytes, pdfPath, pdfProject, pdfRoot, pdfGeneration: 18, pdfViewer: Object.freeze({ pdf, clear() { throw Error('No viewer reset'); } }), pdfLoadingTask: loadingTask, currentCompileContext: () => true, currentCompileReport: Object.freeze({ text: 'Prior report' }) });
  new Script(section('function publicationPath(', 'function publicationCurrent(') + section('function pdfStatus(', 'function windowEditorAccess(') + section('function retireCompileNavigation(', 'function diagnosticContext(')).runInContext(f.context);
  f.sandbox.nativeResult = [{ id: project, name: 'Current project', mainDocument: 'moved.typ' }];
  return { ...f, session, title, label, diagnosticStatus, diagnosticButtons, pdfBytes, pdf, loadingTask };
}
function unchangedPublication(f) {
  assert.equal(f.sandbox.active, f.session); assert.equal(f.session.content, 'Keep current unsaved text.'); assert.equal(f.sandbox.pdfBytes, f.pdfBytes); assert.equal(f.sandbox.pdfViewer.pdf, f.pdf); assert.equal(f.sandbox.pdfLoadingTask, f.loadingTask); assert.equal(f.sandbox.pdfGeneration, 18);
  assert.equal(f.sandbox.navigationIntent, 4); assert.deepEqual(f.ipc, []); assert.ok(f.actions.every(row => row.action === 'projects'));
}
test('Move publication: closed main Move retargets current title and marks retained old PDF stale without effects', async () => {
  const f = publicationAdapter(); await f.config.refresh({ mainAfter: 'historical.typ', mainDocument: 'historical.typ' });
  assert.equal(f.title.title, 'Compile moved.typ'); assert.equal(f.label.dataset.state, 'stale'); assert.ok(f.label.textContent.includes('last good PDF retained')); assert.equal(f.sandbox.pdfPath, 'main.typ'); assert.equal(f.diagnosticButtons[0].disabled, true); unchangedPublication(f);
});
test('Move publication: same target/dependency-only Projects refresh leaves current title/PDF/navigation unchanged', async () => {
  const f = publicationAdapter(); f.sandbox.nativeResult = structuredClone(f.sandbox.projects); await f.config.refresh();
  assert.equal(f.title.title, 'Compile main.typ'); assert.equal(f.label.textContent, 'Current PDF · 2 pages'); assert.equal(f.label.dataset.state, 'current'); assert.equal(f.diagnosticButtons[0].disabled, false); unchangedPublication(f);
});
test('Move publication: current response-time active editor is used instead of a previously active project', async () => {
  const f = publicationAdapter(); const other = { id: id(99), name: 'New current editor project', mainDocument: 'other-main.typ' }; f.sandbox.projects.push(other); f.sandbox.nativeResult.push(structuredClone(other));
  let release; f.sandbox.request = operation => { f.actions.push(operation); return new Promise(resolve => release = resolve); }; const pending = f.config.refresh();
  const next = Object.freeze({ ...f.session, project: other.id, path: 'other.typ' }); f.sandbox.active = next; f.sandbox.pdfProject = other.id; f.sandbox.pdfPath = 'other-main.typ'; f.title.title = 'Compile other-main.typ';
  release(f.sandbox.nativeResult); await pending; assert.equal(f.title.title, 'Compile other-main.typ'); assert.equal(f.label.dataset.state, 'current'); assert.equal(f.sandbox.active, next); assert.equal(f.sandbox.pdfPath, 'other-main.typ'); assert.equal(f.sandbox.pdfBytes, f.pdfBytes); assert.equal(f.sandbox.navigationIntent, 4); assert.deepEqual(f.ipc, []);
});
test('Move publication: navigation during held Projects observation rejects all stale display/metadata writes', async () => {
  const f = publicationAdapter(); const before = f.sandbox.projects; let release; f.sandbox.request = () => new Promise(resolve => release = resolve); const pending = f.config.refresh(); f.sandbox.navigationIntent++; release(f.sandbox.nativeResult); await pending;
  assert.equal(f.sandbox.projects, before); assert.equal(f.title.title, 'Compile main.typ'); assert.equal(f.label.dataset.state, 'current'); assert.deepEqual(f.refreshes, []);
});
test('Move publication: unrelated-project or different-root retained PDF is not relabelled by another target change', async () => {
  for (const options of [{ pdfProject: id(88) }, { pdfRoot: { expectedRoot: { dev: '4', ino: '5' } } }]) {
    const f = publicationAdapter(options); await f.config.refresh(); assert.equal(f.title.title, 'Compile moved.typ'); assert.equal(f.label.dataset.state, 'current'); assert.equal(f.sandbox.pdfPath, 'main.typ'); unchangedPublication(f);
  }
});
test('Move publication: newer matching destination PDF is kept current when actual Projects target catches up', async () => {
  const f = publicationAdapter({ pdfPath: 'moved.typ' }); await f.config.refresh(); assert.equal(f.title.title, 'Compile moved.typ'); assert.equal(f.label.dataset.state, 'current'); assert.equal(f.sandbox.pdfPath, 'moved.typ'); unchangedPublication(f);
});
test('Move publication: held old Projects reply never overwrites a newer local main/preview array update', async () => {
  const f = publicationAdapter(); let release; f.sandbox.request = operation => { f.actions.push(operation); return new Promise(resolve => release = resolve); }; const pending = f.config.refresh();
  const newer = f.sandbox.projects.map(row => ({ ...row, mainDocument: 'newer-explicit-main.typ' })); f.sandbox.projects = newer; f.sandbox.pdfPath = 'newer-explicit-main.typ'; f.title.title = 'Compile newer-explicit-main.typ';
  release(f.sandbox.nativeResult); await pending; assert.equal(f.sandbox.projects, newer); assert.equal(f.title.title, 'Compile newer-explicit-main.typ'); assert.equal(f.label.dataset.state, 'current'); assert.equal(f.sandbox.pdfPath, 'newer-explicit-main.typ'); assert.equal(f.diagnosticButtons[0].disabled, false); unchangedPublication(f);
});

test('Move publication: genuine local main callback and newer preview win over a held old Projects response', async () => {
  const f = publicationAdapter(); const { captureSourceBinding } = await import('../modules/frontend/review-session.js');
  f.sandbox.captureSourceBinding = captureSourceBinding;
  new Script(section('function keyFor(', 'function navigationCurrent(') + section('function observedSourceTarget(', 'function assertPublicationTarget(') + section('async function setMainDocument(', 'function queueSync(')).runInContext(f.context);
  const newPath = 'newer-explicit-main.typ'; f.tree.push({ dataset: { path: newPath, sourceEpoch: '4' } });
  let release; f.sandbox.request = operation => {
    f.actions.push(structuredClone(operation));
    if (operation.action === 'projects') return new Promise(resolve => release = resolve);
    if (operation.action === 'set_main_document') return Promise.resolve({ id: project, name: 'Current project', mainDocument: newPath });
    throw Error('No other request is authorized by this source fixture.');
  };
  const newerBytes = new Uint8Array([10, 11, 12]), newerPdf = Object.freeze({ numPages: 3 }), newerTask = Object.freeze({ destroy() { throw Error('Keep the newer preview.'); } });
  let explicitPreview = 0;
  f.sandbox.loadPublicationPreview = async session => {
    assert.equal(session, f.session); explicitPreview++;
    Object.assign(f.sandbox, { pdfPath: newPath, pdfBytes: newerBytes, pdfViewer: Object.freeze({ pdf: newerPdf, clear() { throw Error('No clear'); } }), pdfLoadingTask: newerTask, pdfGeneration: 19 });
    f.title.title = `Compile ${newPath}`; f.label.textContent = 'Current PDF · 3 pages';
  };
  f.sandbox.status = () => {};
  const pending = f.config.refresh(); await f.sandbox.setMainDocument(newPath);
  const newerProjects = f.sandbox.projects; assert.equal(newerProjects[0].mainDocument, newPath); assert.equal(explicitPreview, 1);
  release(f.sandbox.nativeResult); await pending;
  assert.equal(f.sandbox.projects, newerProjects); assert.equal(f.title.title, `Compile ${newPath}`); assert.equal(f.label.textContent, 'Current PDF · 3 pages'); assert.equal(f.label.dataset.state, 'current');
  assert.equal(f.sandbox.pdfBytes, newerBytes); assert.equal(f.sandbox.pdfViewer.pdf, newerPdf); assert.equal(f.sandbox.pdfLoadingTask, newerTask); assert.equal(f.sandbox.pdfGeneration, 19); assert.equal(f.sandbox.active, f.session); assert.equal(f.sandbox.navigationIntent, 4); assert.equal(f.session.editorState.selection, 'unchanged');
  assert.deepEqual(f.actions.map(row => row.action), ['projects', 'set_main_document']); assert.deepEqual(f.ipc, []); assert.equal(explicitPreview, 1);
});

function focusDialogAdapter({ documentFocused = true, open = true, modal = true, invalidationFocus = null } = {}) {
  const f = dialogAdapter(), document = f.sandbox.document, focusCalls = [];
  document.body = { id: 'fixture-body' }; document.hasFocus = () => documentFocused;
  const prepare = f.nodes.get('file-move-prepare'), status = f.nodes.get('file-move-status'), dialog = f.nodes.get('file-move-dialog');
  dialog.open = open; dialog.matches = selector => selector === ':modal' && modal;
  // This declared DOM model matches the observed real Chrome focused-button invalidation trace.
  for (const name of ['hidden', 'disabled']) {
    let current = prepare[name];
    Object.defineProperty(prepare, name, { get: () => current, set(value) {
      current = value;
      if (value && document.activeElement === prepare) { document.activeElement = invalidationFocus ? f.nodes.get(invalidationFocus) : document.body; }
    } });
  }
  const statusMarkup = awaitHtml.match(/<p\b[^>]*\bid="file-move-status"[^>]*>/)[0];
  for (const node of f.nodes.values()) node.focus = () => {
    if (node.hidden || node.disabled || node === status && !/\btabindex="-1"/.test(statusMarkup)) return;
    document.activeElement = node; focusCalls.push(node.id);
  };
  document.activeElement = prepare;
  return { ...f, document, prepare, status, dialog, focusCalls };
}
async function prepareFocusCallback({ hold = false, ...options } = {}) {
  const f = focusDialogAdapter(options);
  let release, signalSubmitted;
  const held = new Promise(resolve => { release = resolve; }), submitted = new Promise(resolve => { signalSubmitted = resolve; });
  const actual = fixture({ prepare: async (request, result) => { signalSubmitted(); if (hold) await held; return result; } });
  await actual.controller.discover(); f.sandbox.fileMove = actual.controller;
  actual.controller.onChange = () => f.context.renderFileMove();
  f.context.renderFileMove();
  new Script(section('function moveAction(callback)', "$('file-move-close').onclick")).runInContext(f.context);
  return { ...f, actual, release, submitted };
}
test('Move focus: actual Prepare callback preserves focus at the result while the focused button becomes unavailable', async () => {
  const f = await prepareFocusCallback(); const action = f.nodes.get('file-move-prepare').onclick();
  assert.equal(f.document.activeElement, f.status, 'actual busy render must replace invalidated Prepare focus with intended status');
  await action; assert.equal(f.prepare.hidden, true); assert.equal(f.document.activeElement, f.status); assert.deepEqual(f.focusCalls, ['file-move-status']);
  assert.equal(f.actual.controller.current.phase, 'prepared'); assert.equal(f.actual.calls.filter(row => row.prepare).length, 1);
  assert.equal(f.actual.calls.some(row => ['move_commit', 'move_cancel', 'move_reconcile'].includes(row.action)), false);
});
test('Move focus: genuine newer user focus wins over all later actual Prepare response renders', async () => {
  const f = await prepareFocusCallback({ hold: true }); const action = f.nodes.get('file-move-prepare').onclick();
  assert.equal(f.document.activeElement, f.status); await f.submitted;
  const close = f.nodes.get('file-move-close'); f.document.activeElement = close;
  f.release(); await action; assert.equal(f.document.activeElement, close); assert.deepEqual(f.focusCalls, ['file-move-status']);
  assert.equal(f.actual.controller.current.phase, 'prepared');
});
test('Move focus: actual render does not move an already focused enabled Prepare', () => {
  const f = focusDialogAdapter(); f.context.renderFileMove(); assert.equal(f.document.activeElement, f.prepare); assert.deepEqual(f.focusCalls, []);
});
test('Move focus: actual render preserves another user control during unrelated busy metadata updates', () => {
  const f = focusDialogAdapter(), close = f.nodes.get('file-move-close'); f.document.activeElement = close;
  f.controller.busy = true; f.controller.canPrepare = false; f.context.renderFileMove(); assert.equal(f.document.activeElement, close); assert.deepEqual(f.focusCalls, []);
});
test('Move focus: intervening focusout handler movement during invalidation is not stolen', () => {
  const f = focusDialogAdapter({ invalidationFocus: 'file-move-close' }); f.controller.busy = true; f.controller.canPrepare = false; f.context.renderFileMove();
  assert.equal(f.document.activeElement, f.nodes.get('file-move-close')); assert.deepEqual(f.focusCalls, []);
});
for (const [name, options] of [['background document', { documentFocused: false }], ['closed dialog', { open: false }], ['nonmodal dialog', { modal: false }]]) {
  test(`Move focus: actual render does not force focus into a ${name}`, () => {
    const f = focusDialogAdapter(options); f.controller.busy = true; f.controller.canPrepare = false; f.context.renderFileMove();
    assert.equal(f.document.activeElement, f.document.body); assert.deepEqual(f.focusCalls, []);
  });
}
