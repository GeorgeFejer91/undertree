import test from 'node:test';
import assert from 'node:assert/strict';
import { ReviewSession } from '../modules/frontend/review-session.js';

const snapshot = content => ({path:'main.html',content,review:{revision:content,rules:[],markers:[],suggestions:[]}});
function deferred() { let resolve; const promise = new Promise(r => {resolve=r;}); return {promise,resolve}; }
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
test('a failed save exposes the external version and preserves the dirty buffer', async () => {
  const session=new ReviewSession(snapshot('old'),'project',async op=>{
    if(op.action==='save') throw {code:'stale',message:'External change'};
    return snapshot('external');
  });
  session.edit('mine');await assert.rejects(session.flush());
  assert.equal(session.content,'mine');assert.equal(session.conflict.content,'external');assert.equal(session.dirty,true);
  await assert.rejects(session.flush());
});
