import assert from "node:assert/strict";
import test from "node:test";
import { LatestCompileScheduler } from "../modules/frontend/latest-compile-scheduler.js";

const nextTurn = () => new Promise((resolve) => setTimeout(resolve, 5));

test("default timers preserve the Window receiver required by WebKit", async () => {
  const originals = { set: globalThis.setTimeout, clear: globalThis.clearTimeout };
  const scheduled = [];
  const cleared = [];
  const compiled = [];
  try {
    globalThis.setTimeout = function (callback, delay) {
      assert.equal(this, globalThis);
      scheduled.push({ callback, delay });
      return scheduled.length;
    };
    globalThis.clearTimeout = function (handle) {
      assert.equal(this, globalThis);
      cleared.push(handle);
    };
    const scheduler = new LatestCompileScheduler({ delayMs: 10, isBusy: () => false, run: async key => compiled.push(key) });
    scheduler.request("old");
    scheduler.request("canceled");
    scheduler.cancel();
    scheduler.request("current");
    scheduled.at(-1).callback();
  } finally {
    globalThis.setTimeout = originals.set;
    globalThis.clearTimeout = originals.clear;
  }
  await Promise.resolve();
  assert.deepEqual(cleared, [1, 2]);
  assert.deepEqual(compiled, ["current"]);
});

test("live compilation coalesces an edit burst to the newest project/source key", async () => {
  const compiled = [];
  const scheduler = new LatestCompileScheduler({
    delayMs: 1,
    isBusy: () => false,
    run: async (key) => compiled.push(key),
  });
  scheduler.request("project:chapter-1.tex");
  scheduler.request("project:chapter-2.tex");
  scheduler.request("project:paper.tex");
  await nextTurn();
  assert.deepEqual(compiled, ["project:paper.tex"]);
});

test("an edit received during a slow build is retained and released once", async () => {
  let busy = true;
  const compiled = [];
  const scheduler = new LatestCompileScheduler({
    delayMs: 1,
    isBusy: () => busy,
    run: async (key) => compiled.push(key),
  });
  scheduler.request("project:paper.tex@1");
  await nextTurn();
  assert.equal(scheduler.pending, true);
  assert.deepEqual(compiled, []);

  scheduler.request("project:paper.tex@2");
  busy = false;
  scheduler.release();
  await nextTurn();
  assert.deepEqual(compiled, ["project:paper.tex@2"]);
  assert.equal(scheduler.pending, false);
});

test("cancelling a project switch drops scheduled automatic work", async () => {
  const compiled = [];
  const scheduler = new LatestCompileScheduler({
    delayMs: 1,
    isBusy: () => false,
    run: async (key) => compiled.push(key),
  });
  scheduler.request("old-project:paper.tex");
  scheduler.cancel();
  await nextTurn();
  assert.deepEqual(compiled, []);
});
