import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { createZrokFixture } from './zrok-fixture.mjs';
import { consentToFixtureShare, readFixtureContext } from './context-fixture.mjs';

const root = await mkdtemp(join(tmpdir(), 'undertree-ai-highlights-'));
const output = resolve(process.env.UNDERTREE_HIGHLIGHT_RECEIPTS || 'artifacts/ai-highlighting/undertree');
const binary = resolve(process.env.UNDERTREE_REVIEW_BINARY || `target/debug/undertree-review${process.platform === 'win32' ? '.exe' : ''}`);
const inputAssets = resolve(process.env.UNDERTREE_REVIEW_ASSETS || 'dist');
const copiedBinary = join(root, basename(binary)), assets = join(root, 'assets');
const projectRoot = join(root, 'project'), token = randomBytes(32).toString('hex');
const body = 'One [A]. Two [B].', suffix = '\n<p>Outside unchanged.</p>\n';
const original = `<p>${body}</p>${suffix}`, source = join(projectRoot, 'main.html');
const hash = value => createHash('sha256').update(value).digest('hex');
const checks = [], errors = [];
const editorAdmissionRefusals = [];
const frontendInputs = {};
let service, browser, page, base, endpoint, project, snapshot, log = '', failure;
async function until(check, message) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    assert.equal(service.exitCode, null, log);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw Error(message);
}
const refusedBusy = result => result.isError && result.content?.some(item => [
  'A local document operation is running. Retry this action.',
  'A local editor operation is running. Retry this action.',
].includes(item.text));
async function local(operation) {
  const consented = await consentToFixtureShare(operation, local);
  let result;
  await until(async () => {
    result = await fetch(base + '/api/review', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(consented), signal: AbortSignal.timeout(10_000) }).then(reply => reply.json());
    return result.error?.code !== 'busy';
  }, 'Native local admission remained busy.');
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.result;
}
async function rpc(method, params) {
  const reply = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-06-18' }, body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params }), signal: AbortSignal.timeout(15_000) });
  assert.equal(reply.status, 200);
  const result = await reply.json(); assert.equal(result.error, undefined, JSON.stringify(result));
  return result.result;
}
async function remote(name, args, denied = false) {
  let reply;
  await until(async () => { reply = await rpc('tools/call', { name, arguments: args }); return !refusedBusy(reply); }, 'Native remote admission remained busy.');
  assert.equal(reply.isError, denied, JSON.stringify(reply));
  return denied ? reply : reply.structuredContent?.result ?? JSON.parse(reply.content.find(item => item.type === 'text').text);
}
const saved = () => local({ action: 'review', project: project.id, path: 'main.html' });
const currentContext = () => readFixtureContext(rpc, snapshot.documentId);
async function palette(rules) {
  const current = await saved();
  return local({ action: 'palette', project: project.id, path: 'main.html', revision: current.review.revision, expectedRules: current.review.rules, rules });
}
async function reveal(selector) {
  const dialog = page.locator('#color-rule-dialog');
  for (let count = 0; count < 25; count++) {
    if (await page.locator(selector).isVisible()) return;
    const next = dialog.locator('.popup-pager button').last();
    if (!await next.isDisabled()) await next.click();
    else {
      const previous = dialog.locator('.popup-pager button').first();
      while (!await previous.isDisabled()) await previous.click();
    }
  }
  throw Error(`Unreachable rule control: ${selector}`);
}
async function saveRule() {
  await page.locator('#color-rule-save').click(); await page.locator('#color-rule-dialog').waitFor({ state: 'hidden' });
}
function editorRevision(content) {
  const digest = hash(content);
  const pending = page.waitForResponse(async reply => {
    if (!reply.url().endsWith('/api/editor')) return false;
    const operation = reply.request().postDataJSON();
    if (!['editor_register', 'editor_update'].includes(operation?.action) || operation.revision !== digest || operation.contentDigest !== digest || operation.dirty !== false || operation.conflict !== false || operation.composing !== false) return false;
    const value = await reply.json();
    if (value.error?.code === 'busy') { editorAdmissionRefusals.push({ action: operation.action, revision: digest, code: value.error.code }); return false; }
    return true;
  }).then(async reply => { const value = await reply.json(); assert.equal(value.ok, true, JSON.stringify(value)); });
  void pending.catch(() => {}); return pending;
}
async function refreshReview() {
  await until(async () => {
    const response = page.waitForResponse(reply => reply.url().endsWith('/api/review') && reply.request().postDataJSON()?.action === 'review');
    await page.locator('#review-refresh').click();
    const value = await (await response).json();
    if (value.error?.code === 'busy') return false;
    assert.equal(value.ok, true, JSON.stringify(value)); return true;
  }, 'The explicit review refresh did not obtain a current native snapshot.');
}
async function sourcePoint(quote) {
  return page.locator('.cm-content').evaluate((content, quote) => {
    const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const from = walker.currentNode.textContent.indexOf(quote);
      if (from < 0) continue;
      const range = document.createRange(); range.setStart(walker.currentNode, from); range.setEnd(walker.currentNode, from + quote.length);
      const rect = range.getBoundingClientRect(); return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    }
    throw Error('Highlighted source quote is missing.');
  }, quote);
}
async function assertSource(expected) { assert.equal(await readFile(source, 'utf8'), expected); }
try {
  await mkdir(output, { recursive: true }); await mkdir(projectRoot);
  await writeFile(source, original); await cp(binary, copiedBinary); await cp(inputAssets, assets, { recursive: true });
  async function recordAssets(directory, prefix = '') {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name), relative = prefix + entry.name;
      if (entry.isDirectory()) await recordAssets(path, relative + '/');
      else if (entry.isFile()) frontendInputs[relative] = hash(await readFile(path));
    }
  }
  await recordAssets(assets);
  const target = join(root, 'zrok-target'), fixture = await createZrokFixture(root, target, 'highlight.example.org');
  service = spawn(copiedBinary, ['serve'], { windowsHide: true, env: { ...process.env, ...fixture.environment, UNDERTREE_REVIEW_PORT: '0', UNDERTREE_REVIEW_STATE: join(root, 'state'), UNDERTREE_REVIEW_ASSETS: assets, UNDERTREE_REVIEW_TOKEN: token, UNDERTREE_ZROK: fixture.executable }, stdio: ['ignore', 'pipe', 'pipe'] });
  service.on('error', error => { failure = error; });
  for (const stream of [service.stdout, service.stderr]) stream.on('data', bytes => { log = (log + bytes).slice(-12_000); const port = log.match(/127\.0\.0\.1:(\d+)/)?.[1]; if (port) base = `http://127.0.0.1:${port}`; });
  await until(() => { if (failure) throw failure; return !!base; }, 'Isolated Rust host did not start.');
  project = await local({ action: 'add_project', root: projectRoot });
  snapshot = await local({ action: 'open', project: project.id, path: 'main.html' });
  const tunnel = await local({ action: 'tunnel', enabled: true, reservation: 'ai-highlighting-test', public_url: 'https://highlight.example.org' });
  endpoint = (await readFile(target, 'utf8')) + new URL(tunnel.endpoint).pathname;
  await local({ action: 'share', project: project.id, path: 'main.html', enabled: true });
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'AI highlighting qualification', version: '1' } });
  const tools = (await rpc('tools/list', {})).tools;
  assert.deepEqual(tools.map(tool => tool.name).sort(), ['highlight_text', 'list_manuscripts', 'read_manuscript', 'suggest_text']);
  const context = await currentContext();
  const marking = { requestId: randomUUID(), revision: context.revision, contextId: context.contextId, ranges: ['[A]', '[B]'].map(quote => ({ from: original.indexOf(quote), to: original.indexOf(quote) + quote.length, quote })) };
  const request = { documentId: snapshot.documentId, marking };
  const marked = await remote('highlight_text', request);
  assert.equal(marked.markers.length, 2); await assertSource(original);
  const metadata = await readFile(source + '.undertree-review.json');
  assert.deepEqual(await remote('highlight_text', request), marked);
  assert.deepEqual(await readFile(source + '.undertree-review.json'), metadata);
  const neutral = (await saved()).review.rules.find(rule => rule.id === marked.colorId);
  assert.equal(neutral.action, 'neutral'); assert.equal(neutral.prompt, '');
  checks.push('Exact four-tool HTTP catalogue; complete-context neutral batch and identical replay preserve all source bytes and marker identities.');
  const fresh = await currentContext();
  const invalid = { ...marking, requestId: randomUUID(), contextId: fresh.contextId, ranges: [...marking.ranges, { from: 0, to: 1, quote: 'wrong' }] };
  await remote('highlight_text', { documentId: snapshot.documentId, marking: invalid }, true);
  await remote('highlight_text', { documentId: snapshot.documentId, marking: { ...marking, requestId: randomUUID(), contextId: fresh.contextId, action: 'prompt' } }, true);
  await remote('highlight_text', { documentId: snapshot.documentId, marking: { ...marking, requestId: randomUUID(), contextId: fresh.contextId, colorId: 'protect' } }, true);
  await remote('suggest_text', { documentId: snapshot.documentId, proposal: { requestId: randomUUID(), contextId: fresh.contextId, revision: fresh.revision, ...marking.ranges[0], replacement: 'changed', rationale: 'Neutral marks must deny this.' } }, true);
  assert.deepEqual(await readFile(source + '.undertree-review.json'), metadata); await assertSource(original);
  checks.push('Invalid atomic batch, hidden action payload, rule-bearing color reuse and neutral-only wording change are refused without metadata/source mutation.');
  browser = await chromium.launch({ executablePath: process.env.UNDERTREE_CHROME || (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : '/usr/bin/google-chrome'), headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } }); page.on('pageerror', error => errors.push(error.message));
  await page.goto(base + `/manuscript.html#session=${token}`);
  await page.locator('.file-button[data-path="main.html"]').click(); await page.locator('.cm-content').waitFor();
  const point = await sourcePoint('[A]'); await page.mouse.dblclick(point.x, point.y);
  await page.locator('#color-rule-dialog').waitFor();
  assert.equal(await page.locator('input[name="color-rule-action"][value="neutral"]').isChecked(), true);
  assert.equal((await saved()).review.markers.length, 2); await assertSource(original);
  await reveal('input[name="color-rule-action"][value="protect"]'); await page.locator('input[name="color-rule-action"][value="protect"]').check(); await saveRule();
  assert.equal((await saved()).review.rules.find(rule => rule.id === marked.colorId).action, 'protect');
  const before = await saved();
  await local({ action: 'mark', project: project.id, path: 'main.html', revision: before.review.revision, from: 3, to: 20, rule: 'snappier', prompt: '' });
  if (await page.locator('#review-toggle').getAttribute('aria-pressed') !== 'true') await page.locator('#review-toggle').click();
  await refreshReview();
  const overlapPoint = await sourcePoint('[A]'); await page.mouse.dblclick(overlapPoint.x, overlapPoint.y);
  await page.locator('#highlight-color-dialog').waitFor();
  assert.equal(await page.locator('#highlight-color-choice option').count(), 2);
  await page.locator('#highlight-color-choice').selectOption(marked.colorId); await page.locator('#highlight-color-form button[type="submit"]').click(); await page.locator('#color-rule-dialog').waitFor();
  assert.equal(await page.locator('input[name="color-rule-action"][value="protect"]').isChecked(), true);
  await page.locator('#color-rule-dialog [data-close]').click(); await assertSource(original);
  await page.locator('.cm-content').focus(); await page.keyboard.press('Control+Home');
  for (let index = 0; index < original.indexOf('[A]') + 1; index++) await page.keyboard.press('ArrowRight');
  await page.keyboard.press('F4'); await page.locator('#highlight-color-dialog').waitFor();
  assert.equal(await page.locator('#highlight-color-choice option').count(), 2);
  await page.locator('#highlight-color-dialog [data-close]').click();
  assert.equal((await saved()).review.markers.length, 3); await assertSource(original);
  checks.push('Real CodeMirror double-click opens neutral settings; only the local Save assigns Protect. Overlapping source colors require explicit selection without adding marks.');
  const ids = new Map(marked.markers.map(marker => [marker.anchor.quote, marker.id]));
  const propose = async (text, quote, direct = false) => {
    const context = await currentContext();
    return remote('suggest_text', { documentId: snapshot.documentId, proposal: { requestId: randomUUID(), contextId: context.contextId, revision: context.revision, from: 3, to: 3 + quote.length, quote, replacement: '', replacementParts: text, rationale: direct ? 'Locally authorized direct rearrangement.' : 'Preserve both exact protected citations.' } });
  };
  const parts = [{ protectedId: ids.get('[B]') }, { text: ' then ' }, { protectedId: ids.get('[A]') }, { text: '.' }];
  const rejectedCandidate = await propose([{ protectedId: ids.get('[A]') }, { text: ' follows ' }, { protectedId: ids.get('[B]') }, { text: '.' }], body);
  const pending = await propose(parts, body); assert.equal(pending.manuscriptChanged, false); await assertSource(original);
  if (await page.locator('#review-toggle').getAttribute('aria-pressed') !== 'true') await page.locator('#review-toggle').click();
  const acceptedCard = page.locator(`.suggestion-card[data-review-id="${pending.suggestion.id}"]`);
  const rejectedCard = page.locator(`.suggestion-card[data-review-id="${rejectedCandidate.suggestion.id}"]`);
  await refreshReview(); await acceptedCard.locator('.replacement').waitFor();
  assert.equal(await acceptedCard.locator('.replacement').textContent(), '[B] then [A].');
  const accepted = `<p>[B] then [A].</p>${suffix}`;
  const acceptancePublished = editorRevision(accepted);
  await acceptedCard.locator('.accept-suggestion').click();
  await until(async () => await readFile(source, 'utf8') === accepted, 'Local acceptance did not commit preserved units.');
  await acceptedCard.waitFor({ state: 'detached' }); await acceptancePublished;
  await rejectedCard.locator('.reject-suggestion').click();
  await rejectedCard.waitFor({ state: 'detached' });
  const after = await saved();
  for (const marker of marked.markers) {
    const current = after.review.markers.find(value => value.id === marker.id);
    assert.equal(current.anchor.stale, false); assert.equal(current.anchor.quote, marker.anchor.quote);
    assert.equal(accepted.slice(current.anchor.from, current.anchor.to), marker.anchor.quote);
  }
  checks.push('Native protected-unit references render as a pending proposal; actual local Accept reorders intact citations, preserves their IDs/protection and leaves all surrounding HTML exact.');
  for (const [key, expected] of [['Control+z', original], ['Control+y', accepted]]) {
    await page.locator('.cm-content').focus(); await page.keyboard.press(key);
    await until(async () => (await page.locator('.cm-content').innerText()).trimEnd() === expected.trimEnd(), 'Editor history did not restore the exact protected source.');
    const published = editorRevision(expected); await page.keyboard.press('Control+s');
    await until(async () => await readFile(source, 'utf8') === expected, 'The history transition did not save through the normal local path.');
    await published;
    assert.equal((await saved()).review.suggestions.find(value => value.id === rejectedCandidate.suggestion.id).status, 'rejected', 'Undo/Redo must not revive a rejected proposal.');
  }
  checks.push('Rejecting an older pending proposal remains terminal through actual editor Undo/Save and Redo/Save of a later protected rewrite.');
  await palette(after.review.rules.map(rule => rule.id === 'snappier' ? { ...rule, accessMode: 'direct' } : rule));
  const direct = await propose([{ protectedId: ids.get('[A]') }, { text: ' before ' }, { protectedId: ids.get('[B]') }, { text: '.' }], '[B] then [A].', true);
  assert.equal(direct.manuscriptChanged, true);
  const applied = `<p>[A] before [B].</p>${suffix}`; await assertSource(applied);
  await until(async () => (await page.locator('.cm-content').innerText()).trimEnd() === applied.trimEnd(), 'The clean CodeMirror editor did not adopt the native direct receipt.');
  checks.push('A separately direct-authorized enclosing rule applies a second intact protected move, and the clean editor adopts the native receipt.');
  await page.screenshot({ path: join(output, 'source-protected-move.png') });
  await page.locator('.cm-content').focus(); await page.keyboard.press('Control+z');
  await until(async () => (await page.locator('.cm-content').innerText()).trimEnd() === accepted.trimEnd(), 'Editor Undo did not restore the first preserved move.');
  const undoPublished = editorRevision(accepted); await page.keyboard.press('Control+s');
  await until(async () => await readFile(source, 'utf8') === accepted, 'Undo did not save through the normal local path.');
  await undoPublished;
  for (const marker of marked.markers) {
    const current = (await saved()).review.markers.find(value => value.id === marker.id);
    assert.equal(current.anchor.stale, false); assert.equal(accepted.slice(current.anchor.from, current.anchor.to), marker.anchor.quote);
  }
  await page.locator('.cm-content').focus(); await page.keyboard.press('Control+y');
  await until(async () => (await page.locator('.cm-content').innerText()).trimEnd() === applied.trimEnd(), 'Editor Redo did not restore the second preserved move.');
  const redoPublished = editorRevision(applied); await page.keyboard.press('Control+s');
  await until(async () => await readFile(source, 'utf8') === applied, 'Redo did not save through the normal local path.');
  await redoPublished;
  for (const marker of marked.markers) {
    const current = (await saved()).review.markers.find(value => value.id === marker.id);
    assert.equal(current.anchor.stale, false); assert.equal(applied.slice(current.anchor.from, current.anchor.to), marker.anchor.quote);
  }
  checks.push('Actual editor F4 chooses overlapping colors; ordinary CodeMirror Undo/Save and Redo/Save restore native protected-anchor mappings without guessing repeated text.');
  await local({ action: 'share', project: project.id, path: 'main.html', enabled: false });
  await remote('highlight_text', request, true); await assertSource(applied);
  checks.push('Revoking the explicit document share denies the original marking replay without changing source.');
  assert.deepEqual(errors, []);
} catch (error) {
  failure = error;
  if (page) await page.screenshot({ path: join(output, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  if (base && service?.exitCode === null) await local({ action: 'tunnel', enabled: false, reservation: '', public_url: '' }).catch(error => errors.push(error.message));
  await browser?.close(); service?.kill('SIGINT');
  if (service && service.exitCode === null) await Promise.race([new Promise(resolve => service.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 3000))]);
  if (service?.exitCode === null) service.kill('SIGKILL');
  await mkdir(output, { recursive: true });
  await writeFile(join(output, 'receipt.json'), JSON.stringify({ status: failure ? 'FAIL' : 'PASS', failure: failure?.message, checks, errors, editorAdmissionRefusals, binarySha256: await readFile(copiedBinary).then(hash).catch(() => null), frontendInputs, runnerSha256: hash(await readFile(new URL(import.meta.url))), qualification: 'Real Rust HTTP MCP and CodeMirror browser flow, synthetic owned tunnel. Native WebView, installed packages and public ChatGPT remain separate.' }, null, 2) + '\n');
  assert.ok(resolve(root).startsWith(resolve(tmpdir()) + '\\') || resolve(root).startsWith(resolve(tmpdir()) + '/'));
  assert.ok(basename(root).startsWith('undertree-ai-highlights-'));
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
console.log(`AI highlighting: ${checks.length} real Rust/CodeMirror/MCP checks passed.`);
