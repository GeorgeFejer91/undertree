import assert from "node:assert/strict";
import test from "node:test";
import {
  PDF_PREVIEW_CACHE_LIMIT,
  pdfPreviewCacheKey,
  pdfPreviewEvictionKeys,
  touchPdfPreviewCache,
} from "../src/pdf-preview-cache.js";

test("PDF preview cache keys isolate every project and TeX source", () => {
  assert.equal(pdfPreviewCacheKey("project-a", "main.tex"), "project-a:main.tex");
  assert.notEqual(pdfPreviewCacheKey("project-a", "main.tex"), pdfPreviewCacheKey("project-a", "appendix.tex"));
  assert.notEqual(pdfPreviewCacheKey("project-a", "main.tex"), pdfPreviewCacheKey("project-b", "main.tex"));
});

test("touching a preview promotes it and eviction preserves the active source", () => {
  const cache = new Map();
  for (let index = 0; index < PDF_PREVIEW_CACHE_LIMIT; index += 1) cache.set(`source-${index}`, { index });
  touchPdfPreviewCache(cache, "source-0", cache.get("source-0"));
  cache.set("source-new", { index: 99 });
  assert.deepEqual(pdfPreviewEvictionKeys(cache, "source-1"), ["source-2"]);
});
