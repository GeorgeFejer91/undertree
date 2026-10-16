import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../src/manuscript.js', import.meta.url), 'utf8');
const start = source.indexOf('setInterval(async () => {\n  if (document.hidden || refreshing');
const end = source.indexOf('\n}, 2000);', start) + '\n}, 2000);'.length;
assert.ok(start >= 0 && end > start);
const taskStart = source.indexOf('function task(');
const taskEnd = source.indexOf('\nfunction closeDialogs(', taskStart);
assert.ok(taskStart >= 0 && taskEnd > taskStart);

function fixture() {
  let reject, refreshCount = 0;
  const pending = new Promise((resolve, no) => { reject = no; });
  const calls = [], session = { snapshot: { review: {} }, refresh: () => { refreshCount += 1; return pending; } };
  const context = {
    document: { hidden: false }, refreshing: false, active: session,
    saveTimers: new Map([[session, 'timer']]),
    clearTimeout: timer => calls.push(['clear', timer]),
    compileScheduler: { cancel: () => calls.push(['cancel']) },
    renderReview: () => calls.push(['render']),
    pdfStatus: text => calls.push(['pdf-status', text]),
    status: (text, error) => calls.push(['status', text, error]),
    setInterval(callback, milliseconds) { assert.equal(milliseconds, 2000); return callback; },
  };
  const poll = runInNewContext(source.slice(start, end), context);
  return { context, session, calls, poll, reject, refreshCount: () => refreshCount };
}

test('automatic Review contention preserves the existing compile receipt without retrying', async () => {
  const f = fixture(), pending = f.poll();
  assert.equal(f.context.refreshing, true);
  f.reject({ code: 'busy', message: 'A local document operation is running. Retry this action.' });
  await pending;
  assert.deepEqual(f.calls, []);
  assert.equal(f.context.refreshing, false);
  assert.equal(f.refreshCount(), 1);
});

test('a concurrent identity latch still freezes the source when the background read is busy', async () => {
  const f = fixture(), pending = f.poll();
  f.session.identityProblem = { code: 'stale_root', message: 'The project folder changed.' };
  f.reject({ code: 'busy', message: 'A local document operation is running. Retry this action.' });
  await pending;
  assert.deepEqual(f.calls, [
    ['clear', 'timer'], ['cancel'], ['render'], ['pdf-status', 'Source identity changed · last good PDF retained'],
  ]);
  assert.equal(f.context.saveTimers.has(f.session), false);
});

test('a stale-root read still reports the identity error and freezes its source', async () => {
  const f = fixture(), pending = f.poll();
  const error = { code: 'stale_root', message: 'The project folder changed.' };
  f.session.identityProblem = error;
  f.reject(error); await pending;
  assert.deepEqual(f.calls, [
    ['clear', 'timer'], ['cancel'], ['render'], ['pdf-status', 'Source identity changed · last good PDF retained'],
    ['status', error.message, true],
  ]);
});

test('non-busy errors remain visible and a late old-session read cannot replace current status', async () => {
  const current = fixture(), pending = current.poll();
  current.reject({ code: 'io', message: 'Review data could not be read.' }); await pending;
  assert.deepEqual(current.calls, [['status', 'Review data could not be read.', true]]);
  const replaced = fixture(), held = replaced.poll();
  replaced.context.active = { snapshot: { review: {} } };
  replaced.reject({ code: 'io', message: 'Old response' }); await held;
  assert.deepEqual(replaced.calls, []);
});

test('explicit user actions still report busy instead of silently replaying them', async () => {
  const f = fixture();
  const task = runInNewContext(source.slice(taskStart, taskEnd) + '\ntask;', f.context);
  await task(async () => { throw { code: 'busy', message: 'Retry this explicit action.' }; })();
  assert.deepEqual(f.calls, [['status', 'Retry this explicit action.', true]]);
});
