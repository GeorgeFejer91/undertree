// Isolated native authority + rendered inventory; never uses a user project or window.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cp, mkdtemp, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const temporary = await mkdtemp(join(tmpdir(), 'undertree-project-tree-'));
const binary = resolve(process.env.UNDERTREE_REVIEW_BINARY || 'target/debug/undertree-review');
const assets = join(temporary, 'assets'), projectRoot = join(temporary, 'project'), otherRoot = join(temporary, 'other');
const token = randomBytes(32).toString('hex'), checks = [], observations = [], errors = [], operations = [];
const deferred = () => { let resolve, reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail; }); promise.catch(() => {}); return { promise, resolve, reject }; };
const safeMessage = value => String(value ?? '').replaceAll(token, '[redacted]').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 1000);
let service, browser, page, port, log = '', base, lateCreationReply;
async function waitUntil(check, message) {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    if (service?.exitCode !== null) throw new Error(log);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(message);
}
async function native(operation) {
  const response = await fetch(base + '/api/review', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(operation) }).then(response => response.json());
  assert.equal(response.ok, true, response.error?.message); return response.result;
}
try {
  await cp(resolve(process.env.UNDERTREE_REVIEW_ASSETS || 'dist'), assets, { recursive: true });
  await mkdir(join(projectRoot, 'chapters', 'empty'), { recursive: true });
  await mkdir(join(projectRoot, 'empty')); await mkdir(join(projectRoot, 'assets')); await mkdir(otherRoot);
  const original = '<p>Nested source with local history.</p>\n', dirty = '<p>Unsaved user text stays in its editor.</p>\n';
  await writeFile(join(projectRoot, 'main.html'), '<p>Main source.</p>\n');
  await writeFile(join(projectRoot, 'chapters', 'part.html'), original);
  await writeFile(join(projectRoot, 'assets', 'picture.png'), Buffer.from([0xff, 0x80, 0, 0x23]));
  await writeFile(join(projectRoot, 'obsolete.png'), Buffer.from([0xff]));
  await writeFile(join(otherRoot, 'other.html'), '<p>Another project.</p>\n');
  let deep = projectRoot;
  for (let index = 0; index < 34; index += 1) { deep = join(deep, `d${index}`); await mkdir(deep); }
  if (process.platform !== 'win32') await writeFile(Buffer.concat([Buffer.from(projectRoot + '/invalid-'), Buffer.from([0xff]), Buffer.from('.png')]), Buffer.from([0xff]));
  service = spawn(binary, [], { env: { ...process.env, UNDERTREE_REVIEW_PORT: '0', UNDERTREE_REVIEW_STATE: join(temporary, 'state'), UNDERTREE_REVIEW_ASSETS: assets, UNDERTREE_REVIEW_TOKEN: token }, stdio: ['ignore', 'pipe', 'pipe'] });
  service.stdout.on('data', bytes => { log = (log + bytes).slice(-16_000); port = Number(log.match(/127\.0\.0\.1:(\d+)/)?.[1]); });
  service.stderr.on('data', bytes => { log = (log + bytes).slice(-16_000); });
  await waitUntil(() => !!port, 'The isolated Rust authority did not start.'); base = `http://127.0.0.1:${port}`;
  const project = await native({ action: 'add_project', root: projectRoot }), other = await native({ action: 'add_project', root: otherRoot });
  browser = await chromium.launch({ executablePath: process.env.UNDERTREE_CHROME || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
  page = await browser.newPage({ viewport: { width: 1280, height: 850 } }); page.on('pageerror', error => errors.push(error.message));
  let blockSaves = true;
  page.on('request', request => {
    if (/\/api\/(review|editor)$/.test(request.url())) operations.push(request.postDataJSON());
  });
  await page.route('**/api/review', route => route.request().postDataJSON()?.action === 'save' && blockSaves
    ? route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ ok: false, error: { code: 'busy', message: 'Autosave paused in this isolated inventory fixture.' } }) }) : route.continue());
  await page.goto(base + `/manuscript.html#session=${token}`);
  await page.locator('#project-select').selectOption(project.id);
  const tree = page.locator('#manuscript-files');
  await waitUntil(() => tree.getAttribute('data-project').then(value => value === project.id), 'The requested project inventory was not rendered.');
  const folder = path => page.locator('.file-folder').filter({ has: page.locator(`:scope > summary[aria-label=${JSON.stringify('Folder ' + path)}]`) });
  const folderByPath = path => page.locator(`.file-folder[data-path=${JSON.stringify(path)}]`);
  await folderByPath('empty').waitFor(); assert.equal(await folderByPath('empty').locator('.tree-children > *').count(), 0);
  await folderByPath('chapters').locator(':scope > summary').click();
  await folderByPath('chapters/empty').waitFor();
  assert.match(await tree.locator('.file-help').textContent(), /Inventory limit reached/);
  if (process.platform !== 'win32') assert.match(await tree.locator('.file-help').textContent(), /non-UTF-8 filename/);
  assert.doesNotMatch(await tree.innerText(), /No visible files/);
  await page.locator('.file-button[data-path="chapters/part.html"]').click();
  const source = page.locator('.cm-content'); await source.waitFor();
  assert.equal((await source.innerText()).trimEnd(), original.trimEnd());
  await folderByPath('assets').locator(':scope > summary').click();
  const asset = page.locator('.file-asset[data-path="assets/picture.png"]');
  assert.match(await asset.textContent(), /assets\/picture\.png.*Asset \(not editable\)/);
  assert.equal(await asset.locator('button,a').count(), 0);
  const opened = operations.filter(operation => operation.action === 'open').length;
  await asset.click(); await page.evaluate(() => new Promise(requestAnimationFrame));
  assert.equal(operations.filter(operation => operation.action === 'open').length, opened);
  assert.equal(await page.locator('.file-button[aria-current="true"]').getAttribute('data-path'), 'chapters/part.html');
  checks.push('native inventory preserves empty directories, nested sources, binary assets and honest partial/filename notices');

  async function command(name) {
    const mobile = await page.locator('#workspace-menu').isVisible(), menu = page.locator(mobile ? '#workspace-menu' : '#menu-file');
    if (!(await menu.evaluate(element => element.open))) await menu.locator(':scope > summary').click();
    await menu.locator(`[data-command="${name}"]`).click();
  }
  async function newFolder(path) { await command('new-folder'); await page.locator('#new-folder-path').fill(path); await page.locator('#new-folder-submit').click(); }
  const saves = () => operations.filter(operation => operation.action === 'save' || operation.action === 'editor_commit').length;
  await source.focus(); await page.keyboard.press('Control+A'); await page.keyboard.insertText(dirty);
  await waitUntil(() => saves() > 0, 'The fixture did not observe a blocked ordinary autosave.');
  const attempts = saves();
  await newFolder('chapters/drafts');
  await waitUntil(() => folderByPath('chapters/drafts').count(), 'A created empty nested folder was not rendered.');
  await command('refresh-files'); await folderByPath('chapters/drafts').waitFor();
  assert.equal((await source.innerText()).trimEnd(), dirty.trimEnd()); assert.equal(await readFile(join(projectRoot, 'chapters', 'part.html'), 'utf8'), original);
  assert.equal(saves(), attempts, 'folder creation, refresh and expansion must not trigger an editor save');
  await source.focus(); await page.keyboard.press('Control+Z'); assert.equal((await source.innerText()).trimEnd(), original.trimEnd());
  await page.keyboard.press('Control+Shift+Z'); assert.equal((await source.innerText()).trimEnd(), dirty.trimEnd());
  checks.push('folder creation and refresh preserve dirty source, disk bytes and undo/redo history without an implicit save');
  await source.evaluate(element => (element.editContext || element).dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })));
  await command('new-folder'); assert.equal(await page.locator('#new-folder-dialog').evaluate(element => element.open), false);
  assert.match(await page.locator('#review-status').textContent(), /Finish composing text/);
  await source.evaluate(element => (element.editContext || element).dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })));
  await newFolder('missing/child');
  await page.locator('#new-folder-error').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#new-folder-path').inputValue(), 'missing/child');
  assert.equal((await stat(join(projectRoot, 'missing')).catch(() => null)), null);
  await page.locator('#new-folder-dialog [data-close]').click();
  checks.push('IME blocks opening folder creation and native missing-parent refusal preserves the form and editor');

  // An older inventory must not restore an obsolete row after a newer post-create inventory.
  const oldInventory = deferred(), releaseInventory = deferred(), inventoryDone = deferred(); let heldInventory = false;
  await page.route('**/api/review', async route => {
    const operation = route.request().postDataJSON();
    if (operation.action !== 'project_tree' || operation.project !== project.id || heldInventory) return route.fallback();
    heldInventory = true; const response = await route.fetch(); oldInventory.resolve(); await releaseInventory.promise; await route.fulfill({ response }); inventoryDone.resolve();
  });
  await command('refresh-files'); await oldInventory.promise; await rm(join(projectRoot, 'obsolete.png'));
  await newFolder('fresh'); await folderByPath('fresh').waitFor();
  assert.equal(await page.locator('.file-asset[data-path="obsolete.png"]').count(), 0);
  releaseInventory.resolve(); await inventoryDone.promise; await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 50)));
  assert.equal(await page.locator('.file-asset[data-path="obsolete.png"]').count(), 0); await folderByPath('fresh').waitFor();
  checks.push('a held stale inventory cannot replace a newer creation refresh');

  blockSaves = false; await page.locator('#menu-file-toggle').click(); await page.locator('#manuscript-save').click();
  await waitUntil(async () => (await readFile(join(projectRoot, 'chapters', 'part.html'), 'utf8')) === dirty, 'The explicit local save did not finish.');
  for (const [chord, content] of [['Control+S', '<p>Uppercase Save shortcut.</p>\n'], ['Control+s', dirty]]) {
    await source.focus(); await page.keyboard.press('Control+A'); await page.keyboard.insertText(content);
    await page.keyboard.press(chord);
    await waitUntil(async () => (await readFile(join(projectRoot, 'chapters', 'part.html'), 'utf8')) === content, `${chord} must save the actual editor buffer.`);
  }
  checks.push('uppercase and lowercase Ctrl+S both save the actual buffer through the normal local coordinator');
  const created = deferred(), releaseCreation = deferred(), creationDone = deferred(); let heldCreation = false;
  await page.route('**/api/review', async route => {
    const operation = route.request().postDataJSON();
    if (operation.action !== 'create_directory' || operation.path !== 'late-folder' || heldCreation) return route.fallback();
    heldCreation = true;
    try {
      const response = await route.fetch(), result = await response.json();
      lateCreationReply = {
        ok: result.ok, status: response.status(),
        error: result.error ? { code: safeMessage(result.error.code).slice(0, 80), message: safeMessage(result.error.message) } : null,
      };
      created.resolve(lateCreationReply);
      if (result.ok === true) await releaseCreation.promise;
      await route.fulfill({ response }); creationDone.resolve();
    } catch (error) { created.reject(error); creationDone.reject(error); }
  });
  await newFolder('late-folder');
  const creation = await created.promise;
  assert.equal(creation.ok, true, `late-folder native response: ${JSON.stringify(creation)}`);
  await page.locator('#new-folder-dialog [data-close]').click();
  await page.locator('#project-select').selectOption(other.id);
  await waitUntil(() => tree.getAttribute('data-project').then(value => value === other.id), 'The second project inventory did not become current.');
  await command('new-folder'); await page.locator('#new-folder-path').fill('other-draft');
  releaseCreation.resolve(); await creationDone.promise; await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 50)));
  assert.equal(await page.locator('#new-folder-dialog').evaluate(element => element.open), true);
  assert.equal(await page.locator('#new-folder-path').inputValue(), 'other-draft');
  assert.equal(await tree.getAttribute('data-project'), other.id);
  assert.equal((await stat(join(projectRoot, 'late-folder'))).isDirectory(), true);
  assert.equal(await stat(join(otherRoot, 'late-folder')).catch(() => null), null);
  assert.equal(await folderByPath('late-folder').count(), 0);
  await page.locator('#new-folder-dialog [data-close]').click();
  checks.push('a canceled delayed creation cannot close a newer dialog or retarget a switched project');

  await page.locator('#project-select').selectOption(project.id);
  await folderByPath('late-folder').waitFor();
  await page.reload(); await page.locator('#project-select').selectOption(project.id); await folderByPath('late-folder').waitFor();
  for (const [width, height, text] of [[1100, 480, 28], [320, 900, 28]]) {
    await page.setViewportSize({ width, height }); await page.evaluate(size => { document.documentElement.style.fontSize = `${size}px`; }, text);
    if (width <= 900) await page.locator('[data-view="files"]').click();
    await command('new-folder');
    await waitUntil(() => page.locator('#new-folder-title').getAttribute('data-text-fit').then(value => ['fit', 'reflow'].includes(value)), 'Actual Pretext did not measure the folder dialog title.');
    const geometry = await page.evaluate(() => ({ viewport: [innerWidth, innerHeight], text: getComputedStyle(document.documentElement).fontSize, pageOverflow: document.documentElement.scrollWidth > innerWidth + 1 || document.documentElement.scrollHeight > innerHeight + 1, dialogWidth: document.getElementById('new-folder-dialog').getBoundingClientRect().width, titleFit: document.getElementById('new-folder-title').dataset.textFit, createFit: document.getElementById('new-folder-submit').dataset.textFit }));
    observations.push(geometry); assert.equal(geometry.pageOverflow, false); assert.ok(geometry.dialogWidth <= width); assert.ok(['fit', 'reflow'].includes(geometry.createFit));
    await page.locator('#new-folder-dialog [data-close]').click();
  }
  checks.push('empty folders persist after reload and the existing menu/dialog reflows at short height and 320px with 200% text');
  assert.deepEqual(errors, []);
  await mkdir(resolve('artifacts'), { recursive: true }); await writeFile(resolve('artifacts/project-tree-smoke.json'), JSON.stringify({ browser: browser.version(), checks, observations, errors, scope: 'local UI inventory and one-leaf folder creation; no remote file management' }, null, 2) + '\n');
  console.log(`Project tree: ${checks.length} real Rust/rendered checks passed.`);
} catch (error) {
  const directory = resolve('artifacts/project-tree-failure');
  await mkdir(directory, { recursive: true });
  const ui = await page?.evaluate(() => ({
    save: document.getElementById('save-label')?.textContent?.slice(0, 1000),
    status: document.getElementById('review-status')?.textContent?.slice(0, 1000),
    folderError: document.getElementById('new-folder-error')?.textContent?.slice(0, 1000),
    folderPath: document.getElementById('new-folder-path')?.value?.slice(0, 1000),
    folderOpen: document.getElementById('new-folder-dialog')?.open,
    project: document.getElementById('project-select')?.value,
  })).catch(capture => ({ captureError: safeMessage(capture.message) }));
  await writeFile(join(directory, 'evidence.json'), JSON.stringify({
    result: 'failed', error: safeMessage(error.message), lateCreationReply, checks, observations,
    errors: errors.slice(-32).map(safeMessage), ui,
    operations: operations.slice(-128).map(({ action, project, path }) => ({ action, project, path })),
  }, null, 2) + '\n');
  await page?.screenshot({ path: join(directory, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  await browser?.close();
  if (service?.exitCode === null) { service.kill('SIGINT'); await Promise.race([new Promise(resolve => service.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 3000))]); if (service.exitCode === null) service.kill('SIGKILL'); }
  await rm(temporary, { recursive: true, force: true });
}
