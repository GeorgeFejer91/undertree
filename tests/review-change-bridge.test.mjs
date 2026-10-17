import test from 'node:test';
import assert from 'node:assert/strict';
import { ReviewChangeBridge } from '../modules/frontend/review-change-bridge.js';
function gate() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
test('review invalidations resume from the last sequence and never act on a stopped waiter', async () => {
  const waiting = gate(), received = gate(); const requests = []; let changes = 0;
  const bridge = new ReviewChangeBridge({ request: async request => {
    requests.push(request);
    if (requests.length === 1) return { instanceId: 'native', sequence: '1', changed: true };
    received.resolve(); return waiting.promise;
  }, onChange: () => { changes++; } });
  bridge.start(); bridge.start(); await received.promise;
  assert.equal(changes, 1); assert.equal(requests.length, 2);
  assert.deepEqual(requests.map(r => r.after), [null, '1']);
  bridge.stop(); waiting.resolve({ instanceId: 'native', sequence: '2', changed: true });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(changes, 1); assert.equal(requests.length, 2);
});
test('timeout notifications do not create duplicate arrivals and malformed notifications never refresh', async () => {
  let count = 0, changes = 0; const done = gate();
  const bridge = new ReviewChangeBridge({ retryMs: 1, request: async () => {
    count++;
    if (count === 1) return { instanceId: 'native', sequence: '1', changed: true };
    if (count === 2) return { instanceId: 'native', sequence: '1', changed: false };
    if (count === 3) return { instanceId: 'native', sequence: {}, changed: true };
    bridge.stop(); done.resolve(); return { instanceId: 'native', sequence: '2', changed: true };
  }, onChange: () => { changes++; } });
  bridge.start(); await done.promise; assert.equal(changes, 1); assert.equal(count, 4);
});
