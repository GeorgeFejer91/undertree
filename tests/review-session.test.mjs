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
