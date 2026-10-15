import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { ReviewSession } from '../modules/frontend/review-session.js';

const source = await readFile(new URL('../src/manuscript.js', import.meta.url), 'utf8');
const handler = id => source.match(new RegExp(`\\$\\('${id}'\\)\\.onsubmit = task\\((async event => \\{[\\s\\S]*?\\n\\})\\);`))?.[1];
const snapshot = content => ({ path: 'main.typ', content, review: { revision: content, markers: [], rules: [], suggestions: [] } });
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function fixture({ hold = 'save' } = {}) {
  const gate = deferred(), seen = deferred(), operations = [], markers = [];
  let disk = 'Alpha target.\n', held = false;
  const session = new ReviewSession(snapshot(disk), 'project', async operation => {
    operations.push(operation);
    if (operation.action === 'save') disk = operation.content;
    if (operation.action === 'decide') disk = 'X' + disk;
    if (operation.action === hold && !held) { held = true; seen.resolve(); await gate.promise; }
    if (operation.action === 'mark' || operation.action === 'reanchor') markers.push(disk.slice(operation.from, operation.to));
    return snapshot(disk);
  });
  return { session, operations, markers, gate, seen, disk: () => disk };
}
function submitter(session, id = 'highlight-form') {
  const selected = Object.freeze({ session, version: session.version, from: 6, to: 12, quote: 'target', id: 'marker' });
  const controls = { 'highlight-dialog-rule': { value: 'protect' }, 'highlight-prompt': { value: '' }, 'highlight-dialog': { close() {} }, 'reanchor-dialog': { close() {} } };
  const context = { active: session, selection: selected, reanchorSelection: selected, $: id => controls[id], saveSession: value => value.flush(), renderReview() {}, decorations() {}, reviewPanel() {}, queueSync() {}, markSelectedReview() {}, scheduleReviewPositions() {}, status() {} };
  assert.ok(handler(id), 'The actual selection callback must be found.');
  const callback = runInNewContext(`(${handler(id)})`, context);
  return { context, submit: () => callback({ preventDefault() {} }) };
}

test('queued Protect refuses typing after submission before its queued save begins', async () => {
  const { session, operations, markers, gate, seen, disk } = fixture();
  session.edit(session.content + '\n');
  const saving = session.flush(); await seen.promise;
  const { submit } = submitter(session); const marking = submit();
  session.edit('X' + session.content); gate.resolve();
  await saving; await assert.rejects(marking, error => /selection changed/i.test(error.message));
  assert.deepEqual(operations.map(operation => operation.action), ['save']); assert.deepEqual(markers, []);
  assert.equal(disk(), 'Alpha target.\n\n'); assert.equal(session.content, 'XAlpha target.\n\n'); assert.equal(session.dirty, true);
});

test('Protect rechecks captured selection after its own awaited save', async () => {
  const { session, operations, markers, gate, seen } = fixture();
  session.edit(session.content + '\n');
  const { submit } = submitter(session); const marking = submit(); await seen.promise;
  session.edit('X' + session.content); gate.resolve();
  await assert.rejects(marking, error => /selection changed/i.test(error.message));
  assert.deepEqual(operations.map(operation => operation.action), ['save']); assert.deepEqual(markers, []);
  assert.equal(session.content, 'XAlpha target.\n\n'); assert.equal(session.dirty, true);
});

test('queued Protect with no interleaving saves and marks exactly the captured target', async () => {
  const { session, operations, markers, gate, seen } = fixture();
  session.edit(session.content + '\n');
  const saving = session.flush(); await seen.promise;
  const { submit } = submitter(session); const marking = submit(); gate.resolve();
  await saving; await marking;
  assert.deepEqual(operations.map(operation => operation.action), ['save', 'mark']); assert.deepEqual(markers, ['target']);
  assert.equal(session.dirty, false); assert.equal(session.content, 'Alpha target.\n\n');
});

test('queued Protect rejects an authoritative changed quote even at the same edit version', async () => {
  const { session, operations, markers, gate, seen } = fixture({ hold: 'decide' });
  const accepting = session.mutate('decide', { id: 'proposal', decision: 'accepted' }); await seen.promise;
  const { submit } = submitter(session); const marking = submit(); gate.resolve();
  await accepting; await assert.rejects(marking, error => /selection changed/i.test(error.message));
  assert.equal(session.version, 0); assert.equal(session.content, 'XAlpha target.\n');
  assert.deepEqual(operations.map(operation => operation.action), ['decide']); assert.deepEqual(markers, []);
});

test('queued Protect cannot apply after its captured editor is replaced', async () => {
  const { session, operations, markers, gate, seen } = fixture();
  session.edit(session.content + '\n'); const saving = session.flush(); await seen.promise;
  const { submit, context } = submitter(session); const marking = submit();
  context.active = new ReviewSession(snapshot(session.content), 'project', async () => { throw Error('No replacement request'); });
  gate.resolve(); await saving; await assert.rejects(marking, error => /selection changed/i.test(error.message));
  assert.deepEqual(operations.map(operation => operation.action), ['save']); assert.deepEqual(markers, []);
});

test('queued Reanchor refuses stale intent before saving newer typing or changing policy', async () => {
  const { session, operations, markers, gate, seen } = fixture();
  session.edit(session.content + '\n');
  const saving = session.flush(); await seen.promise;
  const { submit } = submitter(session, 'reanchor-form'); const reanchoring = submit();
  session.edit('X' + session.content); gate.resolve(); await saving;
  await assert.rejects(reanchoring, error => /selected passage changed/i.test(error.message));
  assert.deepEqual(operations.map(operation => operation.action), ['save']); assert.deepEqual(markers, []);
  assert.equal(session.content, 'XAlpha target.\n\n'); assert.equal(session.dirty, true);
});

test('unchanged queued Reanchor still saves and applies exactly its selected target', async () => {
  const { session, operations, markers, gate, seen } = fixture();
  session.edit(session.content + '\n'); const saving = session.flush(); await seen.promise;
  const { submit } = submitter(session, 'reanchor-form'); const reanchoring = submit(); gate.resolve();
  await saving; await reanchoring;
  assert.deepEqual(operations.map(operation => operation.action), ['save', 'reanchor']);
  assert.deepEqual(markers, ['target']); assert.equal(session.dirty, false);
});
