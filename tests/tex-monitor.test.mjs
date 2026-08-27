import assert from "node:assert/strict";
import test from "node:test";
import { EXTERNAL_TEX_SCAN_MS, LIVE_COMPILE_DELAY_MS, externalTexChanged } from "../src/tex-monitor.js";

test("live compilation is debounced and external TeX files are scanned every minute", () => {
  assert.equal(LIVE_COMPILE_DELAY_MS, 450);
  assert.equal(EXTERNAL_TEX_SCAN_MS, 60_000);
});

test("external changes rebuild clean tabs without overwriting unsaved editor content", () => {
  assert.equal(externalTexChanged({ mtimeMs: 100, dirty: false }, { mtimeMs: 200 }), true);
  assert.equal(externalTexChanged({ mtimeMs: 100, dirty: false }, { mtimeMs: 100.5 }), false);
  assert.equal(externalTexChanged({ mtimeMs: 100, dirty: true }, { mtimeMs: 200 }), false);
});
