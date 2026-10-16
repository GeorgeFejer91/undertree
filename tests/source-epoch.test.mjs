import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { ReviewSession, sourceEpoch, sourceRoot, sourceRootsEqual, captureSourceBinding, sourceBindingCurrent, assertSourceBinding, assertSourceSnapshot, localNoSaveClose } from '../modules/frontend/review-session.js';
import { EditorSessionBridge } from '../modules/frontend/editor-session-bridge.js';
import { capturePublicationInputs, publicationPreviewCurrent } from '../modules/frontend/manuscript-workspace.js';
import { captureControlState, assertControlState, controlPreviewIdentity } from '../modules/frontend/manuscript-control-state.js';
const manuscript = await readFile(new URL('../src/manuscript.js', import.meta.url), 'utf8');
const identity = { sourceEpoch, sourceRoot, sourceRootsEqual, captureSourceBinding, sourceBindingCurrent, assertSourceBinding, assertSourceSnapshot, localNoSaveClose };
const snap = (epoch = 0, path = 'main.typ', content = 'same bytes') => ({ path, content, sourceEpoch: epoch, sidecarRevision: null, documentId: path, shared: true, review: { revision: content, markers: [], suggestions: [], rules: [] } });
const make = (epoch = 0, path = 'main.typ', request = async () => snap(epoch, path)) => new ReviewSession(snap(epoch, path), 'project', request);
const defer = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const turn = () => new Promise(resolve => setImmediate(resolve));
// A future native-proved rebind is simulated only to test response ownership; no public rebind API is added.
const rebind = (session, epoch) => { session.sourceEpoch = epoch; session.snapshot = { ...session.snapshot, sourceEpoch: epoch }; };

test('source identity accepts missing legacy0 only and validates supplied epoch and raw sidecar hash', () => {
  assert.equal(sourceEpoch({}), 0); assert.equal(sourceEpoch({ sourceEpoch: 9 }), 9);
  for (const value of [null, undefined, '0', -1, .5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => new ReviewSession({ ...snap(), sourceEpoch: value }, 'project', async () => {}), error => error.code === 'format');
  const binding = { project: 'project', path: 'main.typ', sourceEpoch: 0 };
  for (const value of [false, 4, '', 'not-a-hash', undefined]) assert.throws(() => assertSourceSnapshot({ ...snap(), sidecarRevision: value }, binding), error => error.code === 'format');
  assert.doesNotThrow(() => assertSourceSnapshot({ ...snap(), sidecarRevision: 'a'.repeat(64) }, binding));
  const legacy = snap(); delete legacy.sourceEpoch; delete legacy.sidecarRevision;
  assert.equal(new ReviewSession(legacy, 'project', async () => {}).sourceEpoch, 0);
});

test('same-byte pure Review retirement preserves snapshot/history and cannot heal through refresh or clean Save', async () => {
  const actions = [], session = make(0, 'main.typ', async operation => { actions.push(operation); return snap(1); });
  const original = session.snapshot; session.editorState = { undo: 'retained' };
  await assert.rejects(session.refresh(), error => error.code === 'stale_document');
  assert.equal(session.snapshot, original); assert.equal(session.sourceEpoch, 0); assert.equal(session.editorState.undo, 'retained'); assert.equal(session.conflict, null);
  await assert.rejects(session.flush(), error => error.code === 'stale_document');
  await assert.rejects(session.refresh({ retryProblem: true }), error => error.code === 'stale_document');
  assert.deepEqual(actions.map(operation => operation.action), ['review']); assert.equal(actions[0].sourceEpoch, 0);
});

test('Review refresh preserves the rooted native document identity used by Share', async () => {
  const root = { dev: '7', ino: '19' }, operations = [];
  const original = { ...snap(3), expectedRoot: root, documentId: 'rooted-document' };
  const session = new ReviewSession(original, 'project', async operation => {
    operations.push(operation);
    return { ...original, documentId: operation.expectedRoot ? 'rooted-document' : 'legacy-document' };
  });
  assert.equal(await session.refresh(), true);
  assert.deepEqual(operations, [{ action: 'review', project: 'project', path: 'main.typ', sourceEpoch: 3, expectedRoot: root }]);
  assert.equal(session.snapshot.documentId, original.documentId);
  assert.equal(session.snapshot.shared, true);
});

test('queued Save and every policy intent capture identity before earlier work, even with unchanged bytes/version', async () => {
  for (const action of ['save', 'mark', 'unmark', 'reanchor', 'palette', 'decide']) {
    const gate = defer(), operations = [], session = make(2, 'main.typ', async operation => { operations.push(operation); return snap(2); });
    session.queue = gate.promise;
    const work = action === 'save' ? session.flush() : session.mutate(action);
    rebind(session, 3); const current = session.snapshot; gate.resolve();
    await assert.rejects(work, error => error.code === 'stale_document');
    assert.deepEqual(operations, []); assert.equal(session.snapshot, current); assert.equal(session.identityProblem, null);
  }
});

test('late Save/policy responses cannot update a rebound same object or mark later typing saved', async () => {
  for (const action of ['save', 'mark', 'decide']) {
    const gate = defer(), operations = [], session = make(4, 'main.typ', async operation => { operations.push(operation); await gate.promise; return snap(4, 'main.typ', operation.content || 'accepted'); });
    if (action === 'save') session.edit('captured draft');
    const work = action === 'save' ? session.flush() : session.mutate(action);
    await turn(); rebind(session, 5); session.edit('newer user typing'); const current = session.snapshot, savedVersion = session.savedVersion;
    gate.resolve(); await assert.rejects(work, error => error.code === 'stale_document');
    assert.equal(operations[0].sourceEpoch, 4); assert.equal(session.snapshot, current); assert.equal(session.savedVersion, savedVersion); assert.equal(session.content, 'newer user typing'); assert.equal(session.identityProblem, null);
  }
});

test('native stale_document freezes the old binding without fetching/adopting a replacement', async () => {
  const operations = [], session = make(6, 'main.typ', async operation => { operations.push(operation); throw { code: 'stale_document', message: 'Retired source.' }; });
  session.edit('my draft'); const before = session.snapshot;
  await assert.rejects(session.flush(), error => error.code === 'stale_document');
  await assert.rejects(session.mutate('unmark'), error => error.code === 'stale_document');
  assert.equal(operations.length, 1); assert.equal(session.snapshot, before); assert.equal(session.content, 'my draft'); assert.equal(session.sourceEpoch, 6);
});

test('digest and late native registration cannot attach to a rebound source; automatic stale-session retries keep captured epoch', async t => {
  const operations = [], session = make(7), gate = defer();
  const bridge = new EditorSessionBridge({ request: async operation => { operations.push(operation); return { protocolVersion: 1, sessionId: 'native', sourceEpoch: 7 }; }, state: () => ({ current: true }), digest: async () => { await gate.promise; return 'digest'; } });
  t.after(() => bridge.stop()); bridge.watch(session); const publishing = bridge.publishChanges(); await turn(); rebind(session, 8); gate.resolve(); await publishing;
  assert.equal(operations.length, 0);
  const second = make(9), calls = []; let failUpdate = true;
  const next = new EditorSessionBridge({ request: async operation => { calls.push(operation); if (operation.action === 'editor_update' && failUpdate) { failUpdate = false; throw { code: 'stale_session' }; } return { protocolVersion: 1, sessionId: 'same-owner', sourceEpoch: 9 }; }, state: () => ({ current: true }), digest: async () => 'digest' });
  t.after(() => next.stop()); next.watch(second); await next.publishChanges(); second.edit('new draft'); await next.publishChanges(); await next.publishChanges();
  assert.deepEqual(calls.filter(operation => operation.action === 'editor_register').map(operation => operation.sourceEpoch), [9, 9]);
  assert.equal(calls.some(operation => ['review', 'open'].includes(operation.action)), false);
  const late = defer(), third = make(10), retired = [];
  const last = new EditorSessionBridge({ request: async operation => { if (operation.action === 'editor_register') { await late.promise; return { protocolVersion: 1, sessionId: 'late-old-id', sourceEpoch: 10 }; } retired.push(operation); return {}; }, state: () => ({ current: true }), digest: async () => 'digest' });
  t.after(() => last.stop()); last.watch(third); const pending = last.publishChanges(); await turn(); rebind(third, 11); late.resolve(); await pending;
  assert.equal(last.entries.get(third).id, null); assert.equal(retired[0].action, 'editor_unregister'); assert.equal(third.sourceEpoch, 11);
});

test('immutable editor save receipt must match source epoch and cannot clean a rebound buffer', async () => {
  for (const change of ['wrong-receipt', 'rebind']) {
    const gate = defer(), session = make(2); session.edit('captured');
    const work = session.saveEditorSnapshot({ isCurrent: () => true, isBusy: () => false, publish: async () => {}, commit: async captured => { await gate.promise; return { snapshot: snap(2, 'main.typ', captured.content), receipt: { sourceEpoch: change === 'wrong-receipt' ? 3 : 2, status: 'committed', savedGeneration: captured.generation, savedRevision: captured.content } }; } });
    await turn(); if (change === 'rebind') rebind(session, 3); const current = session.snapshot;
    gate.resolve(); await assert.rejects(work, error => ['stale_document', 'outcome_unknown'].includes(error.code));
    assert.equal(session.snapshot, current); assert.equal(session.dirty, true);
  }
});

test('same-object binding changes invalidate App captures and PDF currentness without source/version changes', () => {
  for (const change of ['snapshot-only', 'binding', 'path', 'project', 'frozen']) {
    const session = make(2), context = { sessions: [session], active: session, navigation: 1 }, captured = captureControlState(context), inputs = capturePublicationInputs([session], 0);
    const state = { main: session, inputSessions: [session], captured: inputs, projectVersion: 0 }, pdf = { current: true, revision: session.snapshot.review.revision, sourceEpoch: 2 };
    assert.equal(publicationPreviewCurrent(pdf, state), true);
    if (change === 'snapshot-only') session.snapshot = { ...session.snapshot, sourceEpoch: 3 };
    if (change === 'binding') rebind(session, 3);
    if (change === 'path') session.path = 'moved.typ';
    if (change === 'project') session.project = 'other';
    if (change === 'frozen') session.identityProblem = { code: 'stale_document' };
    assert.throws(() => assertControlState(captured, context)); assert.equal(publicationPreviewCurrent(pdf, state), false);
    assert.equal(controlPreviewIdentity({ active: session, shared: true, pdf: {}, pdfPath: 'main.typ', publicationPath: 'main.typ', pdfSourceEpoch: 2, pdfProject: 'project' }), null);
  }
});

function compileFixture({ mainOpen = true } = {}) {
  const main = make(2), chapter = make(7, 'chapter.typ'), operations = [], saves = [], nodes = new Map();
  const sessions = new Map([['project:chapter.typ', chapter], ...(mainOpen ? [['project:main.typ', main]] : [])]);
  const environment = { ...identity, navigationIntent: 0, setCompileLog() {}, inventoryRoot: () => ({}), sessions, active: chapter, view: null, compiling: false, explicitCompiles: [], keyFor: (project, path) => `${project}:${path}`, publicationPath: () => 'main.typ',
    $: id => { if (!nodes.has(id)) nodes.set(id, { textContent: '', dataset: { project: 'project' }, querySelectorAll: () => [{ dataset: { path: 'main.typ', sourceEpoch: '2' } }] }); return nodes.get(id); },
    request: async operation => { operations.push(operation); return operation.action === 'compile' ? { available: true, current: true, revision: 'same bytes', sourceEpoch: 2 } : snap(2); },
    saveSession: async session => { saves.push(session.path); return session.flush(); }, projectInputVersions: () => capturePublicationInputs([...sessions.values()], 0), showPdf: async () => {}, publicationCurrent: () => true, status() {}, pdfStatus() {}, pdfBytes: null, renderReview() {}, task: callback => callback, compileScheduler: { request() {}, release() {} },
  };
  const helpers = manuscript.slice(manuscript.indexOf('function observedSourceTarget('), manuscript.indexOf('async function setMainDocument('));
  const compile = manuscript.slice(manuscript.indexOf('async function compileSession('), manuscript.indexOf('function renderTabs('));
  const run = runInNewContext(helpers + compile + '\ncompileSession;', environment);
  return { run, main, chapter, operations, saves, environment };
}

test('actual compile captures configured-main epoch independently of active chapter and unopened row', async () => {
  for (const mainOpen of [true, false]) {
    const f = compileFixture({ mainOpen }); await f.run(f.chapter, true);
    assert.deepEqual(f.operations.map(operation => [operation.action, operation.path, operation.sourceEpoch]), [['open', 'main.typ', 2], ['compile', 'main.typ', 2]]);
    assert.equal(f.chapter.sourceEpoch, 7);
  }
});

test('actual queued or save-all-held main capture refuses retirement without resolving a new epoch or compiling', async () => {
  const queued = compileFixture(); queued.environment.compiling = true; await queued.run(queued.chapter, true);
  const job = queued.environment.explicitCompiles.shift(); assert.equal(job.capture.target.sourceEpoch, 2);
  rebind(queued.main, 3); queued.environment.compiling = false;
  await assert.rejects(queued.run(job.session, true, job.path, job.capture), error => error.code === 'stale_document'); assert.deepEqual(queued.operations, []);
  const held = compileFixture(), gate = defer(); held.environment.saveSession = async () => { await gate.promise; };
  const work = held.run(held.chapter, true); await turn(); rebind(held.main, 3); gate.resolve();
  await assert.rejects(work, error => error.code === 'stale_document'); assert.deepEqual(held.operations, []);
});

test('actual Share-on cannot cross a held save identity change; restrictive Share-off still sends no epoch/save', async () => {
  const callback = manuscript.match(/\$\('manuscript-share'\)\.onchange = task\((async \(\) => \{[\s\S]*?\n\})\);/)[1];
  const session = make(3), gate = defer(), operations = [];
  const environment = { ...identity, active: session, sharingSession: null, $: () => ({ checked: true }), saveSession: async () => gate.promise, request: async operation => { operations.push(operation); return { documentId: 'main.typ', shared: false }; }, sessions: new Map([['project:main.typ', session]]), keyFor: (p, path) => `${p}:${path}`, connections: { refresh: async () => {} }, renderReview() {} };
  const handler = runInNewContext(`(${callback})`, environment), enabling = handler(); rebind(session, 4); gate.resolve(); await assert.rejects(enabling, error => error.code === 'stale_document'); assert.deepEqual(operations, []);
  session.identityProblem = { code: 'stale_document' }; environment.$ = () => ({ checked: false }); environment.saveSession = () => { throw Error('No save for revoke'); }; await handler();
  assert.equal(operations.length, 1); assert.equal(Object.hasOwn(operations[0], 'sourceEpoch'), false); assert.equal(session.snapshot.shared, false);
});

test('actual cached tree Open refuses a new occupant and stale project callback without replacing retained history', async () => {
  const code = manuscript.slice(manuscript.indexOf('async function openFile('), manuscript.indexOf('async function loadFiles('));
  const session = make(2), operations = [], sessions = new Map([['project:main.typ', session]]); session.editorState = { undo: 'kept' };
  const environment = { ...identity, inventoryRoot: () => ({}), sessions, active: session, navigationIntent: 1, $: () => ({ value: 'project' }), keyFor: (p, path) => `${p}:${path}`, renderReview() {}, requireSessionCapacity() {}, request: async op => { operations.push(op); return snap(3); }, navigationCurrent: () => true, trackSession() { throw Error('Do not replace old buffer'); }, openSession() { throw Error('No implicit reopen'); } };
  const open = runInNewContext(code + '\nopenFile;', environment);
  await assert.rejects(open('main.typ', 'project', 3), error => error.code === 'stale_document'); assert.equal(session.editorState.undo, 'kept'); assert.equal(session.sourceEpoch, 2); assert.equal(operations.length, 0);
  await assert.rejects(open('main.typ', 'other', 3)); assert.equal(operations.length, 0);
});

test('actual PDF parse cannot install an old result after a same-object main rebind', async () => {
  const session = make(2), gate = defer(); let destroyed = 0, installed = 0;
  const code = manuscript.slice(manuscript.indexOf('async function showPdf('), manuscript.indexOf('async function loadPublicationPreview('));
  const environment = { ...identity, active: session, sessions: new Map([['project:main.typ', session]]), keyFor: (p, path) => `${p}:${path}`, publicationPath: () => 'main.typ', observedSourceTarget: () => ({ ...captureSourceBinding(session), session }), pdfGeneration: 0, atob: () => '', pdfjs: { getDocument: () => ({ promise: gate.promise, destroy: async () => { destroyed += 1; } }) }, pdfViewer: { clear() { installed += 1; } }, pdfLoadingTask: null, $: () => ({}), showingLogs: false };
  const show = runInNewContext(code + '\nshowPdf;', environment), work = show({ available: true, sourceEpoch: 2, base64: '' }, session);
  rebind(session, 3); gate.resolve({}); await work; assert.equal(destroyed, 1); assert.equal(installed, 0);
});

test('actual main choice uses its own captured epoch and main clear remains usable on a frozen active buffer', async () => {
  const f = compileFixture(); f.environment.projects = [{ id: 'project', mainDocument: 'main.typ' }]; f.environment.currentProject = () => f.environment.projects[0];
  f.environment.loadPublicationPreview = async () => {};
  f.environment.request = async operation => { f.operations.push(operation); return { id: 'project', mainDocument: operation.path || null }; };
  const code = manuscript.slice(manuscript.indexOf('function observedSourceTarget('), manuscript.indexOf('function queueSync('));
  const choose = runInNewContext(code + '\nsetMainDocument;', f.environment);
  await choose('main.typ'); assert.equal(f.operations[0].sourceEpoch, 2); assert.equal(f.operations[0].path, 'main.typ');
  f.chapter.identityProblem = { code: 'stale_document' }; await choose(null);
  assert.equal(Object.hasOwn(f.operations[1], 'sourceEpoch'), false); assert.equal(f.operations[1].path, null);
});

test('explicit local clean retired Close skips Save while dirty, pending, uncertain or remote Close stay blocked', async () => {
  const configuration = manuscript.match(/windowChrome = await setupWindowChrome\((\{[\s\S]*?\n\})\);/)[1];
  const session = make(3); session.identityProblem = { code: 'stale_document', message: 'Retired.' }; let saves = 0;
  const chrome = runInNewContext(`(${configuration})`, { ...identity, sessions: new Map([['file', session]]), status() {}, setWindowClosing() {}, controlContext: () => ({ pending: 0 }), saveSession: async () => { saves += 1; } });
  assert.equal(chrome.canClose(), true); await chrome.beforeClose(); assert.equal(saves, 0);
  for (const state of ['dirty', 'pending', 'conflict', 'uncertainMutation', 'unresolvedMove', 'unknown', 'malformed']) {
    const blocked = make(3); blocked.identityProblem = { code: state === 'unknown' ? 'outcome_unknown' : 'stale_document', ...(state !== 'malformed' ? { message: 'Known retired source.' } : {}) };
    if (state === 'dirty') blocked.edit('my draft');
    else if (!['unknown', 'malformed'].includes(state)) blocked[state] = state === 'pending' ? 1 : {};
    assert.equal(localNoSaveClose(blocked), false, state);
    assert.throws(() => assertControlState(captureControlState({ sessions: [blocked] }), { sessions: [blocked] }, { clean: true }), state);
  }
});

test('actual share projection cannot apply a new same-path occupant share to a retired buffer', () => {
  const callbacks = manuscript.slice(manuscript.indexOf('  onRevoked: share =>'), manuscript.indexOf("$('git-open').onclick"));
  const body = callbacks.slice(callbacks.indexOf('  onShares: shares =>') + '  onShares: '.length, callbacks.lastIndexOf('\n  },') + 4).replace(/,$/, '');
  const session = make(3); session.snapshot = { ...session.snapshot, shared: false };
  const environment = { ...identity, sessions: new Map([['file', session]]), sharedManuscripts: [], sharingSession: null, active: session, $: () => ({ checked: false }) };
  const project = runInNewContext(`(${body})`, environment);
  project([{ documentId: 'main.typ', project: 'project', path: 'main.typ', sourceEpoch: 4 }]); assert.equal(session.snapshot.shared, false);
  project([{ documentId: 'main.typ', project: 'project', path: 'main.typ', sourceEpoch: 3 }]); assert.equal(session.snapshot.shared, true);
  session.identityProblem = { code: 'stale_document' }; project([{ documentId: 'main.typ', project: 'project', path: 'main.typ', sourceEpoch: 3 }]); assert.equal(session.snapshot.shared, false);
});

test('actual selected passage retains its dialog-time source identity before entering the policy queue', async () => {
  const session = make(2), selection = { session, binding: captureSourceBinding(session), version: 0, from: 0, to: 4, quote: 'same' };
  rebind(session, 3); let queued = 0; session.mutate = async () => { queued += 1; };
  const callback = manuscript.match(/\$\('highlight-form'\)\.onsubmit = task\((async event => \{[\s\S]*?\n\})\);/)[1];
  const submit = runInNewContext(`(${callback})`, { ...identity, selection, active: session });
  await assert.rejects(submit({ preventDefault() {} }), error => error.code === 'stale_document'); assert.equal(queued, 0);
});

test('deliberate Load disk observes a new epoch without Save and refuses newer typing before recovery Open', async () => {
  const callback = manuscript.match(/\$\('reload-buffer'\)\.onclick = task\((async \(\) => \{[\s\S]*?\n\})\);/)[1];
  const session = make(2), gate = defer(), operations = []; session.identityProblem = { code: 'stale_document' };
  const environment = { ...identity, active: session, navigationIntent: 0, requireNavigationReady() {}, navigationCurrent: () => true, request: async operation => { operations.push(operation); await gate.promise; return snap(3); } };
  const load = runInNewContext(`(${callback})`, environment), work = load(); await turn(); session.edit('newer unsaved draft'); gate.resolve(); await assert.rejects(work);
  assert.deepEqual(operations.map(operation => operation.action), ['review']); assert.equal(session.content, 'newer unsaved draft'); assert.equal(session.sourceEpoch, 2);
});

test('actual transport error ownership never freezes a newer same-path binding for an older explicit epoch', async () => {
  const code = manuscript.slice(manuscript.indexOf('let localRequests ='), manuscript.indexOf('const insertionCommands ='));
  const session = make(3), sessions = new Map([['project:main.typ', session]]);
  const request = runInNewContext(code + '\nrequest;', { ...identity, sessions, keyFor: (p, path) => `${p}:${path}`, nativeRequest: async () => { throw { code: 'stale_document', message: 'Epoch2 retired.' }; } });
  await assert.rejects(request({ action: 'save', project: 'project', path: 'main.typ', sourceEpoch: 2 }));
  assert.equal(session.identityProblem, null); assert.equal(session.sourceEpoch, 3);
});

test('actual explicit clean retired tab Close permits later native no-clobber Create without old epoch or history', async () => {
  const old = make(3), sessions = new Map([['project:main.typ', old]]), operations = [], mounted = [];
  old.identityProblem = { code: 'stale_document', message: 'Known retired source.' }; old.editorState = { undo: 'old history' };
  const node = () => ({ children: [], dataset: {}, setAttribute() {}, append(...children) { this.children.push(...children); }, replaceChildren() { this.children = []; } });
  const tabs = node(), nodes = new Map([['manuscript-tabs', tabs], ['project-select', { value: 'project' }], ['new-path', { value: 'main.typ' }], ['new-dialog', { close() {} }]]);
  const environment = { ...identity, newFileContext: { project: 'project' }, inventoryRoot: () => ({}), sessions, active: null, navigationIntent: 0, keyFor: (p, path) => `${p}:${path}`, $: id => nodes.get(id), element: node, actionButton: (text, callback) => ({ text, onclick: callback, setAttribute() {} }), task: callback => callback, requestAnimationFrame() {},
    saveSession() { throw Error('Known clean retired Close must never Save'); }, editorBridge: { unwatch: async () => {}, watch() {} }, renderReview() {}, currentProject: () => ({ id: 'project' }), requireSessionCapacity() {}, navigationCurrent: () => true,
    request: async operation => { operations.push(operation); return snap(4); }, loadFiles: async () => {}, openSession: async session => { mounted.push(session); }, ReviewSession,
  };
  const tabCode = manuscript.slice(manuscript.indexOf('function renderTabs('), manuscript.indexOf('function selectAnchor('));
  runInNewContext(tabCode + '\nrenderTabs();', environment);
  await tabs.children[0].children[1].onclick(); assert.equal(sessions.size, 0);
  const tracker = manuscript.slice(manuscript.indexOf('function trackSession('), manuscript.indexOf('let windowFocus ='));
  const callback = manuscript.match(/\$\('new-form'\)\.onsubmit = task\((async event => \{[\s\S]*?\n\})\);/)[1];
  const create = runInNewContext(tracker + `\n(${callback})`, environment); await create({ preventDefault() {} });
  assert.equal(operations.length, 1); assert.equal(operations[0].action, 'create'); assert.equal(Object.hasOwn(operations[0], 'sourceEpoch'), false);
  assert.equal(mounted[0].sourceEpoch, 4); assert.notEqual(mounted[0], old); assert.equal(mounted[0].editorState, undefined); assert.equal(old.editorState.undo, 'old history');
});

test('compile captures inactive input identities before save-all and never saves their later replacement', async () => {
  const f = compileFixture(), inactive = make(5, 'inactive.typ'), gate = defer(), calls = [];
  f.environment.sessions.set('project:inactive.typ', inactive);
  f.environment.saveSession = async input => { calls.push(input.path); if (calls.length === 1) await gate.promise; };
  const work = f.run(f.chapter, true); await turn(); rebind(inactive, 6); gate.resolve();
  await assert.rejects(work, error => error.code === 'stale_document'); assert.deepEqual(calls, ['chapter.typ']); assert.deepEqual(f.operations, []);
});

test('retired queued compiles each fail without stranding later requests behind admission guards', async () => {
  const f = compileFixture(); f.environment.compiling = true;
  f.environment.task = callback => async () => { try { await callback(); } catch {} };
  await f.run(f.chapter, true); await f.run(f.chapter, true); assert.equal(f.environment.explicitCompiles.length, 2);
  rebind(f.main, 3); f.environment.compiling = false; f.environment.releaseCompileQueue(); await turn(); await turn();
  assert.equal(f.environment.explicitCompiles.length, 0); assert.equal(f.environment.compiling, false); assert.deepEqual(f.operations, []);
});

test('newly observed PDF of another main epoch cannot parse, paint or become an export under a chapter tab', async () => {
  const code = manuscript.slice(manuscript.indexOf('async function showPdf('), manuscript.indexOf('async function loadPublicationPreview('));
  for (const epoch of [1, 3]) {
    const chapter = make(7, 'chapter.typ'), main = make(2); let parsed = 0;
    const environment = { ...identity, active: chapter, sessions: new Map([['project:main.typ', main]]), keyFor: (p, path) => `${p}:${path}`, publicationPath: () => 'main.typ', observedSourceTarget: () => ({ ...captureSourceBinding(main), session: main }), pdfjs: { getDocument() { parsed += 1; } }, pdfBytes: 'previous explicitly stale bytes', pdfPath: 'main.typ', pdfSourceEpoch: 2 };
    const show = runInNewContext(code + '\nshowPdf;', environment);
    await assert.rejects(show({ available: true, sourceEpoch: epoch, base64: '' }, chapter), error => error.code === 'stale');
    assert.equal(parsed, 0); assert.equal(environment.pdfBytes, 'previous explicitly stale bytes'); assert.equal(chapter.identityProblem, null); assert.equal(main.identityProblem, null);
  }
});

test('restrictive revoke confirms false without adopting a new occupant document ID', async () => {
  const callback = manuscript.match(/\$\('manuscript-share'\)\.onchange = task\((async \(\) => \{[\s\S]*?\n\})\);/)[1];
  const session = make(2); session.identityProblem = { code: 'stale_document', message: 'Retired.' }; const id = session.snapshot.documentId;
  const revoke = runInNewContext(`(${callback})`, { ...identity, active: session, sharingSession: null, $: () => ({ checked: false }), request: async () => ({ documentId: 'new-epoch-specific-id', shared: false }), sessions: new Map([['project:main.typ', session]]), keyFor: (p, path) => `${p}:${path}`, connections: { refresh: async () => {} }, renderReview() {}, saveSession() { throw Error('No Save'); } });
  await revoke(); assert.equal(session.snapshot.shared, false); assert.equal(session.snapshot.documentId, id); assert.equal(session.sourceEpoch, 2); assert.ok(session.identityProblem);
});

test('Load disk cannot turn an uncertain mutation or future unresolved Move into fresh Open authority', async () => {
  const callback = manuscript.match(/\$\('reload-buffer'\)\.onclick = task\((async \(\) => \{[\s\S]*?\n\})\);/)[1];
  for (const state of ['uncertainMutation', 'unresolvedMove', 'unknownIdentity']) {
    const session = make(2); let requests = 0;
    if (state === 'unknownIdentity') session.identityProblem = { code: 'outcome_unknown' }; else session[state] = {};
    const load = runInNewContext(`(${callback})`, { ...identity, active: session, navigationIntent: 0, requireNavigationReady() {}, request() { requests += 1; } });
    await assert.rejects(load()); assert.equal(requests, 0, state); assert.equal(session.sourceEpoch, 2);
  }
});

test('save-all cannot adopt a replacement inactive session from the live map after a held earlier Save', async () => {
  const f = compileFixture(), original = make(5, 'inactive.typ'), replacement = make(6, 'inactive.typ'), gate = defer(), saves = [];
  f.environment.sessions.set('project:inactive.typ', original);
  f.environment.saveSession = async session => { saves.push(session); if (saves.length === 1) await gate.promise; };
  const work = f.run(f.chapter, true); await turn(); f.environment.sessions.set('project:inactive.typ', replacement); gate.resolve();
  await assert.rejects(work, error => error.code === 'stale_document'); assert.deepEqual(saves, [f.chapter]); assert.deepEqual(f.operations, []); assert.equal(original.sourceEpoch, 5); assert.equal(replacement.sourceEpoch, 6);
});

test('missing main inventory identity is observed through pure Review before unbound PDF read, never from active chapter', async () => {
  const chapter = make(7, 'chapter.typ'), operations = [], displayed = [];
  const code = manuscript.slice(manuscript.indexOf('async function loadPublicationPreview('), manuscript.indexOf('async function compileSession('));
  const environment = { ...identity, retireCompileNavigation() {}, setCompileLog() {}, active: chapter, navigationIntent: 1, pdfGeneration: 0, pdfLoadingTask: null, observedSourceTarget: () => null, publicationPath: () => 'main.typ', pdfViewer: { clear() {} }, $: () => ({}), showingLogs: false, pdfStatus() {}, preview() {}, sessionNavigationCurrent: () => true, projectInputVersions: () => capturePublicationInputs([chapter], 0), showPdf: async (result, session, path, inputs) => displayed.push(inputs.main), compiling: false };
  const load = runInNewContext(code + '\nloadPublicationPreview;', environment);
  await load(chapter, 1, async operation => { operations.push(operation); return operation.action === 'review' ? snap(2) : { available: false, sourceEpoch: 2 }; });
  assert.deepEqual(operations.map(operation => operation.action), ['review', 'pdf']); assert.ok(operations.every(operation => !Object.hasOwn(operation, 'sourceEpoch'))); assert.equal(displayed[0].sourceEpoch, 2); assert.equal(chapter.sourceEpoch, 7);
});
