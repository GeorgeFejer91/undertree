// Isolated retained editor qualification: real legacy service, sandboxed contenteditable, no existing browser or projects.
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const temporary = await mkdtemp(join(tmpdir(), 'undertree-html-editor-'));
const library = join(temporary, 'library'), project = join(library, 'visual-fixture');
const token = randomBytes(32).toString('hex');
const prefix = '<!doctype html>\n<html lang="en" data-ut-print-profile="1"><head><meta charset="utf-8"><title>Visual fixture</title><style>body{margin:0;font-family:sans-serif}main{padding:24px;width:700px}section{padding:16px;border:1px solid #aaa}</style></head><body><main data-ut-page data-ut-id="page-1"><section data-ut-id="copy" data-ut-editable>';
const suffix = '</section></main></body></html>\n';
const source = prefix + '<p>Original text.</p>' + suffix;
const sourcePath = join(project, 'fixture.html');
let service, browser, serviceLog = '';
const failures = [], external = [], checks = [];
const record = label => checks.push(label);

async function unusedPort() {
  const socket = createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve)); return port;
}

async function waitUntil(check, message, timeout = 10_000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    try { if (await check()) return; }
    catch (error) {
      // Undo/redo refreshes srcdoc; retry only the obsolete iframe context.
      if (!/Execution context was destroyed|Frame was detached/i.test(error.message)) throw error;
    }
    if (service?.exitCode !== null) throw new Error(serviceLog || 'The isolated service stopped.');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(message);
}

try {
  await mkdir(project, { recursive: true }); await writeFile(sourcePath, source);
  await writeFile(join(library, 'PROJECTS.tsv'), `name\tlocalPath\troot\nVisual fixture\t${project}\tfixture.html\n`);
  const port = await unusedPort(), base = `http://127.0.0.1:${port}`;
  service = spawn(process.execPath, [resolve('server.mjs')], { env: { ...process.env, UNDERTREE_LIBRARY_ROOT: library, UNDERTREE_STATE_ROOT: join(temporary, 'state'), UNDERTREE_PORT: String(port), UNDERTREE_TOKEN: token }, stdio: ['ignore', 'pipe', 'pipe'] });
  service.stdout.on('data', bytes => { serviceLog = (serviceLog + bytes).slice(-16_000); });
  service.stderr.on('data', bytes => { serviceLog = (serviceLog + bytes).slice(-16_000); });
  await waitUntil(async () => fetch(base + '/api/health').then(response => response.ok).catch(() => false), 'The isolated HTML service did not start.');
  browser = await chromium.launch({ executablePath: process.env.UNDERTREE_CHROME || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
  const page = await context.newPage(); page.setDefaultTimeout(10_000);
  page.on('pageerror', error => failures.push(error.message));
  page.on('request', request => { const url = new URL(request.url()); if (['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol) && url.origin !== base) external.push(url.origin); });
  // PDF publication has its own gate; prevent automatic preview builds from requiring a renderer in this editing-only test.
  await page.route('**/api/project/*/build', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Publication is outside the isolated HTML editor gate.' }) }));
  await page.goto(base + `/?token=${token}`, { waitUntil: 'domcontentloaded' });
  await page.locator('.editor-tab.active[title="fixture.html"]').waitFor();
  await page.getByRole('button', { name: 'Visual', exact: true }).click();
  const frame = page.frameLocator('.html-visual-frame'), copy = frame.locator('[data-ut-id="copy"]');
  await copy.locator('p').waitFor();
  assert.equal(await page.locator('.html-visual-frame').getAttribute('sandbox'), 'allow-same-origin');
  assert.equal(await copy.getAttribute('contenteditable'), 'true');
  record('real local service opens the sandboxed Visual editor');
  await copy.evaluate(element => { element.focus(); const range = element.ownerDocument.createRange(); range.selectNodeContents(element.querySelector('p')); const selection = element.ownerDocument.getSelection(); selection.removeAllRanges(); selection.addRange(range); });
  await page.keyboard.insertText('A safe visual edit.');
  await copy.locator('p').getByText('A safe visual edit.', { exact: true }).waitFor();
  // Source history groups adjacent typing; separate the following explicit formatting operation.
  await page.waitForTimeout(600);
  await copy.evaluate(element => { const text = element.querySelector('p').firstChild, from = text.textContent.indexOf('safe'); const range = element.ownerDocument.createRange(); range.setStart(text, from); range.setEnd(text, from + 4); const selection = element.ownerDocument.getSelection(); selection.removeAllRanges(); selection.addRange(range); });
  await page.locator('#bold').click();
  const boldText = () => copy.evaluate(element => [...element.querySelectorAll('b,strong,span')].some(node => node.textContent === 'safe' && Number.parseInt(getComputedStyle(node).fontWeight, 10) >= 600));
  await waitUntil(boldText, 'Visual Bold did not format the selected word.'); record('Visual typing and Bold preserve the requested text');
  await page.locator('#undo').click();
  await waitUntil(async () => !await boldText(), 'Visual undo did not restore unformatted text.');
  assert.equal(await copy.innerText(), 'A safe visual edit.');
  await page.locator('#redo').click(); await waitUntil(boldText, 'Visual redo did not restore Bold.');
  record('toolbar undo and redo preserve visual text and formatting');
  await page.evaluate(() => { window.__undertreePasteExecuted = false; });
  const pastedHtml = '<p>Pasted safe text<img src="data:image/png;base64,broken" onerror="parent.__undertreePasteExecuted=true"><script>parent.__undertreePasteExecuted=true</script></p>';
  await page.evaluate(async html => { await navigator.clipboard.write([new ClipboardItem({ 'text/html': new Blob([html], { type: 'text/html' }), 'text/plain': new Blob(['Pasted safe text'], { type: 'text/plain' }) })]); }, pastedHtml);
  await copy.evaluate(element => { element.focus(); const range = element.ownerDocument.createRange(); range.selectNodeContents(element); range.collapse(false); const selection = element.ownerDocument.getSelection(); selection.removeAllRanges(); selection.addRange(range); });
  await page.keyboard.press('Control+V');
  await waitUntil(async () => (await copy.innerText()).includes('Pasted safe text'), 'Rich clipboard paste did not retain visible text.');
  await page.waitForTimeout(150);
  assert.equal(await page.evaluate(() => window.__undertreePasteExecuted), false, 'pasted image handlers and scripts cannot execute in the application');
  assert.ok((await copy.innerText()).includes('A safe visual edit.'));
  const editedInnerHtml = await copy.innerHTML();
  const paste = await copy.evaluate(element => ({ scriptElements: element.querySelectorAll('script').length, eventAttributes: [...element.querySelectorAll('*')].flatMap(node => [...node.attributes].filter(attribute => /^on/i.test(attribute.name))).length }));
  record('a real rich clipboard paste retains visible text without executing event or script payloads');
  await page.getByRole('button', { name: 'HTML Source', exact: true }).click();
  const saved = page.waitForResponse(response => response.url().includes('/file') && response.request().method() === 'PUT' && response.ok());
  await page.locator('.cm-content').focus(); await page.keyboard.press('Control+S');
  await Promise.race([saved, page.waitForFunction(() => document.getElementById('save-state').textContent === 'Saved locally')]);
  await waitUntil(async () => await readFile(sourcePath, 'utf8') === prefix + editedInnerHtml + suffix, 'Visual edits were not saved exactly to the source.');
  assert.equal(await readFile(sourcePath, 'utf8'), prefix + editedInnerHtml + suffix, 'visual saving changes only the selected editable region');
  await page.getByRole('button', { name: 'Visual', exact: true }).click();
  await waitUntil(async () => (await copy.innerText()).includes('Pasted safe text'), 'Saved pasted text did not reopen in the Visual editor.');
  assert.equal(await page.evaluate(() => window.__undertreePasteExecuted), false, 'reopening saved pasted HTML cannot execute its payload');
  assert.equal(await copy.innerHTML(), editedInnerHtml);
  record('exact HTML saving and reopen preserve user content and inert execution');
  assert.deepEqual(failures, []); assert.deepEqual(external, []);
  await mkdir(resolve('artifacts'), { recursive: true });
  await page.screenshot({ path: resolve('artifacts/html-editor-smoke.png'), fullPage: true });
  await writeFile(resolve('artifacts/html-editor-smoke.json'), JSON.stringify({ browser: browser.version(), editor: 'sandboxed contenteditable and document.execCommand', checks, paste, sourceSha256: createHash('sha256').update(await readFile(sourcePath)).digest('hex'), runtimeErrors: failures, externalRequests: external, publication: 'automatic build requests intercepted; PDF publication is outside this gate', limits: 'This path does not use Tiptap or ProseMirror. Chromium clipboard sanitization and iframe sandbox/CSP contribute to paste safety.' }, null, 2) + '\n');
  console.log(`HTML Visual editor: ${checks.length} checks passed with real local editing/save and clipboard paste; publication and Tiptap/ProseMirror are outside this gate.`);
} finally {
  await browser?.close();
  if (service && service.exitCode === null) {
    service.kill('SIGTERM');
    await Promise.race([new Promise(resolve => service.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 3000))]);
    if (service.exitCode === null) { service.kill('SIGKILL'); await new Promise(resolve => service.once('exit', resolve)); }
  }
  await rm(temporary, { recursive: true, force: true });
}
