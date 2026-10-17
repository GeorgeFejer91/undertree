// Isolated real Rust + CodeMirror + closed MCP acceptance test; never edits a user project.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { createZrokFixture } from './zrok-fixture.mjs';

const binary = resolve(process.env.UNDERTREE_REVIEW_BINARY || `target/debug/undertree-review${process.platform === 'win32' ? '.exe' : ''}`);
const inputAssets = resolve(process.env.UNDERTREE_REVIEW_ASSETS || 'dist');
const output = resolve(process.env.UNDERTREE_COLOR_RULES_RECEIPT || 'artifacts/color-rules-smoke.json');
const root = await mkdtemp(join(tmpdir(), 'undertree-color-rules-'));
const projectRoot = join(root, 'project'), assets = join(root, 'assets');
const runningBinary = join(root, `undertree-review${process.platform === 'win32' ? '.exe' : ''}`);
const token = randomBytes(32).toString('hex');
const original = '<p>Keep this exact passage. Rewrite this sentence. Unicode: naïve 🌳 e\u0301. Keep the ending.</p>\n';
const originalBytes = Buffer.from(original);
const protectedQuote = 'Keep this exact passage.', editableQuote = 'Rewrite this sentence.';
const customPrompt = 'Keep all factual claims and citations. Use plain language.';
const remoteAdmissionBusy = result => result.isError === true && result.content?.some(item => item.type === 'text' && [
  'A local document operation is running. Retry this action.',
  'A local editor operation is running. Retry this action.',
].includes(item.text));
const checks = [], observations = [], errors = [];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
let service, browser, page, port, base, log = '', failure, project;

async function until(check, message) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    if (service?.exitCode !== null && service?.exitCode !== undefined) throw Error(log);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw Error(message);
}
async function call(operation) {
  let value;
  await until(async () => {
    value = await fetch(base + '/api/review', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(operation), signal: AbortSignal.timeout(10_000) }).then(response => response.json());
    return value.error?.code !== 'busy' || value.error.message !== 'A local document operation is running. Retry this action.';
  }, 'The document operation did not finish.');
  assert.equal(value.ok, true, value.error?.message); return value.result;
}
async function saved(path = 'main.html') { return call({ action: 'review', project: project.id, path }); }
async function unchanged(message, path = 'main.html', expected = originalBytes) {
  assert.deepEqual(await readFile(join(projectRoot, path)), expected, message);
}
async function open(path) {
  const button = page.locator(`.file-button[data-path="${path}"]`);
  await button.click();
  await until(async () => await button.getAttribute('aria-current') === 'true', `${path} did not mount.`);
  await page.locator('.cm-content').waitFor();
}
async function select(quote) {
  await page.locator('.cm-content').focus(); await page.keyboard.press('Control+Home');
  for (let index = 0; index < original.indexOf(quote); index++) await page.keyboard.press('ArrowRight');
  for (let index = 0; index < quote.length; index++) await page.keyboard.press('Shift+ArrowRight');
}
async function revealColor(selector) {
  const dialog=page.locator('#color-rule-dialog');
  for(let step=0;step<30;step++) {
    if(await page.locator(selector).isVisible()) return;
    const next=dialog.locator('.popup-pager button').last();
    if(await next.isDisabled()) {
      const previous=dialog.locator('.popup-pager button').first();
      while(!await previous.isDisabled()) await previous.click();
    } else await next.click();
  }
  throw Error(`Color control is unreachable: ${selector}`);
}
async function fillRule({ label, color, action = 'prompt', prompt = '', shorten = false }) {
  await revealColor('#color-rule-label');await page.locator('#color-rule-label').fill(label);
  await page.locator('#color-rule-color').evaluate((input, color) => { input.value = color; input.dispatchEvent(new Event('input', { bubbles: true })); }, color);
  await revealColor(`input[name="color-rule-action"][value="${action}"]`);await page.locator(`input[name="color-rule-action"][value="${action}"]`).check();
  if (action === 'prompt') {
    await revealColor('#color-rule-shorten');await page.locator('#color-rule-shorten').setChecked(shorten);
    await revealColor('#color-rule-prompt');await page.locator('#color-rule-prompt').fill(prompt);
  }
}
async function saveRule() {
  await page.locator('#color-rule-save').click();
  await page.locator('#color-rule-dialog').waitFor({ state: 'hidden' });
}
async function showRule(rule) {
  if (await page.locator(`[data-color-rule="${rule}"]`).count()) return;
  await page.locator('#menu-format summary').click();
  await page.locator('#highlight-rule').selectOption(rule);
  await page.locator('#menu-format summary').click();
}
async function sourceHighlight(submit = true) {
  await page.locator('#menu-format summary').click(); await page.locator('#highlight-selection').click();
  if (submit) await page.locator('#highlight-form button[type="submit"]').click();
}
async function mark(rule, quote, keyboard = false, forcedBusy = false) {
  await showRule(rule);
  const before = (await saved()).review.markers.length;
  await select(quote);
  let attempts = 0, firstOperation;
  const priorPolicy = forcedBusy && await readFile(join(projectRoot, 'main.html.undertree-review.json'));
  const denyOnce = async route => {
    const operation = route.request().postDataJSON();
    if (operation.action !== 'mark') return route.continue();
    attempts++;
    if (attempts === 1) {
      firstOperation = operation;
      await unchanged('A known predispatch busy refusal cannot write any original bytes.');
      assert.deepEqual(await readFile(join(projectRoot, 'main.html.undertree-review.json')), priorPolicy);
      return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ ok: false, error: { code: 'busy', message: 'A local document operation is running. Retry this action.' } }) });
    }
    assert.deepEqual(operation, firstOperation, 'Only the unchanged, guarded request can be retried after the predispatch busy refusal.');
    return route.continue();
  };
  if (forcedBusy) await page.route('**/api/review', denyOnce);
  try {
    const response = page.waitForResponse(async response => {
      if (!response.url().endsWith('/api/review') || response.request().postDataJSON()?.action !== 'mark') return false;
      const value = await response.json();
      return !(value.error?.code === 'busy' && value.error.message === 'A local document operation is running. Retry this action.');
    });
    const swatch = page.locator(`[data-color-rule="${rule}"]`);
    if (keyboard) { await swatch.focus(); await page.keyboard.press('Enter'); }
    else await swatch.click();
    assert.equal((await saved()).review.markers.length, before, 'Arming a swatch alone must not mark an old selection.');
    await sourceHighlight();
    const value = await (await response).json(); assert.equal(value.ok, true, value.error?.message);
    if (forcedBusy) { assert.ok(attempts >= 2); observations.push({ predispatchBusyMarkAttempts: attempts }); }
  } finally { if (forcedBusy) await page.unroute('**/api/review', denyOnce); }
  const snapshot = await saved(); assert.equal(snapshot.review.markers.length, before + 1);
  const marker = snapshot.review.markers.at(-1);
  assert.equal(marker.rule, rule); assert.equal(marker.anchor.quote, quote);
  assert.equal(marker.anchor.from, original.indexOf(quote));
  assert.equal(marker.anchor.to, original.indexOf(quote) + quote.length);
}
async function chromePath() {
  if (process.env.UNDERTREE_CHROME) return process.env.UNDERTREE_CHROME;
  const candidates = process.platform === 'win32' ? [
    join(process.env.PROGRAMFILES || 'C:/Program Files', 'Google/Chrome/Application/chrome.exe'),
    join(process.env['PROGRAMFILES(X86)'] || 'C:/Program Files (x86)', 'Microsoft/Edge/Application/msedge.exe'),
    join(process.env.LOCALAPPDATA || 'C:/Users/Default/AppData/Local', 'Google/Chrome/Application/chrome.exe'),
  ] : ['/usr/bin/google-chrome', '/usr/bin/chromium'];
  for (const candidate of candidates) { try { await access(candidate); return candidate; } catch {} }
  throw Error('Set UNDERTREE_CHROME to an installed Chrome/Edge executable (include .exe on Windows).');
}
async function checkDialogBounds(scenario, dialogId = 'color-rule-dialog') {
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.waitForFunction(id => { const dialog = document.getElementById(id); return ['fit', 'no-fit'].includes(dialog.dataset.popupFit || dialog.dataset.contextFit) && [...dialog.querySelectorAll('[data-measure]')].filter(node => node.getClientRects().length).every(node => node.dataset.textFit && node.dataset.textFit !== 'deferred'); }, dialogId);
  const result = await page.evaluate(dialogId => {
    const dialog = document.getElementById(dialogId), rect = dialog.getBoundingClientRect();
    const regions = [dialog, dialog.querySelector('form'), ...dialog.querySelectorAll('.popup-body,.color-rule-space,.color-rule-body,.context-share-body,#context-share-content')].filter(node => node?.getClientRects().length);
    regions.forEach(node => { node.scrollTop = 100; node.scrollLeft = 100; });
    return {
      fit: dialog.dataset.popupFit || dialog.dataset.contextFit,
      scrollAreas: regions.filter(node => ['auto','scroll'].includes(getComputedStyle(node).overflowY) || ['auto','scroll'].includes(getComputedStyle(node).overflowX)).map(node => node.id || node.className),
      scrolled: regions.filter(node => node.scrollTop || node.scrollLeft).map(node => node.id || node.className),
      overflow: regions.filter(node => node.scrollHeight > node.clientHeight + 2 || node.scrollWidth > node.clientWidth + 1).map(node => node.id || node.className),
      viewport: [innerWidth, innerHeight], page: [document.documentElement.scrollWidth, document.documentElement.scrollHeight],
      rect: { x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom }, horizontal: dialog.scrollWidth > dialog.clientWidth + 1,
      labels: [...dialog.querySelectorAll('[data-measure]')].filter(element => element.getClientRects().length).map(element => ({ text: element.textContent, fit: element.dataset.textFit, width: element.clientWidth, scrollWidth: element.scrollWidth })),
    };
  }, dialogId);
  observations.push({ scenario, ...result });
  assert.ok(result.page[0] <= result.viewport[0] + 1 && result.page[1] <= result.viewport[1] + 1, JSON.stringify(result));
  assert.ok(result.rect.x >= -1 && result.rect.y >= -1 && result.rect.right <= result.viewport[0] + 1 && result.rect.bottom <= result.viewport[1] + 1, JSON.stringify(result));
  assert.equal(result.horizontal, false, JSON.stringify(result));
  assert.deepEqual(result.scrollAreas, [], JSON.stringify(result));
  assert.deepEqual(result.scrolled, [], JSON.stringify(result));
  assert.deepEqual(result.overflow, [], JSON.stringify(result));
  assert.ok(result.labels.length > 0, 'The dialog must use the real bounded text measurement path.');
  for (const label of result.labels) {
    assert.ok(['fit', 'reflow', 'unavailable'].includes(label.fit), JSON.stringify(label));
    assert.ok(label.scrollWidth <= label.width + 1, JSON.stringify(label));
  }
  const action = dialogId === 'context-share-dialog' ? '#context-share-submit' : '#color-rule-save';
  assert.equal(await page.locator(action).isVisible(), true);
  if (result.fit === 'no-fit' && dialogId === 'context-share-dialog') {
    assert.equal(await page.locator(action).isDisabled(), true, 'An unrendered consent/editor cannot approve.');
    const guidance = '#context-share-resize';
    assert.equal(await page.locator(guidance).isVisible(), true);
    const cancel = dialogId === 'context-share-dialog' ? '#context-share-cancel' : '#color-rule-dialog [data-close]';
    assert.equal(await page.locator(cancel).isVisible(), true);
  }
  return result;
}

try {
  await mkdir(resolve('artifacts'), { recursive: true }); await mkdir(projectRoot); await cp(inputAssets, assets, { recursive: true }); await cp(binary, runningBinary);
  for (const path of ['main.html', 'queued.html']) await writeFile(join(projectRoot, path), originalBytes);
  const targetFile = join(root, 'zrok-target'), fixture = await createZrokFixture(root, targetFile, 'review.example.org');
  service = spawn(runningBinary, [], { windowsHide: true, env: { ...process.env, ...fixture.environment, UNDERTREE_REVIEW_PORT: '0', UNDERTREE_REVIEW_STATE: join(root, 'state'), UNDERTREE_REVIEW_ASSETS: assets, UNDERTREE_REVIEW_TOKEN: token, UNDERTREE_ZROK: fixture.executable }, stdio: ['ignore', 'pipe', 'pipe'] });
  service.on('error', error => { log += error.message; });
  for (const stream of [service.stdout, service.stderr]) stream.on('data', bytes => { log = (log + bytes).slice(-24_000); port = Number(log.match(/127\.0\.0\.1:(\d+)/)?.[1]); });
  await until(() => !!port, 'The isolated color-rule service did not start.'); base = `http://127.0.0.1:${port}`;
  project = await call({ action: 'add_project', root: projectRoot });
  browser = await chromium.launch({ executablePath: await chromePath(), headless: true, args: ['--no-sandbox'] });
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } }); page.on('pageerror', error => errors.push(error.message));
  await page.goto(base + `/manuscript.html#session=${token}`, { waitUntil: 'domcontentloaded' });
  // A single approved project is selected by normal startup; wait for its inventory.
  await open('main.html');
  assert.equal(await page.locator('#editor-search').evaluate(element => element.nextElementSibling?.id), 'color-slots');
  assert.ok(await page.locator('[data-color-add]').count() > 0, 'An empty toolbar slot must be available.');
  await unchanged('Opening the toolbar preserves the complete original source bytes.');

  await page.locator('[data-color-add]').first().focus(); await page.keyboard.press('Enter');
  await page.locator('#color-rule-dialog').waitFor({ state: 'visible' });
  await page.keyboard.press('Escape'); await page.locator('#color-rule-dialog').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('[data-color-add]').first().evaluate(element => element === document.activeElement), true, 'Escape returns keyboard focus to the invoked slot.');
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('input[name="color-rule-access"][value="suggestions"]').isChecked(), true, 'New colors require approval by default.');
  await fillRule({ label: 'Green: factual wording', color: '#247546', prompt: customPrompt, shorten: true });
  await checkDialogBounds('normal populated popup');
  const normalBody = await page.locator('#color-rule-dialog .popup-body').evaluate(element => ({ width: element.clientWidth, scrollWidth: element.scrollWidth, height: element.clientHeight, scrollHeight: element.scrollHeight }));
  observations.push({ normalBody });
  assert.ok(normalBody.scrollWidth <= normalBody.width + 1 && normalBody.scrollHeight <= normalBody.height + 1, JSON.stringify(normalBody));
  await page.screenshot({ path: resolve('artifacts/color-rule-dialog.png') });
  await saveRule();
  const green = (await saved()).review.rules.find(rule => rule.label === 'Green: factual wording');
  assert.ok(green); assert.equal(green.color, '#247546'); assert.equal(green.action, 'prompt');
  assert.equal(green.accessMode, 'suggestions');
  assert.match(green.prompt, /shorten|shorter|concise/i); assert.ok(green.prompt.includes(customPrompt));
  await mark(green.id, editableQuote, true, true);
  await unchanged('Configuring and applying a color stores policy only; every original UTF-8 byte is unchanged.');
  checks.push('The toolbar slots sit immediately after Search; Enter/Escape restores focus, and a custom green shortening rule marks exactly the selected source range without changing source bytes.');

  await page.locator('[data-color-add]').first().click();
  await revealColor('#color-rule-permissions');await page.locator('input[name="color-rule-access"][value="direct"]').check();
  await fillRule({ label: 'Finished passage', color: '#9b7131', action: 'protect' }); await saveRule();
  const protect = (await saved()).review.rules.find(rule => rule.label === 'Finished passage');
  assert.equal(protect.accessMode, 'suggestions', 'Protect cannot retain direct edit permission.');
  await mark(protect.id, protectedQuote);
  const visible = () => page.locator('[data-color-rule]').evaluateAll(elements => elements.map(element => element.dataset.colorRule));
  const secondPage = await visible(); assert.ok(secondPage.length <= 4 && secondPage.includes(green.id) && secondPage.includes(protect.id));
  await page.locator('[data-color-next]').focus(); await page.keyboard.press('Enter');
  const firstPage = await visible(); assert.ok(firstPage.length <= 4);
  assert.deepEqual(new Set([...firstPage, ...secondPage]), new Set((await saved()).review.rules.map(rule => rule.id)), 'Keyboard paging exposes every configured rule in bounded groups.');
  await page.locator('[data-color-next]').focus(); await page.keyboard.press('Enter');
  assert.deepEqual(await visible(), secondPage);
  checks.push('Source selection survives keyboard swatch arming and explicit highlight confirmation; keyboard paging exposes all configured rules with at most four colors visible and returns to the chosen page.');
  await showRule(green.id);
  await page.locator(`[data-color-configure="${green.id}"]`).click();
  assert.equal(await page.locator('input[name="color-rule-access"][value="suggestions"]').isChecked(), true, 'Editing a color restores its saved access mode.');
  await revealColor('#color-rule-permissions');await page.locator('input[name="color-rule-access"][value="direct"]').check();
  await saveRule();
  assert.equal((await saved()).review.rules.find(rule => rule.id === green.id).accessMode, 'direct');
  await page.locator(`[data-color-configure="${green.id}"]`).click();
  assert.equal(await page.locator('input[name="color-rule-access"][value="direct"]').isChecked(), true);
  await revealColor('#color-rule-permissions');await page.locator('input[name="color-rule-access"][value="suggestions"]').check();
  await saveRule();
  await page.locator(`[data-color-configure="${green.id}"]`).click();
  assert.equal(await page.locator('#color-rule-color').inputValue(), '#247546');
  await page.locator('#color-rule-color').evaluate(input => { input.value = '#7655ad'; input.dispatchEvent(new Event('input', { bubbles: true })); });
  await saveRule(); assert.equal((await saved()).review.rules.find(rule => rule.id === green.id).color, '#7655ad');
  await unchanged('Changing a marked color and adding a no-edit rule cannot rewrite source text.');

  await select('Keep the ending.');
  await page.locator('.cm-content').dispatchEvent('compositionstart', { data: '' });
  await page.locator(`[data-color-rule="${green.id}"]`).click();
  await sourceHighlight(false);
  await until(async () => /composition|composing/i.test(await page.locator('#review-status').textContent()), 'IME composition did not block marking.');
  await page.locator('.cm-content').dispatchEvent('compositionend', { data: '' });
  assert.equal((await saved()).review.markers.length, 2);
  await unchanged('IME refusal leaves the original source intact.');
  checks.push('Existing slot settings change its color, a no-edit rule marks an exact passage, and IME composition refuses a new marker without source or policy mutation.');

  await page.locator(`[data-color-configure="${green.id}"]`).click();
  const longLabel = 'Überarbeitung 中文 🌳 '.repeat(4).trim();
  await revealColor('#color-rule-label');await page.locator('#color-rule-label').fill(longLabel);
  await revealColor('#color-rule-prompt');await page.locator('#color-rule-prompt').fill((customPrompt + ' Preserve the whole selected argument. ').repeat(35));
  const ruleFormValues = () => page.locator('.color-rule-body input,.color-rule-body textarea').evaluateAll(nodes => nodes.map(node => ({ id: node.id, name: node.name, value: node.value, checked: node.checked, disabled: node.disabled })));
  const preservedRuleValues = await ruleFormValues();
  for (const [width, height, text, expectedFit] of [[1440, 900, 14, 'fit'], [1440, 480, 14, 'fit'], [901, 480, 28, 'fit'], [900, 900, 28, 'fit'], [320, 900, 28, 'fit'], [667, 375, 14, 'fit'], [900, 1800, 28, 'fit'], [1440, 900, 14, 'fit']]) {
    await page.setViewportSize({ width, height }); await page.evaluate(text => { document.documentElement.style.fontSize = `${text}px`; }, text);
    assert.equal((await checkDialogBounds(`${width}x${height}, root text ${text}px`)).fit, expectedFit);
    assert.deepEqual(await ruleFormValues(), preservedRuleValues, 'No-fit and regrowth preserve every rule value and access choice.');
    assert.equal(await page.locator('#color-rule-label').inputValue(), longLabel, 'Resizing must not truncate the editable label.');
  }
  const spacing = await page.addStyleTag({ content: '#color-rule-dialog [data-measure] { line-height:1.5 !important; letter-spacing:.12em !important; word-spacing:.16em !important; } #color-rule-dialog p { margin-bottom:2em !important; }' });
  await page.setViewportSize({ width: 320, height: 900 }); await page.evaluate(() => { document.documentElement.style.fontSize = '28px'; });
  assert.equal((await checkDialogBounds('320px + 200% text + WCAG text spacing')).fit, 'fit'); await spacing.evaluate(style => style.remove());
  await page.setViewportSize({ width: 1440, height: 900 }); await page.evaluate(() => { document.documentElement.style.fontSize = '14px'; });
  assert.equal((await checkDialogBounds('complete editor after no-fit regrowth')).fit, 'fit');
  assert.deepEqual(await ruleFormValues(), preservedRuleValues);
  await page.keyboard.press('Escape'); await page.setViewportSize({ width: 1440, height: 900 }); await page.evaluate(() => { document.documentElement.style.fontSize = '14px'; });
  await page.locator('.manuscript-toolbar').screenshot({ path: resolve('artifacts/color-rules-toolbar.png') });
  checks.push('Color settings have no panel scroll; compact pages fit normal, short, narrow and 200% text sizes with reachable actions and every value preserved through regrowth.');

  if (await page.locator('#review-toggle').getAttribute('aria-pressed') !== 'true') await page.locator('#review-toggle').click();
  const tunnel = await call({ action: 'tunnel', enabled: true, reservation: 'test-session', public_url: 'https://review.example.org/' });
  const refreshed = page.waitForResponse(async response => response.url().endsWith('/api/review') && response.request().postDataJSON()?.action === 'review' && (await response.json()).ok);
  await Promise.all([refreshed, page.locator('#review-refresh').click()]);
  const contextActions = [];
  const observeContext = request => { if (request.url().endsWith('/api/review') && request.method() === 'POST') contextActions.push(request.postDataJSON().action); };
  page.on('request', observeContext);
  await page.locator('#manuscript-share').click();
  await page.locator('#context-share-dialog').waitFor({ state: 'visible' });
  assert.deepEqual(await page.locator('#context-share-location option[data-path]').evaluateAll(options=>options.map(option=>option.dataset.path)), ['main.html'], 'Only the active manuscript is in this context scope; queued.html is unrelated.');
  await page.keyboard.press('Escape');
  await until(async () => !await page.locator('#manuscript-share').isChecked(), 'Cancelling context consent must keep this manuscript unshared.');
  assert.equal((await call({ action: 'connection' })).shared.length, 0);
  await page.locator('#manuscript-share').click(); await page.locator('#context-share-dialog').waitFor({ state: 'visible' });
  for (const [width, height, text] of [[1440, 900, 14], [1440, 480, 14], [320, 900, 28], [667, 375, 14], [1440, 900, 14]]) {
    await page.setViewportSize({ width, height }); await page.evaluate(text => { document.documentElement.style.fontSize = `${text}px`; }, text);
    await checkDialogBounds(`context consent ${width}x${height}, root text ${text}px`, 'context-share-dialog');
  }
  await page.screenshot({ path: resolve('artifacts/context-sharing-dialog.png') });
  const shareResponse = page.waitForResponse(response => response.url().endsWith('/api/review') && response.request().postDataJSON()?.action === 'share');
  await page.locator('#context-share-submit').click();
  const shareValue = await (await shareResponse).json(); assert.equal(shareValue.ok, true, shareValue.error?.message);
  page.off('request', observeContext);
  assert.equal(contextActions.some(action => action === 'save' || action.startsWith('editor_commit')), false, 'Context preview and consent must never save a source.');
  await until(async () => (await call({ action: 'connection' })).shared.some(share => share.project === project.id && share.path === 'main.html'), 'The source was not shared after the explicit local click.');
  const sharedDocument = (await call({ action: 'connection' })).shared.find(share => share.project === project.id && share.path === 'main.html');
  const endpoint = await readFile(targetFile, 'utf8') + new URL(tunnel.endpoint).pathname;
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-06-18' };
  async function rpc(method, params) {
    const response = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(10_000) });
    assert.equal(response.status, 200); const value = await response.json(); assert.equal(value.error, undefined, JSON.stringify(value)); return value.result;
  }
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'UnderTree color-rule acceptance test', version: '1' } });
  assert.equal((await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) })).status, 202);
  assert.deepEqual((await rpc('tools/list', {})).tools.map(tool => tool.name).sort(), ['highlight_text', 'list_manuscripts', 'read_manuscript', 'suggest_text']);
  async function readContext() {
    let response;
    await until(async () => {
      response = await rpc('tools/call', { name: 'read_manuscript', arguments: { documentId: sharedDocument.documentId } });
      return !remoteAdmissionBusy(response);
    }, 'The complete context did not become available.');
    assert.equal(response.isError, false, JSON.stringify(response));
    const result = response.structuredContent?.result ?? JSON.parse(response.content.find(item => item.type === 'text').text);
    assert.equal(result.context.complete, true); assert.equal(result.snapshot, 'saved'); assert.ok(result.contextId);
    return result;
  }
  async function propose(quote, replacement, requestId) {
    const snapshot = await saved(), context = await readContext(); let result;
    await until(async () => {
      result = await rpc('tools/call', { name: 'suggest_text', arguments: { documentId: sharedDocument.documentId, proposal: { requestId, revision: snapshot.review.revision, contextId: context.contextId, from: original.indexOf(quote), to: original.indexOf(quote) + quote.length, quote, replacement, rationale: 'Apply the user-owned passage rule.' } } });
      return !remoteAdmissionBusy(result);
    }, 'The native proposal operation did not become ready.');
    return result;
  }
  const denied = await propose(protectedQuote, 'Forbidden replacement.', 'color-protected');
  assert.equal(denied.isError, true, JSON.stringify(denied));
  assert.match(JSON.stringify(denied), /protect|reject|not allowed|marked against agent changes/i); await unchanged('A protected MCP proposal cannot alter any original bytes.');
  const replacement = 'Rewrite concisely.';
  const pending = await propose(editableQuote, replacement, 'color-pending');
  assert.equal(pending.isError, false, JSON.stringify(pending)); await unchanged('A valid MCP proposal remains a suggestion; it cannot save the replacement.');
  assert.equal((await saved()).review.suggestions.filter(suggestion => suggestion.status === 'pending').length, 1);
  if (await page.locator('#review-toggle').getAttribute('aria-pressed') !== 'true') await page.locator('#review-toggle').click();
  await page.locator('#review-refresh').click(); await page.locator('.suggestion-card .replacement').waitFor();
  assert.equal(await page.locator('.suggestion-card .replacement').textContent(), replacement);
  assert.equal(await page.locator('.suggestion-card').evaluate(card => card.style.getPropertyValue('--review-color')), '#7655ad');
  await unchanged('Rendering the color-coded proposal cannot write the original document.');
  checks.push('The real closed MCP catalogue exposes only the four closed Review tools, rejects protected changes, and displays an allowed replacement as a pending color-coded suggestion while preserving every original byte.');
  await page.locator('.suggestion-card .accept-suggestion').click();
  await page.locator('.suggestion-card').waitFor({ state: 'detached' });
  const acceptedBytes = Buffer.from(original.replace(editableQuote, replacement));
  await unchanged('Only explicit local Accept changes precisely the proposed passage.', 'main.html', acceptedBytes);
  assert.equal((await saved()).review.suggestions[0].status, 'accepted');
  checks.push('Explicit local acceptance writes only the proposed exact passage; the protected passage, Unicode bytes and surrounding source remain unchanged.');

  await showRule(green.id); await page.locator(`[data-color-configure="${green.id}"]`).click();
  await revealColor('#color-rule-permissions');await page.locator('input[name="color-rule-access"][value="direct"]').check(); await saveRule();
  const directBefore = await saved(), directQuote = 'Keep the ending.', directReplacement = 'Preserve the ending.';
  const from = directBefore.content.indexOf(directQuote);
  await call({ action: 'mark', project: project.id, path: 'main.html', sourceEpoch: directBefore.sourceEpoch, expectedRoot: directBefore.expectedRoot, revision: directBefore.review.revision, from, to: from + directQuote.length, rule: green.id, prompt: '' });
  const directContext = await readContext();
  const directProposal = { requestId: 'color-explicit-direct', revision: directBefore.review.revision, contextId: directContext.contextId, from, to: from + directQuote.length, quote: directQuote, replacement: directReplacement, rationale: 'Use explicit direct permission for this marked passage.' };
  let directReply;
  await until(async () => {
    directReply = await rpc('tools/call', { name: 'suggest_text', arguments: { documentId: sharedDocument.documentId, proposal: directProposal } });
    return !remoteAdmissionBusy(directReply) && !directReply.content?.some(item => item.text?.includes('Direct edits require current clean editor buffers'));
  }, 'Direct edit submission did not become ready.');
  assert.equal(directReply.isError, false, JSON.stringify(directReply));
  const directExpected = directBefore.content.replace(directQuote, directReplacement);
  await until(async () => await page.locator('.cm-content').evaluate(node => [...node.querySelectorAll('.cm-line')].map(line => line.textContent).join('\n')) === directExpected, 'A confirmed direct edit did not refresh the clean editor.');
  await unchanged('Explicit direct access changes only its exact marked passage.', 'main.html', Buffer.from(directExpected));
  assert.equal((await saved()).review.suggestions.find(item => item.requestId === 'color-explicit-direct').status, 'accepted');
  assert.equal(await page.locator('#review-conflict').isVisible(), false);
  checks.push('Explicit per-color direct access commits only the marked passage and refreshes the clean CodeMirror buffer through the native direct-edit receipt.');

  // Hold a successful prior Save response while a color click queues behind it.
  await open('queued.html');
  const queuedRule = (await saved('queued.html')).review.rules.find(rule => rule.action === 'protect');
  const gate = deferred(), operations = []; let first = true, saveReady = false, savedPolicy;
  await page.route('**/api/review', async route => {
    const operation = route.request().postDataJSON();
    if (operation.path !== 'queued.html') return route.continue();
    operations.push(operation);
    if (operation.action !== 'save') return route.continue();
    if (!first) return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ ok: false, error: { code: 'busy', message: 'The isolated stale-selection fixture preserves the current draft.' } }) });
    first = false; const response = await route.fetch();
    const receipt = await response.json();
    assert.equal(receipt.ok, true, JSON.stringify(receipt.error)); savedPolicy = await readFile(join(projectRoot, 'queued.html.undertree-review.json'));
    saveReady = true; await gate.promise; await route.fulfill({ response });
  });
  try {
    await page.locator('.cm-content').focus(); await page.keyboard.press('Control+End'); await page.keyboard.insertText('\n');
    await page.keyboard.press('Control+s'); await until(() => saveReady, 'The Save response was not held.');
    await select(protectedQuote); await page.locator(`[data-color-rule="${queuedRule.id}"]`).click();
    await sourceHighlight(); await page.keyboard.press('Escape');
    await page.locator('.cm-content').focus(); await page.keyboard.press('Control+Home'); await page.keyboard.insertText('X');
    gate.resolve();
    await until(async () => /selection changed|selected passage changed/i.test(await page.locator('#review-status').textContent()), 'The queued stale color selection was not refused.');
    assert.equal(operations.some(operation => operation.action === 'mark'), false);
    assert.equal((await saved('queued.html')).review.markers.length, 0);
    await unchanged('The stale queued selection cannot mark or save the newer draft.', 'queued.html', Buffer.from(original + '\n'));
    assert.deepEqual(await readFile(join(projectRoot, 'queued.html.undertree-review.json')), savedPolicy);
    assert.match(await page.locator('.cm-content').textContent(), /^X<p>/);
    await page.keyboard.press('Control+z'); assert.doesNotMatch(await page.locator('.cm-content').textContent(), /^X<p>/);
    await page.keyboard.press('Control+y'); assert.match(await page.locator('.cm-content').textContent(), /^X<p>/);
    checks.push('An explicitly confirmed highlight queued behind Save rejects a subsequently changed selection, writes no marker, and preserves the newest draft plus Undo/Redo.');
    const beforeConsent = operations.length, draft = await page.locator('.cm-content').textContent();
    await page.locator('#manuscript-share').click();
    await until(async () => /Save manuscript drafts explicitly/.test(await page.locator('#review-status').textContent()), 'A dirty source must refuse context consent.');
    assert.equal(await page.locator('#context-share-dialog').isVisible(), false);
    assert.equal(await page.locator('#manuscript-share').isChecked(), false);
    assert.equal(operations.slice(beforeConsent).some(operation => ['share', 'context_preview'].includes(operation.action)), false);
    assert.equal(await page.locator('.cm-content').textContent(), draft);
    await unchanged('Dirty context consent must not flush the draft.', 'queued.html', Buffer.from(original + '\n'));
    checks.push('Dirty context consent refuses before preview or Share, leaves the source unshared and preserves the exact draft and saved bytes.');
  } finally { gate.resolve(); await page.unrouteAll({ behavior: 'wait' }); }
  assert.deepEqual(errors, []);
  console.log(`Color rules: ${checks.length} real-service/CodeMirror/MCP checks passed. Public zrok, native WebViews and GPT account access were not exercised.`);
} catch (error) {
  failure = error;
  if (page) { errors.push(await page.locator('#review-status').textContent({ timeout: 1000 }).catch(() => 'Status unavailable')); await page.screenshot({ path: resolve('artifacts/color-rules-failure.png'), timeout: 5000 }).catch(() => {}); }
  throw error;
} finally {
  if (base && service?.exitCode === null) await call({ action: 'tunnel', enabled: false, reservation: '', public_url: '' }).catch(error => errors.push(`Fixture tunnel cleanup: ${error.message}`));
  await browser?.close(); service?.kill('SIGINT');
  if (service) { await Promise.race([new Promise(resolve => { if (service.exitCode !== null) resolve(); else service.once('exit', resolve); }), new Promise(resolve => setTimeout(resolve, 3000))]); if (service.exitCode === null) service.kill('SIGKILL'); }
  await mkdir(resolve('artifacts'), { recursive: true });
  await writeFile(output, JSON.stringify({ result: failure ? 'failed' : 'passed', error: failure?.message, binary, binarySha256: await readFile(runningBinary).then(hash).catch(() => null), inputAssets, runnerSha256: hash(await readFile(new URL(import.meta.url))), originalSha256: hash(originalBytes), checks, observations, errors, serviceLog: failure ? log : undefined }, null, 2) + '\n');
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
