import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';

const root = await mkdtemp(join(tmpdir(), 'undertree-buffer-limit-'));
const projectRoot = join(root, 'project');
const token = randomBytes(32).toString('hex');
const names = Array.from({ length: 19 }, (_, index) => `buffer-${String(index).padStart(2, '0')}.html`);
const firstSource = '<p>Original file 00.</p>\n';
const draft = 'Draft survives buffer limits.';
const texSource = '\\documentclass{article}\n\\begin{document}\n\\section{Results}A preserved result.\n\\end{document}\n';
let child, browser, log = '', port, startupError;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, message) {
  for (let index = 0; index < 100; index += 1) {
    if (await check()) return;
    await delay(100);
  }
  assert.fail(message);
}
async function sourceReady(page, path) {
  await page.waitForFunction(path => {
    const title = document.querySelector('#manuscript-tabs [role="tab"][aria-selected="true"]')?.textContent;
    return (title === path || title === `${path} •`) && document.querySelector('.cm-content');
  }, path);
}
async function chooseFile(page, path) {
  await page.locator('.file-button').filter({ hasText: new RegExp(`^${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }).click();
  await sourceReady(page, path);
}
async function menuAction(page, command) {
  const menu = await page.locator('#workspace-menu summary').isVisible() ? '#workspace-menu' : '#menu-file';
  await page.locator(`${menu} summary`).click();
  await page.locator(menu).getByRole('menuitem', { name: command, exact: true }).or(page.locator(menu).getByRole('button', { name: command, exact: true })).click();
}
async function closeTab(page, path) {
  await page.getByRole('button', { name: `Close ${path}`, exact: true }).click();
  await until(async () => !(await page.locator('#manuscript-tabs').getByRole('tab', { name: path, exact: true }).count()), `Close ${path} removes its buffer`);
}

try {
  await mkdir(projectRoot);
  for (const [index, name] of names.entries()) await writeFile(join(projectRoot, name), index === 0 ? firstSource : `<p>Original file ${index}.</p>\n`);
  await writeFile(join(projectRoot, 'overflow.html'), '<p>This source is outside the full editor cache.</p>\n');
  await writeFile(join(projectRoot, 'import.tex'), texSource);
  child = spawn(resolve(process.env.UNDERTREE_REVIEW_BINARY || 'target/debug/undertree-review'), [], {
    env: { ...process.env, UNDERTREE_REVIEW_PORT: '0', UNDERTREE_REVIEW_STATE: join(root, 'state'), UNDERTREE_REVIEW_TOKEN: token, UNDERTREE_REVIEW_ASSETS: resolve(process.env.UNDERTREE_REVIEW_ASSETS || 'dist') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', bytes => { log += bytes; port = Number(log.match(/127\.0\.0\.1:(\d+)/)?.[1]); });
  child.stderr.on('data', bytes => { log += bytes; });
  child.on('error', error => { startupError = error; });
  await until(() => port || startupError || child.exitCode !== null, 'native review adapter starts on its allocated loopback port');
  assert.ok(port, startupError?.message || log);
  const base = `http://127.0.0.1:${port}`;
  async function call(operation) {
    const response = await fetch(`${base}/api/review`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(operation), signal: AbortSignal.timeout(10000) });
    const value = await response.json();
    assert.equal(value.ok, true, value.error?.message);
    return value.result;
  }
  const project = await call({ action: 'add_project', root: projectRoot });
  browser = await chromium.launch({ executablePath: process.env.UNDERTREE_CHROME || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = [], operations = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.url() === `${base}/api/review`) operations.push(request.postDataJSON()); });
  const operationCount = (action, path) => operations.filter(operation => operation.action === action && (!path || operation.path === path)).length;
  const tabCount = () => page.locator('#manuscript-tabs [role="tab"]').count();
  const atCapacity = async () => {
    await page.waitForFunction(() => document.getElementById('review-status').textContent.includes('at most 20 editor buffers'));
    assert.equal(await tabCount(), 20);
  };
  await page.goto(`${base}/manuscript.html#session=${token}`);
  await chooseFile(page, names[0]);
  await page.locator('.cm-content').click(); await page.keyboard.press('Control+End'); await page.keyboard.insertText(draft);
  for (const name of names.slice(1)) await chooseFile(page, name);
  await chooseFile(page, 'import.tex');
  assert.equal(await tabCount(), 20, 'nineteen HTML buffers and the original TeX source reach the shared limit');

  const openCount = operationCount('open', 'overflow.html');
  await page.locator('.file-button').getByText('overflow.html', { exact: true }).click(); await atCapacity();
  assert.equal(operationCount('open', 'overflow.html'), openCount, 'blocked Open stops before a backend source request');
  assert.equal(await page.locator('#manuscript-tabs [aria-selected="true"]').textContent(), 'import.tex');
  await menuAction(page, 'New manuscript'); await page.locator('#new-path').fill('created.html');
  const createCount = operationCount('create');
  await page.locator('#new-dialog').getByRole('button', { name: 'Create', exact: true }).click(); await atCapacity();
  assert.equal(operationCount('create'), createCount, 'blocked Create stops before a backend write');
  assert.ok(!(await readdir(projectRoot)).some(name => name.startsWith('created.html')), 'blocked Create leaves no source or review sidecar');
  await page.locator('#new-dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  const importCount = operationCount('import_tex');
  await menuAction(page, 'Import to Typst'); await atCapacity();
  assert.equal(operationCount('import_tex'), importCount, 'blocked TeX import stops before conversion or file creation');
  assert.ok(!(await readdir(projectRoot)).some(name => name.startsWith('import.typ')), 'blocked import leaves no Typst source, sidecar or report');
  assert.equal(await readFile(join(projectRoot, 'import.tex'), 'utf8'), texSource);

  await chooseFile(page, names[0]);
  assert.ok((await page.locator('.cm-content').textContent()).includes(draft), 'cached Open remains available at capacity and retains the draft');
  await page.locator('.cm-content').evaluate(source => source.focus());
  await until(() => page.evaluate(draft => getSelection()?.focusNode?.textContent === draft && getSelection()?.focusOffset === draft.length, draft), 'cached source restores its end-of-draft caret');
  await page.locator('#source-undo').click();
  assert.ok(!(await page.locator('.cm-content').textContent()).includes(draft), 'the original draft remains independently undoable');
  await page.locator('#source-redo').click();
  assert.ok((await page.locator('.cm-content').textContent()).includes(draft), 'redo restores the original draft after blocked actions');
  await menuAction(page, 'Save');
  await page.waitForFunction(() => document.getElementById('save-label').textContent === 'Saved locally');
  assert.equal(await readFile(join(projectRoot, names[0]), 'utf8'), firstSource + draft, 'draft saves to its original source');

  await closeTab(page, names[18]); assert.equal(await tabCount(), 19);
  await chooseFile(page, 'overflow.html'); assert.equal(await tabCount(), 20, 'closing one buffer permits Open again');
  assert.equal(operationCount('open', 'overflow.html'), openCount + 1);
  await closeTab(page, 'overflow.html'); assert.equal(await tabCount(), 19);
  await menuAction(page, 'New manuscript'); await page.locator('#new-path').fill('created.html');
  await page.locator('#new-dialog').getByRole('button', { name: 'Create', exact: true }).click(); await sourceReady(page, 'created.html');
  assert.equal(await tabCount(), 20, 'closing one buffer permits Create again');
  assert.equal(operationCount('create'), createCount + 1);
  assert.ok((await call({ action: 'open', project: project.id, path: 'created.html' })).content.length > 0);
  await closeTab(page, 'created.html'); assert.equal(await tabCount(), 19);
  await chooseFile(page, 'import.tex'); await menuAction(page, 'Import to Typst'); await sourceReady(page, 'import.typ');
  assert.equal(await tabCount(), 20, 'closing one buffer permits TeX import again');
  assert.equal(operationCount('import_tex'), importCount + 1);
  assert.ok((await readFile(join(projectRoot, 'import.typ'), 'utf8')).includes('A preserved result'));
  const report = JSON.parse(await readFile(join(projectRoot, 'import.typ.import-report.json'), 'utf8'));
  assert.equal(report.exactFormatting, false);
  assert.equal(await readFile(join(projectRoot, 'import.tex'), 'utf8'), texSource, 'successful import retains the exact TeX original');
  await chooseFile(page, names[0]); await page.locator('#source-undo').click(); await menuAction(page, 'Save');
  await until(async () => (await readFile(join(projectRoot, names[0]), 'utf8')) === firstSource, 'the original file retains its undo history after all capacity retries');
  assert.equal(await tabCount(), 20); assert.deepEqual(errors, []);
  console.log('Real Rust/browser 20-buffer limit passed for Open, Create and TeX import before backend work; one closed tab permits each retry, cached files remain available, and source/caret/undo/redo plus the TeX original are preserved. No compiler, GitHub or tunnel connection exercised.');
} finally {
  await browser?.close();
  if (child && child.exitCode === null && !startupError) {
    child.kill('SIGINT');
    await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(3000)]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  await rm(root, { recursive: true, force: true });
}
