#!/usr/bin/env node
import { createRequire } from "node:module";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const endpoint = process.env.LOCALTEX_CDP_ENDPOINT || "http://127.0.0.1:9222";
const appUrl = process.env.LOCALTEX_APP_URL;
if (!appUrl) throw new Error("Set LOCALTEX_APP_URL to the tokenized launcher URL");

const browser = await chromium.connectOverCDP(endpoint);
const context = browser.contexts()[0];
const marker = `about:blank#localtex-ui-smoke-${Date.now()}`;
const pagePromise = context.waitForEvent("page", { predicate: (page) => page.url() === marker, timeout: 10000 });
const session = await browser.newBrowserCDPSession();
await session.send("Target.createTarget", { url: marker, background: true });
await session.detach();
const page = await pagePromise;
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
  assert.ok(await page.locator(".editor-tab").count() > 0);
  assert.equal(await page.getByRole("button", { name: "Recompile", exact: true }).count(), 1);

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
  await page.locator("#close-project-modal").click();

  await page.getByRole("button", { name: "Recompile", exact: true }).click();
  await page.waitForFunction(() => document.querySelector("#compile")?.textContent === "Recompile" && !document.querySelector("#compile")?.disabled, null, { timeout: 240000 });
  assert.equal(await page.locator("#pdf-frame.visible").count(), 1);
  assert.equal(errors.length, 0, `browser console errors: ${errors.join(" | ")}`);
  assert.equal(externalRequests.length, 0, `offline UI made external requests: ${externalRequests.join(" | ")}`);
  if (process.env.LOCALTEX_SCREENSHOT) await page.screenshot({ path: process.env.LOCALTEX_SCREENSHOT, fullPage: false });
  process.stdout.write("LocalTeX Studio UI smoke test passed.\n");
} finally {
  await page.close({ runBeforeUnload: false });
  await browser.close();
}
