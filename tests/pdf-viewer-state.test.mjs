import assert from "node:assert/strict";
import test from "node:test";
import { clampPdfPage, nextPdfScale, PDF_MAX_SCALE, PDF_MIN_SCALE } from "../src/pdf-viewer-state.js";

test("PDF page navigation clamps at the document boundaries", () => {
  assert.equal(clampPdfPage(1, 1, 3), 2);
  assert.equal(clampPdfPage(3, 1, 3), 3);
  assert.equal(clampPdfPage(1, -1, 3), 1);
  assert.equal(clampPdfPage(2, -1, 3), 1);
});

test("rapid zoom steps accumulate from the explicit requested scale", () => {
  const first = nextPdfScale(null, 1, 1.22);
  const second = nextPdfScale(first, 1, 1.22);
  assert.ok(Math.abs(second - 1.22 ** 2) < 1e-9);
  assert.equal(nextPdfScale(PDF_MAX_SCALE, 1, 1.22), PDF_MAX_SCALE);
  assert.equal(nextPdfScale(PDF_MIN_SCALE, 1, 0.82), PDF_MIN_SCALE);
});
