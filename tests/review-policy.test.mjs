import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { ReviewSession, sourceEpoch, sourceRootsEqual, captureSourceBinding, assertSourceBinding, localNoSaveClose } from '../modules/frontend/review-session.js';
import { EditorSessionBridge } from '../modules/frontend/editor-session-bridge.js';
import { captureControlState, assertControlState } from '../modules/frontend/manuscript-control-state.js';
import { publicationPreviewCurrent } from '../modules/frontend/manuscript-workspace.js';

const problem = (code = 'policy_missing') => ({ code, message: `${code}: native review files are preserved.` });
const snapshot = content => ({ documentId: 'doc', path: 'main.html', shared: true, content, review: { revision: content, rules: [], markers: [{ id: 'protection' }], suggestions: [] } });
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

test('native policy refusals preserve last-known data and block clean saves and policy writes', async () => {
  for (const code of ['policy_missing', 'recovery_conflict']) {
    const original = snapshot('saved'), operations = [];
    const session = new ReviewSession(original, 'project', async operation => { operations.push(operation); throw problem(code); });
    await assert.rejects(session.refresh(), error => error.code === code);
    assert.equal(session.snapshot, original); assert.equal(session.content, 'saved'); assert.equal(session.reviewProblem.code, code);
    await assert.rejects(session.flush(), error => error.code === code);
    await assert.rejects(session.mutate('unmark', { id: 'protection' }), error => error.code === code);
    assert.deepEqual(operations.map(operation => operation.action), ['review']);
    assert.equal(session.dirty, false); assert.equal(session.conflict, null);
  }
});

test('save and policy failures latch stable native codes without fallback reset reads', async () => {
  for (const action of ['save', 'mark']) {
    const original = snapshot('saved'), operations = [];
    const session = new ReviewSession(original, 'project', async operation => { operations.push(operation); throw problem(); });
    if (action === 'save') session.edit('latest draft');
    await assert.rejects(action === 'save' ? session.flush() : session.mutate('mark'), error => error.code === 'policy_missing');
    assert.equal(session.snapshot, original); assert.equal(session.content, action === 'save' ? 'latest draft' : 'saved');
    assert.deepEqual(operations.map(operation => operation.action), [action]);
    assert.equal(session.reviewProblem.code, 'policy_missing');
  }
});

test('explicit retry reads only Review and preserves dirty content, versions and a separate source conflict', async () => {
  for (const conflict of [null, snapshot('external source')]) {
    const operations = [], original = snapshot('saved'), restored = snapshot('saved');
    const session = new ReviewSession(original, 'project', async operation => { operations.push(operation); return restored; });
    session.edit('unsaved draft'); session.conflict = conflict; session.recordReviewProblem(problem());
    const version = session.version, generation = session.generation, savedVersion = session.savedVersion;
    assert.equal(await session.refresh(), false); assert.equal(operations.length, 0);
    assert.equal(await session.refresh({ retryProblem: true }), true);
    assert.equal(session.reviewProblem, null); assert.equal(session.content, 'unsaved draft'); assert.equal(session.dirty, true);
    assert.equal(session.version, version); assert.equal(session.generation, generation); assert.equal(session.savedVersion, savedVersion);
    assert.equal(session.conflict, conflict); assert.equal(session.snapshot, conflict ? original : restored);
    assert.deepEqual(operations.map(operation => operation.action), ['review']);
  }
});

test('pure retry may restore review availability while preserving an external source conflict', async () => {
  const original = snapshot('saved'), external = snapshot('external');
  const session = new ReviewSession(original, 'project', async () => external);
  session.recordReviewProblem(problem()); session.edit('draft');
  assert.equal(await session.refresh({ retryProblem: true }), true);
  assert.equal(session.reviewProblem, null); assert.equal(session.conflict, external); assert.equal(session.snapshot, original); assert.equal(session.content, 'draft');
});

test('busy journal retry and malformed success retain the exact problem and last snapshot', async () => {
  for (const outcome of ['busy', 'wrong-file']) {
    const original = snapshot('saved'), operations = [];
    const session = new ReviewSession(original, 'project', async operation => {
      operations.push(operation);
      if (outcome === 'busy') throw { code: 'busy', message: 'A preserved journal is still pending.' };
      return { ...snapshot('saved'), path: 'other.html' };
    });
    session.recordReviewProblem(problem('recovery_conflict')); session.edit('draft'); const captured = session.reviewProblem;
    await assert.rejects(session.refresh({ retryProblem: true }));
    assert.equal(session.reviewProblem, captured); assert.equal(session.snapshot, original); assert.equal(session.content, 'draft');
    assert.deepEqual(operations.map(operation => operation.action), ['review']);
  }
});

test('late retry cannot clear a newer problem, edited buffer, source conflict or replaced editor', async () => {
  for (const change of ['typing', 'problem', 'conflict', 'retired']) {
    const gate = deferred(), original = snapshot('saved'); let current = true;
    const session = new ReviewSession(original, 'project', async () => { await gate.promise; return snapshot('saved'); });
    session.recordReviewProblem(problem()); const checking = session.refresh({ retryProblem: true, isCurrent: () => current });
    if (change === 'typing') session.edit('latest draft');
    if (change === 'problem') session.recordReviewProblem(problem('recovery_conflict'));
    if (change === 'conflict') session.conflict = snapshot('external');
    if (change === 'retired') current = false;
    const captured = session.reviewProblem; gate.resolve();
    assert.equal(await checking, false); assert.equal(session.reviewProblem, captured); assert.equal(session.snapshot, original);
    assert.equal(session.content, change === 'typing' ? 'latest draft' : 'saved');
  }
});

test('late saved-source responses cannot reverse a newer native-confirmed sharing change', async () => {
  for (const action of ['save', 'mark', 'editor_commit']) {
    const gate = deferred(), started = deferred();
    const session = new ReviewSession(snapshot('saved'), 'project', async operation => {
      assert.equal(operation.action, action); started.resolve(); await gate.promise;
      return snapshot(operation.content || 'saved');
    });
    let work;
    if (action === 'save') { session.edit('draft'); work = session.flush(); }
    else if (action === 'mark') work = session.mutate('mark');
    else work = session.saveEditorSnapshot({ isCurrent: () => true, isBusy: () => false, publish: async () => {}, commit: async captured => {
      started.resolve(); await gate.promise;
      return { snapshot: snapshot(captured.content), receipt: { status: 'committed', savedGeneration: captured.generation, savedRevision: captured.content } };
    } });
    await started.promise;
    session.snapshot = { ...session.snapshot, shared: false };
    gate.resolve(); await work;
    assert.equal(session.snapshot.shared, false, action);
    assert.equal(session.content, action === 'save' ? 'draft' : 'saved');
  }
});

test('editor bridge advertises the policy block and cannot commit a clean registered buffer', async () => {
  const operations = [], session = new ReviewSession(snapshot('saved'), 'project', async () => { throw Error('No source request'); });
  session.recordReviewProblem(problem());
  const bridge = new EditorSessionBridge({ state: () => ({ current: true }), digest: async () => 'digest', request: async operation => {
    operations.push(operation); return { protocolVersion: 1, sessionId: 'registered' };
  } });
  try {
    bridge.watch(session); await bridge.publishChanges();
    assert.equal(operations[0].action, 'editor_register'); assert.equal(operations[0].conflict, true); assert.equal(operations[0].dirty, false);
    await bridge.save(bridge.entries.get(session), { requestId: 'request', ticket: 'ticket', sessionId: 'registered' });
    assert.equal(operations.some(operation => operation.action === 'editor_commit'), false);
    assert.equal(session.snapshot.content, 'saved'); assert.equal(session.reviewProblem.code, 'policy_missing');
  } finally { bridge.stop(); }
});

test('policy changes invalidate held App captures and keep publication stale without changing source', () => {
  const session = new ReviewSession(snapshot('saved'), 'project', async () => {});
  const context = { sourceEpoch, sourceRootsEqual, captureSourceBinding, assertSourceBinding, localNoSaveClose, sessions: [session], active: session, navigation: 1, requestsVersion: 0, pending: 0, composing: false, closing: false };
  const captured = captureControlState(context); session.recordReviewProblem(problem());
  assert.throws(() => assertControlState(captured, context), error => error.code === 'stale');
  assert.throws(() => assertControlState(captureControlState(context), context, { clean: true }), error => error.code === 'busy');
  assert.equal(publicationPreviewCurrent({ current: true, revision: 'saved' }, { main: session, inputSessions: [session], projectVersion: 0, composing: false }), false);
  assert.equal(session.content, 'saved');
});

const manuscript = await readFile(new URL('../src/manuscript.js', import.meta.url), 'utf8');
test('a late policy error cannot replace a different active manuscript status', async () => {
  const task = manuscript.match(/^function task\(callback\) \{.*\}$/m)?.[0]; assert.ok(task);
  for (const switched of [false, true]) {
    const gate = deferred(), messages = [], context = { active: {}, status: message => messages.push(message) };
    const wrap = runInNewContext(`${task}\ntask`, context);
    const running = wrap(async () => { await gate.promise; throw problem(); })();
    if (switched) context.active = {};
    gate.resolve(); await running;
    assert.equal(messages.length, switched ? 0 : 1);
  }
});

test('actual explicit retry also keeps a late busy-journal error off a different active tab', async () => {
  const callback = manuscript.match(/\$\('review-refresh'\)\.onclick = task\((async \(\) => \{[\s\S]*?\n\})\);/)?.[1]; assert.ok(callback);
  for (const switched of [false, true]) {
    const gate = deferred(), session = { reviewProblem: problem('recovery_conflict'), refresh: async () => { await gate.promise; throw { code: 'busy', message: 'A pending native journal remains.' }; } };
    const context = { sourceEpoch, sourceRootsEqual, captureSourceBinding, assertSourceBinding, localNoSaveClose, active: session };
    const checking = runInNewContext(`(${callback})`, context)();
    if (switched) context.active = {};
    gate.resolve();
    if (switched) await checking; else await assert.rejects(checking, error => error.code === 'busy');
  }
});

test('actual Share-off callback sends only restrictive native Share and preserves blocked dirty draft', async () => {
  const callback = manuscript.match(/\$\('manuscript-share'\)\.onchange = task\((async \(\) => \{[\s\S]*?\n\})\);/)?.[1]; assert.ok(callback);
  for (const result of ['confirmed', 'failed']) {
    const operations = [], session = new ReviewSession(snapshot('saved'), 'project', async () => { throw Error('No Save'); });
    session.edit('draft'); session.recordReviewProblem(problem()); const blocked = session.reviewProblem;
    const context = { sourceEpoch, sourceRootsEqual, captureSourceBinding, assertSourceBinding, localNoSaveClose, active: session, sharingSession: null, contextShareIntent: 0, $: () => ({ checked: false }), sessions: new Map([['project:main.html', session]]), keyFor: (project, path) => `${project}:${path}`,
      saveSession: () => { throw Error('Revoke must not save'); }, request: async operation => { operations.push(operation); if (result === 'failed') throw { code: 'busy' }; return { documentId: 'doc', shared: false }; }, connections: { refresh: async () => {} }, renderReview() {} };
    const submit = runInNewContext(`(${callback})`, context);
    if (result === 'failed') await assert.rejects(submit()); else await submit();
    assert.equal(operations.length, 1); assert.equal(operations[0].action, 'share'); assert.equal(operations[0].enabled, false);
    assert.equal(session.snapshot.shared, result === 'failed'); assert.equal(session.reviewProblem, blocked); assert.equal(session.content, 'draft'); assert.equal(session.dirty, true);
  }
});

test('actual native-confirmed revoke invalidates a held successful policy retry', async () => {
  const callback = manuscript.match(/\$\('manuscript-share'\)\.onchange = task\((async \(\) => \{[\s\S]*?\n\})\);/)?.[1]; assert.ok(callback);
  const gate = deferred(), session = new ReviewSession(snapshot('saved'), 'project', async () => { await gate.promise; return snapshot('saved'); });
  session.recordReviewProblem(problem()); const blocked = session.reviewProblem;
  const checking = session.refresh({ retryProblem: true });
  const context = { sourceEpoch, sourceRootsEqual, captureSourceBinding, assertSourceBinding, localNoSaveClose, active: session, sharingSession: null, contextShareIntent: 0, $: () => ({ checked: false }), sessions: new Map([['project:main.html', session]]), keyFor: (project, path) => `${project}:${path}`,
    saveSession() { throw Error('Revoke must not save'); }, request: async () => ({ documentId: 'doc', shared: false }), connections: { refresh: async () => {} }, renderReview() {} };
  await runInNewContext(`(${callback})`, context)();
  gate.resolve(); assert.equal(await checking, false);
  assert.equal(session.snapshot.shared, false); assert.equal(session.reviewProblem, blocked);
});

test('actual local Close skips a clean policy-blocked source but refuses dirty or pending state', async () => {
  const configuration = manuscript.match(/windowChrome = await setupWindowChrome\((\{[\s\S]*?\n\})\);/)?.[1]; assert.ok(configuration);
  const session = new ReviewSession(snapshot('saved'), 'project', async () => { throw Error('No native write'); }); session.recordReviewProblem(problem());
  let pending = 0, saves = 0;
  const context = { sourceEpoch, sourceRootsEqual, captureSourceBinding, assertSourceBinding, localNoSaveClose, sessions: new Map([['file', session]]), status() {}, setWindowClosing() {}, controlContext: () => ({ pending }), saveSession: value => { saves += 1; return value.flush(); } };
  const chrome = runInNewContext(`(${configuration})`, context);
  assert.equal(chrome.canClose(), true); await chrome.beforeClose(); assert.equal(saves, 0);
  session.edit('draft'); assert.equal(chrome.canClose(), false); await assert.rejects(chrome.beforeClose(), error => error.code === 'policy_missing');
  assert.equal(session.content, 'draft'); pending = 1;
  await assert.rejects(chrome.beforeClose(), error => /pending local operations/.test(error.message));
  assert.equal(chrome.canClose(), false);
});
