import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { applyResolvedFitsToHtml, renderHtmlPrint } from "../src/html-renderer.mjs";

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
    persistFits: false,
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

test("resolved Pretext values persist as stable custom properties without duplicate styles", () => {
  const source = '<!doctype html><html data-ut-print-profile="1" data-ut-site="zanv"><head></head><body><main data-ut-page data-ut-id="page" data-ut-size="A4" data-ut-orientation="portrait"><img src="ZANV.svg"><section data-ut-id="copy" data-ut-box data-ut-fit="pretext">Text</section></main></body></html>';
  const fits = [{ dataUtId: "copy", fontSize: 12.345, lineHeight: 15.678, gap: 2.5 }];
  const fitted = applyResolvedFitsToHtml(source, fits);
  assert.match(fitted, /style="--ut-fit-font-size: 12\.35px; --ut-fit-line-height: 15\.68px; --ut-fit-gap: 2\.50px;"/);
  assert.equal(applyResolvedFitsToHtml(fitted, fits), fitted);
});
