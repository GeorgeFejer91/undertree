import test from 'node:test';
import assert from 'node:assert/strict';
import { EditorSessionBridge } from '../modules/frontend/editor-session-bridge.js';
import { ReviewSession } from '../modules/frontend/review-session.js';

const snapshot = content => ({ path: 'main.html', content, review: { revision: content } });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const turn = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
  const operations = [], actions = [], errors = [];
  const session = new ReviewSession(snapshot('original'), 'project', async operation => snapshot(operation.content));
  let composing = false, current = true, serial = 0, saved = 0;
  const fixture = { session, operations, actions, errors, get saved() { return saved; }, compose(value) { composing = value; fixture.bridge.changed(session); }, retire() { current = false; } };
  fixture.request = async operation => {
    operations.push(operation);
    if (operation.action === 'editor_register') return { protocolVersion: 1, sessionId: `session-${++serial}` };
    if (operation.action === 'editor_update') return { protocolVersion: 1, sessionId: operation.sessionId };
    if (operation.action === 'editor_poll') return { protocolVersion: 1, requests: [...actions] };
    if (operation.action === 'editor_commit') return { snapshot: snapshot(operation.content), receipt: { status: 'committed', savedGeneration: operation.generation, savedRevision: operation.content } };
    return {};
  };
  fixture.bridge = new EditorSessionBridge({ request: operation => fixture.request(operation), state: () => ({ current, composing, closing: false }), digest: async content => `digest:${content}`, onSaved: () => { saved += 1; }, onError: error => errors.push(error) });
  fixture.bridge.watch(session);
  fixture.action = () => actions.push({ requestId: `request-${actions.length}`, ticket: 'ticket', sessionId: fixture.bridge.entries.get(session).id, project: session.project, path: session.path });
  return fixture;
}
test('the bridge registers exact state and dispatches each polled save once through its session', async t => {
  const f = fixture(); t.after(() => f.bridge.stop());
  await f.bridge.poll();
  assert.equal(f.operations[0].contentDigest, 'digest:original'); assert.equal(f.operations[0].generation, 0);
  f.session.edit('user text'); await f.bridge.publishChanges(); f.action();
  await f.bridge.poll(); await turn(); await f.bridge.poll(); await turn();
  const commits = f.operations.filter(operation => operation.action === 'editor_commit');
  assert.equal(commits.length, 1); assert.equal(commits[0].content, 'user text'); assert.equal(f.saved, 1);
  assert.equal(f.session.dirty, false); assert.equal(f.operations.find(operation => operation.action === 'editor_complete').status, 'saved');
  assert.deepEqual(f.errors, []);
});
test('composition publishes busy state and never commits; later requests can save normally', async t => {
  const f = fixture(); t.after(() => f.bridge.stop());
  await f.bridge.poll(); f.compose(true); f.action(); await f.bridge.poll(); await turn();
  assert.equal(f.operations.some(operation => operation.action === 'editor_update' && operation.composing), true);
  assert.equal(f.operations.some(operation => operation.action === 'editor_commit'), false);
  assert.equal(f.operations.find(operation => operation.action === 'editor_complete').status, 'busy');
  f.compose(false); f.session.edit('composed'); f.action(); await f.bridge.poll(); await turn();
  assert.equal(f.session.snapshot.content, 'composed'); assert.equal(f.session.dirty, false);
});
test('typing while hashing the capture rejects it before native commit', async t => {
  const f = fixture(); t.after(() => f.bridge.stop());
  await f.bridge.poll(); f.session.edit('first'); await f.bridge.publishChanges(); f.action();
  f.bridge.entries.get(f.session).digest = null;
  const gate = deferred(); f.bridge.digest = async content => { await gate.promise; return `digest:${content}`; };
  await f.bridge.poll(); await turn(); f.session.edit('new typing'); gate.resolve(); await turn();
  assert.equal(f.operations.some(operation => operation.action === 'editor_commit'), false);
  assert.equal(f.session.content, 'new typing'); assert.equal(f.session.dirty, true);
  assert.equal(f.operations.find(operation => operation.action === 'editor_complete').status, 'stale_buffer');
});
test('a lost commit response stays uncertain and is never retried by subsequent polls', async t => {
  const f = fixture(); t.after(() => f.bridge.stop());
  const request = f.request; f.request = async operation => { if (operation.action === 'editor_commit') { f.operations.push(operation); throw new TypeError('connection lost'); } return request(operation); };
  await f.bridge.poll(); f.session.edit('buffer'); f.action(); await f.bridge.poll(); await turn(); await f.bridge.poll(); await turn();
  assert.equal(f.operations.filter(operation => operation.action === 'editor_commit').length, 1);
  assert.equal(f.operations.some(operation => operation.action === 'editor_complete'), false);
  assert.equal(f.session.content, 'buffer'); assert.equal(f.session.dirty, true);
});
test('a newer buffer during commit is published and completed as divergent without overwriting it', async t => {
  const f = fixture(); t.after(() => f.bridge.stop());
  const gate = deferred(), request = f.request;
  f.request = async operation => { if (operation.action === 'editor_commit') await gate.promise; return request(operation); };
  await f.bridge.poll(); f.session.edit('captured'); f.action(); await f.bridge.poll(); await turn();
  f.session.edit('newer'); gate.resolve(); await turn(); await turn();
  assert.equal(f.session.content, 'newer'); assert.equal(f.session.snapshot.content, 'captured'); assert.equal(f.session.dirty, true);
  const completion = f.operations.find(operation => operation.action === 'editor_complete');
  assert.equal(completion.status, 'newer_buffer'); assert.equal(completion.generation, 2);
  assert.equal(f.operations.filter(operation => operation.action === 'editor_commit').length, 1);
});
test('composition without an input event is observed on the next poll without hashing unchanged source again', async t => {
  const f = fixture(); t.after(() => f.bridge.stop()); let composing = false, hashes = 0;
  f.bridge.state = () => ({ current: true, composing, closing: false });
  f.bridge.digest = async content => { hashes += 1; return `digest:${content}`; };
  await f.bridge.poll(); composing = true; await f.bridge.poll();
  assert.equal(f.operations.filter(operation => operation.action === 'editor_update').at(-1).composing, true);
  assert.equal(hashes, 1);
});
test('retiring a session unregisters it and reopening rotates its identity', async t => {
  const f = fixture(); t.after(() => f.bridge.stop());
  await f.bridge.poll(); const first = f.bridge.entries.get(f.session).id; f.action();
  await f.bridge.unwatch(f.session); f.retire(); await f.bridge.poll();
  assert.equal(f.operations.find(operation => operation.action === 'editor_unregister').sessionId, first);
  assert.equal(f.operations.some(operation => operation.action === 'editor_commit'), false);
  assert.equal(f.session.onChange, null);
  const reopened = new ReviewSession(snapshot('original'), 'project', async operation => snapshot(operation.content));
  f.bridge.state = session => ({ current: session === reopened, composing: false, closing: false });
  f.bridge.watch(reopened); await f.bridge.poll(); await turn();
  assert.notEqual(f.bridge.entries.get(reopened).id, first);
  assert.equal(f.operations.some(operation => operation.action === 'editor_commit'), false, 'the old polled ticket never targets a reopened tab');
});
test('slow metadata publication stays bounded and the next poll publishes the newest generation', async t => {
  const f = fixture(); t.after(() => f.bridge.stop()); await f.bridge.poll();
  const gate = deferred(), request = f.request; let inFlight = 0, maximum = 0;
  f.request = async operation => {
    if (operation.action !== 'editor_update') return request(operation);
    inFlight += 1; maximum = Math.max(maximum, inFlight); await gate.promise; inFlight -= 1; return request(operation);
  };
  f.session.edit('first'); const publications = [f.bridge.publishChanges()]; await turn();
  for (let index = 0; index < 20; index += 1) { f.session.edit(`buffer ${index}`); publications.push(f.bridge.publishChanges()); }
  gate.resolve(); await Promise.all(publications); await f.bridge.poll();
  const updates = f.operations.filter(operation => operation.action === 'editor_update');
  assert.equal(maximum, 1); assert.equal(updates.length, 2); assert.equal(updates.at(-1).generation, 21);
  assert.equal(updates.at(-1).contentDigest, 'digest:buffer 19');
});
