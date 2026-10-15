import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { ReviewSession, sourceEpoch, sourceRoot, sourceRootsEqual, captureSourceBinding, sourceBindingCurrent, assertSourceBinding, assertSourceSnapshot, localNoSaveClose } from '../modules/frontend/review-session.js';
import { EditorSessionBridge } from '../modules/frontend/editor-session-bridge.js';
import { capturePublicationInputs, publicationPreviewCurrent, manuscriptTree } from '../modules/frontend/manuscript-workspace.js';
import { captureControlState, assertControlState, controlPreviewIdentity, assertControlPreview } from '../modules/frontend/manuscript-control-state.js';

const manuscript = await readFile(new URL('../src/manuscript.js', import.meta.url), 'utf8');
const identity = { sourceEpoch, sourceRoot, sourceRootsEqual, captureSourceBinding, sourceBindingCurrent, assertSourceBinding, assertSourceSnapshot, localNoSaveClose };
const root0 = Object.freeze({ dev: '18446744073709551615', ino: '9007199254740993' });
const root1 = Object.freeze({ dev: root0.dev, ino: '9007199254740994' });
const snap = (root = root0, path = 'main.typ', content = 'same bytes', epoch = 2) => ({ path, content, sourceEpoch: epoch, ...(root ? { expectedRoot: root } : {}), documentId: path, shared: true, sidecarRevision: null, review: { revision: content, markers: [{ id: 'retained' }], rules: [], suggestions: [] } });
const make = (root = root0, path = 'main.typ', request = async () => snap(root, path), epoch = 2) => new ReviewSession(snap(root, path, 'same bytes', epoch), 'project', request);
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const turn = () => new Promise(resolve => setImmediate(resolve));
// Simulate only a future proved rebind to test late ownership; no public rebind API.
function rebind(session, root) { session.expectedRoot = root; session.snapshot = { ...session.snapshot, expectedRoot: root }; }
const callback = (id, event = 'onclick', start = 'async \\(\\)') => manuscript.match(new RegExp(`\\$\\('${id}'\\)\\.${event} = task\\((${start} => \\{[\\s\\S]*?\\n\\})\\);`))[1];

test('root identity uses exact canonical decimal u64 strings and immutable copies, with omission as the only legacy form', () => {
  assert.equal(sourceRoot({}), undefined);
  assert.deepEqual(sourceRoot({ expectedRoot: root0 }), root0);
  assert.deepEqual(sourceRoot({ expectedRoot: { dev: '0', ino: '0' } }), { dev: '0', ino: '0' });
  const bad = [null, undefined, [], 'root', 0, {}, { dev: '1' }, { dev: '1', ino: '2', extra: '3' }, { dev: 1, ino: '2' }, { dev: '01', ino: '2' }, { dev: '-1', ino: '2' }, { dev: '+1', ino: '2' }, { dev: '1e2', ino: '2' }, { dev: '18446744073709551616', ino: '2' }, { dev: '1', ino: '184467440737095516150' }, { dev: '1', ino: '' }, { dev: '1', ino: '2\n' }, Object.assign(Object.create({ extra: 'unknown' }), { dev: '1', ino: '2' }), { get dev() { throw Error('Do not invoke a getter'); }, ino: '2' }, { dev: '1', ino: '2', [Symbol('unknown')]: '3' }];
  for (const expectedRoot of bad) assert.throws(() => sourceRoot({ expectedRoot }), error => error.code === 'format');
  assert.throws(() => sourceRoot(Object.create({ expectedRoot: root0 })), error => error.code === 'format');
  assert.throws(() => sourceRoot({ get expectedRoot() { throw Error('Do not invoke a root getter'); } }), error => error.code === 'format');
  const original = { ...root0 }, session = make(original), captured = captureSourceBinding(session);
  original.ino = root1.ino;
  assert.deepEqual(captured.expectedRoot, root0); assert.deepEqual(session.expectedRoot, root0);
  assert.equal(Object.isFrozen(captured.expectedRoot), true);
  assert.equal(sourceBindingCurrent(session, captured), false, 'a changed snapshot never lends a replacement root');
  assert.equal(sourceRootsEqual({}, { expectedRoot: root0 }), false);
});

test('queued Save and policy callbacks keep the original root before prior work without saving a same-byte replacement', async () => {
  for (const action of ['save', 'mark', 'unmark', 'palette', 'reanchor', 'decide']) {
    const gate = deferred(), operations = [], session = make(root0, 'main.typ', async operation => { operations.push(operation); return snap(); });
    session.queue = gate.promise;
    const work = action === 'save' ? session.flush() : session.mutate(action);
    rebind(session, root1); const current = session.snapshot; gate.resolve();
    await assert.rejects(work, error => error.code === 'stale_root');
    assert.deepEqual(operations, []); assert.equal(session.snapshot, current); assert.equal(session.identityProblem, null);
  }
});

test('late Save and policy responses cannot clean or replace a rebound root with newer typing', async () => {
  for (const action of ['save', 'mark', 'decide']) {
    const gate = deferred(), operations = [], session = make(root0, 'main.typ', async operation => { operations.push(operation); await gate.promise; return snap(root0, 'main.typ', operation.content || 'accepted'); });
    if (action === 'save') session.edit('captured draft');
    const work = action === 'save' ? session.flush() : session.mutate(action);
    await turn(); rebind(session, root1); session.edit('newer typing'); const current = session.snapshot, savedVersion = session.savedVersion;
    gate.resolve(); await assert.rejects(work, error => error.code === 'stale_root');
    assert.deepEqual(operations[0].expectedRoot, root0); assert.equal(session.snapshot, current); assert.equal(session.savedVersion, savedVersion); assert.equal(session.content, 'newer typing'); assert.equal(session.identityProblem, null);
  }
});

test('pure Review cannot silently adopt changed, added or missing root authority even with identical content and epoch', async () => {
  for (const [oldRoot, observedRoot] of [[root0, root1], [root0, null], [null, root0]]) {
    const calls = [], original = snap(oldRoot), session = new ReviewSession(original, 'project', async operation => { calls.push(operation); return snap(observedRoot); });
    session.editorState = { undo: 'retained', caret: 4 };
    await assert.rejects(session.refresh(), error => error.code === 'stale_root');
    assert.equal(session.snapshot, original); assert.equal(session.editorState.undo, 'retained'); assert.equal(session.identityProblem.code, 'stale_root'); assert.equal(session.reviewProblem, null); assert.equal(session.conflict, null);
    await assert.rejects(session.flush(), error => error.code === 'stale_root'); await assert.rejects(session.refresh({ retryProblem: true }), error => error.code === 'stale_root');
    assert.deepEqual(calls.map(operation => operation.action), ['review']); assert.equal(Object.hasOwn(calls[0], 'expectedRoot'), false);
  }
});

test('native stale_root latches without repair reads; a late old-root error cannot freeze a newly bound object', async () => {
  const operations = [], session = make(root0, 'main.typ', async operation => { operations.push(operation); throw { code: 'stale_root', message: 'Native captured folder retired.' }; });
  session.edit('draft'); const original = session.snapshot;
  await assert.rejects(session.flush(), error => error.code === 'stale_root'); await assert.rejects(session.mutate('unmark'), error => error.code === 'stale_root');
  assert.equal(operations.length, 1); assert.equal(session.snapshot, original); assert.equal(session.dirty, true); assert.equal(session.content, 'draft');
  const fresh = make(), gate = deferred(); fresh.request = async () => { await gate.promise; throw { code: 'stale_root', message: 'Late old refusal.' }; };
  const refreshing = fresh.refresh(); await turn(); rebind(fresh, root1); gate.resolve(); await assert.rejects(refreshing);
  assert.equal(fresh.identityProblem, null); assert.deepEqual(fresh.expectedRoot, root1);
});

test('Register digest, stale-owner retry and late reply retain the immutable root and never add it to closed Update inputs', async t => {
  const gate = deferred(), operations = [], session = make();
  const bridge = new EditorSessionBridge({ request: async operation => { operations.push(operation); return {}; }, state: () => ({ current: true }), digest: async () => { await gate.promise; return 'digest'; } });
  t.after(() => bridge.stop()); bridge.watch(session); const publishing = bridge.publishChanges(); await turn(); rebind(session, root1); gate.resolve(); await publishing; assert.deepEqual(operations, []);
  const calls = [], second = make(); let fail = true;
  const retry = new EditorSessionBridge({ request: async operation => { calls.push(operation); if (operation.action === 'editor_update' && fail) { fail = false; throw { code: 'stale_session' }; } return { protocolVersion: 1, sessionId: 'registered', sourceEpoch: 2, expectedRoot: root0 }; }, state: () => ({ current: true }), digest: async () => 'digest' });
  t.after(() => retry.stop()); retry.watch(second); await retry.publishChanges(); second.edit('newer'); await retry.publishChanges(); await retry.publishChanges();
  assert.deepEqual(calls.filter(operation => operation.action === 'editor_register').map(operation => operation.expectedRoot), [root0, root0]);
  assert.ok(calls.filter(operation => operation.action === 'editor_update').every(operation => !Object.hasOwn(operation, 'expectedRoot')));
  assert.equal(calls.some(operation => ['open', 'review'].includes(operation.action)), false);
  const late = deferred(), third = make(), cleanup = [];
  const old = new EditorSessionBridge({ request: async operation => { if (operation.action === 'editor_register') { await late.promise; return { protocolVersion: 1, sessionId: 'retired-native', sourceEpoch: 2, expectedRoot: root0 }; } cleanup.push(operation); return {}; }, state: () => ({ current: true }), digest: async () => 'digest' });
  t.after(() => old.stop()); old.watch(third); const pending = old.publishChanges(); await turn(); rebind(third, root1); late.resolve(); await pending;
  assert.equal(old.entries.get(third).id, null); assert.equal(cleanup[0].action, 'editor_unregister'); assert.equal(third.identityProblem, null);
});

test('native Register echo and durable editor receipt must prove the same captured root', async t => {
  const session = make(), calls = [];
  const bridge = new EditorSessionBridge({ request: async operation => { calls.push(operation); return { protocolVersion: 1, sessionId: 'wrong-root', sourceEpoch: 2, expectedRoot: root1 }; }, state: () => ({ current: true }), digest: async () => 'digest' });
  t.after(() => bridge.stop()); bridge.watch(session); await bridge.publishChanges();
  assert.equal(bridge.entries.get(session).id, null); assert.equal(session.identityProblem.code, 'stale_root'); assert.equal(calls.at(-1).action, 'editor_unregister');
  for (const receiptRoot of [root1, null]) {
    const current = make(); current.edit('captured');
    await assert.rejects(current.saveEditorSnapshot({ isCurrent: () => true, isBusy: () => false, publish: async () => {}, commit: async captured => ({ snapshot: snap(root0, 'main.typ', captured.content), receipt: { status: 'committed', sourceEpoch: 2, ...(receiptRoot ? { expectedRoot: receiptRoot } : {}), savedGeneration: captured.generation, savedRevision: captured.content } }) }), error => error.code === 'outcome_unknown');
    assert.equal(current.dirty, true); assert.equal(current.snapshot.content, 'same bytes');
  }
});

test('root changes invalidate captured App and publication state, and legacy artifacts cannot certify rooted source', () => {
  const session = make(), context = { sessions: [session], active: session, navigation: 1 }, captured = captureControlState(context), inputs = capturePublicationInputs([session], 0);
  const pdf = { current: true, sourceEpoch: 2, expectedRoot: root0, revision: 'same bytes' }, state = { main: session, inputSessions: [session], captured: inputs, projectVersion: 0 };
  assert.equal(publicationPreviewCurrent(pdf, state), true);
  const preview = { active: session, shared: true, pdf: {}, pdfPath: 'main.typ', publicationPath: 'main.typ', pdfSourceEpoch: 2, pdfRoot: { expectedRoot: root0 } };
  const before = controlPreviewIdentity(preview); assert.ok(before);
  assert.equal(controlPreviewIdentity({ ...preview, pdfRoot: {} }), null);
  assert.equal(publicationPreviewCurrent({ ...pdf, expectedRoot: root1 }, state), false);
  const legacy = { ...pdf }; delete legacy.expectedRoot; assert.equal(publicationPreviewCurrent(legacy, { ...state, main: null }), false);
  rebind(session, root1); assert.throws(() => assertControlState(captured, context)); assert.equal(publicationPreviewCurrent(pdf, state), false); assert.equal(controlPreviewIdentity(preview), null); assert.throws(() => assertControlPreview(before, controlPreviewIdentity({ ...preview, pdfRoot: { expectedRoot: root1 } })));
});

function compileFixture() {
  const main = make(), chapter = make(root0, 'chapter.typ', async () => snap(root0, 'chapter.typ', 'same bytes', 7), 7), operations = [], saves = [], nodes = new Map();
  const sessions = new Map([['project:chapter.typ', chapter], ['project:main.typ', main]]);
  const environment = { ...identity, navigationIntent: 0, setCompileLog() {}, sessions, active: chapter, view: null, compiling: false, explicitCompiles: [], keyFor: (p, path) => `${p}:${path}`, publicationPath: () => 'main.typ', inventoryRoot: () => ({ expectedRoot: root0 }),
    $: id => { if (!nodes.has(id)) nodes.set(id, { textContent: '', dataset: { project: 'project' }, querySelectorAll: () => [{ dataset: { path: 'main.typ', sourceEpoch: '2' } }] }); return nodes.get(id); },
    request: async operation => { operations.push(operation); return operation.action === 'compile' ? { available: true, current: true, revision: 'same bytes', sourceEpoch: 2, expectedRoot: root0 } : snap(); }, saveSession: async session => { saves.push(session); return session.flush(); }, projectInputVersions: () => capturePublicationInputs([...sessions.values()], 0), showPdf: async () => {}, publicationCurrent: () => true, status() {}, pdfStatus() {}, pdfBytes: null, renderReview() {}, task: callback => callback, compileScheduler: { request() {}, release() {} } };
  const helpers = manuscript.slice(manuscript.indexOf('function observedSourceTarget('), manuscript.indexOf('async function setMainDocument('));
  const code = manuscript.slice(manuscript.indexOf('async function compileSession('), manuscript.indexOf('function renderTabs('));
  return { run: runInNewContext(helpers + code + '\ncompileSession;', environment), main, chapter, operations, saves, environment };
}

test('actual configured-main Open/Compile carry root strings independently of chapter epoch and queued waits', async () => {
  const good = compileFixture(); await good.run(good.chapter, true);
  assert.deepEqual(good.operations.map(operation => [operation.action, operation.path, operation.sourceEpoch, operation.expectedRoot]), [['open', 'main.typ', 2, root0], ['compile', 'main.typ', 2, root0]]);
  const queued = compileFixture(); queued.environment.compiling = true; await queued.run(queued.chapter, true); const job = queued.environment.explicitCompiles.shift();
  rebind(queued.main, root1); queued.environment.compiling = false;
  await assert.rejects(queued.run(job.session, true, job.path, job.capture), error => error.code === 'stale_root'); assert.deepEqual(queued.operations, []);
  const held = compileFixture(), gate = deferred(); held.environment.saveSession = async input => { held.saves.push(input); await gate.promise; };
  const work = held.run(held.chapter, true); await turn(); rebind(held.main, root1); gate.resolve();
  await assert.rejects(work, error => error.code === 'stale_root'); assert.deepEqual(held.saves, [held.chapter]); assert.deepEqual(held.operations, []);
  const mismatch = compileFixture(); rebind(mismatch.main, root1); await assert.rejects(mismatch.run(mismatch.chapter, true), error => error.code === 'stale_root'); assert.deepEqual(mismatch.saves, []);
});

test('new wrong-root PDF refuses parsing/export while held parse cannot install after same-object root replacement', async () => {
  const code = manuscript.slice(manuscript.indexOf('async function showPdf('), manuscript.indexOf('async function loadPublicationPreview('));
  for (const artifactRoot of [root1, null]) {
    const session = make(); let parsed = 0;
    const environment = { ...identity, active: session, sessions: new Map([['project:main.typ', session]]), keyFor: (p, path) => `${p}:${path}`, publicationPath: () => 'main.typ', observedSourceTarget: () => ({ ...captureSourceBinding(session), session }), pdfjs: { getDocument() { parsed += 1; } }, pdfBytes: 'previous explicitly stale PDF', pdfPath: 'main.typ' };
    const show = runInNewContext(code + '\nshowPdf;', environment);
    await assert.rejects(show({ available: true, sourceEpoch: 2, ...(artifactRoot ? { expectedRoot: artifactRoot } : {}), base64: '' }, session), error => error.code === 'stale');
    assert.equal(parsed, 0); assert.equal(environment.pdfBytes, 'previous explicitly stale PDF'); assert.equal(session.identityProblem, null);
  }
  const session = make(), gate = deferred(); let destroyed = 0, installed = 0;
  const environment = { ...identity, active: session, sessions: new Map([['project:main.typ', session]]), keyFor: (p, path) => `${p}:${path}`, publicationPath: () => 'main.typ', observedSourceTarget: () => ({ ...captureSourceBinding(session), session }), pdfGeneration: 0, atob: () => '', pdfjs: { getDocument: () => ({ promise: gate.promise, destroy: async () => { destroyed += 1; } }) }, pdfViewer: { clear() { installed += 1; } }, pdfLoadingTask: null, $: () => ({}), showingLogs: false };
  const work = runInNewContext(code + '\nshowPdf;', environment)({ available: true, sourceEpoch: 2, expectedRoot: root0, base64: '' }, session);
  rebind(session, root1); gate.resolve({}); await work; assert.equal(destroyed, 1); assert.equal(installed, 0);
});

test('actual cached tree and held Open cannot adopt a changed root or replace old history', async () => {
  const code = manuscript.slice(manuscript.indexOf('async function openFile('), manuscript.indexOf('async function loadFiles('));
  const session = make(), gate = deferred(), calls = [], mounted = []; let inventory = { expectedRoot: root1 };
  session.editorState = { undo: 'kept' };
  const environment = { ...identity, sessions: new Map([['project:main.typ', session]]), active: session, navigationIntent: 1, $: () => ({ value: 'project' }), inventoryRoot: () => inventory, keyFor: (p, path) => `${p}:${path}`, renderReview() {}, requireSessionCapacity() {}, request: async operation => { calls.push(operation); await gate.promise; return snap(root0, operation.path); }, navigationCurrent: () => true, trackSession: snapshot => { mounted.push(snapshot); return session; }, openSession() {} };
  const open = runInNewContext(code + '\nopenFile;', environment);
  await assert.rejects(open('main.typ', 'project', 2, inventory), error => error.code === 'stale_root'); assert.equal(session.identityProblem.code, 'stale_root'); assert.equal(session.editorState.undo, 'kept'); assert.deepEqual(calls, []);
  inventory = { expectedRoot: root0 }; const work = open('other.typ', 'project', 2, inventory); await turn(); inventory = { expectedRoot: root1 }; gate.resolve();
  await assert.rejects(work, error => error.code === 'stale_root'); assert.deepEqual(calls[0].expectedRoot, root0); assert.deepEqual(mounted, []);
});

test('actual rendered tree captures the envelope root once and preserves clicked identity without row root copies', async () => {
  const container = { dataset: {}, children: [], replaceChildren() { this.children = []; }, append(node) { this.children.push(node); } }, opened = [], roots = new WeakMap();
  const code = manuscript.slice(manuscript.indexOf('function renderFiles('), manuscript.indexOf('function openNewFolder('));
  const environment = { ...identity, $: () => container, fileInventoryRoots: roots, manuscriptTree, active: null, actionButton: (name, callback) => ({ name, callback, dataset: {}, setAttribute() {} }), openFile: (...args) => opened.push(args) };
  const render = runInNewContext(code + '\nrenderFiles;', environment), expectedRoot = { ...root0 };
  render({ project: 'project', expectedRoot, entries: [{ path: 'main.typ', kind: 'source', editable: true, sourceEpoch: 2 }] }, 'project');
  expectedRoot.ino = root1.ino; container.children[0].callback();
  assert.deepEqual(opened[0].slice(0, 3), ['main.typ', 'project', 2]); assert.deepEqual(opened[0][3].expectedRoot, root0); assert.equal(Object.isFrozen(opened[0][3].expectedRoot), true); assert.deepEqual(Object.keys(container.children[0].dataset).sort(), ['path', 'sourceEpoch']);
  assert.deepEqual(roots.get(container).expectedRoot, root0);
});

test('New file captures tree root before submission and suppresses a late result after inventory replacement', async () => {
  const session = make(), gate = deferred(), calls = [], mounted = [], context = { project: 'project', expectedRoot: root0 }; let inventory = { expectedRoot: root0 };
  const environment = { ...identity, newFileContext: context, navigationIntent: 0, currentProject: () => ({ id: 'project' }), inventoryRoot: () => inventory, requireSessionCapacity() {}, sessions: new Map(), keyFor: (p, path) => `${p}:${path}`, $: id => id === 'new-path' ? { value: 'new.typ' } : { close() {} }, request: async operation => { calls.push(operation); await gate.promise; return snap(root0, 'new.typ', 'new', 4); }, navigationCurrent: () => true, trackSession: snapshot => { mounted.push(snapshot); return session; }, loadFiles() {}, openSession() {} };
  const submit = runInNewContext(`(${callback('new-form', 'onsubmit', 'async event')})`, environment);
  const work = submit({ preventDefault() {} }); await turn(); inventory = { expectedRoot: root1 }; gate.resolve(); await work;
  assert.deepEqual(calls[0].expectedRoot, root0); assert.equal(Object.hasOwn(calls[0], 'sourceEpoch'), false); assert.deepEqual(mounted, []);
  calls.length = 0; await assert.rejects(submit({ preventDefault() {} }), error => error.code === 'stale_root'); assert.deepEqual(calls, []);
});

test('New folder uses captured root with no source epoch/save, and refuses changed inventory before its effect', async () => {
  const context = { project: 'project', expectedRoot: root0, pending: false }, calls = [], nodes = new Map(); let inventory = { expectedRoot: root1 };
  const code = manuscript.match(/\$\('new-folder-form'\)\.onsubmit = (async event => \{[\s\S]*?\n\});/)[1];
  const environment = { ...identity, newFolderContext: context, currentProject: () => ({ id: 'project' }), inventoryRoot: () => inventory, view: null, $: id => { if (!nodes.has(id)) nodes.set(id, { value: 'folder', open: true, close() {} }); return nodes.get(id); }, request: async operation => { calls.push(operation); return { project: 'project', path: 'folder', created: true, expectedRoot: root0 }; }, expandedFolders: new Set(), rememberExpandedFolders() {}, loadFiles() {}, status() {} };
  const submit = runInNewContext(`(${code})`, environment); await submit({ preventDefault() {} }); assert.deepEqual(calls, []); assert.match(nodes.get('new-folder-error').textContent, /project folder changed/);
  inventory = { expectedRoot: root0 }; await submit({ preventDefault() {} }); assert.equal(calls.length, 1); assert.deepEqual(calls[0].expectedRoot, root0); assert.equal(Object.hasOwn(calls[0], 'sourceEpoch'), false); assert.equal(calls[0].action, 'create_directory');
});

test('known stale_root permits only clean explicit local no-save Close with an original valid root', () => {
  const session = make(); session.identityProblem = { code: 'stale_root', message: 'Native root changed.' };
  assert.equal(localNoSaveClose(session), true);
  const context = { sessions: [session], active: session }; assert.throws(() => assertControlState(captureControlState(context), context, { clean: true }));
  for (const state of ['pending', 'conflict', 'uncertainMutation', 'unresolvedMove', 'dirty']) {
    const blocked = make(); blocked.identityProblem = session.identityProblem;
    if (state === 'dirty') blocked.edit('draft'); else blocked[state] = state === 'pending' ? 1 : {};
    assert.equal(localNoSaveClose(blocked), false, state);
  }
  const legacy = make(null); legacy.identityProblem = session.identityProblem; assert.equal(localNoSaveClose(legacy), false);
  const unknown = make(); unknown.identityProblem = { code: 'unknown', message: 'Not proven.' }; assert.equal(localNoSaveClose(unknown), false);
});

test('actual held Open retains source binding before saving the previous editor and never mounts a rebound target', async () => {
  const current = make(root0, 'previous.typ'), target = make(), gate = deferred(); current.edit('draft'); let mounts = 0;
  const code = manuscript.slice(manuscript.indexOf('async function openSession('), manuscript.indexOf('// This mount never flushes'));
  const navigation = manuscript.slice(manuscript.indexOf('function sessionNavigationCurrent('), manuscript.indexOf('function requireNavigationReady('));
  const environment = { ...identity, active: current, view: {}, navigationIntent: 0, navigationCurrent: () => true, sessions: new Map([['project:main.typ', target]]), keyFor: (p, path) => `${p}:${path}`, saveSession: async () => gate.promise, mountSession: () => { mounts += 1; }, request() {} };
  const open = runInNewContext(navigation + code + '\nopenSession;', environment), work = open(target, 1); rebind(target, root1); gate.resolve(); await work; assert.equal(mounts, 0);
});

test('actual Share-off stays restrictive across stale root while Share-on cannot cross an awaited rebind', async () => {
  const session = make(), gate = deferred(), operations = [];
  const environment = { ...identity, active: session, sharingSession: null, $: () => ({ checked: true }), saveSession: async () => gate.promise, request: async operation => { operations.push(operation); return { shared: false, documentId: 'replacement-id' }; }, sessions: new Map([['project:main.typ', session]]), keyFor: (p, path) => `${p}:${path}`, connections: { refresh: async () => {} }, renderReview() {} };
  const share = runInNewContext(`(${callback('manuscript-share', 'onchange')})`, environment), enabling = share(); rebind(session, root1); gate.resolve(); await assert.rejects(enabling, error => error.code === 'stale_root'); assert.deepEqual(operations, []);
  session.identityProblem = { code: 'stale_root', message: 'Native root changed.' }; const id = session.snapshot.documentId; environment.$ = () => ({ checked: false }); environment.saveSession = () => { throw Error('No implicit save'); }; await share();
  assert.equal(operations.length, 1); assert.equal(Object.hasOwn(operations[0], 'expectedRoot'), false); assert.equal(Object.hasOwn(operations[0], 'sourceEpoch'), false); assert.equal(session.snapshot.shared, false); assert.equal(session.snapshot.documentId, id); assert.ok(session.identityProblem);
});

test('ImportTex response must prove the captured root and exact new target before any new session is tracked', async () => {
  for (const [root, path, code] of [[root1, 'main.typ', 'stale_root'], [root0, 'other.typ', 'format'], [null, 'main.typ', 'stale_root']]) {
    const session = make(root0, 'main.tex'), calls = [], mounted = [];
    const environment = { ...identity, active: session, navigationIntent: 0, requireSessionCapacity() {}, saveSession: async () => session.snapshot, request: async operation => { calls.push(operation); return { snapshot: snap(root, path, 'imported', 4), warnings: [] }; }, navigationCurrent: () => true, trackSession: snapshot => mounted.push(snapshot), loadFiles() {}, openSession() {}, closeWorkspaceMenus() {}, status() {} };
    const importing = runInNewContext(`(${callback('tex-import')})`, environment);
    await assert.rejects(importing(), error => error.code === code); assert.deepEqual(mounted, []);
    assert.equal(calls[0].action, 'import_tex'); assert.deepEqual(calls[0].expectedRoot, root0); assert.equal(calls[0].sourceEpoch, 2); assert.equal(calls[0].target, 'main.typ'); assert.equal(session.path, 'main.tex');
  }
});

test('a held PDF reply cannot start parsing when only the captured main editor binding or Map changed', async () => {
  const code = manuscript.slice(manuscript.indexOf('async function showPdf('), manuscript.indexOf('async function loadPublicationPreview('));
  for (const change of ['root', 'map']) {
    const chapter = make(root0, 'chapter.typ', async () => snap(root0, 'chapter.typ', 'same bytes', 7), 7), main = make(), captured = { main: { ...captureSourceBinding(main), session: main } }; let parsed = 0;
    const sessions = new Map([['project:main.typ', main]]), environment = { ...identity, active: chapter, sessions, keyFor: (p, path) => `${p}:${path}`, publicationPath: () => 'main.typ', pdfjs: { getDocument() { parsed += 1; } }, pdfBytes: 'last good PDF' };
    if (change === 'root') rebind(main, root1); else sessions.set('project:main.typ', make(root1));
    const show = runInNewContext(code + '\nshowPdf;', environment);
    await assert.rejects(show({ available: true, sourceEpoch: 2, expectedRoot: root0, base64: '' }, chapter, 'main.typ', captured), error => error.code === 'stale');
    assert.equal(parsed, 0); assert.equal(environment.pdfBytes, 'last good PDF'); assert.equal(chapter.identityProblem, null);
  }
});
