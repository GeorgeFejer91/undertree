import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeFileImport } from '../modules/frontend/file-import.js';
import { sourceRoot, sourceRootsEqual } from '../modules/frontend/review-session.js';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
const expectedRoot = { dev: '18446744073709551615', ino: '9007199254740993' };
const files = [{ fileId: 'source', name: 'part.typ', kind: 'source', editable: true, bytes: 20, sha256: 'a'.repeat(64) }, { fileId: 'asset', name: 'figure.png', kind: 'asset', editable: false, bytes: 8, sha256: 'b'.repeat(64) }];
const selection = (project = 'one', parent = 'chapters') => ({ selectionId: `selection-${project}`, project, parent, expectedRoot, files, expiresAt: Date.now() + 60_000 });
const committed = (requestId = 'request-one') => ({ requestId, status: 'committed', project: 'one', parent: 'chapters', expectedRoot, mainDocument: null, gitOwnership: 'undertree', files: files.map(file => ({ sha256: file.sha256, bytes: file.bytes, path: `chapters/${file.name}`, kind: file.kind, editable: file.editable })) });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function setup(options = {}) {
  const calls = [], applied = [], changes = []; let project = 'one', composing = false;
  const model = new NativeFileImport({ choose: async (project, parent) => { calls.push({ choose: project, parent }); return selection(project, parent); }, request: async operation => { calls.push(operation); return operation.action === 'import_cancel' ? { selectionId: operation.selectionId, cancelled: true } : committed(); }, canStart: target => { if (composing) throw { code: 'busy' }; if (target !== project) throw { code: 'stale' }; }, requestId: () => 'request-one', onChange: context => changes.push(context), onCommitted: receipt => { applied.push(receipt); }, ...options });
  model.open({ id: 'one', name: 'Project one' }, 'chapters', expectedRoot);
  return { model, calls, applied, changes, project: value => { project = value; }, composing: value => { composing = value; } };
}
test('source and asset metadata commit only an opaque selection and verified native ownership', async () => {
  const { model, calls, applied } = setup(); await model.choose('chapters'); await model.commit();
  assert.equal(model.current.phase, 'committed'); assert.equal(applied.length, 1);
  assert.deepEqual(calls, [{ choose: 'one', parent: 'chapters' }, { action: 'import_files', selectionId: 'selection-one', requestId: 'request-one' }]);
  await model.check(); assert.equal(applied.length, 1, 'status replay cannot reapply UI completion');
  assert.equal(calls.some(call => ['save', 'open', 'share'].includes(call.action)), false);
});
test('canceling a picker changes no files and clearing releases only its staged selection', async () => {
  const canceled = setup({ choose: async () => null }); await canceled.model.choose('chapters'); assert.equal(canceled.model.current.phase, 'empty'); assert.deepEqual(canceled.calls, []);
  const { model, calls } = setup(); await model.choose('chapters'); await model.clear();
  assert.equal(model.current.selection, null); assert.equal(model.current.phase, 'empty'); assert.equal(calls.at(-1).action, 'import_cancel');
});
test('a late picker result is canceled without replacing a newer project dialog', async () => {
  const picked = deferred(), { model, calls, project } = setup({ choose: () => picked.promise });
  const old = model.current, pending = model.choose('chapters'); await model.close(old); project('two');
  const current = model.open({ id: 'two', name: 'Project two' }, 'assets', expectedRoot); picked.resolve(selection()); await pending;
  assert.equal(model.current, current); assert.equal(current.selection, null); assert.equal(current.parent, 'assets');
  assert.deepEqual(calls, [{ action: 'import_cancel', selectionId: 'selection-one' }]);
});
test('unconfirmed cancellation keeps the staged files available instead of claiming they were cleared', async () => {
  const { model } = setup({ request: async () => ({ cancelled: false }) }); await model.choose('chapters');
  await assert.rejects(model.clear()); assert.equal(model.current.phase, 'ready'); assert.equal(model.current.selection.selectionId, 'selection-one');
});
test('project switches and IME block picker/commit without changing the captured staged target', async () => {
  const { model, calls, project, composing } = setup(); composing(true);
  await assert.rejects(model.choose('chapters'), error => error.code === 'busy'); assert.deepEqual(calls, []);
  composing(false); await model.choose('chapters'); project('two');
  await assert.rejects(model.commit(), error => error.code === 'stale'); assert.equal(calls.filter(call => call.action === 'import_files').length, 0); assert.equal(model.current.selection.project, 'one');
});
test('a project change during staging cancels its immutable native selection', async () => {
  const picked = deferred(), { model, calls, project } = setup({ choose: () => picked.promise });
  const pending = model.choose('chapters'); project('two'); picked.resolve(selection()); await pending;
  assert.equal(model.current.selection, null); assert.equal(calls.at(-1).action, 'import_cancel');
});
test('lost commit acknowledgement checks the same request without replaying any write', async () => {
  const calls = [], applied = [], model = setup({ request: async operation => { calls.push(operation); if (operation.action === 'import_files') throw new Error('lost response'); return calls.length === 2 ? { requestId: 'request-one', status: 'pending', project: 'one', parent: 'chapters', expectedRoot } : committed(); }, onCommitted: receipt => applied.push(receipt) }).model;
  await model.choose('chapters'); await model.commit(); assert.equal(model.current.phase, 'unconfirmed');
  assert.equal(model.pendingCount, 1); const original = model.current;
  await model.close(); assert.equal(model.pendingCount, 1); assert.equal(model.open({ id: 'one', name: 'Project one' }, 'other', expectedRoot), original, 'reopening restores the submitted request rather than losing its safety guard');
  await model.commit(); assert.equal(calls.length, 1);
  await model.check(); assert.equal(model.current.phase, 'unconfirmed'); assert.equal(model.pendingCount, 1); await model.check(); assert.equal(model.current.phase, 'committed'); assert.equal(model.pendingCount, 0);
  assert.equal(calls.filter(call => call.action === 'import_files').length, 1); assert.equal(applied.length, 1);
});
test('a pending commit cannot be canceled or submitted twice', async () => {
  const response = deferred(), calls = [], model = setup({ request: operation => { calls.push(operation); return response.promise; } }).model;
  await model.choose('chapters'); const pending = model.commit(); await model.commit(); assert.equal(await model.close(), false); assert.equal(calls.length, 1);
  response.resolve(committed()); await pending; assert.equal(model.current.phase, 'committed');
});
test('unknown, failed and mismatched results never claim success or retry source writes', async () => {
  for (const receipt of [{ requestId: 'request-one', status: 'unknown' }, { requestId: 'request-one', status: 'outcome_unknown', project: 'one', parent: 'chapters', expectedRoot }, { ...committed(), project: 'two' }, { ...committed(), gitOwnership: 'external' }]) {
    const { model, applied } = setup({ request: async () => receipt }); await model.choose('chapters'); await model.commit();
    assert.equal(model.current.phase, 'unconfirmed'); assert.equal(applied.length, 0);
  }
  const { model, applied } = setup({ request: async () => ({ requestId: 'request-one', status: 'failed', project: 'one', parent: 'chapters', expectedRoot, error: { code: 'exists', message: 'A target already exists.' } }) });
  await model.choose('chapters'); await model.commit(); assert.equal(model.current.phase, 'failed'); assert.equal(model.current.selection, null); assert.equal(applied.length, 0);
});
test('a tree refresh failure preserves confirmed native success rather than fabricating an uncertain write', async () => {
  const { model } = setup({ onCommitted: async () => { throw new Error('listing unavailable'); } }); await model.choose('chapters'); await model.commit();
  assert.equal(model.current.phase, 'committed'); assert.match(model.current.message, /Refresh the file tree/);
});
test('unknown result requires an inspected selection-cancel barrier; busy cancellation preserves the guard', async () => {
  const calls = []; let busy = true;
  const { model } = setup({ request: async operation => {
    calls.push(operation);
    if (operation.action === 'import_cancel') { if (busy) throw { code: 'busy', message: 'Import is running.' }; return { selectionId: operation.selectionId, cancelled: true }; }
    return { requestId: 'request-one', status: 'unknown' };
  } });
  await model.choose('chapters'); await model.commit(); assert.equal(model.pendingCount, 1);
  await model.dismiss(); assert.equal(model.pendingCount, 1); assert.equal(model.current.phase, 'unconfirmed');
  busy = false; await model.dismiss(); assert.equal(model.pendingCount, 0); assert.equal(model.current.phase, 'inspected');
  assert.equal(calls.filter(call => call.action === 'import_files').length, 1);
});
test('terminal outcome_unknown clears only after explicit inspection without replaying or canceling a finished write', async () => {
  const calls = [], { model } = setup({ request: async operation => { calls.push(operation); return { requestId: 'request-one', status: 'outcome_unknown', project: 'one', parent: 'chapters', expectedRoot }; } });
  await model.choose('chapters'); await model.commit(); assert.equal(model.pendingCount, 1);
  await model.dismiss(); assert.equal(model.pendingCount, 0); assert.equal(calls.length, 1); assert.equal(model.current.phase, 'inspected');
});

test('import holds an immutable inventory root through chooser awaits and refuses another staged root', async () => {
  const gate = deferred(), calls = [], initial = { ...expectedRoot }, { model } = setup({ choose: (...args) => { calls.push(args); return gate.promise; } });
  model.open({ id: 'one', name: 'Project one' }, 'chapters', initial); const context = model.current, choosing = model.choose('chapters');
  initial.ino = '9007199254740994'; assert.deepEqual(calls[0][2], expectedRoot); assert.equal(Object.isFrozen(context.expectedRoot), true);
  assert.throws(() => { context.expectedRoot = initial; }, TypeError);
  gate.resolve({ ...selection(), expectedRoot: initial }); await choosing;
  assert.equal(context.selection, null); assert.equal(context.phase, 'empty');
});

test('every known wrong-root import receipt preserves the unresolved request and cannot acknowledge completion', async () => {
  for (const status of ['committed', 'pending', 'failed', 'outcome_unknown']) {
    for (const root of [undefined, { ...expectedRoot, ino: '9007199254740994' }]) {
      const operations = [], { model, applied } = setup({ request: async operation => { operations.push(operation); return { ...committed(), status, expectedRoot: root }; } });
      await model.choose('chapters'); await model.commit();
      assert.equal(model.current.phase, 'unconfirmed', status); assert.equal(model.pendingCount, 1); assert.equal(applied.length, 0); assert.deepEqual(model.current.expectedRoot, expectedRoot);
      assert.equal(operations.filter(call => call.action === 'import_files').length, 1, 'the original write is never replayed');
    }
  }
});

test('actual Import dialog captures inventory once and a changed tree blocks chooser or cancels held staging without Save', async () => {
  const source = await readFile(new URL('../src/manuscript.js', import.meta.url), 'utf8');
  const construct = source.slice(source.indexOf('let renderedImportContext ='), source.indexOf('function renderFileImport('));
  const opening = source.slice(source.indexOf('function openFileImport()'), source.indexOf('const projectExport ='));
  for (const held of [false, true]) {
    let treeRoot = { ...expectedRoot }; const gate = deferred(), calls = [], dialog = { open: false, showModal() {} };
    const adapter = runInNewContext(construct + opening + '\n({fileImport,openFileImport});', {
      NativeFileImport, sourceRoot, sourceRootsEqual, nativeReview: true, windowClosing: false, view: null, active: null, localRequestsVersion: 0,
      currentProject: () => ({ id: 'one', name: 'Project one' }), inventoryRoot: () => ({ expectedRoot: treeRoot }), $: () => dialog, renderFileImport() {}, fileActivity: callback => callback(),
      chooseImportFiles: (...args) => { calls.push({ choose: args }); return gate.promise; },
      importRequest: async operation => { calls.push(operation); return { selectionId: operation.selectionId, cancelled: true }; },
      queueSync: () => { throw Error('No source sync from an unadopted selection'); }, loadFiles: () => { throw Error('No stale tree refresh'); },
    });
    adapter.openFileImport(); const captured = adapter.fileImport.current.expectedRoot;
    if (!held) {
      treeRoot.ino = '9007199254740994'; await assert.rejects(adapter.fileImport.choose('chapters'), error => error.code === 'stale_root'); assert.equal(calls.length, 0);
    } else {
      const choosing = adapter.fileImport.choose('chapters'); treeRoot = { ...expectedRoot, ino: '9007199254740994' }; gate.resolve(selection()); await choosing;
      assert.deepEqual(calls[0].choose[2], expectedRoot); assert.equal(calls[1].action, 'import_cancel'); assert.equal(adapter.fileImport.current.selection, null);
    }
    assert.deepEqual(captured, expectedRoot); assert.equal(Object.isFrozen(captured), true);
  }
});

test('actual late Import completion retains committed ownership but never syncs or refreshes a replaced project root', async () => {
  const source = await readFile(new URL('../src/manuscript.js', import.meta.url), 'utf8');
  const construct = source.slice(source.indexOf('let renderedImportContext ='), source.indexOf('function renderFileImport('));
  for (const replacement of ['root', 'project']) {
    const gate = deferred(), effects = [], calls = []; let treeRoot = expectedRoot, selected = 'one';
    const adapter = runInNewContext(construct + '\nfileImport;', {
      NativeFileImport: class extends NativeFileImport { constructor(options) { super({ ...options, requestId: () => 'request-one' }); } },
      sourceRoot, sourceRootsEqual, nativeReview: true, windowClosing: false, view: null, navigationIntent: 3,
      currentProject: () => ({ id: selected }), inventoryRoot: () => ({ expectedRoot: treeRoot }),
      renderFileImport() {}, fileActivity: callback => callback(), chooseImportFiles: async () => selection(),
      importRequest: operation => { calls.push(operation); return gate.promise; },
      queueSync: (...args) => effects.push(['sync', ...args]), loadFiles: (...args) => effects.push(['tree', ...args]),
    });
    adapter.open({ id: 'one', name: 'Project one' }, 'chapters', expectedRoot); await adapter.choose('chapters');
    const pending = adapter.commit();
    if (replacement === 'root') treeRoot = { ...expectedRoot, ino: '9007199254740994' }; else selected = 'two';
    gate.resolve(committed()); await pending;
    assert.equal(adapter.current.phase, 'committed'); assert.equal(adapter.pendingCount, 0); assert.equal(adapter.current.applied, true);
    assert.match(adapter.current.message, /Refresh the file tree/); assert.deepEqual(effects, []);
    assert.deepEqual(calls.map(call => call.action), ['import_files']);
    assert.deepEqual(adapter.current.expectedRoot, expectedRoot, 'native ownership remains bound to the original folder');
  }
});

test('actual Import completion passes the original root to both delayed sync and the tree read', async () => {
  const source = await readFile(new URL('../src/manuscript.js', import.meta.url), 'utf8'), effects = [];
  const construct = source.slice(source.indexOf('let renderedImportContext ='), source.indexOf('function renderFileImport('));
  const adapter = runInNewContext(construct + '\nfileImport;', {
    NativeFileImport: class extends NativeFileImport { constructor(options) { super({ ...options, requestId: () => 'request-one' }); } },
    sourceRoot, sourceRootsEqual, nativeReview: true, windowClosing: false, view: null, navigationIntent: 7,
    currentProject: () => ({ id: 'one' }), inventoryRoot: () => ({ expectedRoot }), noteProjectEdit: project => effects.push(['edit', project]), pdfBytes: null, renderFileImport() {}, fileActivity: callback => callback(),
    chooseImportFiles: async () => selection(), importRequest: async () => committed(),
    queueSync: (...args) => effects.push(['sync', ...args]), loadFiles: (...args) => effects.push(['tree', ...args]),
  });
  adapter.open({ id: 'one', name: 'Project one' }, 'chapters', expectedRoot); await adapter.choose('chapters'); await adapter.commit();
  assert.deepEqual(effects, [['edit', 'one'], ['sync', 'one', expectedRoot], ['tree', 7, expectedRoot]]); assert.equal(adapter.current.phase, 'committed');
});

test('actual root-bound tree refresh refuses replacement response or inventory without installing its entries', async () => {
  const source = await readFile(new URL('../src/manuscript.js', import.meta.url), 'utf8');
  const loading = source.slice(source.indexOf('async function loadFiles('), source.indexOf('function rememberExpandedFolders('));
  for (const replacement of ['reply', 'inventory', 'selection', 'none']) {
    const gate = deferred(), calls = [], rendered = []; let treeRoot = expectedRoot, selected = 'one';
    const changedRoot = { ...expectedRoot, ino: '9007199254740994' };
    const adapter = runInNewContext(loading + '\nloadFiles;', {
      sourceRoot, sourceRootsEqual, navigationIntent: 3, navigationCurrent: () => true, fileInventoryGeneration: 0,
      $: id => id === 'project-select' ? { value: selected } : { dataset: { project: 'one' } },
      inventoryRoot: () => ({ expectedRoot: treeRoot }), request: operation => { calls.push(operation); return gate.promise; },
      renderFiles: (...args) => rendered.push(args),
    });
    const pending = adapter(3, expectedRoot);
    if (replacement === 'inventory') treeRoot = changedRoot;
    if (replacement === 'selection') selected = 'two';
    const result = { project: 'one', expectedRoot: replacement === 'reply' ? changedRoot : expectedRoot, entries: [] };
    gate.resolve(result);
    if (replacement === 'none') { await pending; assert.equal(rendered.length, 1); assert.equal(rendered[0][0], result); }
    else { await assert.rejects(pending, error => error.code === 'stale_root'); assert.deepEqual(rendered, []); }
    assert.equal(calls.length, 1); assert.equal(calls[0].action, 'project_tree'); assert.equal(calls[0].project, 'one'); assert.deepEqual(calls[0].expectedRoot, expectedRoot);
  }
});

test('actual Import sync timer freezes its root and rechecks inventory immediately before dispatch; ordinary sync is unchanged', async () => {
  const source = await readFile(new URL('../src/manuscript.js', import.meta.url), 'utf8');
  const scheduling = source.slice(source.indexOf('function queueSync('), source.indexOf('async function saveSession('));
  for (const mode of ['matching', 'replaced', 'ordinary']) {
    const timers = [], calls = [], messages = [], pausedSync = new Set(); let treeRoot = { ...expectedRoot };
    const adapter = runInNewContext(scheduling + '\nqueueSync;', {
      sourceRoot, sourceRootsEqual, sessions: new Map(), projects: [{ id: 'one', autoSync: true }], pausedSync, syncTimers: new Map(),
      inventoryRoot: () => { if (mode === 'ordinary') throw Error('An ordinary sync must not acquire an inventory binding'); return { expectedRoot: treeRoot }; },
      setTimeout: (callback, delay) => { assert.equal(delay, 4000); timers.push(callback); return timers.length; }, clearTimeout() {},
      request: async operation => { calls.push(operation); return { message: 'Synced' }; }, status: (...args) => messages.push(args),
    });
    const rootArgument = { ...expectedRoot };
    adapter('one', mode === 'ordinary' ? undefined : rootArgument); rootArgument.ino = '9007199254740994';
    if (mode === 'replaced') treeRoot = { ...rootArgument };
    assert.equal(timers.length, 1); await timers[0]();
    assert.equal(calls.length, mode === 'replaced' ? 0 : 1);
    if (mode === 'replaced') { assert.equal(pausedSync.has('one'), true); assert.match(messages[0][0], /project folder changed/); }
    else assert.equal(calls[0].action, 'sync');
  }
});
