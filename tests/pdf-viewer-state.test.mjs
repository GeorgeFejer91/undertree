import assert from "node:assert/strict";
import test from "node:test";
import {
  boundedPdfOutputScale,
  clampPdfPage,
  destroyPdfResource,
  nextPdfScale,
  PDF_MAX_RENDER_PIXELS,
  PDF_MAX_SCALE,
  PDF_MIN_SCALE,
} from "../src/pdf-viewer-state.js";

test("PDF page navigation clamps at the document boundaries", () => {
  assert.equal(clampPdfPage(1, 1, 3), 2);
  assert.equal(clampPdfPage(3, 1, 3), 3);
  assert.equal(clampPdfPage(1, -1, 3), 1);
  assert.equal(clampPdfPage(2, -1, 3), 1);
});

test("PDF page navigation truncates numeric inputs and rejects nonfinite state", () => {
  for (const [page, delta, total, expected] of [
    [2.9, 0, 10, 2],
    ["2.5", 0, "10", 2],
    [4, 1.9, 10, 5],
    [4, -1.9, 10, 3],
    [99, 0, 10.9, 10],
    [-2.5, 0, 10, 1],
    ["", 0, 10, 1],
    ["invalid", 0, 10, 1],
    [NaN, 0, 10, 1],
    [Infinity, 0, 10, 1],
    [-Infinity, 0, 10, 1],
    [4, Infinity, 10, 4],
    [4, -Infinity, 10, 4],
    [4, "invalid", 10, 4],
    [4, 0, Infinity, 1],
    [4, 0, NaN, 1],
    [4, 0, 0.5, 1],
  ]) {
    const result = clampPdfPage(page, delta, total);
    assert.equal(result, expected, `page ${page}, delta ${delta}, total ${total}`);
    assert.ok(Number.isInteger(result) && Number.isFinite(result) && result >= 1);
  }
});

test("rapid zoom steps accumulate from the explicit requested scale", () => {
  const first = nextPdfScale(null, 1, 1.22);
  const second = nextPdfScale(first, 1, 1.22);
  assert.ok(Math.abs(second - 1.22 ** 2) < 1e-9);
  assert.equal(nextPdfScale(PDF_MAX_SCALE, 1, 1.22), PDF_MAX_SCALE);
  assert.equal(nextPdfScale(PDF_MIN_SCALE, 1, 0.82), PDF_MIN_SCALE);
});

test("PDF backing canvases respect the render-pixel budget at high zoom", () => {
  assert.equal(boundedPdfOutputScale(600, 850, 2), 2);
  const scale = boundedPdfOutputScale(2400, 3400, 2);
  assert.ok(scale < 2);
  assert.ok(2400 * scale * 3400 * scale <= PDF_MAX_RENDER_PIXELS + 1);
});

test("PDF cleanup uses the PDF.js loading task instead of assuming the document proxy is destroyable", async () => {
  let loadingTaskDestroyed = 0;
  let documentDestroyed = 0;
  const loadingTask = { destroy: async () => { loadingTaskDestroyed += 1; } };
  const document = { destroy: async () => { documentDestroyed += 1; } };

  assert.equal(await destroyPdfResource(loadingTask, document), true);
  assert.equal(loadingTaskDestroyed, 1);
  assert.equal(documentDestroyed, 0);
});

test("PDF cleanup tolerates PDF.js document proxies without a destroy method", async () => {
  assert.equal(await destroyPdfResource(null, { numPages: 1 }), false);
});
