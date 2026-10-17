import { confirmContextShareUi, readFixtureContext } from './context-fixture.mjs';
import assert from 'node:assert/strict';
import { createZrokFixture } from './zrok-fixture.mjs';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const selectedBinary = resolve(process.env.UNDERTREE_REVIEW_BINARY || 'target/debug/undertree-review');
const selectedAssets = resolve(process.env.UNDERTREE_REVIEW_ASSETS || 'dist');
const receiptPath = resolve(process.env.UNDERTREE_DISCARD_RECEIPT || 'artifacts/review-discard-smoke.json');
const root = await mkdtemp(join(tmpdir(), 'undertree-discard-ui-'));
const projectRoot = join(root, 'project'), binary = join(root, `undertree-review${process.platform === 'win32' ? '.exe' : ''}`), assets = join(root, 'assets');
const token = randomBytes(32).toString('hex');
const original = '<p>Keep this. Discard this idea. Keep the ending.</p>\n';
const quote = 'Discard this idea.';
const from = original.indexOf(quote), to = from + quote.length;
const checks = [], observations = [], errors = [];
let service, browser, page, base, port, failure, log = '';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function until(check, message) {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    if (service?.exitCode !== null && service?.exitCode !== undefined) throw Error(log);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw Error(message);
}
async function call(operation) {
  for (let attempt = 0; attempt < 30; attempt++) {
    const response = await fetch(base + '/api/review', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(operation), signal: AbortSignal.timeout(10_000) });
    const value = await response.json();
    if (['open', 'review', 'connection'].includes(operation.action) && value.error?.code === 'busy' && value.error.message === 'A local document operation is running. Retry this action.' && attempt < 29) { await new Promise(resolve => setTimeout(resolve, 50)); continue; }
    assert.equal(value.ok, true, value.error?.message); return value.result;
  }
}
async function menuAction(label) {
  await page.locator('#menu-format summary').click();
  await page.locator('#menu-format').getByRole('button', { name: label, exact: true }).click();
}
async function clickOperation(selector, expected) {
  for (let attempt = 0; attempt < 30; attempt++) {
    const response = page.waitForResponse(response => {
      if (!response.url().endsWith('/api/review') || response.request().method() !== 'POST') return false;
      const operation = response.request().postDataJSON(); return Object.entries(expected).every(([key, value]) => operation[key] === value);
    });
    await page.locator(selector).click();
    if (selector === '#manuscript-share') await confirmContextShareUi(page, ['main.html']);
    const value = await (await response).json();
    if (value.error?.code === 'busy' && value.error.message === 'A local document operation is running. Retry this action.' && attempt < 29) { await new Promise(resolve => setTimeout(resolve, 50)); continue; }
    assert.equal(value.ok, true, value.error?.message); return;
  }
}
try {
  await mkdir(projectRoot); await cp(selectedBinary, binary); await chmod(binary, 0o700); await cp(selectedAssets, assets, { recursive: true });
  await writeFile(join(projectRoot, 'main.html'), original);
  const targetFile = join(root, 'zrok-target');
  const zrokFixture = await createZrokFixture(root, targetFile, 'review.example.org');
  service = spawn(binary, [], { env: { ...process.env, ...zrokFixture.environment, UNDERTREE_REVIEW_PORT: '0', UNDERTREE_REVIEW_STATE: join(root, 'state'), UNDERTREE_REVIEW_ASSETS: assets, UNDERTREE_REVIEW_TOKEN: token, UNDERTREE_ZROK: zrokFixture.executable }, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [service.stdout, service.stderr]) stream.on('data', bytes => { log = (log + bytes).slice(-16_000); port = Number(log.match(/127\.0\.0\.1:(\d+)/)?.[1]); });
  await until(() => !!port, 'The isolated discard service did not start.'); base = `http://127.0.0.1:${port}`;
  const project = await call({ action: 'add_project', root: projectRoot });
  const initial = await call({ action: 'open', project: project.id, path: 'main.html' });
  const binding = { sourceEpoch: initial.sourceEpoch, expectedRoot: initial.expectedRoot };
  const ruleIndex = initial.review.rules.findIndex(rule => rule.id === 'discard');
  assert.ok(ruleIndex >= 0, 'new manuscripts offer a discard rule');
  browser = await chromium.launch({ executablePath: process.env.UNDERTREE_CHROME || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } }); page.on('pageerror', error => errors.push(error.message));
  page.setDefaultTimeout(60_000);
  await page.goto(base + `/manuscript.html#session=${token}`, { waitUntil: 'domcontentloaded', timeout: 60_000 }); await page.locator('#project-select').selectOption(project.id);
  await page.getByRole('button', { name: 'main.html', exact: true }).click(); await page.locator('.cm-content').waitFor();
  await menuAction('Color rules');
  const row = page.locator('.palette-row').nth(ruleIndex);
  assert.deepEqual(await row.getByLabel('Rule action').locator('option').evaluateAll(options => options.map(option => option.value)), ['prompt', 'protect', 'reject', 'discard']);
  await row.getByLabel('Rule action').selectOption('prompt'); await row.getByLabel('Rule action').selectOption('discard');
  await row.locator('input[type="color"]').evaluate(input => { input.value = '#b26a44'; input.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.getByRole('button', { name: 'Save rules', exact: true }).click(); await page.locator('#palette-dialog').waitFor({ state: 'hidden' });
  const customized = await call({ action: 'open', project: project.id, path: 'main.html', ...binding });
  assert.equal(customized.review.rules[ruleIndex].action, 'discard'); assert.equal(customized.review.rules[ruleIndex].color, '#b26a44');
  await page.locator('.cm-content').focus(); await page.keyboard.press('Control+Home');
  for (let index = 0; index < from; index++) await page.keyboard.press('ArrowRight');
  for (let index = from; index < to; index++) await page.keyboard.press('Shift+ArrowRight');
  await menuAction('Highlight selection'); assert.equal(await page.locator('#highlight-quote').textContent(), quote);
  await page.locator('#highlight-dialog-rule').selectOption('discard'); await page.locator('#highlight-prompt').fill('This argument is superseded.');
  assert.match(await page.locator('#highlight-dialog').textContent(), /Discard requires local approval/);
  await page.getByRole('button', { name: 'Add highlight', exact: true }).click(); await page.locator('#highlight-dialog').waitFor({ state: 'hidden' });
  if (await page.locator('#review-toggle').getAttribute('aria-pressed') !== 'true') await page.locator('#review-toggle').click();
  await clickOperation('#manuscript-share', { action: 'share', enabled: true });
  await until(async () => (await call({ action: 'connection' })).shared.some(share => share.project === project.id && share.path === 'main.html'), 'The local UI did not confirm manuscript sharing.');
  const marked = await call({ action: 'open', project: project.id, path: 'main.html', ...binding });
  assert.equal(marked.review.markers[0].rule, 'discard'); assert.equal(marked.review.markers[0].anchor.quote, quote);
  checks.push('The local palette saves a custom color with the discard action; an exact CodeMirror selection becomes a discard highlight.');
  const tunnel = await call({ action: 'tunnel', enabled: true, reservation: 'test-session', public_url: 'https://review.example.org/' });
  const endpoint = (await readFile(targetFile, 'utf8')) + new URL(tunnel.endpoint).pathname;
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-06-18' };
  async function rpc(method, params) {
    const response = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(10_000) });
    assert.equal(response.status, 200); return (await response.json()).result;
  }
  assert.equal((await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'UnderTree discard UI test', version: '1' } })).protocolVersion, '2025-06-18');
  assert.equal((await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }), signal: AbortSignal.timeout(10_000) })).status, 202);
  async function propose(requestId) {
    const snapshot = await call({ action: 'open', project: project.id, path: 'main.html', ...binding });
    const context = await readFixtureContext(rpc, snapshot.documentId);
    let result;
    await until(async () => {
      result = await rpc('tools/call', { name: 'suggest_text', arguments: { documentId: snapshot.documentId, proposal: { requestId, revision: snapshot.review.revision, contextId: context.contextId, from, to, quote, replacement: '', rationale: 'Remove the superseded argument.' } } });
      return !result.isError || !result.content?.some(item => item.text?.includes('A local document operation is running. Retry this action.'));
    }, 'The local document operation did not release its lock for the MCP proposal.');
    assert.equal(result.isError, false, JSON.stringify(result)); assert.equal(await readFile(join(projectRoot, 'main.html'), 'utf8'), original);
    await page.locator('#review-refresh').click(); await page.getByRole('heading', { name: 'Proposed deletion', exact: true }).waitFor();
    assert.equal(await page.locator('.suggestion-card').evaluate(card => card.style.getPropertyValue('--review-color')), '#b26a44');
  }
  await propose('discard-rejected');
  assert.equal(await page.locator('.suggestion-card .replacement').textContent(), 'Delete the quoted passage. Your text changes only when you accept.');
  await clickOperation('.suggestion-card .reject-suggestion', { action: 'decide', decision: 'rejected' }); await page.locator('.suggestion-card').waitFor({ state: 'detached' });
  assert.equal(await readFile(join(projectRoot, 'main.html'), 'utf8'), original);
  const rejected = await call({ action: 'open', project: project.id, path: 'main.html', ...binding });
  assert.equal(rejected.review.markers.length, 1); assert.equal(rejected.review.suggestions[0].status, 'rejected');
  await page.locator('#review-list details summary').click(); assert.match(await page.locator('#review-list details').textContent(), /Rejected: Delete “Discard this idea\.”/);
  checks.push('An MCP deletion remains pending without source writes; local rejection preserves the source and discard marker with readable history.');
  await propose('discard-accepted');
  for (const [width, height, text] of [[1440, 900, 14], [1100, 480, 14], [901, 480, 28], [900, 900, 28], [320, 900, 28], [667, 375, 14], [1440, 900, 14]]) {
    await page.setViewportSize({ width, height }); await page.evaluate(text => { document.documentElement.style.fontSize = `${text}px`; }, text);
    if (width <= 900) await page.locator('[data-view="review"]').click();
    await page.locator('.suggestion-card').scrollIntoViewIfNeeded();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const bounds = await page.evaluate(() => {
      const card = document.querySelector('.suggestion-card'), list = document.querySelector('#review-list');
      return { viewport: [innerWidth, innerHeight], page: [document.documentElement.scrollWidth, document.documentElement.scrollHeight], horizontal: list.scrollWidth > list.clientWidth + 1, labels: [...card.querySelectorAll('h3, .replacement, button')].map(element => ({ text: element.textContent, fit: element.dataset.textFit, width: element.clientWidth, scrollWidth: element.scrollWidth, height: element.clientHeight, scrollHeight: element.scrollHeight })) };
    });
    observations.push(bounds); assert.ok(bounds.page[0] <= width + 1 && bounds.page[1] <= height + 1); assert.equal(bounds.horizontal, false);
    for (const label of bounds.labels) { assert.ok(['fit', 'reflow', 'unavailable'].includes(label.fit), JSON.stringify(label)); assert.ok(label.scrollWidth <= label.width + 1 && label.scrollHeight <= label.height + 2, JSON.stringify(label)); }
  }
  const spacing = await page.addStyleTag({ content: '.suggestion-card h3, .suggestion-card .replacement, .suggestion-card button { line-height: 1.5 !important; letter-spacing: .12em !important; word-spacing: .16em !important; } .suggestion-card p { margin-bottom: 2em !important; }' });
  await page.setViewportSize({ width: 320, height: 900 }); await page.evaluate(() => { document.documentElement.style.fontSize = '28px'; });
  await page.locator('[data-view="review"]').click(); await page.locator('.suggestion-card .accept-suggestion').scrollIntoViewIfNeeded();
  await page.waitForFunction(() => [...document.querySelectorAll('.suggestion-card h3, .suggestion-card .replacement, .suggestion-card button')].every(element => ['fit', 'reflow', 'unavailable'].includes(element.dataset.textFit)));
  assert.equal(await page.locator('.suggestion-card').evaluate(card => card.scrollWidth <= card.clientWidth + 1), true);
  await spacing.evaluate(style => style.remove());
  checks.push('Deletion wording and local actions remain measured and readable across 320px, 200% text, independent width/height changes, phone landscape, regrowth and text-spacing overrides.');
  await clickOperation('.suggestion-card .accept-suggestion', { action: 'decide', decision: 'accepted' }); await page.locator('.suggestion-card').waitFor({ state: 'detached' });
  const accepted = await call({ action: 'open', project: project.id, path: 'main.html', ...binding });
  assert.equal(accepted.content, original.slice(0, from) + original.slice(to)); assert.equal(accepted.review.markers.length, 0);
  assert.equal(accepted.review.suggestions.find(suggestion => suggestion.id !== rejected.review.suggestions[0].id).status, 'accepted');
  assert.equal(await readFile(join(projectRoot, 'main.html'), 'utf8'), accepted.content);
  assert.doesNotMatch(await page.locator('.cm-content').textContent(), /Discard this idea\./); assert.match(await page.locator('.cm-content').textContent(), /Keep this\.  Keep the ending\./);
  assert.match(await page.locator('#review-list details').textContent(), /Accepted: Delete “Discard this idea\.”/); assert.deepEqual(errors, []);
  checks.push('Only the local Accept button deletes the exact marked passage and retires its consumed discard marker.');
  console.log(`Discard UI: ${checks.length} real-service/CodeMirror checks passed. Public zrok and native WebViews were not exercised.`);
} catch (error) {
  failure = error; if (page) { errors.push(await page.locator('#review-status').textContent({ timeout: 1000 }).catch(() => 'Status unavailable')); await page.screenshot({ path: resolve('artifacts/review-discard-failure.png'), timeout: 5000 }).catch(() => {}); } throw error;
} finally {
  await browser?.close(); service?.kill('SIGINT');
  if (service) { await Promise.race([new Promise(resolve => { if (service.exitCode !== null) resolve(); else service.once('exit', resolve); }), new Promise(resolve => setTimeout(resolve, 3000))]); if (service.exitCode === null) service.kill('SIGKILL'); }
  await mkdir(resolve('artifacts'), { recursive: true });
  await writeFile(receiptPath, JSON.stringify({ result: failure ? 'failed' : 'passed', error: failure?.message, selectedBinary, binarySha256: await readFile(binary).then(hash).catch(() => null), selectedAssets, runnerSha256: hash(await readFile(new URL(import.meta.url))), checks, observations, errors }, null, 2) + '\n');
  await rm(root, { recursive: true, force: true });
}
