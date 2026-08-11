#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { renderHtmlPrint } from "./src/html-renderer.mjs";

function usage(message = "") {
  if (message) console.error(message);
  console.error("Usage: undertree render-html <source.html> --pdf <output.pdf> [--tex <output.tex>]");
  process.exit(message ? 2 : 0);
}

function option(args, name) {
  const index = args.indexOf(name);
  if (index < 0) return "";
  if (!args[index + 1] || args[index + 1].startsWith("--")) usage(`${name} requires a path.`);
  return args[index + 1];
}

function projectRoot(source) {
  const result = spawnSync("git", ["-C", dirname(source), "rev-parse", "--show-toplevel"], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : dirname(source);
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] !== "render-html") usage(args.length ? `Unknown command: ${args[0]}` : "");
  if (!args[1] || args[1].startsWith("--")) usage("render-html requires a source HTML file.");
  const sourcePath = resolve(args[1]);
  const pdf = option(args, "--pdf");
  if (!pdf) usage("render-html requires --pdf.");
  const tex = option(args, "--tex");
  const result = await renderHtmlPrint({
    sourcePath,
    projectRoot: projectRoot(sourcePath),
    pdfPath: resolve(pdf),
    texPath: tex ? resolve(tex) : "",
  });
  console.log(`Rendered ${result.pageCount} A4 page(s) with WebKitGTK ${result.webkitVersion}.`);
  console.log(`PDF: ${result.pdfPath}`);
  if (result.texPath) {
    console.log(`Generated LuaLaTeX: ${result.texPath}`);
    console.log(`Compiled LuaLaTeX PDF: ${result.texPdfPath}`);
  }
  console.log(`HTML SHA-256: ${result.sourceHash}`);
}

main().catch((error) => {
  console.error(error?.message || String(error));
  process.exitCode = 1;
});
