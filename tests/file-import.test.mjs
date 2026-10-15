import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeFileImport } from '../modules/frontend/file-import.js';
const files = [{ fileId: 'source', name: 'part.typ', kind: 'source', editable: true, bytes: 20, sha256: 'a'.repeat(64) }, { fileId: 'asset', name: 'figure.png', kind: 'asset', editable: false, bytes: 8, sha256: 'b'.repeat(64) }];
const selection = (project = 'one', parent = 'chapters') => ({ selectionId: `selection-${project}`, project, parent, files, expiresAt: Date.now() + 60_000 });
const committed = (requestId = 'request-one') => ({ requestId, status: 'committed', project: 'one', parent: 'chapters', mainDocument: null, gitOwnership: 'undertree', files: files.map(file => ({ sha256: file.sha256, bytes: file.bytes, path: `chapters/${file.name}`, kind: file.kind, editable: file.editable })) });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function setup(options = {}) {
  const calls = [], applied = [], changes = []; let project = 'one', composing = false;
  const model = new NativeFileImport({ choose: async (project, parent) => { calls.push({ choose: project, parent }); return selection(project, parent); }, request: async operation => { calls.push(operation); return operation.action === 'import_cancel' ? { selectionId: operation.selectionId, cancelled: true } : committed(); }, canStart: target => { if (composing) throw { code: 'busy' }; if (target !== project) throw { code: 'stale' }; }, requestId: () => 'request-one', onChange: context => changes.push(context), onCommitted: receipt => { applied.push(receipt); }, ...options });
  model.open({ id: 'one', name: 'Project one' }, 'chapters');
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
  const current = model.open({ id: 'two', name: 'Project two' }, 'assets'); picked.resolve(selection()); await pending;
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
  const calls = [], applied = [], model = setup({ request: async operation => { calls.push(operation); if (operation.action === 'import_files') throw new Error('lost response'); return calls.length === 2 ? { requestId: 'request-one', status: 'pending', project: 'one', parent: 'chapters' } : committed(); }, onCommitted: receipt => applied.push(receipt) }).model;
  await model.choose('chapters'); await model.commit(); assert.equal(model.current.phase, 'unconfirmed');
  assert.equal(model.pendingCount, 1); const original = model.current;
  await model.close(); assert.equal(model.pendingCount, 1); assert.equal(model.open({ id: 'one', name: 'Project one' }, 'other'), original, 'reopening restores the submitted request rather than losing its safety guard');
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
  for (const receipt of [{ requestId: 'request-one', status: 'unknown' }, { requestId: 'request-one', status: 'outcome_unknown', project: 'one', parent: 'chapters' }, { ...committed(), project: 'two' }, { ...committed(), gitOwnership: 'external' }]) {
    const { model, applied } = setup({ request: async () => receipt }); await model.choose('chapters'); await model.commit();
    assert.equal(model.current.phase, 'unconfirmed'); assert.equal(applied.length, 0);
  }
  const { model, applied } = setup({ request: async () => ({ requestId: 'request-one', status: 'failed', project: 'one', parent: 'chapters', error: { code: 'exists', message: 'A target already exists.' } }) });
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
  const calls = [], { model } = setup({ request: async operation => { calls.push(operation); return { requestId: 'request-one', status: 'outcome_unknown', project: 'one', parent: 'chapters' }; } });
  await model.choose('chapters'); await model.commit(); assert.equal(model.pendingCount, 1);
  await model.dismiss(); assert.equal(model.pendingCount, 0); assert.equal(calls.length, 1); assert.equal(model.current.phase, 'inspected');
});
