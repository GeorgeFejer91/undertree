#!/usr/bin/env node
import { createRequire } from "node:module";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright-core");
const endpoint = process.env.LOCALTEX_CDP_ENDPOINT || "http://127.0.0.1:9222";
const appUrl = process.env.UNDERTREE_APP_URL || process.env.LOCALTEX_APP_URL || `http://127.0.0.1:37371/?token=${encodeURIComponent(readFileSync(join(homedir(), ".config/undertree/token"), "utf8").trim())}`;

const browser = await chromium.connectOverCDP(endpoint);
const context = browser.contexts()[0];
const marker = `about:blank#localtex-ui-smoke-${Date.now()}`;
const pagePromise = context.waitForEvent("page", { predicate: (page) => page.url() === marker, timeout: 10000 });
const session = await browser.newBrowserCDPSession();
await session.send("Target.createTarget", { url: marker, background: true });
await session.detach();
const page = await pagePromise;
await page.addInitScript(() => localStorage.removeItem("localtex-source-files-only"));
const errors = [];
const externalRequests = [];
page.on("console", (message) => {
  const location = message.location().url || "unknown";
  if (message.type() === "error" && location !== "chrome-extension://invalid/") errors.push(`${message.text()} @ ${location}`);
});
page.on("pageerror", (error) => errors.push(error.message));
page.on("request", (request) => {
  try {
    const url = new URL(request.url());
    if (["http:", "https:", "ws:", "wss:"].includes(url.protocol) && !["127.0.0.1", "localhost"].includes(url.hostname)) {
      externalRequests.push(request.url());
    }
  } catch {}
});

try {
  await page.goto(appUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForSelector(".cm-editor", { timeout: 30000 });
  assert.equal(await page.locator(".rail").count(), 1);
  assert.equal(await page.locator(".left-panel").count(), 1);
  assert.equal(await page.locator(".editor-pane").count(), 1);
  assert.equal(await page.locator(".preview-pane").count(), 1);
  assert.ok(await page.locator(".tree-row").count() > 0);
  const sourceFilesOnly = page.getByRole("checkbox", { name: "TeX & Bib only" });
  assert.equal(await sourceFilesOnly.isChecked(), true);
  const filteredFileNames = await page.locator(".tree-file .tree-label").allTextContents();
  assert.ok(filteredFileNames.length > 0);
  assert.ok(filteredFileNames.every((name) => /\.(?:tex|bib)$/i.test(name)), "source-only tree must hide support and output files");
  await sourceFilesOnly.uncheck();
  assert.ok(await page.locator('.tree-file .tree-label').evaluateAll((labels) => labels.some((label) => !/\.(?:tex|bib)$/i.test(label.textContent || ""))));
  assert.equal(await page.evaluate(() => localStorage.getItem("localtex-source-files-only")), "false");
  const contextTarget = page.locator(".tree-file.editable .tree-row").first();
  await contextTarget.click({ button: "right" });
  const contextMenu = page.locator("#file-context-menu:not([hidden])");
  await contextMenu.waitFor();
  const contextActions = await contextMenu.locator("[data-tree-action] .context-label").allTextContents();
  for (const expectedAction of ["Open", "Rename", "Duplicate", "Copy relative path", "Copy full path", "Open file location", "Delete file", "Refresh file tree"]) {
    assert.ok(contextActions.includes(expectedAction), `file context menu must include ${expectedAction}`);
  }
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("#file-context-menu:not([hidden])").count(), 0);
  assert.ok(await page.locator(".editor-tab").count() > 0);
  assert.equal(await page.getByRole("button", { name: "Recompile", exact: true }).count(), 1);
  assert.equal(await page.getByRole("button", { name: "Download all PDFs", exact: true }).count(), 1);
  assert.equal(await page.getByRole("button", { name: "GitHub Sync", exact: true }).count(), 1);
  assert.equal(await page.getByRole("button", { name: "Overleaf Sync", exact: true }).count(), 1);

  await page.locator("#compile-menu").click();
  assert.equal(await page.locator("#compile-popover:not([hidden]) [data-compile-action]").count(), 4);
  assert.equal(await page.getByRole("checkbox", { name: "Automatically repair failed TeX with Codex" }).isChecked(), true);
  await page.locator("#compile-menu").click();

  await page.getByRole("button", { name: "Project search" }).click();
  await page.locator("#project-search").fill("Informationsblatt");
  await page.waitForSelector(".search-result", { timeout: 15000 });
  assert.ok(await page.locator(".search-result").count() > 0);

  await page.getByRole("button", { name: "Git and synchronization" }).click();
  await page.waitForSelector(".git-card", { timeout: 15000 });
  assert.ok(await page.locator(".git-card").count() >= 2);

  await page.getByRole("button", { name: "Choose a project" }).click();
  await page.waitForSelector(".project-row", { timeout: 15000 });
  assert.ok(await page.locator(".project-row").count() > 10);
  const initialProjectSort = await page.locator("#project-sort").inputValue();
  await page.locator("#project-sort").selectOption("name-desc");
  const projectNames = await page.locator(".project-row .project-details strong").allTextContents();
  const expectedNames = [...projectNames].sort((a, b) => b.localeCompare(a, undefined, { sensitivity: "base", numeric: true }));
  assert.deepEqual(projectNames, expectedNames, "project dialog should reorder names from Z to A");
  await page.locator("#project-sort").selectOption("created-desc");
  assert.equal(await page.locator(".project-row-meta small", { hasText: /^Created / }).count(), projectNames.length);
  await page.locator("#project-sort").selectOption(initialProjectSort);
  await page.locator("#close-project-modal").click();
  await page.getByRole("button", { name: "Organize projects" }).click();
  await page.waitForSelector("#project-modal:not([hidden])");
  await page.waitForFunction(() => document.activeElement?.id === "project-sort");
  assert.equal(await page.evaluate(() => document.activeElement?.id), "project-sort");
  await page.locator("#close-project-modal").click();

  const navigationMarker = `localtex-ui-${Date.now()}`;
  await page.evaluate((marker) => { window.__localtexNavigationMarker = marker; }, navigationMarker);
  await page.getByRole("button", { name: "Recompile", exact: true }).click();
  await page.waitForFunction(() => document.querySelector("#compile")?.textContent === "Recompile" && !document.querySelector("#compile")?.disabled, null, { timeout: 240000 });
  await page.waitForFunction(() => document.querySelector("#pdf-pages canvas")?.width > 0, null, { timeout: 30000 });
  assert.equal(await page.evaluate(() => window.__localtexNavigationMarker), navigationMarker, "Recompile must not reload the workspace");
  assert.equal(await page.locator("#pdf-viewer.visible #pdf-pages canvas").count(), 1);
  assert.equal(await page.locator("#logs-panel.visible").count(), 0);

  const initialPdfWidth = await page.locator("#pdf-pages canvas").evaluate((canvas) => Number.parseFloat(canvas.style.width));
  const initialPdfPercent = Number.parseInt((await page.locator("#page-status").textContent()).match(/(\d+)%/)?.[1] || "0", 10);
  await page.locator("#pdf-zoom-in").evaluate((button) => { button.click(); button.click(); });
  await page.waitForFunction((minimumWidth) => Number.parseFloat(document.querySelector("#pdf-pages canvas")?.style.width || "0") > minimumWidth && !document.querySelector("#pdf-viewer")?.hasAttribute("aria-busy"), initialPdfWidth * 1.4, { timeout: 30000 });
  const rapidZoomPercent = Number.parseInt((await page.locator("#page-status").textContent()).match(/(\d+)%/)?.[1] || "0", 10);
  assert.ok(rapidZoomPercent > initialPdfPercent * 1.4, "two immediate zoom clicks should accumulate");
  assert.equal(await page.locator("#pdf-previous").isDisabled(), true);
  assert.equal(await page.locator("#pdf-next").isDisabled(), true);
  assert.equal(await page.locator("#pdf-next").getAttribute("title"), "This PDF has only one page");
  await page.locator("#pdf-fit-width").click();
  await page.waitForFunction((expectedWidth) => Math.abs(Number.parseFloat(document.querySelector("#pdf-pages canvas")?.style.width || "0") - expectedWidth) < 2 && !document.querySelector("#pdf-viewer")?.hasAttribute("aria-busy"), initialPdfWidth, { timeout: 30000 });

  await page.locator("#compile-menu").click();
  await page.locator("#auto-compile-interval").selectOption("5");
  assert.match(await page.locator("#compile").getAttribute("title"), /every 5 seconds/);
  await page.waitForFunction(() => document.querySelector("#status-message")?.textContent?.startsWith("Auto-compiled at") && !document.querySelector("#compile")?.disabled, null, { timeout: 240000 });
  await page.locator("#auto-compile-interval").selectOption("0");
  assert.equal(await page.locator("#compile").getAttribute("title"), "Recompile PDF");
  assert.equal(await page.evaluate(() => localStorage.getItem(`localtex-auto-compile:${document.querySelector("#project-picker")?.value}`)), "0");
  await page.locator("#compile-menu").click();

  await page.getByRole("button", { name: "File tree" }).click();
  await page.locator('.tree-row[title="layout-experiments"]').click();
  await page.locator('.tree-row[title="layout-experiments/adaptive-boxes.layout.xml"]').click();
  await page.getByRole("button", { name: "Render layout", exact: true }).waitFor({ timeout: 15000 });
  await page.getByRole("button", { name: "Render layout", exact: true }).click();
  await page.waitForFunction(() => document.querySelector("#compile")?.textContent === "Render layout" && !document.querySelector("#compile")?.disabled, null, { timeout: 240000 });
  assert.match(await page.locator("#compile-log").textContent(), /UnderTree Layout validated and generated two targets/);
  await page.locator("#compile-menu").click();
  await page.locator('[data-compile-action="proof"]').click();
  await page.waitForSelector("#html-proof:not([hidden])", { timeout: 15000 });
  const proofFrame = page.frameLocator("#html-proof");
  await proofFrame.locator("#short-box").waitFor({ timeout: 15000 });
  const exampleFitErrors = await proofFrame.locator(".fit-error").evaluateAll((boxes) => boxes.map((box) => {
    const content = box.querySelector(".box-content");
    return { id: box.id, client: [content.clientWidth, content.clientHeight], scroll: [content.scrollWidth, content.scrollHeight], rect: [box.clientWidth, box.clientHeight] };
  }));
  assert.deepEqual(exampleFitErrors, [], `example HTML boxes should fit above their declared minimums: ${JSON.stringify(exampleFitErrors)}`);

  await page.locator('.tree-row[title="layout-experiments/ethics-participant-information-sheet.layout.xml"]').click();
  await page.getByRole("button", { name: "Render layout", exact: true }).click();
  await page.waitForFunction(() => document.querySelector("#compile")?.textContent === "Render layout" && !document.querySelector("#compile")?.disabled, null, { timeout: 240000 });
  await page.locator("#compile-menu").click();
  await page.locator('[data-compile-action="proof"]').click();
  await page.waitForSelector("#html-proof:not([hidden])", { timeout: 15000 });
  const ethicsProof = page.frameLocator("#html-proof");
  await ethicsProof.locator("#intro-copy[data-fitted-font]").waitFor({ timeout: 30000 });
  assert.equal(await ethicsProof.locator(".page").count(), 1, "ethics HTML proof should stay on one page");
  const ethicsFitErrors = await ethicsProof.locator(".fit-error").evaluateAll((boxes) => boxes.map((box) => box.id));
  assert.deepEqual(ethicsFitErrors, [], `ethics HTML boxes should fit above their declared minimums: ${ethicsFitErrors.join(", ")}`);
  assert.equal(errors.length, 0, `browser console errors: ${errors.join(" | ")}`);
  assert.equal(externalRequests.length, 0, `offline UI made external requests: ${externalRequests.join(" | ")}`);
  if (process.env.LOCALTEX_SCREENSHOT) await page.screenshot({ path: process.env.LOCALTEX_SCREENSHOT, fullPage: false });
  process.stdout.write("UnderTree UI smoke test passed.\n");
} finally {
  await page.close({ runBeforeUnload: false });
  await browser.close();
}
