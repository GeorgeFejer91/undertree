import assert from "node:assert/strict";
import test from "node:test";

import { gridTrackRange, parsePixelTracks, resizeTrackBoundary, tracksToMillimetres } from "../src/html-visual-layout.js";

test("visual grid resizing resolves spans and preserves the shared total", () => {
  const tracks = parsePixelTracks("100px 100px 100px 100px");
  assert.deepEqual(gridTrackRange("1", "span 2", tracks.length), { start: 0, end: 2 });
  assert.deepEqual(gridTrackRange("2", "auto", tracks.length), { start: 1, end: 2 });
  const resized = resizeTrackBoundary(tracks, 2, 15);
  assert.deepEqual(resized, [100, 115, 85, 100]);
  assert.equal(resized.reduce((sum, value) => sum + value, 0), tracks.reduce((sum, value) => sum + value, 0));
  assert.equal(resizeTrackBoundary(tracks, 2, 90), null);
  assert.match(tracksToMillimetres(resized), /^26\.46mm 30\.43mm 22\.49mm 26\.46mm$/);
});

test("visual grid resizing rejects unresolved or non-pixel tracks", () => {
  assert.deepEqual(parsePixelTracks("1fr 1fr"), []);
  assert.equal(gridTrackRange("auto", "auto", 3), null);
  assert.equal(gridTrackRange("2", "4", 3)?.end, 3);
});
