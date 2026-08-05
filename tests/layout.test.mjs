import assert from "node:assert/strict";
import { readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { compileLayout, LayoutError, parseLayout, renderHtml, renderLatex } from "../layout/compiler.mjs";

const VALID_LAYOUT = `<?xml version="1.0"?>
<layout-document version="1" title="Test layout" lang="en">
  <page size="A4" margin="10mm">
    <grid columns="1fr 2fr" rows="35mm 1fr" gap="4mm">
      <box id="heading" row="1" column="1" column-span="2" min-font-size="8.5pt" max-font-size="15pt">
        <heading>Adaptive title</heading><p>Short semantic text.</p>
      </box>
      <box id="details" row="2" column="1" padding="3mm"><p>Left panel.</p></box>
      <box id="notes" row="2" column="2" padding="3mm"><list><item>First</item><item>Second</item></list></box>
    </grid>
  </page>
</layout-document>`;

function run(program, args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(program, args, { cwd });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.on("close", (code) => resolve({ code, output }));
  });
}

test("semantic layout validates and emits physical HTML and LuaLaTeX targets", () => {
  const model = parseLayout(VALID_LAYOUT, "fixture.layout.xml");
  assert.equal(model.pages.length, 1);
  assert.equal(model.pages[0].width, 210);
  assert.equal(model.pages[0].height, 297);
  assert.equal(model.pages[0].boxes.length, 3);
  assert.ok(model.pages[0].boxes[2].width > model.pages[0].boxes[1].width, "2fr column should be wider than 1fr");
  const html = renderHtml(model);
  assert.match(html, /width:var\(--page-width\)/);
  assert.match(html, /data-min-font="8\.5"/);
  assert.match(html, /CONTENT DOES NOT FIT/);
  assert.match(html, /function fitBox/);
  const latex = renderLatex(model);
  assert.match(latex, /\\newcommand\{\\LocalTeXAdaptiveBox\}\[6\]/);
  assert.match(latex, /paperwidth=210mm,paperheight=297mm/);
  assert.match(latex, /Content overflow in an adaptive box/);
});

test("validator rejects overlapping boxes and minimum sizes above maximum sizes", () => {
  const overlap = VALID_LAYOUT.replace('id="details" row="2" column="1"', 'id="details" row="2" column="2"');
  assert.throws(() => parseLayout(overlap), LayoutError);
  const inverted = VALID_LAYOUT.replace('min-font-size="8.5pt" max-font-size="15pt"', 'min-font-size="16pt" max-font-size="15pt"');
  assert.throws(() => parseLayout(inverted), /minimum font size exceeds/);
});

test("compiler writes both targets and the generated LuaLaTeX produces one A4 PDF", async (context) => {
  const temporary = await mkdtemp(join(tmpdir(), "localtex-layout-test-"));
  context.after(() => rm(temporary, { recursive: true, force: true }));
  const source = join(temporary, "fixture.layout.xml");
  const output = join(temporary, "output");
  await writeFile(source, VALID_LAYOUT);
  const generated = await compileLayout(source, output);
  assert.match(await readFile(generated.htmlPath, "utf8"), /Adaptive title/);
  assert.match(await readFile(generated.texPath, "utf8"), /Adaptive title/);
  const compiled = await run("latexmk", ["-norc", "-lualatex", "-interaction=nonstopmode", "-file-line-error", "-halt-on-error", `-outdir=${output}`, generated.texPath], temporary);
  assert.equal(compiled.code, 0, compiled.output);
  const info = await run("pdfinfo", [generated.pdfPath], temporary);
  assert.equal(info.code, 0, info.output);
  assert.match(info.output, /Pages:\s+1/);
  assert.match(info.output, /Page size:\s+595\.\d+ x 841\.\d+ pts \(A4\)/);
});

test("content below the declared minimum is reported instead of silently over-shrunk", async (context) => {
  const temporary = await mkdtemp(join(tmpdir(), "localtex-layout-overflow-"));
  context.after(() => rm(temporary, { recursive: true, force: true }));
  const source = join(temporary, "overflow.layout.xml");
  const output = join(temporary, "output");
  const repeated = Array.from({ length: 12 }, (_, index) => `<p>Paragraph ${index + 1} contains deliberately excessive text for this physically constrained region.</p>`).join("");
  await writeFile(source, `<layout-document version="1" title="Overflow"><page size="A4" margin="10mm"><grid columns="1fr" rows="18mm"><box id="too-dense" padding="2mm" min-font-size="12pt" max-font-size="12pt">${repeated}</box></grid></page></layout-document>`);
  const generated = await compileLayout(source, output);
  const compiled = await run("latexmk", ["-norc", "-lualatex", "-interaction=nonstopmode", "-file-line-error", `-outdir=${output}`, generated.texPath], temporary);
  assert.equal(compiled.code, 0, compiled.output);
  assert.match(compiled.output, /Content overflow in an adaptive box at minimum\s+size/);
  assert.match(await readFile(generated.htmlPath, "utf8"), /CONTENT DOES NOT FIT AT/);
});
