// Real Rust + CodeMirror: selection identity must survive queueing without marking neighboring text.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { cp, mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const binary = resolve(process.env.UNDERTREE_REVIEW_BINARY || 'target/debug/undertree-review');
const inputAssets = resolve(process.env.UNDERTREE_REVIEW_ASSETS || 'dist');
const output = resolve(process.env.UNDERTREE_SELECTION_RECEIPT || 'artifacts/review-selection-smoke.json');
const root = await mkdtemp(join(tmpdir(), 'undertree-review-selection-'));
const projectRoot = join(root, 'project'), assets = join(root, 'assets'), token = randomBytes(32).toString('hex');
const original = '<p>Alpha target.</p>\n';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const checks = [], observations = [], errors = [];
let service, browser, page, port, base, log = '', failure;
async function until(check, message) {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) { if (await check()) return; if (service?.exitCode !== null && service?.exitCode !== undefined) throw Error(log); await new Promise(resolve => setTimeout(resolve, 20)); }
  throw Error(message);
}
async function call(operation) {
  const value = await fetch(base + '/api/review', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(operation), signal: AbortSignal.timeout(10_000) }).then(response => response.json());
  assert.equal(value.ok, true, value.error?.message); return value.result;
}
async function capturePassage() {
  await page.locator('.cm-content').focus(); await page.keyboard.press('Control+Home');
  for (let index = 0; index < original.indexOf('target'); index += 1) await page.keyboard.press('ArrowRight');
  for (let index = 0; index < 'target'.length; index += 1) await page.keyboard.press('Shift+ArrowRight');
  const menu = await page.locator('#menu-format-toggle').isVisible() ? '#menu-format' : '#workspace-menu';
  await page.locator(menu + ' summary').click(); await page.locator(menu).getByRole('menuitem', { name: 'Highlight selection', exact: true }).or(page.locator(menu).getByRole('button', { name: 'Highlight selection', exact: true })).click();
  assert.equal(await page.locator('#highlight-quote').textContent(), 'target');
  await page.locator('#highlight-dialog-rule').selectOption('protect');
}
try {
  await mkdir(projectRoot); await cp(inputAssets, assets, { recursive: true });
  for (const name of ['control.html', 'queued.html']) await writeFile(join(projectRoot, name), original);
  service = spawn(binary, [], { env: { ...process.env, UNDERTREE_REVIEW_PORT: '0', UNDERTREE_REVIEW_STATE: join(root, 'state'), UNDERTREE_REVIEW_ASSETS: assets, UNDERTREE_REVIEW_TOKEN: token }, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [service.stdout, service.stderr]) stream.on('data', bytes => { log = (log + bytes).slice(-16_000); port = Number(log.match(/127\.0\.0\.1:(\d+)/)?.[1]); });
  await until(() => !!port, 'The isolated authority did not start.'); base = `http://127.0.0.1:${port}`;
  const project = await call({ action: 'add_project', root: projectRoot });
  browser = await chromium.launch({ executablePath: process.env.UNDERTREE_CHROME || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } }); page.on('pageerror', error => errors.push(error.message));
  await page.goto(base + `/manuscript.html#session=${token}`); await page.locator('#project-select').selectOption(project.id);
  for (const mode of ['control', 'queued']) {
    const path = `${mode}.html`, gate = deferred(), operations = [];
    let first = true, saveReady = false, savedPolicy;
    const holdSave = async route => {
      const operation = route.request().postDataJSON();
      if (operation.path !== path) return route.continue();
      operations.push(operation);
      if (operation.action !== 'save') return route.continue();
      if (!first) return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ ok: false, error: { code: 'busy', message: 'The isolated selection fixture preserves the latest unsaved draft.' } }) });
      first = false;
      const response = await route.fetch({ timeout: 10_000 }), value = await response.json(); assert.equal(value.ok, true, value.error?.message);
      savedPolicy = await readFile(join(projectRoot, path + '.undertree-review.json'));
      observations.push({ mode, saveBeganAfterSubmit: await page.evaluate(() => window.__selectionSubmitted) });
      saveReady = true; await gate.promise; await route.fulfill({ response });
    };
    await page.route('**/api/review', holdSave);
    try {
      const fileButton = page.locator(`.file-button[data-path="${path}"]`);
      await fileButton.click();
      await until(async () => await fileButton.getAttribute('aria-current') === 'true', 'The requested document did not finish mounting.');
      await page.locator('.cm-content').waitFor();
      await page.evaluate(() => {
        window.__selectionSubmitted = false;
        document.getElementById('highlight-form').addEventListener('submit', () => { window.__selectionSubmitted = true; }, { once: true, capture: true });
      });
      await page.locator('.cm-content').focus(); await page.keyboard.press('Control+End'); await page.keyboard.insertText('\n');
      await until(async () => await page.locator('.cm-line').count() === 3 && await page.locator('#save-label').textContent() === 'Unsaved changes', 'The requested document edit did not reach its dirty buffer.');
      await page.keyboard.press('Control+s');
      await until(() => saveReady, 'The earlier successful Save response was not held.');
      await capturePassage(); await page.getByRole('button', { name: 'Add highlight', exact: true }).click();
      await until(() => saveReady, 'The selection Save response was not held.');
      assert.equal(observations.at(-1).saveBeganAfterSubmit, false, 'The held response precedes the queued selection submission.');
      if (mode !== 'control') {
        await page.keyboard.press('Escape'); await page.locator('#highlight-dialog').waitFor({ state: 'hidden' });
        await page.locator('.cm-content').focus(); await page.keyboard.press('Control+Home'); await page.keyboard.insertText('X');
      }
      gate.resolve();
      if (mode === 'control') {
        await page.locator('#highlight-dialog').waitFor({ state: 'hidden' });
        const snapshot = await call({ action: 'review', project: project.id, path });
        assert.equal(snapshot.review.markers.length, 1); assert.equal(snapshot.review.markers[0].anchor.quote, 'target');
        assert.deepEqual(operations.filter(operation => operation.action === 'mark').map(operation => operation.from), [original.indexOf('target')]);
        checks.push('An unchanged queued selection protects exactly target through the real native Save and Mark.');
      } else {
        await until(async () => /selection changed/i.test(await page.locator('#review-status').textContent()), 'The stale queued selection was not reported.');
        assert.equal(operations.some(operation => operation.action === 'mark'), false);
        assert.match(await page.locator('.cm-content').textContent(), /^X<p>Alpha target/);
        await page.locator('#source-undo').click();
        await until(async () => !/^X/.test(await page.locator('.cm-content').textContent()), 'Undo did not restore the prior draft.');
        await page.locator('#source-redo').click();
        await until(async () => /^X<p>Alpha target/.test(await page.locator('.cm-content').textContent()), 'Redo did not restore the newest draft.');
        await page.waitForTimeout(550); // Let independent autosave attempt settle against the explicit fixture refusal.
        assert.equal(operations.some(operation => operation.action === 'mark'), false, 'No delayed marker protects the neighboring substring.');
        const snapshot = await call({ action: 'review', project: project.id, path });
        assert.equal(snapshot.review.markers.length, 0); assert.equal(snapshot.content, original + '\n');
        assert.equal(await readFile(join(projectRoot, path), 'utf8'), original + '\n');
        assert.deepEqual(await readFile(join(projectRoot, path + '.undertree-review.json')), savedPolicy);
        assert.match(await page.locator('#manuscript-tabs').textContent(), /•/);
        checks.push('Typing while Mark is queued rejects the stale selection, preserves the draft and Undo/Redo, and makes no policy write.');
      }
      observations.push({ mode, path, actions: operations.map(operation => operation.action), markerCount: mode === 'control' ? 1 : 0 });
      // Remove only the unsaved X before the next file; ordinary autosave is still refused here.
      if (mode !== 'control') { await page.locator('.cm-content').focus(); await page.keyboard.press('Control+z'); }
    } finally { gate.resolve(); await page.unrouteAll({ behavior: 'wait' }); }
  }
  assert.deepEqual(errors, []);
  console.log(`Review selection: ${checks.length} real-service/CodeMirror checks passed.`);
} catch (error) { failure = error; if (page) await page.screenshot({ path: resolve('artifacts/review-selection-failure.png') }).catch(() => {}); throw error; }
finally {
  await browser?.close(); service?.kill('SIGINT');
  if (service) { await Promise.race([new Promise(resolve => { if (service.exitCode !== null) resolve(); else service.once('exit', resolve); }), new Promise(resolve => setTimeout(resolve, 3000))]); if (service.exitCode === null) service.kill('SIGKILL'); }
  await mkdir(resolve('artifacts'), { recursive: true });
  await writeFile(output, JSON.stringify({ result: failure ? 'failed' : 'passed', error: failure?.message, binary, binarySha256: hash(await readFile(binary)), assets: inputAssets, runnerSha256: hash(await readFile(new URL(import.meta.url))), checks, observations, errors }, null, 2) + '\n');
  await rm(root, { recursive: true, force: true });
}
