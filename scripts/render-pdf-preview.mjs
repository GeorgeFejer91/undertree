#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright-core");
const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const requestedScreenshot = process.argv[2] || join(appRoot, "artifacts", "undertree-pdf-preview.png");
const screenshotPath = resolve(requestedScreenshot);
const extensionIndex = screenshotPath.lastIndexOf(".");
const previewScreenshotPath = extensionIndex > 0
  ? `${screenshotPath.slice(0, extensionIndex)}-pane${screenshotPath.slice(extensionIndex)}`
  : `${screenshotPath}-pane.png`;

function firstExisting(paths) {
  return paths.find((path) => path && existsSync(path)) || "";
}

function freePort() {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close((error) => error ? reject(error) : resolvePort(port));
    });
  });
}

async function waitForHealth(baseUrl, serverOutput) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      if ((await fetch(`${baseUrl}/api/health`)).ok) return;
    } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`UnderTree renderer server did not become healthy.\n${serverOutput()}`);
}

const temporaryRoot = await mkdtemp(join(tmpdir(), "undertree-preview-renderer-"));
const library = join(temporaryRoot, "library");
const project = join(library, "preview-verification");
const token = `preview-renderer-${Date.now()}`;
const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;
const latexmk = firstExisting([
  process.env.UNDERTREE_LATEXMK,
  join(process.env.LOCALAPPDATA || "", "Programs", "MiKTeX", "miktex", "bin", "x64", "latexmk.exe"),
  join(process.env.ProgramFiles || "", "MiKTeX", "miktex", "bin", "x64", "latexmk.exe"),
]);
const browserExecutable = firstExisting([
  process.env.UNDERTREE_RENDER_BROWSER,
  join(process.env["ProgramFiles(x86)"] || "", "Microsoft", "Edge", "Application", "msedge.exe"),
  join(process.env.ProgramFiles || "", "Microsoft", "Edge", "Application", "msedge.exe"),
  join(process.env.ProgramFiles || "", "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
]);
const perlDirectory = firstExisting([
  "C:\\Strawberry\\perl\\bin",
  join(process.env.LOCALAPPDATA || "", "Programs", "Strawberry", "perl", "bin"),
]);

if (process.platform === "win32") {
  assert.ok(latexmk, "A MiKTeX latexmk.exe is required for the Windows preview renderer");
  assert.ok(browserExecutable, "Microsoft Edge or Brave is required for the background preview renderer");
}

let appServer;
let browser;
let serverLog = "";
try {
  await mkdir(project, { recursive: true });
  await mkdir(dirname(screenshotPath), { recursive: true });
  await writeFile(join(project, "main.tex"), String.raw`\documentclass{article}
\usepackage[a4paper,margin=22mm]{geometry}
\usepackage{xcolor}
\pagestyle{empty}
\begin{document}
\begin{center}
{\color{blue!65!black}\Huge\bfseries UnderTree PDF Preview Verified}

\vspace{14mm}
{\Large Compiled by the real Windows TeX pipeline}
\end{center}
\vspace{10mm}
\noindent\fbox{\parbox{0.92\linewidth}{
This page proves that UnderTree compiled a TeX source, loaded the resulting PDF
through PDF.js, and painted it into the right-side preview canvas in a headless
background browser without taking control of the desktop.
}}
\end{document}
`);
  await writeFile(join(project, "alternate.tex"), String.raw`\documentclass{article}
\usepackage[a4paper,margin=22mm]{geometry}
\pagestyle{empty}
\begin{document}
\begin{center}\Huge\bfseries Alternate TeX Preview\end{center}
\vspace{12mm}
This independently compiled document verifies per-source PDF switching.
\end{document}
`);
  await writeFile(join(project, ".tex-sync.conf"), "[build]\n\troot = main.tex\n\tengine = pdflatex\n\tworkingDirectory = repository-root\n\tshellEscape = false\n");
  await writeFile(join(library, "PROJECTS.tsv"), `type\tname\tlocalPath\trepository\tbranch\troot\tengine\toverleafUrl\nlocal\tPreview Verification\t${project}\tlocal/preview-verification\tmain\tmain.tex\tpdflatex\t\n`);
  await writeFile(join(library, "PROJECT_DOMAINS.tsv"), `id\ttype\tname\tprojectTitle\tsemanticDomain\tthemes\tdocumentFunction\tprojectFamily\treuseRole\tlocalPath\trepository\troot\tengine\toverleafUrl\npreview-verification\tlocal\tPreview Verification\tPreview Verification\ttesting\tpdf preview\tverification\ttest\ttest\t${project}\tlocal/preview-verification\tmain.tex\tpdflatex\t\n`);

  const runtimeDirectories = [latexmk && dirname(latexmk), perlDirectory, process.env.PATH].filter(Boolean);
  appServer = spawn(process.execPath, [join(appRoot, "server.mjs")], {
    cwd: appRoot,
    windowsHide: true,
    env: {
      ...process.env,
      PATH: runtimeDirectories.join(";"),
      LOCALTEX_PORT: String(port),
      LOCALTEX_TOKEN: token,
      LOCALTEX_LIBRARY_ROOT: library,
      UNDERTREE_LATEXMK: latexmk || process.env.UNDERTREE_LATEXMK,
    },
  });
  appServer.stdout.on("data", (chunk) => { serverLog += chunk; });
  appServer.stderr.on("data", (chunk) => { serverLog += chunk; });
  await waitForHealth(baseUrl, () => serverLog);

  browser = await chromium.launch({
    executablePath: browserExecutable || undefined,
    headless: true,
    args: ["--disable-gpu", "--disable-background-networking"],
  });
  const page = await browser.newPage({ viewport: { width: 1500, height: 900 }, deviceScaleFactor: 1 });
  const browserErrors = [];
  let buildRequests = 0;
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith("/build")) buildRequests += 1;
  });
  await page.goto(`${baseUrl}/?token=${encodeURIComponent(token)}`, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForFunction(() => document.querySelector("#compile")?.textContent === "Recompile"
    && !document.querySelector("#compile")?.disabled, null, { timeout: 240000 });
  await page.waitForSelector('#pdf-viewer.visible .pdf-page[data-page-number="1"] canvas', { timeout: 60000 });
  await page.waitForFunction(() => document.querySelector("#page-status")?.textContent?.startsWith("1 of 1")
    && !document.querySelector("#pdf-viewer")?.hasAttribute("aria-busy"), null, { timeout: 60000 });

  const mainBuildRequests = buildRequests;
  await page.locator('.tree-row[title="alternate.tex"]').click();
  await page.waitForFunction(() => document.querySelector("#download-pdf")?.href.includes("sourcePath=alternate.tex")
    && document.querySelector("#page-status")?.textContent?.startsWith("1 of 1")
    && !document.querySelector("#compile")?.disabled, null, { timeout: 240000 });
  assert.ok(buildRequests > mainBuildRequests, "selecting an unbuilt TeX source must compile its own PDF");

  const alternateBuildRequests = buildRequests;
  await page.locator(".cm-content").click();
  await page.locator(".cm-content").press("Control+End");
  await page.keyboard.insertText("\n% live preview edit verification");
  for (let attempt = 0; attempt < 100 && buildRequests <= alternateBuildRequests; attempt += 1) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  assert.ok(buildRequests > alternateBuildRequests, "editing TeX in live mode must trigger another PDF build");
  await page.waitForFunction(() => document.querySelector("#status-message")?.textContent?.startsWith("Auto-compiled at")
    && !document.querySelector("#compile")?.disabled, null, { timeout: 240000 });

  const buildsBeforeCachedSwitch = buildRequests;
  await page.locator('.tree-row[title="main.tex"]').click();
  await page.waitForFunction(() => document.querySelector("#download-pdf")?.href.includes("sourcePath=main.tex")
    && document.querySelector("#page-status")?.textContent?.startsWith("1 of 1")
    && !document.querySelector("#pdf-viewer")?.hasAttribute("aria-busy"), null, { timeout: 60000 });
  await new Promise((resolveWait) => setTimeout(resolveWait, 1000));
  assert.equal(buildRequests, buildsBeforeCachedSwitch, "switching to a current cached PDF must not rebuild it");

  const proof = await page.evaluate(() => {
    const canvas = document.querySelector('#pdf-viewer.visible .pdf-page[data-page-number="1"] canvas');
    return {
      status: document.querySelector("#page-status")?.textContent || "",
      compileStatus: document.querySelector("#status-message")?.textContent || "",
      compileLog: document.querySelector("#compile-log")?.textContent || "",
      canvasWidth: canvas?.width || 0,
      canvasHeight: canvas?.height || 0,
      canvasDataLength: canvas?.toDataURL("image/png").length || 0,
      previewVisible: Boolean(document.querySelector("#pdf-viewer.visible")),
    };
  });
  assert.equal(proof.previewVisible, true, "the right-side PDF viewer must be visible");
  assert.ok(proof.canvasWidth > 300 && proof.canvasHeight > 300, `unexpected preview canvas: ${proof.canvasWidth}x${proof.canvasHeight}`);
  assert.ok(proof.canvasDataLength > 10_000, "the preview canvas must contain rendered pixels");
  assert.doesNotMatch(proof.compileLog, /toHex is not a function/i);
  assert.doesNotMatch(proof.compileStatus, /failed/i);
  assert.deepEqual(browserErrors, [], `background browser errors: ${browserErrors.join(" | ")}`);

  await page.screenshot({ path: screenshotPath, fullPage: false });
  await page.locator("#preview-pane").screenshot({ path: previewScreenshotPath });
  process.stdout.write(`${JSON.stringify({
    ok: true,
    screenshotPath,
    previewScreenshotPath,
    buildRequests,
    sourceSwitchVerified: true,
    liveRecompileVerified: true,
    ...proof,
  }, null, 2)}\n`);
} finally {
  if (browser) await browser.close().catch(() => {});
  if (appServer) {
    appServer.kill("SIGTERM");
    await Promise.race([once(appServer, "close"), new Promise((resolveWait) => setTimeout(resolveWait, 3000))]).catch(() => {});
  }
  await rm(temporaryRoot, { recursive: true, force: true });
}
