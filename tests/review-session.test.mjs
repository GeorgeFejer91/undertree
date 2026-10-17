import test from 'node:test';
import assert from 'node:assert/strict';
import { ReviewSession } from '../modules/frontend/review-session.js';

const snapshot = content => ({path:'main.html',content,review:{revision:content,rules:[],markers:[],suggestions:[]}});
function deferred() { let resolve; const promise = new Promise(r => {resolve=r;}); return {promise,resolve}; }
const nativeDocumentBusy = () => ({ code: 'busy', message: 'A local document operation is running. Retry this action.' });
const nextTurn = () => new Promise(resolve => setImmediate(resolve));

test('PDF marking and removal persist review metadata without saving or replacing a dirty source buffer', async () => {
  for (const action of ['pdf_mark', 'pdf_unmark']) {
    const actions = [];
    const session = new ReviewSession(snapshot('saved source'), 'project', async operation => {
      actions.push(operation.action);
      const response = snapshot('saved source');
      response.review.pdfAnnotations = action === 'pdf_mark' ? [{ id: 'pdf-1' }] : [];
      return response;
    });
    session.edit('my unsaved draft');
    const version = session.version, savedVersion = session.savedVersion;
    await session.mutate(action, { identity: 'pdf', segments: [] });
    assert.deepEqual(actions, [action]);
    assert.equal(session.content, 'my unsaved draft');
    assert.equal(session.version, version);
    assert.equal(session.savedVersion, savedVersion);
    assert.equal(session.dirty, true);
    assert.equal(session.snapshot.content, 'saved source');
    assert.equal(session.snapshot.review.pdfAnnotations.length, action === 'pdf_mark' ? 1 : 0);
  }
});

test('typing during a PDF annotation response cannot become clean or overwrite the current draft', async () => {
  const gate = deferred();
  const session = new ReviewSession(snapshot('saved'), 'project', async () => { await gate.promise; return snapshot('saved'); });
  const marking = session.mutate('pdf_mark');
  await nextTurn(); session.edit('newer typing'); gate.resolve(); await marking;
  assert.equal(session.content, 'newer typing'); assert.equal(session.dirty, true); assert.equal(session.snapshot.content, 'saved');
});

test('an external saved-source change during PDF annotation preserves the draft and refuses snapshot adoption', async () => {
  const session = new ReviewSession(snapshot('saved'), 'project', async () => snapshot('external'));
  session.edit('my draft');
  await assert.rejects(session.mutate('pdf_mark'), error => error.code === 'conflict');
  assert.equal(session.content, 'my draft'); assert.equal(session.dirty, true); assert.equal(session.snapshot.content, 'saved');
});

test('transient native pre-dispatch contention retries inside the same review queue', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const operations = []; let commits = 0, selected = true;
  const session = new ReviewSession(snapshot('source'), 'project', async operation => {
    operations.push(operation);
    if (operation.action === 'mark' && operations.length < 3) throw nativeDocumentBusy();
    if (operation.action === 'mark') commits += 1;
    return snapshot('source');
  });
  const assertSelected = () => assert.equal(selected, true);
  const marking = session.mutate('mark', { from: 0, to: 6, rule: 'protect' }, assertSelected);
  let laterRan = false;
  const later = session.enqueue(() => { laterRan = true; });
  await nextTurn();
  assert.equal(operations.length, 1); assert.equal(commits, 0); assert.equal(laterRan, false);
  t.mock.timers.tick(50); await nextTurn();
  assert.equal(operations.length, 2); assert.equal(commits, 0); assert.equal(laterRan, false);
  t.mock.timers.tick(100); await marking; await later;
  assert.equal(operations.length, 3); assert.equal(commits, 1); assert.equal(laterRan, true);
  assert.deepEqual(operations[1], operations[0]); assert.deepEqual(operations[2], operations[0]);
  assert.equal(session.content, 'source'); assert.equal(session.dirty, false); assert.equal(session.pending, 0);
});

test('persistent known contention stops after four refused dispatches without committing', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let attempts = 0;
  const session = new ReviewSession(snapshot('source'), 'project', async () => { attempts += 1; throw nativeDocumentBusy(); });
  const refused = assert.rejects(session.mutate('mark', { rule: 'protect' }), error => error.code === 'busy');
  await nextTurn();
  for (const delay of [50, 100, 150]) { t.mock.timers.tick(delay); await nextTurn(); }
  await refused;
  assert.equal(attempts, 4); assert.equal(session.pending, 0);
  assert.equal(session.content, 'source'); assert.equal(session.snapshot.content, 'source'); assert.equal(session.dirty, false);
});

test('a selection change while waiting prevents another mark dispatch', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let attempts = 0, selected = true;
  const session = new ReviewSession(snapshot('source'), 'project', async () => {
    attempts += 1;
    if (attempts === 1) throw nativeDocumentBusy();
    return snapshot('source');
  });
  const refused = assert.rejects(session.mutate('mark', { rule: 'protect' }, () => {
    if (!selected) throw { code: 'selection_changed' };
  }), error => error.code === 'selection_changed');
  await nextTurn(); selected = false; t.mock.timers.tick(50); await refused;
  assert.equal(attempts, 1); assert.equal(session.pending, 0); assert.equal(session.content, 'source');
});

test('new typing while waiting prevents replay even without a selection callback', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let attempts = 0;
  const session = new ReviewSession(snapshot('source'), 'project', async () => {
    attempts += 1;
    if (attempts === 1) throw nativeDocumentBusy();
    return snapshot('source');
  });
  const refused = assert.rejects(session.mutate('unmark', { id: 'marker' }), error => error.code === 'stale_buffer');
  await nextTurn(); session.edit('newer typing'); t.mock.timers.tick(50); await refused;
  assert.equal(attempts, 1); assert.equal(session.content, 'newer typing'); assert.equal(session.dirty, true);
  assert.equal(session.snapshot.content, 'source'); assert.equal(session.pending, 0);
});

test('busy from another boundary and uncertain or unknown failures never replay a mutation', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const error of [
    { code: 'busy', message: 'Another document operation is running.' },
    { code: 'busy', message: 'The editor is composing text or closing. Retry after it is ready.' },
    { code: 'outcome_unknown', message: 'A local document operation is running. Retry this action.' },
    { message: 'A local document operation is running. Retry this action.' },
    new Error('Connection lost after submitting the mutation.'),
  ]) {
    let attempts = 0;
    const session = new ReviewSession(snapshot('source'), 'project', async () => { attempts += 1; throw error; });
    await assert.rejects(session.mutate('decide', { id: 'suggestion', decision: 'accepted' }), actual => actual === error);
    t.mock.timers.tick(1000); await nextTurn();
    assert.equal(attempts, 1); assert.equal(session.pending, 0); assert.equal(session.content, 'source');
  }
});
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
test('live review metadata arrives while typing without saving or replacing the draft', async () => {
  const gate = deferred(); const operations = [];
  const incoming = snapshot('old'); incoming.review.suggestions = [{ id: 'live', status: 'pending', replacement: 'Proposed wording' }];
  const session = new ReviewSession(snapshot('old'), 'project', async operation => { operations.push(operation.action); await gate.promise; return incoming; });
  session.edit('my draft');
  const refreshing = session.refresh({ metadataOnly: true });
  session.edit('my newer draft'); gate.resolve();
  assert.equal(await refreshing, true);
  assert.deepEqual(operations, ['review']);
  assert.equal(session.snapshot.review.suggestions[0].id, 'live');
  assert.equal(session.snapshot.content, 'old'); assert.equal(session.content, 'my newer draft');
  assert.equal(session.dirty, true); assert.equal(session.version, 2); assert.equal(session.savedVersion, 0);
  assert.equal(session.conflict, null);
});
test('live review refresh preserves dirty drafts on external changes and refuses retired responses', async () => {
  for (const retired of [false, true]) {
    const gate = deferred(); const external = snapshot('external');
    const session = new ReviewSession(snapshot('old'), 'project', async () => { await gate.promise; return external; });
    session.edit('my draft'); let current = true;
    const refreshing = session.refresh({ metadataOnly: true, isCurrent: () => current });
    if (retired) current = false;
    gate.resolve(); assert.equal(await refreshing, false);
    assert.equal(session.content, 'my draft'); assert.equal(session.snapshot.content, 'old'); assert.equal(session.dirty, true);
    assert.equal(session.conflict, retired ? null : external);
  }
});

test('a confirmed direct edit updates a clean buffer once and advances its saved generation', async () => {
  const incoming = { ...snapshot('edited'), directEdit: { fromRevision: 'old', toRevision: 'edited' } };
  const session = new ReviewSession(snapshot('old'), 'project', async () => incoming);
  assert.equal(await session.refresh({ metadataOnly: true, directEdits: true }), true);
  assert.equal(session.content, 'edited'); assert.equal(session.snapshot, incoming);
  assert.equal(session.version, 1); assert.equal(session.generation, 1); assert.equal(session.savedVersion, 1);
  assert.equal(session.dirty, false); assert.equal(session.conflict, null);
  await session.refresh({ metadataOnly: true, directEdits: true });
  assert.equal(session.generation, 1);
});

test('direct edits never overwrite dirty, pending, composing or changed buffers and require an exact native receipt', async () => {
  for (const condition of ['dirty', 'typing', 'pending', 'composing', 'unrequested', 'missing', 'wrong_from', 'wrong_to']) {
    const gate = deferred();
    const incoming = { ...snapshot('edited'), directEdit: { fromRevision: 'old', toRevision: 'edited' } };
    if (condition === 'missing') delete incoming.directEdit;
    if (condition === 'wrong_from') incoming.directEdit.fromRevision = 'different';
    if (condition === 'wrong_to') incoming.directEdit.toRevision = 'different';
    const session = new ReviewSession(snapshot('old'), 'project', async () => { await gate.promise; return incoming; });
    if (condition === 'dirty') session.edit('my draft');
    const refreshing = session.refresh({ metadataOnly: true, directEdits: condition !== 'unrequested', isCurrent: () => condition !== 'composing' });
    if (condition === 'typing') session.edit('new typing');
    if (condition === 'pending') session.pending += 1;
    gate.resolve(); assert.equal(await refreshing, false, condition);
    assert.equal(session.content, condition === 'dirty' ? 'my draft' : condition === 'typing' ? 'new typing' : 'old', condition);
    assert.equal(session.snapshot.content, 'old', condition);
    assert.equal(session.conflict, ['composing', 'pending'].includes(condition) ? null : incoming, condition);
    assert.equal(session.generation, ['dirty', 'typing'].includes(condition) ? 1 : 0, condition);
  }
});

test('live metadata observation defers a held local save instead of declaring its committed text an external conflict', async () => {
  const gate = deferred(); let disk = 'old';
  const session = new ReviewSession(snapshot(disk), 'project', async operation => {
    if (operation.action === 'save') { disk = operation.content; await gate.promise; }
    return snapshot(disk);
  });
  session.edit('local saved text');
  const saving = session.flush(); await nextTurn();
  assert.equal(await session.refresh({ metadataOnly: true, directEdits: true }), false);
  assert.equal(session.conflict, null); assert.equal(session.content, 'local saved text');
  assert.equal(session.snapshot.content, 'old'); assert.equal(session.dirty, true);
  gate.resolve(); await saving;
  assert.equal(session.snapshot.content, 'local saved text'); assert.equal(session.dirty, false);
  assert.equal(session.conflict, null);
  disk = 'unrelated external edit';
  assert.equal(await session.refresh({ metadataOnly: true, directEdits: true }), false);
  assert.equal(session.conflict.content, disk); assert.equal(session.content, 'local saved text');
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
