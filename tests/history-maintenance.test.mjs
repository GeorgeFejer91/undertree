import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { ReviewSession } from '../modules/frontend/review-session.js';
import { EditorSessionBridge } from '../modules/frontend/editor-session-bridge.js';

const root = { dev: '18446744073709551615', ino: '9007199254740993' };
const snapshot = (content, pending) => ({ path: 'main.typ', sourceEpoch: 7, expectedRoot: root, documentId: 'main-7', content, shared: false, review: { revision: content, rules: [], markers: [], suggestions: [] }, ...(pending === undefined ? {} : { historyMaintenancePending: pending }) });
const turn = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const source = await readFile(new URL('../src/manuscript.js', import.meta.url), 'utf8');
const labelCode = source.slice(source.indexOf('function saveLabel('), source.indexOf('function pdfStatus('));
const renderPrefix = source.slice(source.indexOf('function renderReview('), source.indexOf("  for (const id of ['manuscript-save'", source.indexOf('function renderReview(')));
const onSavedCode = source.slice(source.indexOf('onSaved: session => {'), source.indexOf('  onError:', source.indexOf('onSaved: session => {')));
assert.ok(labelCode.startsWith('function saveLabel(') && renderPrefix.startsWith('function renderReview(') && onSavedCode.startsWith('onSaved:'));

// Use the actual shared label, actual render prefix and actual registered-save callback.
function ui(active) {
  const nodes = new Map(), queued = [];
  const node = id => { if (!nodes.has(id)) nodes.set(id, { textContent: '', scrollTop: 0, querySelector: () => null, contains: () => false, replaceChildren() {} }); return nodes.get(id); };
  const env = { active, $: node, document: { activeElement: null }, currentCompileContext: null,
    historyPanel: { changed() {} }, renderProjectExport() {}, reviewCue() {}, renderTabs() {},
    renderedReviewSession: active, restoreReviewScroll: null, reviewCardsObserved: new Set(), reviewGeometry: { unobserve() {} }, sharingSession: null,
    queueSync: project => queued.push(project) };
  const adapter = runInNewContext(labelCode + renderPrefix + '\n}\nconst onSaved = ({' + onSavedCode + '}).onSaved;\n({saveLabel,renderReview,onSaved});', env);
  return { ...adapter, env, queued, label: () => node('save-label').textContent };
}
test('only the native-confirmed true flag adds information while existing saved, dirty and blocked labels stay truthful', () => {
  const session = new ReviewSession(snapshot('old'), 'project', async () => { throw Error('No request from a label'); }), view = ui(session);
  for (const value of [undefined, false, null, 'true', 1]) { session.snapshot = snapshot('old', value); assert.equal(view.saveLabel(session), 'Saved locally'); }
  session.snapshot = snapshot('old', true); assert.equal(view.saveLabel(session), 'Saved locally · saved History needs attention');
  session.edit('draft'); assert.equal(view.saveLabel(session), 'Unsaved changes · saved History needs attention');
  session.reviewProblem = { code: 'policy_missing' }; assert.equal(view.saveLabel(session), 'Unsaved changes · review blocked · saved History needs attention');
  session.identityProblem = { code: 'stale_root' }; assert.equal(view.saveLabel(session), 'Source identity needs resolution · saved History needs attention');
});
test('proved Save with maintenance pending stays saved and a subsequent clean Save does not replay it', async () => {
  const calls = [], session = new ReviewSession(snapshot('old'), 'project', async operation => { calls.push(operation); return snapshot(operation.content, true); }), view = ui(session);
  session.edit('saved bytes'); await session.flush(); view.renderReview();
  assert.equal(session.content, 'saved bytes'); assert.equal(session.dirty, false); assert.equal(session.reviewProblem, null); assert.equal(session.uncertainMutation, undefined);
  assert.equal(view.label(), 'Saved locally · saved History needs attention');
  const saved = session.snapshot; await session.flush(); view.renderReview(); assert.equal(session.snapshot, saved);
  assert.deepEqual(calls.map(call => call.action), ['save']);
});
test('newer typing during a proved flagged Save remains dirty and is never labelled Saved by the notice', async () => {
  const gate = deferred(), calls = [];
  const session = new ReviewSession(snapshot('old'), 'project', async operation => { calls.push(operation); await gate.promise; return snapshot(operation.content, true); }), view = ui(session);
  session.edit('captured'); const saving = session.flush(); await turn(); session.edit('newer typing'); gate.resolve(); await saving; view.renderReview();
  assert.equal(session.snapshot.content, 'captured'); assert.equal(session.content, 'newer typing'); assert.equal(session.dirty, true);
  assert.equal(view.label(), 'Unsaved changes · saved History needs attention'); assert.equal(calls.length, 1); assert.equal(calls[0].content, 'captured');
});
test('local acceptance adopts the informational snapshot through the existing mutation path without an extra Save or History query', async () => {
  const calls = [], session = new ReviewSession(snapshot('old'), 'project', async operation => { calls.push(operation); return snapshot('accepted', true); }), view = ui(session);
  await session.mutate('decide', { id: 'suggestion', decision: 'accepted' }); view.renderReview();
  assert.equal(session.content, 'accepted'); assert.equal(session.dirty, false); assert.equal(session.conflict, null); assert.equal(session.reviewProblem, null);
  assert.equal(view.label(), 'Saved locally · saved History needs attention'); await session.flush();
  assert.deepEqual(calls.map(call => call.action), ['decide']);
});
test('registered editor commit delivers a proved maintenance notice once; an inactive completion cannot stamp another tab', async t => {
  const calls = [], session = new ReviewSession(snapshot('old'), 'project', async () => { throw Error('No ordinary source action'); }), view = ui(session), errors = [];
  const bridge = new EditorSessionBridge({ digest: async content => content,
    state: input => ({ current: input === session, composing: false, closing: false }), onSaved: view.onSaved, onError: error => errors.push(error),
    request: async operation => {
      calls.push(operation);
      if (['editor_register','editor_update'].includes(operation.action)) return { protocolVersion: 1, sessionId: 'registered', sourceEpoch: 7, expectedRoot: root };
      if (operation.action === 'editor_commit') return { snapshot: snapshot(operation.content, true), receipt: { status: 'committed', sourceEpoch: 7, expectedRoot: root, savedGeneration: operation.generation, savedRevision: operation.content } };
      return {};
    } });
  t.after(() => bridge.stop()); bridge.watch(session); await bridge.publishChanges(); session.edit('CLI saved');
  await bridge.save(bridge.entries.get(session), { requestId: 'request', ticket: 'ticket', sessionId: 'registered' });
  assert.equal(session.dirty, false); assert.equal(view.label(), 'Saved locally · saved History needs attention'); assert.deepEqual(errors, []);
  assert.equal(calls.filter(call => call.action === 'editor_commit').length, 1); assert.equal(calls.find(call => call.action === 'editor_complete').status, 'saved');
  const other = new ReviewSession(snapshot('other'), 'other-project', async () => {}); view.env.active = other; view.renderReview();
  assert.equal(view.label(), 'Saved locally'); view.onSaved(session); assert.equal(view.label(), 'Saved locally');
  view.env.active = session; view.renderReview(); assert.equal(view.label(), 'Saved locally · saved History needs attention');
});
test('only an adopted authoritative later snapshot clears the notice; late Review cannot clear it across newer typing', async () => {
  const gate = deferred(), calls = []; let held = true;
  const session = new ReviewSession(snapshot('saved', true), 'project', async operation => { calls.push(operation); if (held) await gate.promise; return snapshot('saved'); }), view = ui(session);
  const refreshing = session.refresh(); await turn(); session.edit('draft'); gate.resolve(); assert.equal(await refreshing, false); view.renderReview();
  assert.equal(session.snapshot.historyMaintenancePending, true); assert.equal(view.label(), 'Unsaved changes · saved History needs attention');
  // An independent clean session receives a real-shaped unflagged observation; no optimistic acknowledgement clears the first one.
  const clean = new ReviewSession(snapshot('saved', true), 'project', session.request); held = false; view.env.active = clean;
  await clean.refresh(); view.renderReview(); assert.equal(view.label(), 'Saved locally'); assert.equal(clean.dirty, false);
  assert.deepEqual(calls.map(call => call.action), ['review','review']); assert.equal(session.content, 'draft');
});
