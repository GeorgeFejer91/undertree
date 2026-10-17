import { contextValue } from './context-fixture.mjs';
import { readFixtureContext } from './context-fixture.mjs';
import { consentToFixtureShare } from './context-fixture.mjs';
// Real mouse drags over an actual compiled publication, including an active included source.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { createZrokFixture } from './zrok-fixture.mjs';

assert.ok(process.env.UNDERTREE_TYPST && process.env.UNDERTREE_CHROME, 'Supply actual Typst and Chrome executables.');
const selectedBinary = resolve(process.env.UNDERTREE_REVIEW_BINARY || `target/debug/undertree-review${process.platform === 'win32' ? '.exe' : ''}`);
const selectedAssets = resolve(process.env.UNDERTREE_REVIEW_ASSETS || 'dist');
const output = resolve(process.env.UNDERTREE_PDF_HIGHLIGHTER_RECEIPT || 'artifacts/pdf-highlighter-smoke.json');
const root = await mkdtemp(join(tmpdir(), 'undertree-pdf-highlighter-')), projectRoot = join(root, 'project'), assets = join(root, 'assets');
const binary = join(root, `undertree-review${process.platform === 'win32' ? '.exe' : ''}`), token = randomBytes(32).toString('hex');
const firstQuote = 'First root passage for the green highlighter.', repeatedQuote = 'Repeated review idea.';
const privateQuote = 'Private publication opening.';
const linkedPrompt = 'Shorten this passage while preserving the original meaning. Propose changes only.';
const unlinkedPrompt = 'Review this PDF-only passage for clarity; do not infer a source anchor.';
const privateAnnotationPrompt = 'Private annotation-only instruction: use a shorter publication opening.';
const section = '= Included chapter\n\n' + firstQuote + '\n\n' + repeatedQuote + '\n\n' + repeatedQuote + '\n\nMixed *bold words* and _italic words_ form this sentence. The 40 observations in 2026 had a descriptive mean of 18.2. A longer explanation deliberately wraps across several rendered lines so selection can follow the printed paragraph rather than raw source formatting.\n';
const main = '#set page(width: 180mm, height: 130mm, margin: 18mm)\n#set text(size: 12pt)\n#set par.line(numbering: "1")\n\n' + privateQuote + '\n\n#include "section.typ"\n' + Array.from({ length: 7 }, (_, index) => `\n#pagebreak()\nScroll page ${index + 2} has its own visible prose.\n`).join('');
const originals = { 'main.typ': Buffer.from(main), 'section.typ': Buffer.from(section) };
const checks = [], observations = [], errors = [], traffic = [], hash = value => createHash('sha256').update(value).digest('hex');
const runnerSha256 = hash(await readFile(new URL(import.meta.url)));
const pendingNative = new Set(); let lastNativeActivity = Date.now();
let service, browser, page, project, base, port, log = '', failure, endpoint;
function observeResponse(predicate) { const pending = page.waitForResponse(predicate); void pending.catch(() => {}); return pending; }
async function settleDocumentOperations() { await until(() => pendingNative.size === 0 && Date.now() - lastNativeActivity >= 500, 'Document operations did not settle.'); }
async function until(check, message, duration = 20_000) {
  const deadline = Date.now() + duration;
  while (Date.now() < deadline) { if (await check()) return; if (service?.exitCode !== null && service?.exitCode !== undefined) throw Error(log); await new Promise(resolve => setTimeout(resolve, 25)); }
  throw Error(message);
}
async function local(operation, expectedError = null) {
  if (!expectedError) operation = await consentToFixtureShare(operation, local);
  let value;
  await until(async () => {
    value = await fetch(base + '/api/review', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(operation), signal: AbortSignal.timeout(10_000) }).then(response => response.json());
    return value.error?.code !== 'busy' || value.error.message !== 'A local document operation is running. Retry this action.';
  }, 'The native observation remained busy.');
  if (expectedError) { assert.equal(value.ok, false); assert.equal(value.error.code, expectedError, JSON.stringify(value)); return value.error; }
  assert.equal(value.ok, true, value.error?.message); return value.result;
}
const snapshot = (path = 'section.typ') => local({ action: 'review', project: project.id, path });
const annotations = async () => (await snapshot()).review.pdfAnnotations || [];
const binding = value => ({ sourceEpoch: value.sourceEpoch, expectedRoot: value.expectedRoot });
async function unchanged() { for (const [path, bytes] of Object.entries(originals)) assert.deepEqual(await readFile(join(projectRoot, path)), bytes, `PDF highlighter must not write ${path}.`); }
function done(message) { checks.push(message); console.log(message); }
async function open(path) {
  const button = page.locator(`.file-button[data-path="${path}"]`);
  if (await button.getAttribute('aria-current') === 'true') { await page.locator('.cm-content').waitFor(); return; }
  let refused;
  const observe = async response => {
    if (!response.url().endsWith('/api/review')) return;
    const operation = response.request().postDataJSON();
    if (operation?.action !== 'open' || operation.path !== path) return;
    const value = await response.json().catch(() => null);
    if (value && !value.ok) refused = {operation, error:value.error};
  };
  page.on('response', observe);
  try {
    for (let attempt = 0; attempt < 4; attempt++) {
      refused = null; await button.click();
      await until(async () => refused || await button.getAttribute('aria-current') === 'true', 'The requested source did not mount or reach a terminal Open refusal.');
      if (!refused) { await page.locator('.cm-content').waitFor(); return; }
      assert.equal(refused.error.code, 'busy');
      assert.equal(refused.error.message, 'A local document operation is running. Retry this action.');
      assert.equal(Number(await button.getAttribute('data-source-epoch')), refused.operation.sourceEpoch);
      await settleDocumentOperations();
    }
    assert.fail('The fixture Open remained explicitly busy after four source-bound attempts.');
  } finally { page.off('response', observe); }
}

async function navigate(reload = false) {
  // Watch requests intentionally remain open; settle completed document operations before replacing their page.
  if (reload) await settleDocumentOperations();
  const ready = action => observeResponse(async response => response.url().endsWith('/api/review') && response.request().postDataJSON()?.action === action && (await response.json()).ok);
  await Promise.all([ready('project_tree'), ready('connection'), reload ? page.reload() : page.goto(base + `/manuscript.html#session=${token}`)]);
}
async function arm(rule) {
  for (let attempt = 0; attempt < 6 && !await page.locator(`[data-color-rule="${rule.id}"]`).count(); attempt += 1) await page.locator('[data-color-next]').click();
  await page.locator(`[data-color-rule="${rule.id}"]`).click();
  assert.equal(await page.locator(`[data-color-rule="${rule.id}"]`).getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('#color-rule-dialog').isVisible(), false, 'Selecting another color arms it without opening its settings.');
}
// DOM Ranges are used only for pixel coordinates. Selection itself is made exclusively by mouse.
async function drag(quote, occurrence = 0) {
  const target = await page.evaluate(({ quote, occurrence }) => {
    let found = 0;
    for (const layer of document.querySelectorAll('.pdf-text-layer')) {
      let from = layer.textContent.indexOf(quote);
      while (from >= 0) {
        if (found++ === occurrence) {
          const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT), range = document.createRange();
          let offset = 0, start, end;
          while (walker.nextNode()) {
            const node = walker.currentNode, next = offset + node.textContent.length;
            if (!start && from < next) start = { node, offset: from - offset };
            if (from + quote.length <= next) { end = { node, offset: from + quote.length - offset }; break; }
            offset = next;
          }
          if (!start || !end) return null;
          range.setStart(start.node, start.offset); range.setEnd(start.node, start.offset + 1); const a = range.getBoundingClientRect();
          range.setStart(end.node, end.offset - 1); range.setEnd(end.node, end.offset); const b = range.getBoundingClientRect();
          return { page: Number(layer.parentElement.dataset.page), from, to: from + quote.length, quote, start: { x: a.left + .2, y: a.top + a.height / 2 }, end: { x: b.right - .2, y: b.top + b.height / 2 } };
        }
        from = layer.textContent.indexOf(quote, from + 1);
      }
    }
    return null;
  }, { quote, occurrence });
  assert.ok(target, `Actual PDF text must contain ${JSON.stringify(quote)} occurrence ${occurrence}.`);
  assert.ok(target.start.y > 0 && target.end.y < await page.evaluate(() => innerHeight), 'The drag endpoints must be visible.');
  await page.mouse.move(target.start.x, target.start.y); await page.mouse.down(); await page.mouse.move(target.end.x, target.end.y, { steps: 16 });
  const actualSelection = await page.evaluate(() => { const selected = document.getSelection(); return { nativeText: selected.toString(), rangeText: selected.rangeCount ? selected.getRangeAt(0).toString() : '' }; });
  await page.mouse.up();
  observations.push({ drag: target, nativeSelectionBeforeRelease: actualSelection.nativeText, rangeTextBeforeRelease: actualSelection.rangeText });
  assert.equal(actualSelection.rangeText, quote, 'Real pointer selection must cover the exact intended PDF text nodes.');
  return target;
}
async function markDrag(rule, quote, occurrence = 0, linked = false) {
  const beforeReview = (await snapshot()).review, before = beforeReview.pdfAnnotations || [];
  let busyResponses = 0;
  const completion = observeResponse(async response => {
    if (!response.url().endsWith('/api/review')) return false;
    const operation = response.request().postDataJSON();
    if (operation?.action !== 'pdf_mark' || operation.rule !== rule.id || operation.segments?.[0]?.quote !== quote) return false;
    const value = await response.json();
    const busy = value.error?.code === 'busy' && value.error.message === 'A local document operation is running. Retry this action.';
    return !busy || ++busyResponses >= 4;
  });
  await arm(rule); const target = await drag(quote, occurrence);
  const value = await (await completion).json(); assert.equal(value.ok, true, value.error?.message);
  const afterReview = value.result.review, after = afterReview.pdfAnnotations;
  assert.equal(after.length, before.length + 1);
  const added = after.find(annotation => !before.some(prior => prior.id === annotation.id));
  assert.ok(added); assert.equal(added.rule, rule.id); assert.equal(added.pdfPath, 'main.typ'); assert.match(added.identity, /^[a-f0-9]{64}$/);
  assert.deepEqual(added.segments, [{ page: target.page, from: target.from, to: target.to, quote }]);
  if (linked) {
    const marker = afterReview.markers.find(marker => marker.id === added.sourceMarkerId);
    assert.ok(marker, 'An exact unique PDF/source match must carry its validated source marker.');
    assert.equal(marker.rule, rule.id); assert.equal(marker.anchor.quote, quote);
    assert.equal(marker.anchor.from, section.indexOf(quote)); assert.equal(marker.anchor.to, section.indexOf(quote) + quote.length);
    assert.equal(afterReview.markers.length, beforeReview.markers.length + 1);
  } else {
    assert.equal(added.sourceMarkerId, undefined, 'Unmapped or dirty PDF text must stay unlinked.');
    assert.deepEqual(afterReview.markers, beforeReview.markers, 'A positional PDF mark cannot invent a source anchor.');
  }
  await until(async () => await page.evaluate(() => !document.getSelection() || document.getSelection().isCollapsed), 'The native blue selection still obscures the persisted color.');
  await until(async () => await page.evaluate(target => {
    const layer = document.querySelector(`.pdf-page[data-page="${target.page}"] .pdf-text-layer`); if (!layer) return false;
    for (const [name, ranges] of CSS.highlights.entries()) {
      if (!name.startsWith('undertree-pdf-annotation-')) continue;
      for (const range of ranges) {
        if (!layer.contains(range.startContainer) || !layer.contains(range.endContainer) || range.toString() !== target.quote) continue;
        const prefix = document.createRange(); prefix.selectNodeContents(layer); prefix.setEnd(range.startContainer, range.startOffset);
        if (prefix.toString().length === target.from) return true;
      }
    }
    return false;
  }, target), 'The persisted annotation has no colored overlay on its exact PDF text offsets.');
  assert.deepEqual((await annotations()).find(annotation => annotation.id === added.id), added);
  await unchanged(); return added;
}
async function visibleAnnotations(count) {
  await until(async () => await page.locator('#typst-preview').getAttribute('data-pdf-annotations') === String(count), 'The current annotation inventory was not rendered.');
  assert.ok(await page.evaluate(() => [...CSS.highlights.entries()].some(([name, ranges]) => name.startsWith('undertree-pdf-annotation-') && ranges.size > 0)));
}
async function rpc(method, params) {
  if (method === 'tools/call' && params.name === 'suggest_text' && !params.arguments.proposal.contextId) {
    const context = await readFixtureContext(rpc, params.arguments.documentId);
    params = { ...params, arguments: { ...params.arguments, proposal: { ...params.arguments.proposal, contextId: context.contextId } } };
  }
  const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-06-18' }, body: JSON.stringify({ jsonrpc: '2.0', id: randomBytes(4).toString('hex'), method, params }), signal: AbortSignal.timeout(10_000) });
  assert.equal(response.status, 200); const result = await response.json(); assert.equal(result.error, undefined, JSON.stringify(result)); return result.result;
}

try {
  await mkdir(resolve('artifacts'), { recursive: true }); await mkdir(projectRoot); await cp(selectedBinary, binary); await cp(selectedAssets, assets, { recursive: true });
  for (const [path, bytes] of Object.entries(originals)) await writeFile(join(projectRoot, path), bytes);
  const targetFile = join(root, 'zrok-target'), fixture = await createZrokFixture(root, targetFile, 'highlighter.example.org');
  service = spawn(binary, [], { windowsHide: true, env: { ...process.env, ...fixture.environment, UNDERTREE_REVIEW_PORT: '0', UNDERTREE_REVIEW_STATE: join(root, 'state'), UNDERTREE_REVIEW_ASSETS: assets, UNDERTREE_REVIEW_TOKEN: token, UNDERTREE_ZROK: fixture.executable }, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [service.stdout, service.stderr]) stream.on('data', bytes => { log = (log + bytes).slice(-24_000); port = Number(log.match(/127\.0\.0\.1:(\d+)/)?.[1]); });
  await until(() => !!port, 'The isolated highlighter authority did not start.'); base = `http://127.0.0.1:${port}`; project = await local({ action: 'add_project', root: projectRoot });
  const mainSnapshot = await snapshot('main.typ'); await local({ action: 'set_main_document', project: project.id, path: 'main.typ', ...binding(mainSnapshot) });
  browser = await chromium.launch({ executablePath: process.env.UNDERTREE_CHROME, headless: true, args: ['--no-sandbox'] }); page = await browser.newPage({ viewport: { width: 1700, height: 1050 } });
  page.on('request', request => {
    if (!/\/api\/(review|editor)$/.test(request.url()) || ['review_changes', 'editor_poll', 'control_poll'].includes(request.postDataJSON()?.action)) return;
    pendingNative.add(request); lastNativeActivity = Date.now();
  });
  const completed = request => { if (pendingNative.delete(request)) lastNativeActivity = Date.now(); };
  page.on('requestfinished', completed); page.on('requestfailed', completed);
  page.on('pageerror', error => errors.push(error.message));
  page.on('response', async response => { if (response.url().endsWith('/api/review')) { const operation = response.request().postDataJSON(); const value = await response.json().catch(() => null); traffic.push({ action: operation?.action, ok: value?.ok, error: value?.error }); } });
  await navigate(); await open('main.typ');
  const initialAnnotationRead = observeResponse(async response => response.url().endsWith('/api/review') && response.request().postDataJSON()?.action === 'pdf_annotations' && (await response.json()).ok);
  await settleDocumentOperations(); await page.locator('#typst-compile').click();
  await until(async () => await page.locator('#typst-preview-status').getAttribute('data-state') === 'current' && await page.locator('.pdf-text-layer span').count() > 0, 'The real main/include publication did not render.');
  await initialAnnotationRead;
  await open('section.typ'); await until(async () => await page.locator('.pdf-text-layer span').count() > 0, 'The included source did not retain the main PDF.');
  const rules = (await snapshot()).review.rules; let prompt = rules.find(rule => rule.action === 'prompt'); const protect = rules.find(rule => rule.action === 'protect'); assert.ok(prompt && protect);
  await page.locator(`[data-color-configure="${prompt.id}"]`).click(); await page.locator('#color-rule-shorten').uncheck(); await page.locator('#color-rule-detail').uncheck(); await page.locator('#color-rule-prompt').fill(linkedPrompt); await page.locator('#color-rule-save').click(); await page.locator('#color-rule-dialog').waitFor({ state: 'hidden' });
  prompt = (await snapshot()).review.rules.find(rule => rule.id === prompt.id); assert.equal(prompt.prompt, linkedPrompt);
  const first = await markDrag(prompt, firstQuote, 0, true);
  done('Clicking a color first, then a real pointer drag in the main PDF while an included source is active, reveals its color and links only the exact unique source passage.');
  const repeatedA = await markDrag(prompt, repeatedQuote, 0), repeatedB = await markDrag(prompt, repeatedQuote, 1);
  assert.notEqual(repeatedA.segments[0].from, repeatedB.segments[0].from); assert.equal(repeatedA.identity, repeatedB.identity);
  await page.locator('[data-color-add]').first().click(); await page.locator('#color-rule-label').fill('PDF-only instructions');
  await page.locator('#color-rule-color').evaluate(input => { input.value = '#b148a4'; input.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.locator('#color-rule-prompt').fill(unlinkedPrompt); await page.locator('#color-rule-save').click(); await page.locator('#color-rule-dialog').waitFor({ state: 'hidden' });
  const pdfOnly = (await snapshot()).review.rules.find(rule => rule.label === 'PDF-only instructions'); assert.equal(pdfOnly.prompt, unlinkedPrompt);
  assert.notEqual(pdfOnly.color, prompt.color); const privateMark = await markDrag(pdfOnly, privateQuote);
  const beforePrivateNote = await snapshot();
  await local({ action: 'pdf_mark', project: project.id, path: 'section.typ', revision: beforePrivateNote.review.revision, identity: privateMark.identity, pdfPath: privateMark.pdfPath, segments: privateMark.segments, rule: pdfOnly.id, prompt: privateAnnotationPrompt, ...binding(beforePrivateNote) });
  const privateNote = (await annotations()).find(annotation => annotation.prompt === privateAnnotationPrompt);
  assert.ok(privateNote && !privateNote.sourceMarkerId);
  done('Repeated text occurrences and a passage absent from the active source are marked by page offsets rather than guessed source matches.');
  // Select the full printed mixed-format paragraph, including its actual visual wrapping.
  const wrapped = await page.locator('.pdf-text-layer').evaluateAll(layers => {
    for (const layer of layers) { const text = layer.textContent, start = text.indexOf('Mixed '), end = text.indexOf('raw source formatting.'); if (start >= 0 && end >= start) return text.slice(start, end + 'raw source formatting.'.length); }
    return null;
  });
  assert.ok(wrapped); const mixed = await markDrag(prompt, wrapped);
  assert.ok(!mixed.segments[0].quote.includes('*') && !mixed.segments[0].quote.includes('_')); assert.ok(mixed.segments[0].quote.includes('40') && mixed.segments[0].quote.includes('2026') && mixed.segments[0].quote.includes('18.2'));
  done('One real drag marks wrapped bold/italic printed prose and preserves inline numbers without requiring source-format delimiters.');
  await arm(prompt); await page.locator(`[data-color-configure="${prompt.id}"]`).click(); await page.locator('#color-rule-dialog').waitFor({ state: 'visible' }); await page.keyboard.press('Escape'); await page.locator('#color-rule-dialog').waitFor({ state: 'hidden' });
  const count = (await annotations()).length; await visibleAnnotations(count);
  await page.locator('#pdf-zoom-in').click(); await until(async () => await page.locator('.pdf-text-layer').count() > 0, 'Zoom did not restore the text layer.'); await visibleAnnotations(count);
  await page.locator('#pdf-page-number').fill('7'); await page.locator('#pdf-page-number').press('Enter'); await until(async () => await page.locator('.pdf-page[data-page="7"]').count() > 0, 'The scrolled page did not render.');
  await page.locator('#pdf-page-number').fill('1'); await page.locator('#pdf-page-number').press('Enter'); await until(async () => await page.locator('.pdf-page[data-page="1"] .pdf-text-layer').count() > 0, 'Returning to page one did not repaint its text.'); await visibleAnnotations(count);
  await navigate(true); await open('section.typ'); await until(async () => await page.locator('.pdf-text-layer').count() > 0, 'Reopening did not restore the saved PDF.'); await visibleAnnotations(count);
  assert.deepEqual((await annotations()).map(annotation => annotation.id).sort(), [first, repeatedA, repeatedB, privateMark, privateNote, mixed].map(annotation => annotation.id).sort()); await unchanged();
  done('PDF annotation IDs and colored ranges survive settings dismissal, zoom, offscreen virtualization and browser reopen.');
  await page.screenshot({ path: resolve('artifacts/pdf-highlighter-annotations.png') });
  // A known pre-dispatch busy response must not replay a captured selection after zoom replaces its DOM.
  let releaseBusy, heldBusy = false, dispatchedMarks = 0;
  const busyGate = new Promise(resolve => { releaseBusy = resolve; });
  await page.route('**/api/review', async route => {
    if (route.request().postDataJSON().action !== 'pdf_mark') return route.continue();
    dispatchedMarks += 1; heldBusy = true; await busyGate;
    return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ ok: false, error: { code: 'busy', message: 'A local document operation is running. Retry this action.' } }) });
  });
  try {
    const before = await annotations(); await arm(prompt); await drag(firstQuote);
    await until(() => heldBusy, 'The queued annotation did not reach its pre-dispatch gate.');
    const oldLayer = await page.locator('.pdf-text-layer').first().elementHandle();
    await page.locator('#pdf-zoom-in').click();
    await until(async () => await oldLayer.evaluate(layer => !layer.isConnected), 'Zoom did not retire the captured text layer.');
    await until(async () => await page.locator('.pdf-text-layer').count() > 0, 'The replacement zoom layer did not render.');
    releaseBusy();
    await until(async () => /PDF or highlighter changed/.test(await page.locator('#review-status').textContent()), 'A stale PDF selection was not refused after zoom.');
    assert.equal(dispatchedMarks, 1, 'A PDF selection from the previous viewer generation must not be retried.');
    assert.deepEqual(await annotations(), before); await unchanged();
  } finally { releaseBusy(); await page.unrouteAll({ behavior: 'wait' }); }
  done('A selection queued behind a known pre-dispatch busy response is rejected when zoom changes its PDF generation.');
  // Metadata-only marking must not flush an independent dirty source buffer.
  await page.route('**/api/review', route => { const operation = route.request().postDataJSON(); return operation.action === 'save' ? route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ ok: false, error: { code: 'busy', message: 'The isolated highlighter fixture keeps this local draft unsaved.' } }) }) : route.continue(); });
  try {
    await page.locator('.cm-content').focus(); await page.keyboard.press('Control+End'); await page.keyboard.insertText('Unsaved local tail.');
    await until(async () => await page.locator('#save-label').textContent() === 'Unsaved changes', 'The fixture draft did not become dirty.');
    await page.locator('#pdf-fit-width').click(); await until(async () => await page.locator('.pdf-text-layer').count() > 0, 'Fit width did not restore the text layer.');
    const dirtyMark = await markDrag(prompt, 'bold words'); assert.ok(dirtyMark);
    assert.match(await page.locator('.cm-content').textContent(), /Unsaved local tail\.$/); assert.equal(await page.locator('#save-label').textContent(), 'Unsaved changes'); await unchanged();
    await page.locator('.cm-content').focus(); await page.keyboard.press('Control+z'); await until(async () => !/Unsaved local tail\.$/.test(await page.locator('.cm-content').textContent()), 'Undo did not preserve and remove the local draft.');
  } finally { await page.unrouteAll({ behavior: 'wait' }); }
  done('An annotation on the retained PDF preserves a dirty source buffer and its unsaved state without implicit source saves.');
  const tunnel = await local({ action: 'tunnel', enabled: true, reservation: 'highlighter-fixture', public_url: 'https://highlighter.example.org/' }); endpoint = (await readFile(targetFile, 'utf8')).trim() + new URL(tunnel.endpoint).pathname;
  const beforeShare = await snapshot(); const share = await local({ action: 'share', project: project.id, path: 'section.typ', enabled: true, ...binding(beforeShare) });
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'PDF highlighter fixture', version: '1' } });
  // The first incoming proposal can reveal this pane. Establish its final PDF geometry before any drag coordinates.
  if (await page.locator('#review-toggle').getAttribute('aria-pressed') !== 'true') {
    const oldLayer = await page.locator('.pdf-text-layer').first().elementHandle();
    await page.locator('#review-toggle').click();
    await until(async () => await oldLayer.evaluate(layer => !layer.isConnected), 'Opening Review did not update the fitted PDF.');
    await until(async () => await page.locator('.pdf-text-layer').count() > 0, 'The fitted PDF did not reappear beside Review.');
  }
  await settleDocumentOperations();
  const propose = async requestId => {
    const current = await snapshot(); let result;
    await until(async () => { result = await rpc('tools/call', { name: 'suggest_text', arguments: { documentId: share.documentId, proposal: { requestId, revision: current.review.revision, from: section.indexOf(firstQuote), to: section.indexOf(firstQuote) + firstQuote.length, quote: firstQuote, replacement: 'A suggested source revision.', rationale: 'Synthetic suggestion-only boundary check.' } } }); return !['A local document operation is running. Retry this action.', 'A local editor operation is running. Retry this action.'].some(message => JSON.stringify(result).includes(message)); }, 'The proposal remained busy.'); return result;
  };
  const proposed = await propose('before-pdf-protection'); assert.equal(proposed.isError, false);
  assert.ok(JSON.stringify(proposed).includes(linkedPrompt), 'The actual linked PDF instructions must accompany the resulting source proposal.');
  await page.locator('.suggestion-card .accept-suggestion').waitFor(); await settleDocumentOperations();
  const protectedMark = await markDrag(protect, wrapped); assert.equal((await propose('after-pdf-protection')).isError, true); await unchanged();
  await page.locator('.suggestion-card .accept-suggestion').waitFor(); await settleDocumentOperations();
  const acceptResponse = observeResponse(response => response.url().endsWith('/api/review') && response.request().postDataJSON()?.action === 'decide'); await page.locator('.suggestion-card .accept-suggestion').click(); const acceptance = await (await acceptResponse).json(); assert.equal(acceptance.ok, false); assert.equal(acceptance.error.code, 'protected_pdf'); await unchanged();
  const current = await snapshot(); await local({ action: 'pdf_unmark', project: project.id, path: 'section.typ', revision: current.review.revision, id: protectedMark.id, ...binding(current) });
  const afterUnmarkProposal = await propose('after-local-pdf-unmark'); assert.equal(afterUnmarkProposal.isError, false, JSON.stringify(afterUnmarkProposal)); assert.ok((await snapshot()).review.suggestions.every(suggestion => suggestion.status === 'pending')); await unchanged();
  assert.ok((await annotations()).some(annotation => annotation.prompt === privateAnnotationPrompt && !annotation.sourceMarkerId));
  const remote = await rpc('tools/call', { name: 'read_manuscript', arguments: { documentId: share.documentId } });
  observations.push({ remoteRead: remote });
  assert.ok(JSON.stringify(remote).includes(linkedPrompt), 'An exactly linked PDF annotation must expose its actual instructions to source suggestions.');
  const complete = contextValue(remote);
  assert.deepEqual(complete.context.files.map(file => file.path).sort(), ['main.typ', 'section.typ']);
  assert.ok(JSON.stringify(complete.context).includes(privateQuote), 'The explicitly approved complete main manuscript is necessary source context.');
  assert.ok(JSON.stringify(remote).includes(unlinkedPrompt), 'The historically shared owner palette remains available as labeled rule context.');
  assert.ok(!JSON.stringify(remote).includes(privateAnnotationPrompt), 'Annotation-only instructions must remain private.');
  assert.ok(!JSON.stringify(remote).includes('pdfAnnotations'), 'Raw positional PDF records must not be forwarded as source context.');
  await unchanged();
  done('Unlinked PDF protection blocks new MCP proposals and explicit local acceptance project-wide until local removal; pending suggestions never modify source and raw PDF-only annotation instructions remain private.');
  await settleDocumentOperations(); await arm(prompt);
  await page.screenshot({ path: resolve('artifacts/pdf-highlighter.png') }); assert.deepEqual(errors, []);
  console.log(`PDF highlighter: ${checks.length} real pointer-drag/service/MCP checks passed.`);
} catch (error) {
  failure = error; if (page) { errors.push(await page.locator('#review-status').textContent({ timeout: 1000 }).catch(() => 'Status unavailable')); await page.screenshot({ path: resolve('artifacts/pdf-highlighter-failure.png'), timeout: 5000 }).catch(() => {}); } throw error;
} finally {
  if (base && service?.exitCode === null) await local({ action: 'tunnel', enabled: false, reservation: '', public_url: '' }).catch(error => errors.push(`Fixture cleanup: ${error.message}`));
  await browser?.close(); service?.kill('SIGINT'); if (service) { await Promise.race([new Promise(resolve => { if (service.exitCode !== null) resolve(); else service.once('exit', resolve); }), new Promise(resolve => setTimeout(resolve, 3000))]); if (service.exitCode === null) service.kill('SIGKILL'); }
  await writeFile(output, JSON.stringify({ result: failure ? 'failed' : 'passed', error: failure?.message, checks, observations, errors, traffic, binarySha256: await readFile(binary).then(hash).catch(() => null), manuscriptHtmlSha256: await readFile(join(assets, 'manuscript.html')).then(hash).catch(() => null), runnerSha256, originalSourceHashes: Object.fromEntries(Object.entries(originals).map(([name, bytes]) => [name, hash(bytes)])), serviceLog: failure ? log : undefined }, null, 2) + '\n');
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
