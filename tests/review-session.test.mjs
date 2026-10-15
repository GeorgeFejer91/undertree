import test from 'node:test';
import assert from 'node:assert/strict';
import { ReviewSession } from '../modules/frontend/review-session.js';

const snapshot = content => ({path:'main.html',content,review:{revision:content,rules:[],markers:[],suggestions:[]}});
function deferred() { let resolve; const promise = new Promise(r => {resolve=r;}); return {promise,resolve}; }
test('typing during a review action save remains dirty after its metadata response', async () => {
  for (const action of ['mark', 'unmark', 'reanchor', 'palette']) {
    const gate = deferred(); const operations = [];
    let disk = 'old';
    const session = new ReviewSession(snapshot(disk), 'project', async operation => {
      operations.push(operation);
      if (operation.action === 'save') { await gate.promise; disk = operation.content; }
      else assert.equal(operation.revision, disk);
      return snapshot(disk);
    });
    session.edit('selected source');
    const applying = session.mutate(action, { id: 'highlight' });
    await new Promise(resolve => setImmediate(resolve));
    session.edit('newer typing');
    gate.resolve(); await applying;
    assert.deepEqual(operations.map(operation => operation.action), ['save', action]);
    assert.equal(session.content, 'newer typing', action);
    assert.equal(session.snapshot.content, 'selected source');
    assert.equal(session.dirty, true);
    assert.equal(session.conflict, null);
    await session.flush();
    assert.equal(disk, 'newer typing');
    assert.equal(session.dirty, false);
  }
});
test('typing during the save before acceptance preserves the buffer as a conflict', async () => {
  const gate = deferred();
  const session = new ReviewSession(snapshot('old'), 'project', async operation => {
    if (operation.action === 'save') { await gate.promise; return snapshot(operation.content); }
    return snapshot('accepted on disk');
  });
  session.edit('selected source');
  const accepting = session.mutate('decide', { id: 'suggestion', decision: 'accepted' });
  await new Promise(resolve => setImmediate(resolve));
  session.edit('newer typing'); gate.resolve(); await accepting;
  assert.equal(session.content, 'newer typing');
  assert.equal(session.conflict.content, 'accepted on disk');
  assert.equal(session.dirty, true);
  await assert.rejects(session.flush());
});
test('a delayed save never marks newer typing clean or changes the bound file', async () => {
  const gate = deferred(); let request;
  const session = new ReviewSession(snapshot('old'),'project',async op => {request=op;await gate.promise;return snapshot(op.content);});
  session.edit('first'); const saving = session.flush(); await new Promise(r=>setImmediate(r));
  session.edit('newer'); gate.resolve(); await saving;
  assert.equal(request.path,'main.html'); assert.equal(session.content,'newer'); assert.equal(session.dirty,true);
  await session.flush(); assert.equal(session.dirty,false); assert.equal(session.snapshot.review.revision,'newer');
});
test('typing during acceptance is preserved and cannot overwrite the accepted disk version', async () => {
  const gate = deferred();
  const session = new ReviewSession(snapshot('old'),'project',async op => {if(op.action==='decide') {await gate.promise;return snapshot('accepted');} return snapshot(op.content);});
  const accepting = session.mutate('decide',{id:'suggestion',decision:'accepted'}); await new Promise(r=>setImmediate(r));
  session.edit('my typing'); const saving = session.flush(); gate.resolve(); await accepting;
  assert.equal(session.content,'my typing'); assert.equal(session.conflict.content,'accepted');
  await assert.rejects(saving); assert.equal(session.dirty,true);
});
test('a refresh observing an in-flight acceptance does not retain an obsolete source conflict', async () => {
  const gate = deferred();
  let disk = 'old';
  const session = new ReviewSession(snapshot(disk), 'project', async operation => {
    if (operation.action === 'decide') { disk = 'accepted'; await gate.promise; return snapshot('accepted'); }
    return snapshot(disk);
  });
  const accepting = session.mutate('decide', { id: 'suggestion', decision: 'accepted' });
  await new Promise(resolve => setImmediate(resolve));
  await session.refresh();
  assert.equal(session.conflict.content, 'accepted');
  gate.resolve(); await accepting;
  assert.equal(session.content, 'accepted');
  assert.equal(session.conflict, null);
  assert.equal(session.dirty, false);
  await session.flush();
});
test('an accepted response cannot clear a different external change or newer typing', async () => {
  for (const typing of [false, true]) {
    const gate = deferred();
    let disk = 'old';
    const session = new ReviewSession(snapshot(disk), 'project', async operation => {
      if (operation.action === 'decide') { disk = 'accepted'; await gate.promise; return snapshot('accepted'); }
      return snapshot(disk);
    });
    const accepting = session.mutate('decide', { id: 'suggestion', decision: 'accepted' });
    await new Promise(resolve => setImmediate(resolve));
    if (!typing) disk = 'different external source';
    await session.refresh();
    if (typing) session.edit('my newer typing');
    gate.resolve(); await accepting;
    assert.equal(session.content, typing ? 'my newer typing' : 'accepted');
    assert.equal(session.conflict.content, typing ? 'accepted' : 'different external source');
    await assert.rejects(session.flush());
  }
});
test('a remote refresh cannot replace a dirty buffer', async () => {
  const gate = deferred(); const session = new ReviewSession(snapshot('old'),'project',async()=>{await gate.promise;return snapshot('external');});
  const refresh = session.refresh(); session.edit('mine'); gate.resolve(); assert.equal(await refresh,false);
  assert.equal(session.content,'mine'); assert.equal(session.snapshot.content,'old');
});
test('an older refresh cannot replace a newer local review policy response', async () => {
  const gate = deferred();
  const original = snapshot('source');
  const updated = snapshot('source'); updated.review.rules = [{ id: 'current policy' }];
  const session = new ReviewSession(original, 'project', async operation => {
    if (operation.action === 'review') { await gate.promise; return original; }
    return updated;
  });
  const refreshing = session.refresh();
  await session.mutate('palette', { rules: updated.review.rules });
  gate.resolve(); assert.equal(await refreshing, false);
  assert.equal(session.snapshot, updated);
  assert.deepEqual(session.snapshot.review.rules, updated.review.rules);
});
test('a failed save exposes the external version and preserves the dirty buffer', async () => {
  const session=new ReviewSession(snapshot('old'),'project',async op=>{
    if(op.action==='save') throw {code:'stale',message:'External change'};
    return snapshot('external');
  });
  session.edit('mine');await assert.rejects(session.flush());
  assert.equal(session.content,'mine');assert.equal(session.conflict.content,'external');assert.equal(session.dirty,true);
  await assert.rejects(session.flush());
});

const editorSave = (session, overrides = {}) => session.saveEditorSnapshot({
  isCurrent: () => true, isBusy: () => false, publish: async () => {},
  commit: async captured => ({ snapshot: snapshot(captured.content), receipt: { status: 'committed', savedGeneration: captured.generation, savedRevision: captured.content } }),
  ...overrides,
});
test('a native editor save verifies even a clean buffer and waits behind acceptance', async () => {
  const gate = deferred(); let commits = 0;
  const session = new ReviewSession(snapshot('old'), 'project', async () => { await gate.promise; return snapshot('accepted'); });
  const accepting = session.mutate('decide', { decision: 'accepted' });
  const saving = editorSave(session, { commit: async captured => {
    commits += 1; assert.equal(captured.content, 'accepted'); assert.equal(captured.generation, 1);
    return { snapshot: snapshot(captured.content), receipt: { status: 'committed', savedGeneration: captured.generation, savedRevision: captured.content } };
  } });
  gate.resolve(); await accepting; assert.equal((await saving).current, true);
  assert.equal(commits, 1); assert.equal(session.dirty, false);
});
test('typing, composition, conflict, or retirement during preparation never commits', async () => {
  for (const change of ['typing', 'composition', 'conflict', 'retired']) {
    const gate = deferred(); let current = true, busy = false, commits = 0;
    const session = new ReviewSession(snapshot('old'), 'project', async () => snapshot('old'));
    session.edit('my buffer');
    const saving = editorSave(session, { publish: () => gate.promise, isCurrent: () => current, isBusy: () => busy, commit: async () => { commits += 1; } });
    await new Promise(resolve => setImmediate(resolve));
    if (change === 'typing') session.edit('new typing');
    if (change === 'composition') busy = true;
    if (change === 'conflict') session.conflict = snapshot('external');
    if (change === 'retired') current = false;
    gate.resolve();
    await assert.rejects(saving, error => error.code === { typing: 'stale_buffer', composition: 'busy', conflict: 'conflict', retired: 'stale_session' }[change]);
    assert.equal(commits, 0); assert.equal(session.dirty, true); assert.equal(session.snapshot.content, 'old');
  }
});
test('new typing during native commit stays dirty and reports a divergent current buffer', async () => {
  const gate = deferred(); let commits = 0;
  const session = new ReviewSession(snapshot('old'), 'project', async operation => snapshot(operation.content));
  session.edit('captured');
  const saving = editorSave(session, { commit: async captured => { commits += 1; await gate.promise; return { snapshot: snapshot(captured.content), receipt: { status: 'committed', savedGeneration: captured.generation, savedRevision: captured.content } }; } });
  await new Promise(resolve => setImmediate(resolve));
  session.edit('newer typing'); gate.resolve();
  assert.equal((await saving).current, false); assert.equal(commits, 1);
  assert.equal(session.content, 'newer typing'); assert.equal(session.snapshot.content, 'captured'); assert.equal(session.dirty, true);
  await session.flush(); assert.equal(session.dirty, false);
});
test('a native conflict or mismatched receipt cannot claim a buffer was saved', async () => {
  const session = new ReviewSession(snapshot('old'), 'project', async () => snapshot('external'));
  session.edit('my buffer');
  await assert.rejects(editorSave(session, { commit: async () => { throw { code: 'stale' }; } }), error => error.code === 'stale');
  assert.equal(session.conflict.content, 'external'); assert.equal(session.content, 'my buffer'); assert.equal(session.dirty, true);
  session.conflict = null;
  await assert.rejects(editorSave(session, { commit: async () => ({ snapshot: snapshot('wrong'), receipt: { savedGeneration: 1, savedRevision: 'wrong' } }) }), error => error.code === 'outcome_unknown');
  assert.equal(session.snapshot.content, 'old'); assert.equal(session.content, 'my buffer'); assert.equal(session.dirty, true);
});
test('pending local operations are observable until both success and failure settle', async () => {
  const gate = deferred(); let fail = true;
  const session = new ReviewSession(snapshot('old'), 'project', async () => { await gate.promise; if (fail) throw { code: 'busy' }; return snapshot('old'); });
  const first = session.mutate('mark'); const second = session.flush();
  assert.equal(session.pending, 2); gate.resolve(); await assert.rejects(first); await second;
  assert.equal(session.pending, 0); fail = false; await session.mutate('mark'); assert.equal(session.pending, 0);
});
