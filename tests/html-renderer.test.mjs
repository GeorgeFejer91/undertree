import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { link, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { applyResolvedFitsToHtml, renderHtmlPrint } from "../src/html-renderer.mjs";

const exec = promisify(execFile);

test(process.platform === "win32"
  ? "unsupported Windows HTML renderer preserves source and requested destinations before rendering"
  : "HTML rendering refuses source/output aliases including implicit manifest, symlink and hardlink destinations", async context => {
  const directory = await mkdtemp(join(tmpdir(), "undertree-render-alias-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, "print.pdf.manifest.json");
  const content = await readFile(resolve("examples/html-print-profile.html"), "utf8");
  await writeFile(source, content);
  const aliases = [];
  const symbolic = join(directory, "linked.pdf");
  try {
    await symlink(source, symbolic);
    aliases.push(symbolic);
  } catch (error) {
    if (process.platform !== "win32" || error.code !== "EPERM") throw error;
    context.diagnostic("File symlink fixture unavailable: Windows denied EPERM; this does not qualify alias validation on Windows.");
  }
  const hard = join(directory, "hardlinked.pdf");
  await link(source, hard);
  aliases.push(hard);
  for (const options of [
    { pdfPath: join(directory, "print.pdf") },
    ...aliases.map(pdfPath => ({ pdfPath })),
    { pdfPath: join(directory, "other.pdf"), manifestPath: source },
    { pdfPath: join(directory, "other.pdf"), texPath: source },
    { pdfPath: join(directory, "same"), manifestPath: join(directory, "same") },
  ]) {
    await assert.rejects(renderHtmlPrint({ sourcePath: source, projectRoot: directory, ...options }),
      process.platform === "win32" ? /requires the Linux WebKitGTK renderer/ : /different from the source/);
    assert.equal(await readFile(source, "utf8"), content);
    if (process.platform === "win32") {
      for (const destination of [options.pdfPath, options.manifestPath || `${options.pdfPath}.manifest.json`, ...(options.texPath ? [options.texPath] : [])]) {
        if (destination === source || aliases.includes(destination)) assert.equal(await readFile(destination, "utf8"), content);
        else await assert.rejects(readFile(destination), { code: "ENOENT" });
      }
    }
  }
});

test(process.platform === "win32"
  ? "native HTML rendering truthfully refuses unsupported Windows host without creating PDF or manifest"
  : "native WebKit waits for Pretext and produces the declared A4 page", { timeout: 90000 }, async (context) => {
  const temporary = await mkdtemp(join(tmpdir(), "undertree-html-render-"));
  context.after(() => rm(temporary, { recursive: true, force: true }));
  const pdf = join(temporary, "profile.pdf");
  const manifest = join(temporary, "profile.json");
  const options = {
    sourcePath: resolve("examples/html-print-profile.html"),
    projectRoot: resolve("."),
    pdfPath: pdf,
    manifestPath: manifest,
    persistFits: false,
  };
  if (process.platform === "win32") {
    const source = await readFile(options.sourcePath);
    await assert.rejects(renderHtmlPrint(options), /requires the Linux WebKitGTK renderer/);
    assert.deepEqual(await readFile(options.sourcePath), source);
    await assert.rejects(readFile(pdf), { code: "ENOENT" });
    await assert.rejects(readFile(manifest), { code: "ENOENT" });
    return;
  }
  const result = await renderHtmlPrint(options);
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
