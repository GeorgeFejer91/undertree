import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeProjectExport } from '../modules/frontend/project-export.js';

const archive = (project = 'one') => ({ exportId: `archive-${project}`, project, snapshotId: 'snapshot-one', sha256: 'a'.repeat(64), bytes: 512, entries: 5, fileCount: 3, directoryCount: 2, mainDocument: 'main.typ', policy: 'saved-only', exclusions: [{ path: '.git', reason: 'runtime' }], expiresAt: Date.now() + 60_000, fileName: `${project}.zip` });
const receipt = (status = 'exported', requestId = 'request-one', prepared = archive()) => ({ requestId, status, ...(status === 'exported' ? { destinationName: prepared.fileName } : {}), ...Object.fromEntries(['exportId', 'project', 'snapshotId', 'sha256', 'bytes', 'entries', 'mainDocument', 'fileName'].map(key => [key, prepared[key]])) });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function setup(options = {}) {
  const calls = []; let composing = false, closing = false;
  const model = new NativeProjectExport({
    prepare: async project => { calls.push({ prepare: project }); return archive(project); },
    choose: async (exportId, requestId) => { calls.push({ choose: exportId, requestId }); return receipt(); },
    request: async operation => { calls.push(operation); return operation.action === 'export_cancel' ? { exportId: operation.exportId, cancelled: true } : receipt(); },
    canStart: () => { if (composing || closing) throw { code: 'busy', message: 'Finish composing text and keep UnderTree open.' }; },
    requestId: () => 'request-one', ...options,
  });
  return { model, calls, composing: value => { composing = value; }, closing: value => { closing = value; } };
}
const project = { id: 'one', name: 'Project one' };

test('one action prepares a saved-only archive then stores its identities before the native Save dialog', async () => {
  const { model, calls } = setup({ choose: async (exportId, requestId) => {
    assert.equal(model.current.prepared.exportId, exportId); assert.equal(model.current.requestId, requestId); assert.equal(model.pendingCount, 1);
    calls.push({ choose: exportId, requestId }); return receipt();
  } });
  await model.start(project);
  assert.deepEqual(calls, [{ prepare: 'one' }, { choose: 'archive-one', requestId: 'request-one' }]);
  assert.equal(model.current.phase, 'exported'); assert.equal(model.pendingCount, 0); assert.match(model.current.message, /Unsaved editor changes were excluded/);
});
test('lost preparation acknowledgement cannot request a destination or leave a submitted write', async () => {
  let destinations = 0;
  const { model } = setup({ prepare: async () => { throw new Error('lost preparation response'); }, choose: async () => { destinations += 1; } });
  await model.start(project);
  assert.equal(destinations, 0); assert.equal(model.pendingCount, 0); assert.equal(model.current.requestId, null); assert.equal(model.current.phase, 'failed');
});
test('wrong project, non-saved policy and malformed archive identities never reach the Save dialog', async () => {
  for (const change of [{ project: 'two' }, { policy: 'buffer' }, { sha256: 'bad' }, { bytes: -1 }, { exportId: '' }, { entries: 1.5 }]) {
    let destinations = 0; const { model } = setup({ prepare: async () => ({ ...archive(), ...change }), choose: async () => { destinations += 1; } });
    await model.start(project); assert.equal(destinations, 0); assert.equal(model.pendingCount, 0); assert.equal(model.current.phase, 'failed');
  }
});
test('double clicks cannot duplicate preparation or open a second native dialog', async () => {
  const prepared = deferred(), destination = deferred(), calls = [];
  const { model } = setup({ prepare: project => { calls.push(project); return prepared.promise; }, choose: (exportId, requestId) => { calls.push({ exportId, requestId }); return destination.promise; } });
  const running = model.start(project); await model.start(project); assert.deepEqual(calls, ['one']);
  prepared.resolve(archive()); await new Promise(resolve => setImmediate(resolve)); await model.start(project);
  assert.equal(calls.length, 2); assert.equal(model.pendingCount, 1);
  destination.resolve(receipt('cancelled')); await running; assert.equal(model.current.phase, 'cancelled'); assert.equal(model.pendingCount, 0);
});
test('project selection changes cannot retarget an already captured archive or its result', async () => {
  const prepared = deferred(), calls = [], selected = { ...project };
  const { model } = setup({ prepare: project => { calls.push(project); return prepared.promise; }, choose: async (exportId, requestId) => { calls.push({ exportId, requestId }); return receipt(); } });
  const running = model.start(selected); selected.id = 'two'; selected.name = 'Project two'; prepared.resolve(archive()); await running;
  assert.deepEqual(calls, ['one', { exportId: 'archive-one', requestId: 'request-one' }]); assert.equal(model.current.project.name, 'Project one'); assert.match(model.current.message, /Project one/);
});
test('composition or closing before preparation blocks work; late composition cancels only the unused private archive', async () => {
  for (const state of ['composing', 'closing']) {
    const { model, calls, [state]: block } = setup(); block(true);
    await assert.rejects(model.start(project), error => error.code === 'busy'); assert.equal(calls.length, 0);
  }
  const prepared = deferred(), { model, calls, composing } = setup({ prepare: () => prepared.promise });
  const running = model.start(project); composing(true); prepared.resolve(archive()); await running;
  assert.deepEqual(calls, [{ action: 'export_cancel', exportId: 'archive-one' }]); assert.equal(model.pendingCount, 0); assert.equal(model.current.requestId, null);
});
test('a lost destination acknowledgement remains busy and status never replays preparation or the write', async () => {
  const calls = []; let checks = 0;
  const { model } = setup({ choose: async (exportId, requestId) => { calls.push({ exportId, requestId }); throw new Error('lost destination response'); }, request: async operation => { calls.push(operation); return receipt(++checks === 1 ? 'pending' : 'exported'); } });
  await model.start(project); const original = model.current;
  assert.equal(model.pendingCount, 1); assert.equal(original.phase, 'unconfirmed');
  await model.start({ id: 'two', name: 'Project two' }); assert.equal(model.current, original); assert.equal(calls.length, 1);
  await model.check(); assert.equal(model.pendingCount, 1); await model.check(); assert.equal(model.pendingCount, 0); assert.equal(model.current.phase, 'exported');
  assert.deepEqual(calls.slice(1), [{ action: 'export_status', requestId: 'request-one' }, { action: 'export_status', requestId: 'request-one' }]);
});
test('unknown status requires explicit inspection plus a successful cancellation barrier', async () => {
  let busy = true; const calls = [];
  const { model } = setup({ choose: async () => ({ requestId: 'request-one', status: 'unknown' }), request: async operation => {
    calls.push(operation); if (busy) throw { code: 'busy', message: 'Native download is running.' }; return { exportId: operation.exportId, cancelled: true };
  } });
  await model.start(project); await model.dismiss(); assert.equal(model.pendingCount, 1); assert.equal(model.current.phase, 'unconfirmed');
  busy = false; await model.dismiss(); assert.equal(model.pendingCount, 0); assert.equal(model.current.phase, 'inspected');
  assert.deepEqual(calls, [{ action: 'export_cancel', exportId: 'archive-one' }, { action: 'export_cancel', exportId: 'archive-one' }]);
});
test('terminal uncertain output requires inspection but no cancellation or replay of finished native work', async () => {
  const { model, calls } = setup({ choose: async () => receipt('outcome_unknown') });
  await model.start(project); assert.equal(model.pendingCount, 1); await model.dismiss(); assert.equal(model.pendingCount, 0); assert.equal(model.current.phase, 'inspected'); assert.deepEqual(calls, [{ prepare: 'one' }]);
});
test('mismatched receipts cannot claim completion or release an unresolved native write', async () => {
  for (const change of [{ requestId: 'another' }, { exportId: 'another' }, { project: 'two' }, { sha256: 'b'.repeat(64) }, { snapshotId: 'another' }, { bytes: 6 }, { entries: 6 }, { fileName: 'another.zip' }, { mainDocument: null }]) {
    const { model } = setup({ choose: async () => ({ ...receipt(), ...change }) }); await model.start(project);
    assert.equal(model.current.phase, 'unconfirmed'); assert.equal(model.pendingCount, 1); assert.equal(model.current.lastStatus, null);
  }
});
test('matching native failure releases the pending guard and preserves the native error', async () => {
  const { model } = setup({ choose: async () => ({ ...receipt('failed'), error: { code: 'exists', message: 'A destination already exists.' } }) });
  await model.start(project); assert.equal(model.current.phase, 'failed'); assert.equal(model.pendingCount, 0); assert.equal(model.current.message, 'A destination already exists.');
});
test('success displays the actual Unicode chosen leaf while retaining the prepared filename identity', async () => {
  const { model } = setup({ choose: async () => ({ ...receipt(), destinationName: 'résumé final.zip' }) });
  await model.start(project); assert.equal(model.current.phase, 'exported'); assert.match(model.current.message, /résumé final\.zip/); assert.doesNotMatch(model.current.message, /one\.zip/);
  assert.equal(model.current.prepared.fileName, 'one.zip');
  const mismatched = setup({ choose: async () => ({ ...receipt(), fileName: 'résumé final.zip', destinationName: 'résumé final.zip' }) }).model;
  await mismatched.start(project); assert.equal(mismatched.pendingCount, 1); assert.equal(mismatched.current.phase, 'unconfirmed');
});
test('an absent, unbounded or path-bearing destination name cannot fabricate successful completion', async () => {
  for (const destinationName of [undefined, '', '/private/chosen.zip', 'C:\\private\\chosen.zip', 'line\nbreak.zip', 'é'.repeat(128)]) {
    const { model } = setup({ choose: async () => ({ ...receipt(), destinationName }) }); await model.start(project);
    assert.equal(model.current.phase, 'unconfirmed'); assert.equal(model.pendingCount, 1); assert.doesNotMatch(model.current.message, /Downloaded saved project/);
  }
});
