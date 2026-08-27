import assert from "node:assert/strict";
import test from "node:test";
import { LatestCompileScheduler } from "../modules/frontend/latest-compile-scheduler.js";

const nextTurn = () => new Promise((resolve) => setTimeout(resolve, 5));

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
