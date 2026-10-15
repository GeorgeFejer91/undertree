import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { ReviewSession, sourceEpoch, sourceRoot, sourceRootsEqual } from '../modules/frontend/review-session.js';
import { NativeFileImport } from '../modules/frontend/file-import.js';
import { NativeProjectExport } from '../modules/frontend/project-export.js';
import { captureControlState, assertControlState, assertControlPassage, controlPreviewIdentity, assertControlPreview } from '../modules/frontend/manuscript-control-state.js';
import { assertMcpCommand } from '../src/mcp-control.js';
const expectedRoot = { dev: '18446744073709551615', ino: '9007199254740993' };
const session = (id = 'private-1') => new ReviewSession({ documentId: id, path: 'source.typ', content: 'A 🌳 manuscript.', review: { revision: 'saved' } }, 'project', async () => {});
const context = sessions => ({ sessions, active: sessions[0], navigation: 1, composing: false, closing: false, pending: 0 });

test('inactive private buffers participate in clean, conflict, composition and pending guards', () => {
  for (const state of ['dirty', 'conflict', 'composing', 'pending']) {
    const privateTab = session(), current = context([session('shared-1'), privateTab]), captured = captureControlState(current);
    if (state === 'dirty') privateTab.edit('private typing');
    if (state === 'conflict') privateTab.conflict = {};
    if (state === 'composing') current.composing = true;
    if (state === 'pending') privateTab.pending = 1;
    assert.throws(() => assertControlState(captured, current, { clean: true }));
  }
});
test('stable dirty buffers permit presentation changes but never navigation, compilation or close', () => {
  const active = session(); active.edit('user text'); const current = context([active]), captured = captureControlState(current);
  assert.doesNotThrow(() => assertControlState(captured, current));
  assert.throws(() => assertControlState(captured, current, { clean: true }), error => error.code === 'busy');
});
test('same-path reopen, completed local requests, accepted source and navigation invalidate a prepared effect', () => {
  for (const change of ['reopen', 'request', 'accepted', 'revision', 'navigation', 'closing']) {
    const active = session(), current = context([active]), captured = captureControlState(current);
    if (change === 'reopen') current.sessions[0] = session();
    if (change === 'request') active.queue = Promise.resolve();
    if (change === 'accepted') active.generation += 1;
    if (change === 'revision') active.snapshot.review.revision = 'different saved source';
    if (change === 'navigation') current.navigation += 1;
    if (change === 'closing') current.closing = true;
    assert.throws(() => assertControlState(captured, current), change);
  }
});
test('metadata-only refresh leaves saved input identity intact during a slow effect', () => {
  const active = session(), current = context([active]), captured = captureControlState(current);
  active.snapshot = { ...active.snapshot, review: { ...active.snapshot.review, suggestions: [{ id: 'new review suggestion' }] } };
  assert.doesNotThrow(() => assertControlState(captured, current, { clean: true }));
});
test('actual request accounting allows harmless background reads but blocks recovery Open and writes', async () => {
  const source = await readFile(new URL('../src/manuscript.js', import.meta.url), 'utf8');
  const accounting = source.slice(source.indexOf('let localRequests ='), source.indexOf('const insertionCommands ='));
  let finish;
  const adapter = runInNewContext(accounting + '\n({request, state:()=>({pending:localRequests, requestsVersion:localRequestsVersion})});', { nativeRequest: () => new Promise(resolve => { finish = resolve; }) });
  const active = session(), current = context([active]); Object.assign(current, adapter.state());
  const captured = captureControlState(current);
  for (const action of ['review', 'project_tree', 'connection']) {
    const reading = adapter.request({ action });
    Object.assign(current, adapter.state());
    assert.doesNotThrow(() => assertControlState(captured, current, { clean: true }), action);
    finish({}); await reading;
  }
  for (const action of ['open', 'save', 'create_directory']) {
    const before = captureControlState({ ...current, ...adapter.state() });
    const work = adapter.request({ action });
    Object.assign(current, adapter.state());
    assert.throws(() => assertControlState(before, current), error => error.code === 'busy', action);
    finish({}); await work; Object.assign(current, adapter.state());
    assert.throws(() => assertControlState(before, current), error => error.code === 'stale', `${action} still invalidates a prepared effect after completion`);
  }
  const before = captureControlState(current), reading = adapter.request({ action: 'review' });
  active.conflict = { content: 'externally changed source' };
  assert.throws(() => assertControlState(before, { ...current, ...adapter.state() }), error => error.code === 'stale');
  finish({}); await reading;
});
test('native import work and opening its idle dialog invalidate a prepared acknowledged Close', async () => {
  const source = await readFile(new URL('../src/manuscript.js', import.meta.url), 'utf8');
  const accounting = source.slice(source.indexOf('let localRequests ='), source.indexOf('const insertionCommands ='));
  const open = source.slice(source.indexOf('function openFileImport()'), source.indexOf('const projectExport ='));
  let finish, opened = 0;
  const adapter = runInNewContext(accounting + open + '\n({fileActivity, openFileImport, state:()=>({pending:localRequests,requestsVersion:localRequestsVersion})});', {
    nativeRequest: async () => {}, sourceRoot, inventoryRoot: () => ({ expectedRoot }), $: () => ({ open: false, showModal: () => { opened += 1; } }), currentProject: () => ({ id: 'project', name: 'Project' }), active: null, fileImport: { open: () => {} },
  });
  const current = context([session()]); Object.assign(current, adapter.state());
  let captured = captureControlState(current);
  adapter.openFileImport(); Object.assign(current, adapter.state());
  assert.equal(opened, 1); assert.equal(current.pending, 0, 'idle dialog is not a source save or in-flight operation');
  assert.throws(() => assertControlState(captured, { ...current, closing: true }, { clean: true, allowClosing: true }), error => error.code === 'stale');
  for (const work of ['native picker and staging', 'commit', 'status']) {
    captured = captureControlState(current);
    const pending = adapter.fileActivity(() => new Promise(resolve => { finish = resolve; })); Object.assign(current, adapter.state());
    assert.throws(() => assertControlState(captured, { ...current, closing: true }, { clean: true, allowClosing: true }), error => error.code === 'busy', work);
    finish(); await pending; Object.assign(current, adapter.state());
    assert.throws(() => assertControlState(captured, { ...current, closing: true }, { clean: true, allowClosing: true }), error => error.code === 'stale', `${work} invalidates the old capture even after completion`);
  }
});
test('actual controlContext remains busy after a lost import RPC and pending status, until a matching terminal receipt', async () => {
  const source = await readFile(new URL('../src/manuscript.js', import.meta.url), 'utf8');
  const accounting = source.slice(source.indexOf('let localRequests ='), source.indexOf('const insertionCommands ='));
  const contextFunction = source.slice(source.indexOf('function controlContext()'), source.indexOf('function controlPreparation('));
  const active = session(), environment = { nativeRequest: async () => {}, sessions: new Map([['active', active]]), active, view: null, navigationIntent: 1, windowClosing: false, fileImport: null, projectExport: { pendingCount: 0 } };
  const adapter = runInNewContext(accounting + contextFunction + '\n({fileActivity, context:controlContext, rpcPending:()=>localRequests});', environment);
  let checks = 0;
  const importer = new NativeFileImport({ choose: async () => ({ selectionId: 'staged', project: 'project', parent: '', expectedRoot, files: [{ name: 'new.typ', kind: 'source', editable: true, bytes: 4, sha256: 'hash' }] }), canStart: () => {}, requestId: () => 'request', request: operation => adapter.fileActivity(async () => {
    if (operation.action === 'import_files') throw new Error('lost acknowledgement');
    checks += 1;
    return checks === 1 ? { requestId: 'request', status: 'pending', project: 'project', parent: '', expectedRoot } : { requestId: 'request', status: 'committed', project: 'project', parent: '', expectedRoot, gitOwnership: 'undertree', files: [{ path: 'new.typ', kind: 'source', editable: true, bytes: 4, sha256: 'hash' }] };
  }) });
  environment.fileImport = importer; importer.open({ id: 'project', name: 'Project' }, '', expectedRoot); await importer.choose('');
  const captured = captureControlState(adapter.context()); await importer.commit();
  assert.equal(adapter.rpcPending(), 0); assert.equal(adapter.context().pending, 1);
  assert.throws(() => assertControlState(captured, { ...adapter.context(), closing: true }, { clean: true, allowClosing: true }), error => error.code === 'busy');
  await importer.close(); assert.equal(adapter.context().pending, 1);
  importer.open({ id: 'project', name: 'Project' }, '', expectedRoot); await importer.check(); assert.equal(adapter.context().pending, 1);
  assert.throws(() => assertControlState(captured, adapter.context(), { clean: true }), error => error.code === 'busy');
  await importer.check(); assert.equal(adapter.context().pending, 0);
  assert.throws(() => assertControlState(captured, adapter.context(), { clean: true }), error => error.code === 'stale');
});
test('an acknowledged no-save close may use its own editing freeze but retains all other guards', () => {
  const current = context([session()]), captured = captureControlState(current); current.closing = true;
  assert.doesNotThrow(() => assertControlState(captured, current, { clean: true, allowClosing: true }));
  current.composing = true; assert.throws(() => assertControlState(captured, current, { clean: true, allowClosing: true }));
});
test('actual controlContext blocks prepared App effects during ZIP preparation and after lost Save acknowledgement', async () => {
  const source = await readFile(new URL('../src/manuscript.js', import.meta.url), 'utf8');
  const accounting = source.slice(source.indexOf('let localRequests ='), source.indexOf('const insertionCommands ='));
  const contextFunction = source.slice(source.indexOf('function controlContext()'), source.indexOf('function controlPreparation('));
  const active = session(), environment = { nativeRequest: async () => {}, sessions: new Map([['active', active]]), active, view: null, navigationIntent: 1, windowClosing: false, fileImport: { pendingCount: 0 }, projectExport: null };
  const adapter = runInNewContext(accounting + contextFunction + '\n({fileActivity, context:controlContext, rpcPending:()=>localRequests});', environment);
  let preparedReady, checks = 0;
  const prepared = { exportId: 'archive', project: 'project', expectedRoot, policy: 'saved-only', snapshotId: 'snapshot', sha256: 'a'.repeat(64), bytes: 400, entries: 2, mainDocument: 'main.typ', fileName: 'project.zip' };
  const result = status => ({ ...prepared, requestId: 'download', status, ...(status === 'exported' ? { destinationName: 'chosen.zip' } : {}) });
  const exporter = new NativeProjectExport({
    prepare: () => adapter.fileActivity(() => new Promise(resolve => { preparedReady = resolve; })),
    choose: () => adapter.fileActivity(async () => { throw new Error('lost Save response'); }),
    request: () => adapter.fileActivity(async () => result(++checks === 1 ? 'pending' : 'exported')),
    canStart: () => {}, requestId: () => 'download',
  });
  environment.projectExport = exporter;
  const captured = captureControlState(adapter.context()), running = exporter.start({ id: 'project', name: 'Project' }, expectedRoot);
  assert.equal(adapter.context().pending, 1);
  assert.throws(() => assertControlState(captured, { ...adapter.context(), closing: true }, { clean: true, allowClosing: true }), error => error.code === 'busy');
  preparedReady(prepared); await running; assert.equal(adapter.rpcPending(), 0); assert.equal(adapter.context().pending, 1);
  await exporter.check(); assert.equal(adapter.context().pending, 1);
  assert.throws(() => assertControlState(captured, adapter.context(), { clean: true }), error => error.code === 'busy');
  await exporter.check(); assert.equal(adapter.context().pending, 0);
  assert.throws(() => assertControlState(captured, adapter.context(), { clean: true }), error => error.code === 'stale');
});
test('actual File download hook captures the selected project without saving dirty or conflicted editor state', async () => {
  const source = await readFile(new URL('../src/manuscript.js', import.meta.url), 'utf8');
  const hook = source.slice(source.indexOf('const projectExport ='), source.indexOf('async function loadProjects('));
  const active = session(); active.edit('Unsaved private manuscript'); active.conflict = { content: 'External saved manuscript' };
  const before = { content: active.content, version: active.version, generation: active.generation, queue: active.queue, conflict: active.conflict, snapshot: active.snapshot };
  const calls = [], selected = { id: 'project', name: 'Project' }, prepared = { exportId: 'archive', project: 'project', expectedRoot, policy: 'saved-only', snapshotId: 'snapshot', sha256: 'a'.repeat(64), bytes: 400, entries: 2, mainDocument: 'main.typ', fileName: 'project.zip' };
  const unexpected = () => { throw new Error('Project download must not save, mount, compile or sync source.'); };
  const download = runInNewContext(hook + '\nrenderProjectExport=()=>{}; downloadSavedProject;', {
    NativeProjectExport, crypto: { randomUUID: () => 'download' }, nativeReview: true, windowClosing: false, view: { compositionStarted: false }, active,
    sourceRoot, inventoryRoot: () => ({ expectedRoot }), currentProject: () => selected, fileActivity: callback => callback(), status: () => {},
    prepareProjectExport: async project => { calls.push(project); return prepared; },
    chooseProjectExportDestination: async (exportId, requestId) => { calls.push({ exportId, requestId }); return { ...prepared, requestId, status: 'exported', destinationName: 'chosen.zip' }; },
    projectExportRequest: unexpected, saveSession: unexpected, openSession: unexpected, compileSession: unexpected, queueSync: unexpected,
  });
  await download(); assert.equal(calls[0], selected.id); assert.equal(calls[1].exportId, 'archive'); assert.match(calls[1].requestId, /^[a-f0-9-]{36}$/);
  assert.deepEqual({ content: active.content, version: active.version, generation: active.generation, queue: active.queue, conflict: active.conflict, snapshot: active.snapshot }, before);
});
test('selection verifies the exact saved UTF-16 passage without editing source', () => {
  const active = session('shared-1'), command = { documentId: 'shared-1', revision: 'saved', from: 2, to: 4, quote: '🌳' };
  assert.doesNotThrow(() => assertControlPassage(active, command));
  for (const change of [{ quote: 'xx' }, { revision: 'old' }, { documentId: 'unshared' }, { to: 3 }]) assert.throws(() => assertControlPassage(active, { ...command, ...change }));
  assert.equal(active.content, 'A 🌳 manuscript.'); assert.equal(active.dirty, false);
});
test('the actual shared PDF snapshot reports local zoom through 999% without widening remote commands', async () => {
  const source = await readFile(new URL('../src/manuscript.js', import.meta.url), 'utf8');
  const functions = source.slice(source.indexOf('function controlWorkspaceSnapshot()'), source.indexOf('function retireCompileNavigation('));
  const active = session('shared-main'), viewer = { pdf: { numPages: 5 }, ready: true, page: 2, currentScale: 1 };
  const snapshot = runInNewContext(functions + '\ncontrolWorkspaceSnapshot;', {
    active, view: null, sessions: new Map([['main', active]]), pdfViewer: viewer, pdfPath: active.path, pdfGeneration: 1,
    publicationPath: () => active.path, sharedManuscripts: [{ documentId: active.snapshot.documentId, project: active.project, path: active.path }],
    workspace: { dataset: {} }, $: () => ({ dataset: { collapsed: 'false' } }), showingLogs: false, historyPanel: { visible: false },
    workspacePreferences: { editorFontSize: 12, wordWrap: true }, controlPreviewIdentity, sourceEpoch, sourceRootsEqual, pdfRoot: {}, pdfSourceEpoch: 0, pdfProject: active.project,
  });
  for (const percent of [400, 800, 801, 900, 999]) {
    viewer.currentScale = percent / 100;
    const observed = snapshot();
    assert.equal(observed.preview.zoomPercent, percent, 'local high zoom must be observed without an 800% cap');
    assert.equal(viewer.currentScale, percent / 100, 'observation must not change the rendered zoom');
    assert.doesNotThrow(() => assertMcpCommand({ kind: 'set_preview_view', zoomPercent: 400 }, observed));
    for (const requested of [401, 800, 999]) assert.throws(() => assertMcpCommand({ kind: 'set_preview_view', zoomPercent: requested }, observed), error => error.code === 'arguments');
  }
});
test('a shared chapter cannot expose or control a different persisted main-document PDF', () => {
  const active = session('shared-chapter'); active.path = 'chapter.typ'; active.snapshot = { ...active.snapshot, path: active.path };
  const context = { active, shared: true, pdf: { numPages: 10 }, pdfPath: 'private-book.typ', publicationPath: 'private-book.typ', generation: 1 };
  assert.equal(controlPreviewIdentity(context), null);
  assert.throws(() => assertControlPreview(null, controlPreviewIdentity(context)));
  assert.equal(context.pdf.numPages, 10, 'the normal local main-document preview remains untouched');
  context.pdfPath = context.publicationPath = active.path;
  assert.ok(controlPreviewIdentity(context)); context.shared = false; assert.equal(controlPreviewIdentity(context), null);
});
test('main-document, artifact, page-session and pending-PDF changes during authorization cancel the preview effect', () => {
  const active = session('shared-main');
  const original = { active, shared: true, pdf: {}, pdfPath: active.path, publicationPath: active.path, generation: 3 };
  const captured = controlPreviewIdentity(original);
  for (const change of [{ publicationPath: 'private-book.typ' }, { pdfPath: 'private-book.typ' }, { pdf: {} }, { generation: 4 }, { active: session('shared-main') }, { shared: false }]) {
    let applied = 0;
    assert.throws(() => { assertControlPreview(captured, controlPreviewIdentity({ ...original, ...change })); applied += 1; });
    assert.equal(applied, 0);
  }
  assert.doesNotThrow(() => assertControlPreview(captured, controlPreviewIdentity(original)));
});
test('the actual manuscript snapshot hides an unshared main PDF and its effect rejects a switch during await', async () => {
  const source = await readFile(new URL('../src/manuscript.js', import.meta.url), 'utf8');
  const active = session('shared-chapter'); active.path = 'chapter.typ'; active.snapshot = { ...active.snapshot, path: active.path };
  const pdf = { numPages: 10 }, viewer = { pdf, ready: true, page: 1, currentScale: 1 };
  const context = {
    sessions: new Map([['chapter', active]]), active, view: null, pdfViewer: viewer, pdfPath: 'private-book.typ', pdfGeneration: 1,
    publicationPath: () => 'private-book.typ', sharedManuscripts: [{ documentId: 'shared-chapter', project: active.project, path: active.path }],
    workspace: { dataset: {} }, $: () => ({ dataset: { collapsed: 'false' } }), showingLogs: false, historyPanel: { visible: false },
    workspacePreferences: { editorFontSize: 12, wordWrap: true }, controlPreviewIdentity, sourceEpoch, sourceRootsEqual, pdfRoot: {}, pdfSourceEpoch: 0, pdfProject: 'project',
  };
  const snapshotFunctions = source.slice(source.indexOf('function controlWorkspaceSnapshot()'), source.indexOf('function setCompileLogs('));
  const snapshot = runInNewContext(snapshotFunctions + '\ncontrolWorkspaceSnapshot();', context);
  assert.equal(snapshot.preview, null, 'the real snapshot must not publish private PDF page or zoom geometry');
  let changes = 0;
  viewer.go = () => { changes += 1; }; viewer.zoom = viewer.fit = viewer.go;
  const previewContext = { active, shared: true, pdf, pdfPath: active.path, publicationPath: active.path, generation: 1 };
  const effect = source.slice(source.indexOf('const controlEffects ='), source.indexOf('function publicationPath('));
  const operation = runInNewContext(effect + '\ncontrolEffects.set_preview_view({page:2}, {});', {
    controlPreparation: () => ({ check: async () => { previewContext.publicationPath = 'private-book.typ'; }, assert: () => {} }),
    controlPreview: () => controlPreviewIdentity(previewContext), pdfViewer: viewer, assertControlPreview,
  });
  await assert.rejects(operation, error => error.code === 'stale'); assert.equal(changes, 0);
  assert.equal(viewer.pdf, pdf); assert.equal(viewer.page, 1, 'the normal local PDF stays intact');
});
