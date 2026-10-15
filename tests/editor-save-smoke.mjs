// Named local CLI save against a real Rust authority and isolated rendered editor.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cp, mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const temporary = await mkdtemp(join(tmpdir(), 'undertree-editor-save-'));
const projectRoot = join(temporary, 'project'), stateRoot = join(temporary, 'state'), assets = join(temporary, 'assets');
const binary = resolve(process.env.UNDERTREE_REVIEW_BINARY || 'target/debug/undertree-review');
const token = randomBytes(32).toString('hex'), checks = [], errors = [];
let service, browser, log = '', port;
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function waitUntil(check, message) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) { if (await check()) return; if (service.exitCode !== null) throw new Error(log); await new Promise(resolve => setTimeout(resolve, 25)); }
  throw new Error(message);
}
async function cli(...args) {
  const env = { ...process.env, UNDERTREE_REVIEW_STATE: stateRoot };
  delete env.UNDERTREE_REVIEW_ENDPOINT; delete env.UNDERTREE_REVIEW_TOKEN;
  const child = spawn(binary, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', stderr = '';
  child.stdout.on('data', bytes => { output += bytes; }); child.stderr.on('data', bytes => { stderr += bytes; });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 35_000);
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); }); clearTimeout(timeout);
  assert.ok(output, stderr || 'The local CLI returned no outcome.');
  return { code, value: JSON.parse(output) };
}
try {
  await mkdir(projectRoot); await cp(resolve('dist'), assets, { recursive: true });
  const file = join(projectRoot, 'main.html'), original = '<p>Original source.</p>\n';
  await writeFile(file, original);
  service = spawn(binary, [], { env: { ...process.env, UNDERTREE_REVIEW_PORT: '0', UNDERTREE_REVIEW_STATE: stateRoot, UNDERTREE_REVIEW_ASSETS: assets, UNDERTREE_REVIEW_TOKEN: token }, stdio: ['ignore', 'pipe', 'pipe'] });
  service.stdout.on('data', bytes => { log = (log + bytes).slice(-16_000); port = Number(log.match(/127\.0\.0\.1:(\d+)/)?.[1]); });
  service.stderr.on('data', bytes => { log = (log + bytes).slice(-16_000); });
  await waitUntil(() => !!port, 'The isolated native service did not start.');
  const base = `http://127.0.0.1:${port}`;
  const added = await fetch(base + '/api/review', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ action: 'add_project', root: projectRoot }) }).then(response => response.json());
  assert.equal(added.ok, true, added.error?.message); const project = added.result;
  const headless = await cli('save', project.id, 'main.html');
  assert.notEqual(headless.code, 0); assert.equal(headless.value.error.code, 'ui_unavailable'); assert.equal(await readFile(file, 'utf8'), original);
  checks.push('a headless local save refuses without writing source');
  browser = await chromium.launch({ executablePath: process.env.UNDERTREE_CHROME || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } }); page.on('pageerror', error => errors.push(error.message));
  let registered = false, composing = false, retired = false, commits = 0;
  page.on('response', async response => {
    if (!response.url().endsWith('/api/editor')) return;
    const operation = response.request().postDataJSON();
    const value = await response.json().catch(() => null); if (!value?.ok) return;
    if (operation.action === 'editor_register') registered = true;
    if (operation.action === 'editor_register' || operation.action === 'editor_update') composing = operation.composing;
    if (operation.action === 'editor_commit') commits += 1;
    if (operation.action === 'editor_unregister') retired = true;
  });
  // Keep autosave from satisfying a CLI assertion; only the real editor_commit may write this fixture.
  await page.route('**/api/review', route => route.request().postDataJSON()?.action === 'save'
    ? route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ ok: false, error: { code: 'busy', message: 'Autosave is paused in this isolated CLI fixture.' } }) }) : route.continue());
  await page.goto(base + `/manuscript.html#session=${token}`);
  await page.getByRole('button', { name: 'main.html', exact: true }).click();
  const source = page.locator('.cm-content'); await source.waitFor();
  await waitUntil(() => registered, 'The actual editor did not register a native session.');
  async function replace(content) { await source.focus(); await page.keyboard.press('Control+A'); await page.keyboard.insertText(content); }
  async function confirmed(receipt, expected) {
    let outcome;
    await waitUntil(async () => { outcome = await cli('save-receipt', receipt.requestId); return outcome.value.result?.bufferStatus === expected; }, `The committed native receipt did not confirm ${expected}.`);
    assert.equal(outcome.value.result.status, 'committed'); return outcome.value.result;
  }
  const first = '<p>The live user buffer.</p>\n'; await replace(first);
  const saved = await cli('save', project.id, 'main.html');
  assert.equal(saved.code, 0); assert.equal(saved.value.result.status, 'committed');
  const confirmedSaved = await confirmed(saved.value.result, 'saved');
  assert.equal(await readFile(file, 'utf8'), first); assert.equal(await page.locator('#save-label').textContent(), 'Saved locally');
  const receipt = await cli('save-receipt', saved.value.result.requestId);
  assert.deepEqual(receipt.value.result, confirmedSaved);
  checks.push('named CLI save captures a dirty rendered buffer and its durable receipt replays exactly');
  const clean = await cli('save', project.id, 'main.html'); assert.equal(clean.code, 0); await confirmed(clean.value.result, 'saved'); assert.equal(commits, 2);
  checks.push('a clean buffer still passes native revision verification and a distinct committed receipt');
  const captured = '<p>Captured before later typing.</p>\n', newer = '<p>Newer typing remains in the editor.</p>\n';
  const received = deferred(), release = deferred(); let held = false;
  await page.route('**/api/editor', async route => {
    if (route.request().postDataJSON()?.action !== 'editor_commit' || held) return route.continue();
    held = true; const response = await route.fetch(); received.resolve(); await release.promise; await route.fulfill({ response });
  });
  await replace(captured); const pending = cli('save', project.id, 'main.html');
  await Promise.race([received.promise, new Promise((_, reject) => setTimeout(() => reject(new Error('The captured native commit did not arrive.')), 10_000))]);
  await replace(newer); release.resolve(); const divergent = await pending;
  assert.equal(divergent.code, 0); assert.equal(divergent.value.result.status, 'committed'); await confirmed(divergent.value.result, 'newer_buffer');
  assert.equal(await readFile(file, 'utf8'), captured); assert.equal((await source.innerText()).trimEnd(), newer.trimEnd());
  assert.equal(await page.locator('#save-label').textContent(), 'Unsaved changes');
  checks.push('typing during a held committed response stays dirty and reports newer_buffer without a second save');
  await source.evaluate(element => (element.editContext || element).dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })));
  await waitUntil(() => composing, 'EditContext composition was not published to the native session.');
  const beforeBusy = commits, busy = await cli('save', project.id, 'main.html');
  assert.notEqual(busy.code, 0); assert.equal(busy.value.error?.code || busy.value.result?.error?.code, 'busy'); assert.equal(commits, beforeBusy);
  assert.equal(await readFile(file, 'utf8'), captured);
  await source.evaluate(element => (element.editContext || element).dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })));
  await waitUntil(() => !composing, 'The finished composition did not become saveable.');
  const latest = await cli('save', project.id, 'main.html'); assert.equal(latest.code, 0); await confirmed(latest.value.result, 'saved'); assert.equal(await readFile(file, 'utf8'), newer);
  checks.push('IME blocks native save without mutation and a later explicit save commits the newest buffer');
  await page.getByRole('button', { name: 'Close main.html', exact: true }).click();
  await waitUntil(() => page.locator('.cm-content').count().then(count => count === 0 && retired), 'The clean tab did not close and retire its native session.');
  const closed = await cli('save', project.id, 'main.html'); assert.notEqual(closed.code, 0); assert.equal(closed.value.error.code, 'ui_unavailable');
  checks.push('closing the tab retires its native session and prevents a fallback disk save');
  assert.deepEqual(errors, []);
  await mkdir(resolve('artifacts'), { recursive: true });
  await writeFile(resolve('artifacts/editor-save-smoke.json'), JSON.stringify({ browser: browser.version(), checks, commits, errors, receipt: latest.value.result, scope: 'local CLI and registered native editor only; no remote content or Full MCP authority' }, null, 2) + '\n');
  console.log(`Editor save: ${checks.length} real Rust/CLI/rendered lifecycle checks passed.`);
} finally {
  await browser?.close();
  if (service?.exitCode === null) { service.kill('SIGINT'); await Promise.race([new Promise(resolve => service.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 3000))]); if (service.exitCode === null) service.kill('SIGKILL'); }
  await rm(temporary, { recursive: true, force: true });
}
