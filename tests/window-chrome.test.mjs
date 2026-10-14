import assert from 'node:assert/strict';
import test from 'node:test';
import { createWindowCloseGuard } from '../modules/frontend/window-chrome.js';
import { ReviewSession } from '../modules/frontend/review-session.js';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function fixture({ beforeClose, canClose, unlisten = async () => {} }) {
  const calls = [];
  const errors = [];
  let nativeCloseRequest;
  const window = {
    onCloseRequested: async callback => {
      calls.push('listen');
      nativeCloseRequest = callback;
      return async () => { calls.push('unlisten-start'); await unlisten(); calls.push('unlisten-done'); };
    },
    close: async () => { calls.push('close'); },
  };
  const guard = createWindowCloseGuard(window, {
    beforeClose, canClose,
    onError: error => { errors.push(error.message); },
    onClosing: busy => { calls.push(busy ? 'busy' : 'ready'); },
  });
  return { calls, errors, guard, requestNativeClose: event => nativeCloseRequest(event) };
}

test('close waits for a pending local save before closing', async () => {
  const write = deferred();
  const snapshot = { path: 'main.typ', content: 'Original', review: { revision: 'old' } };
  const session = new ReviewSession(snapshot, 'project', async operation => {
    await write.promise;
    return { ...snapshot, content: operation.content, review: { revision: 'new' } };
  });
  session.edit('Latest manuscript');
  const pendingSave = session.flush();
  const f = fixture({ beforeClose: () => session.flush(), canClose: () => !session.dirty && !session.conflict });
  await f.guard.listen();
  const closing = f.guard.close();
  await Promise.resolve();
  assert.equal(f.calls.includes('close'), false);
  write.resolve();
  await pendingSave;
  await closing;
  assert.equal(session.snapshot.content, 'Latest manuscript');
  assert.equal(f.calls.includes('close'), true);
  assert.deepEqual(f.errors, []);
});

test('conflicts and failed saves keep the native close guard active', async () => {
  for (const message of ['External file conflict', 'Disk write failed']) {
    const f = fixture({ beforeClose: async () => { throw new Error(message); }, canClose: () => false });
    await f.guard.listen();
    let prevented = false;
    await f.requestNativeClose({ preventDefault: () => { prevented = true; } });
    assert.equal(prevented, true);
    assert.equal(f.calls.includes('close'), false);
    assert.equal(f.calls.includes('unlisten-start'), false);
    assert.deepEqual(f.errors, [message]);
    assert.equal(f.calls.at(-1), 'ready');
  }
});

test('close awaits listener removal, rechecks newer edits, and restores protection', async () => {
  const removal = deferred();
  let clean = true;
  const f = fixture({ beforeClose: async () => {}, canClose: () => clean, unlisten: () => removal.promise });
  await f.guard.listen();
  const closing = f.guard.close();
  await Promise.resolve();
  assert.equal(f.calls.includes('unlisten-start'), true);
  assert.equal(f.calls.includes('close'), false);
  clean = false;
  removal.resolve();
  await closing;
  assert.equal(f.calls.includes('close'), false);
  assert.equal(f.calls.filter(call => call === 'listen').length, 2);
  assert.match(f.errors[0], /changed while closing/);
});

test('native close requests use the same guard and concurrent requests do not duplicate saves', async () => {
  const saving = deferred();
  let saves = 0;
  const f = fixture({ beforeClose: async () => { saves++; await saving.promise; }, canClose: () => true });
  await f.guard.listen();
  let prevented = 0;
  const closing = f.requestNativeClose({ preventDefault: () => { prevented++; } });
  await f.requestNativeClose({ preventDefault: () => { prevented++; } });
  assert.equal(prevented, 2);
  assert.equal(saves, 1);
  saving.resolve();
  await closing;
  assert.deepEqual(f.calls.slice(-3), ['unlisten-done', 'close', 'ready']);
  assert.deepEqual(f.errors, []);
});
