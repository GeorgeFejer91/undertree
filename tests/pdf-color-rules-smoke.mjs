// Actual Typst PDF.js text layer -> local color policy. No mocked PDF or document writes.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';

assert.ok(process.env.UNDERTREE_TYPST, 'Supply UNDERTREE_TYPST: this gate compiles an actual Typst PDF.');
assert.ok(process.env.UNDERTREE_CHROME, 'Supply UNDERTREE_CHROME as an explicit installed browser executable path.');
const binary = resolve(process.env.UNDERTREE_REVIEW_BINARY || `target/debug/undertree-review${process.platform === 'win32' ? '.exe' : ''}`);
const inputAssets = resolve(process.env.UNDERTREE_REVIEW_ASSETS || 'dist');
const output = resolve(process.env.UNDERTREE_PDF_COLOR_RECEIPT || 'artifacts/pdf-color-rules-smoke.json');
const root = await mkdtemp(join(tmpdir(), 'undertree-pdf-colors-')), projectRoot = join(root, 'project'), assets = join(root, 'assets');
const runningBinary = join(root, `undertree-review${process.platform === 'win32' ? '.exe' : ''}`);
const token = randomBytes(32).toString('hex');
const source = '#set page(width: 180mm, height: 100mm)\n#set text(size: 12pt)\n\nUnique PDF passage for review.\n\nRepeated idea. Repeated idea.\n\nUnicode remains: naïve.\n';
const quote = 'Unique PDF passage for review.', bytes = Buffer.from(source);
let savedBytes = bytes;
const checks = [], errors = [], observations = [];
const hash = value => createHash('sha256').update(value).digest('hex');
let service, browser, page, port, base, project, log = '', failure;
async function until(check, message) {
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) { if (await check()) return; if (service?.exitCode !== null && service?.exitCode !== undefined) throw Error(log); await new Promise(resolve => setTimeout(resolve, 30)); }
  throw Error(message);
}
async function call(operation) {
  let value;
  await until(async () => {
    value = await fetch(base + '/api/review', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(operation) }).then(response => response.json());
    return value.error?.code !== 'busy';
  }, 'Native operation remained busy.');
  assert.equal(value.ok, true, value.error?.message); return value.result;
}
const saved = () => call({ action: 'review', project: project.id, path: 'main.typ' });
async function selectPdf(text) {
  const result = await page.locator('.pdf-text-layer').first().evaluate((layer, text) => {
    const from = layer.textContent.indexOf(text);
    if (from < 0) return { found: false, content: layer.textContent };
    const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT), range = document.createRange();
    let offset = 0, started = false, ended = false;
    while (walker.nextNode()) {
      const node = walker.currentNode, end = offset + node.textContent.length;
      if (!started && from < end) { range.setStart(node, from - offset); started = true; }
      if (started && from + text.length <= end) { range.setEnd(node, from + text.length - offset); ended = true; break; }
      offset = end;
    }
    const selection = document.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    return { found: ended, selected: selection.toString(), rects: range.getClientRects().length };
  }, text);
  assert.equal(result.found, true, JSON.stringify(result)); assert.equal(result.selected, text); assert.ok(result.rects > 0);
  observations.push({ pdfSelection: result });
}
async function unchanged() { assert.deepEqual(await readFile(join(projectRoot, 'main.typ')), savedBytes); }
async function highlightSelectedPdf() {
  let busy = 0;
  const completed = page.waitForResponse(async response => {
    if (!response.url().endsWith('/api/review') || response.request().postDataJSON()?.action !== 'pdf_mark') return false;
    const value = await response.json();
    const retryable = value.error?.code === 'busy' && value.error.message === 'A local document operation is running. Retry this action.';
    return !retryable || ++busy >= 4;
  });
  void completed.catch(() => {});
  await page.locator('#pdf-highlight-selection').click();
  const value = await (await completed).json(); assert.equal(value.ok, true, value.error?.message);
}

try {
  await mkdir(resolve('artifacts'), { recursive: true }); await mkdir(projectRoot); await cp(inputAssets, assets, { recursive: true }); await cp(binary, runningBinary); await writeFile(join(projectRoot, 'main.typ'), bytes);
  await writeFile(join(projectRoot, 'other.typ'), Array.from({ length: 5 }, (_, index) => `#pagebreak()\nPadding page ${index + 1}.\n`).join('') + '#pagebreak()\n' + quote + '\n');
  service = spawn(runningBinary, [], { windowsHide: true, env: { ...process.env, UNDERTREE_REVIEW_PORT: '0', UNDERTREE_REVIEW_STATE: join(root, 'state'), UNDERTREE_REVIEW_ASSETS: assets, UNDERTREE_REVIEW_TOKEN: token }, stdio: ['ignore', 'pipe', 'pipe'] });
  service.on('error', error => { log += error.message; });
  for (const stream of [service.stdout, service.stderr]) stream.on('data', chunk => { log = (log + chunk).slice(-24_000); port = Number(log.match(/127\.0\.0\.1:(\d+)/)?.[1]); });
  await until(() => !!port, 'The PDF color service did not start.'); base = `http://127.0.0.1:${port}`;
  project = await call({ action: 'add_project', root: projectRoot });
  browser = await chromium.launch({ executablePath: process.env.UNDERTREE_CHROME, headless: true, args: ['--no-sandbox'] });
  page = await browser.newPage({ viewport: { width: 1600, height: 950 } }); page.on('pageerror', error => errors.push(error.message));
  // Startup selects the one approved project; avoid racing that inventory with a second change.
  await page.goto(base + `/manuscript.html#session=${token}`);
  await page.locator('.file-button[data-path="main.typ"]').click(); await page.locator('.cm-content').waitFor();
  await page.locator('#typst-compile').click();
  await until(async () => await page.locator('#typst-preview-status').getAttribute('data-state') === 'current' && await page.locator('.pdf-text-layer').count() > 0, 'The real compiler/PDF.js text layer did not become current.');
  const rule = (await saved()).review.rules.find(rule => rule.action === 'prompt'); assert.ok(rule);
  await page.locator(`[data-color-rule="${rule.id}"]`).click();
  assert.equal((await saved()).review.markers.length, 0, 'Selecting a color only arms the tool.');
  await selectPdf(quote);
  await highlightSelectedPdf();
  await until(async () => /PDF text highlighted/i.test(await page.locator('#review-status').textContent()), 'The mark did not receive its local UI acknowledgement.');
  const marker = (await saved()).review.markers[0];
  assert.equal((await saved()).review.pdfAnnotations[0].sourceMarkerId, marker.id);
  assert.equal(marker.anchor.quote, quote); assert.equal(marker.anchor.from, source.indexOf(quote)); assert.equal(marker.anchor.to, source.indexOf(quote) + quote.length); assert.equal(marker.rule, rule.id);
  await unchanged();
  await until(async () => await page.evaluate(() => [...CSS.highlights.entries()].some(([name, highlight]) => name.startsWith('undertree-pdf-annotation-') && [...highlight].some(range => range.toString() === 'Unique PDF passage for review.'))), 'The marked passage has no exact rendered PDF highlight.');
  await page.screenshot({ path: resolve('artifacts/pdf-color-rules.png') });
  await page.locator('.manuscript-toolbar').screenshot({ path: resolve('artifacts/color-rules-toolbar.png') });
  checks.push('A real compiled PDF text selection produces the exact source marker and visible native CSS highlight without changing any original source byte.');
  const beforeRuleAccess = (await saved()).review;
  await selectPdf(quote);
  const point = await page.evaluate(() => {
    const rect = document.getSelection().getRangeAt(0).getClientRects()[0];
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  });
  await page.mouse.dblclick(point.x, point.y);
  await page.locator('#color-rule-dialog').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#color-rule-label').inputValue(), rule.label);
  await page.locator('#color-rule-dialog [data-close]').click();
  await selectPdf(quote);
  await page.locator('#typst-preview').focus(); await page.keyboard.press('F4');
  await page.locator('#color-rule-dialog').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#color-rule-label').inputValue(), rule.label);
  await page.locator('#color-rule-dialog [data-close]').click();
  const afterRuleAccess = (await saved()).review;
  assert.deepEqual(afterRuleAccess.rules, beforeRuleAccess.rules);
  assert.deepEqual(afterRuleAccess.markers, beforeRuleAccess.markers);
  assert.deepEqual(afterRuleAccess.pdfAnnotations, beforeRuleAccess.pdfAnnotations);
  await unchanged();
  checks.push('Actual PDF-highlight double-click and F4 open the same local color-rule form, and Cancel leaves rules, markers, annotation identities and source bytes unchanged.');
  await page.locator(`[data-color-rule="${rule.id}"]`).click();
  await selectPdf('Repeated idea.'); await highlightSelectedPdf();
  assert.equal((await saved()).review.pdfAnnotations.length, 2);
  assert.equal((await saved()).review.markers.length, 1); assert.equal((await saved()).review.pdfAnnotations.at(-1).sourceMarkerId, undefined); await unchanged();
  checks.push('A PDF quote repeated in the source is marked positionally without assigning an arbitrary source occurrence or changing source bytes.');

  // The active source contains the quote once, but an included file renders it again offscreen.
  // Local typing and Save are explicit; subsequent PDF marking must not infer a source link.
  const include = '#include "other.typ"\n';
  await page.evaluate(() => document.getSelection().removeAllRanges());
  const includeSave = page.waitForResponse(response => response.url().endsWith('/api/review') && response.request().postDataJSON()?.action === 'save');
  await page.locator('.cm-content').focus(); await page.keyboard.press('Control+End'); await page.keyboard.insertText(include); await page.keyboard.press('Control+s');
  const includeResult = await (await includeSave).json(); assert.equal(includeResult.ok, true, includeResult.error?.message);
  savedBytes = Buffer.from(source + include);
  await until(async () => (await saved()).content === savedBytes.toString(), 'The explicit local include edit did not save.');
  await page.locator('#typst-compile').click();
  await until(async () => await page.locator('#typst-preview-status').getAttribute('data-state') === 'current' && Number(await page.locator('#pdf-page-number').getAttribute('max')) >= 7 && await page.locator('.pdf-text-layer').count() > 0, 'The included duplicate PDF did not compile.');
  assert.equal((await saved()).content.split(quote).length - 1, 1, 'The active source itself has one matching quote.');
  assert.equal(await page.locator('.pdf-page[data-page="7"]').count(), 0, 'The duplicate PDF page is outside the painted window.');
  await selectPdf(quote); await highlightSelectedPdf();
  assert.equal((await saved()).review.pdfAnnotations.length, 3);
  assert.equal(await page.evaluate(() => [...CSS.highlights.entries()].some(([name, highlight]) => name.startsWith('undertree-pdf-rule-') && [...highlight].some(range => range.toString() === 'Unique PDF passage for review.'))), false, 'A marker must not paint an arbitrary occurrence of globally duplicated PDF text.');
  assert.equal((await saved()).review.markers.length, 1); assert.equal((await saved()).review.pdfAnnotations.at(-1).sourceMarkerId, undefined); await unchanged();
  checks.push('A quote duplicated on an unpainted included PDF page is marked at the selected position without creating a false unique source link.');

  // Keep a local edit dirty so an old, still visible PDF cannot silently target newer text.
  await page.route('**/api/review', route => {
    const operation = route.request().postDataJSON();
    if (operation.action !== 'save') return route.continue();
    return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ ok: false, error: { code: 'busy', message: 'The isolated fixture keeps the local draft unsaved.' } }) });
  });
  try {
    await page.locator('.cm-content').focus(); await page.keyboard.press('Control+End'); await page.keyboard.insertText('Local unsaved change.');
    await until(async () => await page.locator('#save-label').textContent() === 'Unsaved changes', 'The local draft did not become dirty.');
    await selectPdf(quote); await highlightSelectedPdf();
    assert.equal((await saved()).review.pdfAnnotations.length, 4);
    assert.equal((await saved()).review.markers.length, 1); assert.equal((await saved()).review.pdfAnnotations.at(-1).sourceMarkerId, undefined); await unchanged();
    assert.equal(await page.locator('#save-label').textContent(), 'Unsaved changes');
    assert.match(await page.locator('.cm-content').textContent(), /Local unsaved change\.$/);
    checks.push('A visible PDF from before a local edit records only positional metadata, preserving saved source bytes and the unsaved draft without a source anchor or implicit save.');
  } finally { await page.unrouteAll({ behavior: 'wait' }); }
  assert.deepEqual(errors, []);
  console.log(`PDF color rules: ${checks.length} real Typst/PDF.js checks passed. Native WebViews were not exercised.`);
} catch (error) {
  failure = error;
  if (page) { errors.push(await page.locator('#review-status').textContent({ timeout: 1000 }).catch(() => 'Status unavailable')); await page.screenshot({ path: resolve('artifacts/pdf-color-rules-failure.png'), timeout: 5000 }).catch(() => {}); }
  throw error;
} finally {
  await browser?.close(); service?.kill('SIGINT');
  if (service) { await Promise.race([new Promise(resolve => { if (service.exitCode !== null) resolve(); else service.once('exit', resolve); }), new Promise(resolve => setTimeout(resolve, 3000))]); if (service.exitCode === null) service.kill('SIGKILL'); }
  await mkdir(resolve('artifacts'), { recursive: true });
  await writeFile(output, JSON.stringify({ result: failure ? 'failed' : 'passed', error: failure?.message, binary, binarySha256: await readFile(runningBinary).then(hash).catch(() => null), inputAssets, typst: process.env.UNDERTREE_TYPST, runnerSha256: hash(await readFile(new URL(import.meta.url))), sourceSha256: hash(bytes), checks, observations, errors, serviceLog: failure ? log : undefined }, null, 2) + '\n');
  await rm(root, { recursive: true, force: true });
}
