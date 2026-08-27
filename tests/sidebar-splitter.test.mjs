import assert from "node:assert/strict";
import test from "node:test";
import { clampTreeHeight } from "../modules/frontend/sidebar-splitter.js";

test("sidebar splitter keeps both panes above their minimum heights", () => {
  assert.equal(clampTreeHeight(320, 600), 320);
  assert.equal(clampTreeHeight(40, 600), 150);
  assert.equal(clampTreeHeight(590, 600), 470);
});

test("sidebar splitter supports custom pane constraints", () => {
  assert.equal(clampTreeHeight(500, 520, 100, 80), 440);
});
