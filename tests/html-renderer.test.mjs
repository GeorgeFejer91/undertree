import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { renderHtmlPrint } from "../src/html-renderer.mjs";

const exec = promisify(execFile);

test("native WebKit waits for Pretext and produces the declared A4 page", { timeout: 90000 }, async (context) => {
  const temporary = await mkdtemp(join(tmpdir(), "undertree-html-render-"));
  context.after(() => rm(temporary, { recursive: true, force: true }));
  const pdf = join(temporary, "profile.pdf");
  const manifest = join(temporary, "profile.json");
  const result = await renderHtmlPrint({
    sourcePath: resolve("examples/html-print-profile.html"),
    projectRoot: resolve("."),
    pdfPath: pdf,
    manifestPath: manifest,
  });
  assert.equal(result.pageCount, 1);
  assert.equal(result.diagnostics.length, 0);
  const data = JSON.parse(await readFile(manifest, "utf8"));
  assert.equal(data.capabilities.canvas2d, true);
  assert.equal(data.capabilities.segmenter, true);
  assert.ok(data.resolvedFits.some((item) => item.dataUtId === "copy"));
  const { stdout } = await exec("pdfinfo", [pdf]);
  assert.match(stdout, /^Pages:\s+1$/m);
  assert.match(stdout, /Page size:\s+595 x 842 pts \(A4\)/);
});
