#!/usr/bin/env node
import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright-core");
const appRoot = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const endpoint = process.env.LOCALTEX_CDP_ENDPOINT || "http://127.0.0.1:9222";

function run(program, args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(program, args, { cwd });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.on("close", (code) => resolve({ code, output }));
  });
}

async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  server.close();
  await once(server, "close");
  return port;
}

async function waitForHealth(baseUrl) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      if ((await fetch(`${baseUrl}/api/health`)).ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("PDF controls test server did not become healthy");
}

const temporaryRoot = await mkdtemp(join(tmpdir(), "localtex-pdf-controls-test-"));
const library = join(temporaryRoot, "library");
const project = join(library, "three-page-project");
let appServer;
let browser;
let page;

try {
  await mkdir(join(project, "scripts"), { recursive: true });
  await writeFile(join(project, "main.tex"), String.raw`\documentclass{article}
\usepackage[margin=25mm]{geometry}
\begin{document}
\section*{Page one} First page marker.
\newpage
\section*{Page two} Second page marker.
\newpage
\section*{Page three} Third page marker.
\end{document}
`);
  await writeFile(join(project, "appendix.tex"), String.raw`\documentclass{article}
\begin{document}
Cached appendix preview.
\end{document}
`);
  await writeFile(join(project, ".tex-sync.conf"), `[build]\n\troot = main.tex\n\tengine = pdflatex\n\tworkingDirectory = repository-root\n\tshellEscape = false\n`);
  await writeFile(join(project, "scripts", "tex-sync"), "#!/usr/bin/env bash\nset -euo pipefail\nlatexmk -norc -pdf -interaction=nonstopmode -halt-on-error -outdir=.tex-build main.tex\n");
  await chmod(join(project, "scripts", "tex-sync"), 0o755);
  await writeFile(join(library, "PROJECTS.tsv"), `type\tname\tlocalPath\trepository\tbranch\troot\tengine\toverleafUrl\nlocal\tThree Page PDF\t${project}\tlocal/three-page\tmain\tmain.tex\tpdflatex\t\n`);
  await writeFile(join(library, "PROJECT_DOMAINS.tsv"), `id\ttype\tname\tprojectTitle\tsemanticDomain\tthemes\tdocumentFunction\tprojectFamily\treuseRole\tlocalPath\trepository\troot\tengine\toverleafUrl\nthree-page\tlocal\tThree Page PDF\tThree Page PDF\ttesting\tpdf controls\tverification\ttest\ttest\t${project}\tlocal/three-page\tmain.tex\tpdflatex\t\n`);
  await run("git", ["init", "-b", "main"], project);
  await run("git", ["config", "user.name", "LocalTeX Test"], project);
  await run("git", ["config", "user.email", "localtex@example.invalid"], project);
  await run("git", ["add", "."], project);
  await run("git", ["commit", "-m", "Three-page fixture"], project);
  const compiled = await run("bash", ["scripts/tex-sync"], project);
  assert.equal(compiled.code, 0, compiled.output);
  const appendixCompiled = await run("latexmk", ["-norc", "-pdf", "-interaction=nonstopmode", "-halt-on-error", "-outdir=.tex-build", "appendix.tex"], project);
  assert.equal(appendixCompiled.code, 0, appendixCompiled.output);
  await new Promise((resolve) => setTimeout(resolve, 5));
  await writeFile(join(project, "appendix.tex"), `${await readFile(join(project, "appendix.tex"), "utf8")}% changed after the cached build\n`);

  const port = await freePort();
  const token = "pdf-controls-test-token";
  const baseUrl = `http://127.0.0.1:${port}`;
  appServer = spawn(process.execPath, [join(appRoot, "server.mjs")], {
    cwd: appRoot,
    env: { ...process.env, LOCALTEX_PORT: String(port), LOCALTEX_TOKEN: token, LOCALTEX_LIBRARY_ROOT: library },
  });
  await waitForHealth(baseUrl);

  browser = await chromium.connectOverCDP(endpoint);
  const context = browser.contexts()[0];
  const marker = `about:blank#localtex-pdf-controls-${Date.now()}`;
  const pagePromise = context.waitForEvent("page", { predicate: (candidate) => candidate.url() === marker, timeout: 10000 });
  const session = await browser.newBrowserCDPSession();
  await session.send("Target.createTarget", { url: marker, background: true });
  await session.detach();
  page = await pagePromise;
  let buildRequests = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith("/build")) buildRequests += 1;
  });
  await page.goto(`${baseUrl}/?token=${token}`, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForSelector('#pdf-viewer.visible .pdf-page[data-page-number="1"] canvas', { timeout: 30000 });
  await page.waitForFunction(() => document.querySelector("#page-status")?.textContent?.startsWith("1 of 3") && !document.querySelector("#pdf-viewer")?.hasAttribute("aria-busy"), null, { timeout: 30000 });
  assert.equal(await page.locator("#pdf-pages .pdf-page").count(), 3, "every PDF page should be present in the continuous scroll stack");

  const buildsBeforeCachedSwitch = buildRequests;
  await page.locator('.tree-row[title="appendix.tex"]').click();
  await page.waitForFunction(() => document.querySelector("#page-status")?.textContent?.includes("cached (source changed)") && !document.querySelector("#pdf-viewer")?.hasAttribute("aria-busy"), null, { timeout: 30000 });
  assert.equal(buildRequests, buildsBeforeCachedSwitch, "selecting a stale cached PDF must not submit another build");
  assert.equal(await page.locator(".preview-pane.stale-pdf").count(), 1);
  await page.locator('.tree-row[title="main.tex"]').click();
  await page.waitForFunction(() => document.querySelector("#page-status")?.textContent?.startsWith("1 of 3") && !document.querySelector("#page-status")?.textContent?.includes("cached") && !document.querySelector("#pdf-viewer")?.hasAttribute("aria-busy"), null, { timeout: 30000 });
  assert.equal(buildRequests, buildsBeforeCachedSwitch, "switching back to another cached source must remain build-free");

  const initialWidth = await page.locator('.pdf-page[data-page-number="1"] canvas').evaluate((canvas) => Number.parseFloat(canvas.style.width));
  await page.locator("#pdf-viewer").evaluate((viewer) => { viewer.scrollTop = viewer.scrollHeight; });
  await page.waitForFunction(() => document.querySelector("#page-status")?.textContent?.startsWith("3 of 3") && document.querySelector('.pdf-page[data-page-number="3"] canvas'), null, { timeout: 30000 });
  assert.equal(await page.locator("#pdf-next").isDisabled(), true);
  assert.equal(await page.locator("#pdf-previous").isEnabled(), true);

  await page.locator("#pdf-previous").click();
  await page.waitForFunction(() => {
    const viewer = document.querySelector("#pdf-viewer");
    const second = document.querySelector('.pdf-page[data-page-number="2"]');
    return document.querySelector("#page-status")?.textContent?.startsWith("2 of 3")
      && second?.querySelector("canvas")
      && Math.abs(second.getBoundingClientRect().top - viewer.getBoundingClientRect().top - 16) < 3;
  }, null, { timeout: 30000 });

  await page.locator("#pdf-zoom-in").evaluate((button) => { button.click(); button.click(); });
  await page.waitForFunction((minimumWidth) => Number.parseFloat(document.querySelector('.pdf-page[data-page-number="2"] canvas')?.style.width || "0") > minimumWidth && !document.querySelector("#pdf-viewer")?.hasAttribute("aria-busy"), initialWidth * 1.4, { timeout: 30000 });
  await page.locator("#pdf-fit-width").click();
  await page.waitForFunction((expectedWidth) => Math.abs(Number.parseFloat(document.querySelector('.pdf-page[data-page-number="2"] canvas')?.style.width || "0") - expectedWidth) < 2 && !document.querySelector("#pdf-viewer")?.hasAttribute("aria-busy"), initialWidth, { timeout: 30000 });

  await page.locator("#reload-pdf").click();
  await page.waitForFunction(() => document.querySelector("#page-status")?.textContent?.startsWith("2 of 3") && !document.querySelector("#pdf-viewer")?.hasAttribute("aria-busy"), null, { timeout: 30000 });
  await page.locator("#compile-menu").click();
  await page.locator("#auto-compile-interval").selectOption("changes");
  assert.match(await page.locator("#compile").getAttribute("title"), /one second after editing stops/);
  await page.locator(".cm-content").click();
  await page.locator(".cm-content").press("Control+End");
  await page.keyboard.insertText("\n% edit-aware compile smoke test");
  await page.waitForFunction(() => document.querySelector("#status-message")?.textContent?.startsWith("Auto-compiled at") && !document.querySelector("#compile")?.disabled, null, { timeout: 240000 });
  await page.locator("#compile-menu").click();
  await page.locator("#auto-compile-interval").selectOption("0");
  if (process.env.LOCALTEX_SCREENSHOT) {
    await page.locator("#compile-menu").click();
    await page.locator("#pdf-zoom-out").evaluate((button) => { button.click(); button.click(); });
    await page.waitForFunction(() => !document.querySelector("#pdf-viewer")?.hasAttribute("aria-busy"), null, { timeout: 30000 });
    await page.locator("#toast-region").evaluate((region) => region.replaceChildren());
    await page.screenshot({ path: process.env.LOCALTEX_SCREENSHOT, fullPage: false });
  }
  process.stdout.write("LocalTeX cached PDF switching, continuous scroll, edit-aware compile, zoom, fit, and reload controls passed.\n");
} finally {
  if (page) await page.close({ runBeforeUnload: false }).catch(() => {});
  if (browser) await browser.close().catch(() => {});
  if (appServer) {
    appServer.kill("SIGTERM");
    await Promise.race([once(appServer, "close"), new Promise((resolve) => setTimeout(resolve, 3000))]);
  }
  await rm(temporaryRoot, { recursive: true, force: true });
}
