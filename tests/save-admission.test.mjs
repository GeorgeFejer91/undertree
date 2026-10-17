import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import * as review from '../modules/frontend/review-session.js';

const source = await readFile(new URL('../src/manuscript.js', import.meta.url), 'utf8');
const start = source.indexOf('async function saveSession(');
const end = source.indexOf('function decorations(', start);
assert.ok(start >= 0 && end > start);
const code = source.slice(start, end) + '\nsaveSession;';
const busy = () => ({ code: 'busy', message: 'A local document operation is running. Retry this action.' });

function fixture({ failures = 1, error = busy, afterWait = () => {} } = {}) {
  const calls = [], delays = [], synced = [], timers = new Map();
  const snapshot = { documentId: 'document', path: 'main.tex', content: 'Saved', sourceEpoch: 3, expectedRoot: { dev: '1', ino: '2' }, sidecarRevision: 'a'.repeat(64), review: { revision: 'saved', rules: [], markers: [], suggestions: [] } };
  const session = new review.ReviewSession(snapshot, 'project', async operation => {
    calls.push(operation);
    if (operation.action === 'review') return structuredClone(snapshot);
    if (calls.filter(call => call.action === 'save').length <= failures) throw error();
    return { ...snapshot, content: operation.content, review: { revision: 'new' } };
  });
  session.edit('New draft');
  const environment = { ...review, sessions: new Map([['project:main.tex', session]]), active: session,
    navigationIntent: 0, windowClosing: false, saveTimers: timers,
    keyFor: (project, path) => `${project}:${path}`, clearTimeout() {},
    setTimeout(callback, delay) { delays.push(delay); Promise.resolve(afterWait(environment, session)).then(callback); },
    renderReview() {}, renderTabs() {}, saveLabel: () => 'Saved', $: () => ({}),
    queueSync: project => synced.push(project),
  };
  const save = runInNewContext(code, environment);
  return { save, session, environment, calls, delays, synced };
}

test('actual Save completes after native pre-dispatch contention with identical captured input', async () => {
  const f = fixture({ failures: 2 });
  await f.save(f.session);
  assert.equal(f.calls.length, 3); assert.deepEqual(f.delays, [50, 100]);
  for (const operation of f.calls) {
    assert.equal(operation.action, 'save'); assert.equal(operation.content, 'New draft');
    assert.equal(operation.revision, 'saved'); assert.equal(operation.sourceEpoch, 3);
    assert.deepEqual(operation.expectedRoot, { dev: '1', ino: '2' });
  }
  assert.equal(f.session.dirty, false); assert.equal(f.session.content, 'New draft');
  assert.deepEqual(f.synced, ['project']);
});

test('Save contention retries are bounded and leave unsaved content intact', async () => {
  const f = fixture({ failures: Infinity });
  await assert.rejects(f.save(f.session), error => error.code === 'busy');
  assert.equal(f.calls.length, 6); assert.deepEqual(f.delays, [50, 100, 200, 400, 800]);
  assert.equal(f.session.dirty, true); assert.equal(f.session.content, 'New draft');
  assert.deepEqual(f.synced, []);
});

test('an actual metadata-only refresh with identical source and policy does not strand Save', async () => {
  let replaced = false;
  const f = fixture({ afterWait: async (_, session) => {
    const before = session.snapshot;
    await session.refresh({ metadataOnly: true });
    replaced = session.snapshot !== before;
    assert.deepEqual(session.snapshot, before);
  } });
  await f.save(f.session);
  assert.equal(replaced, true);
  assert.deepEqual(f.calls.map(operation => operation.action), ['save', 'review', 'save']);
  assert.deepEqual(f.delays, [50]); assert.equal(f.session.dirty, false);
  assert.equal(f.session.content, 'New draft');
});

for (const error of [
  { code: 'busy', message: 'Another source operation is running.' },
  { code: 'busy', message: 'A pending save appeared during compilation. The last good PDF was preserved.' },
  { code: 'outcome_unknown', message: busy().message },
  { code: 'io', message: busy().message },
]) test(`Save never retries ${error.code}: ${error.message}`, async () => {
  const f = fixture({ error: () => error });
  await assert.rejects(f.save(f.session), observed => observed === error);
  assert.equal(f.calls.length, 1); assert.deepEqual(f.delays, []);
  assert.equal(f.session.dirty, true);
});

for (const [name, change] of [
  ['new edit', (_, session) => session.edit('Latest typed draft')],
  ['new saved revision', (_, session) => { session.snapshot = { ...session.snapshot, review: { ...session.snapshot.review, revision: 'external' } }; }],
  ['new saved content', (_, session) => { session.snapshot = { ...session.snapshot, content: 'External' }; }],
  ['new document id', (_, session) => { session.snapshot = { ...session.snapshot, documentId: 'replacement' }; }],
  ['new sidecar receipt', (_, session) => { session.snapshot = { ...session.snapshot, sidecarRevision: 'b'.repeat(64) }; }],
  ['new policy', (_, session) => { session.snapshot = { ...session.snapshot, review: { ...session.snapshot.review, rules: [{ id: 'new-policy' }] } }; }],
  ['retired epoch', (_, session) => { session.sourceEpoch += 1; }],
  ['changed root', (_, session) => { session.expectedRoot = { dev: '1', ino: '9' }; }],
  ['closed session', environment => environment.sessions.clear()],
  ['replaced session', environment => environment.sessions.set('project:main.tex', {})],
  ['navigation', environment => { environment.navigationIntent += 1; }],
  ['closing', environment => { environment.windowClosing = true; }],
  ['conflict', (_, session) => { session.conflict = {}; }],
  ['review problem', (_, session) => { session.reviewProblem = { code: 'policy_missing' }; }],
]) test(`Save retry stops after ${name} while keeping the draft`, async () => {
  const f = fixture({ afterWait: change });
  await assert.rejects(f.save(f.session), error => error.code === 'busy');
  assert.equal(f.calls.length, 1); assert.deepEqual(f.delays, [50]);
  assert.equal(f.session.dirty, true); assert.deepEqual(f.synced, []);
});
