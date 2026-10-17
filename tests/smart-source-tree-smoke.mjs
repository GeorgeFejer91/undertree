// Real Rust inventory + saved Typst graph + shipped browser UI. No user projects or profile.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { cp, mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const binary = resolve(process.env.UNDERTREE_REVIEW_BINARY || `target/debug/undertree-review${process.platform === 'win32' ? '.exe' : ''}`);
const assets = resolve(process.env.UNDERTREE_REVIEW_ASSETS || 'dist');
const chrome = process.env.UNDERTREE_CHROME || (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : '/usr/bin/google-chrome');
const evidence = resolve('artifacts/smart-source-tree-smoke.json');
const temporary = await mkdtemp(join(tmpdir(), 'undertree-smart-tree-'));
const fixtureAssets = join(temporary, 'assets');
const fixtureBinary = join(temporary, `undertree-review${process.platform === 'win32' ? '.exe' : ''}`);
const projectRoot = join(temporary, 'project'), otherRoot = join(temporary, 'other-project');
const token = randomBytes(32).toString('hex');
const mainPath = 'manuscript/typst/thesis.typ', chapterPath = 'manuscript/typst/parts/chapter.typ';
const expected = [mainPath, chapterPath, 'manuscript/typst/parts/nested/end.typ', 'manuscript/typst/parts/style.typ'].sort();
const fixture = {
  [mainPath]: '#import "parts/style.typ": local-style\n= Main document\n#include "parts/chapter.typ"\n',
  [chapterPath]: '= Chapter\n#include "nested/end.typ"\n',
  'manuscript/typst/parts/nested/end.typ': 'Final paragraph.\n',
  'manuscript/typst/parts/style.typ': '#let local-style = true\n',
  'manuscript/typst/alternate.typ': '= Alternate PDF\n#include "other.typ"\n',
  'manuscript/typst/other.typ': 'Alternate content.\n',
  'manuscript/typst/partial.typ': '#include "missing.typ"\n#let chosen = "other.typ"\n#include chosen\n',
  'analysis/unused.typ': '= Unused source\n',
  'data/results.csv': 'participant,value\n1,42\n',
  'figures/diagram.svg': '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>',
  'README.md': 'A complete project with data, assets, and multiple PDF sources.\n',
};
const checks = [], observations = [], errors = [], operations = [], apiFailures = [];
const pendingApi = new Set();
const backgroundObservations = new Set(['editor_poll', 'editor_register', 'editor_update', 'review_changes', 'review', 'connection', 'capabilities', 'pdf', 'pdf_annotations', 'git_status', 'projects', 'files']);
let child, browser, page, port, base, failure, log = '', releaseSave, releaseTree;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function check(message) { checks.push(message); console.log(message); }
async function startService() {
  port = undefined; log = '';
  child = spawn(fixtureBinary, [], { env: { ...process.env, UNDERTREE_REVIEW_PORT: '0', UNDERTREE_REVIEW_STATE: join(temporary, 'state'), UNDERTREE_REVIEW_TOKEN: token, UNDERTREE_REVIEW_ASSETS: fixtureAssets }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.on('error', error => { log += error.message; });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { log = (log + bytes).slice(-16000); port = Number(log.match(/127\.0\.0\.1:(\d+)/)?.[1]); });
  await until(() => !!port, 'The isolated Rust service did not start.'); base = `http://127.0.0.1:${port}`;
}
async function stopService() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const stopped = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGINT');
  await Promise.race([stopped, new Promise(resolve => setTimeout(resolve, 3000))]);
  if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await stopped; }
}
async function until(check, message, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    if (child?.exitCode !== null && child?.exitCode !== undefined) throw Error(log);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw Error(message);
}
async function native(operation) {
  const result = await fetch(base + '/api/review', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(operation), signal: AbortSignal.timeout(60000),
  }).then(response => response.json());
  assert.equal(result.ok, true, result.error?.message); return result.result;
}
async function menu(command) {
  const target = page.locator(await page.locator('#menu-file-toggle').isVisible() ? '#menu-file' : '#workspace-menu');
  if ((await target.getAttribute('open')) === null) await target.locator('summary').click();
  await target.locator(`[data-command="${command}"]`).click();
}
async function paths() { return page.locator('#manuscript-files .file-button').evaluateAll(nodes => nodes.map(node => node.dataset.path).sort()); }
async function expectPaths(expectedPaths) {
  await until(async () => JSON.stringify(await paths()) === JSON.stringify([...expectedPaths].sort()), `Wrong rendered source inventory: ${JSON.stringify(await paths())}`);
  assert.deepEqual(await paths(), [...expectedPaths].sort());
}
async function apiIdle() { await until(() => pendingApi.size === 0, 'The current page API operations did not finish.', 60000); }
async function smart(value, key) {
  const button = page.locator('#files-smart');
  assert.notEqual(await button.getAttribute('aria-checked'), String(value), 'Each toggle actually changes the current view');
  const before = operations.length;
  if (key) { await button.focus(); await page.keyboard.press(key); } else await button.click();
  assert.equal(await button.getAttribute('aria-checked'), String(value));
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.deepEqual(operations.slice(before).filter(operation => !backgroundObservations.has(operation?.action)), [], 'A view toggle issues no inventory reads, opens, writes, or builds beyond independent background observations');
}
async function open(path) {
  await apiIdle();
  const row = page.locator(`.file-button[data-path="${path}"]`);
  // Full view preserves the user's closed folders; opening them here is an explicit user action.
  const ancestors = await row.evaluate(node => {
    const paths = []; for (let folder = node.closest('details'); folder; folder = folder.parentElement.closest('details')) paths.unshift(folder.dataset.path); return paths;
  });
  for (const ancestor of ancestors) {
    const folder = page.locator(`.file-folder[data-path="${ancestor}"]`);
    if (!(await folder.evaluate(node => node.open))) await folder.locator(':scope > summary').click();
  }
  await row.click();
  await page.waitForFunction(path => document.querySelector('#manuscript-tabs [aria-selected="true"]')?.textContent === path, path);
  await page.locator('.cm-content').waitFor(); await apiIdle();
}
async function selectMain(path) {
  await open(path); await menu('set-main-document');
  await page.waitForFunction(path => document.getElementById('review-status').textContent === `Main document: ${path}`, path);
}
async function geometry(label) {
  await page.waitForFunction(() => ['files-heading', 'files-smart'].every(id => ['fit', 'reflow'].includes(document.getElementById(id).dataset.textFit)));
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const result = await page.evaluate(() => {
    const header = document.querySelector('.file-tree-heading');
    const controls = [...header.children].filter(node => node.getClientRects().length).map(node => ({ id: node.id, rect: node.getBoundingClientRect().toJSON(), fit: node.dataset.textFit, font: getComputedStyle(node).fontSize, overflow: node.scrollWidth > node.clientWidth + 1 || node.scrollHeight > node.clientHeight + 2 }));
    return { viewport: [innerWidth, innerHeight], rootText: getComputedStyle(document.documentElement).fontSize, pane: document.querySelector('.manuscript-files').getBoundingClientRect().toJSON(), header: header.getBoundingClientRect().toJSON(), headerOverflow: header.scrollWidth > header.clientWidth + 1 || header.scrollHeight > header.clientHeight + 2, pageOverflow: document.documentElement.scrollWidth > innerWidth + 1 || document.documentElement.scrollHeight > innerHeight + 1, controls };
  });
  observations.push({ label, ...result });
  assert.equal(result.pageOverflow, false, `${label}: no page overflow`);
  assert.equal(result.headerOverflow, false, `${label}: finite file header does not scroll or clip`);
  for (const control of result.controls) {
    assert.equal(control.overflow, false, `${label}: ${control.id} retains its content`);
    assert.ok(control.rect.width > 0 && control.rect.height > 0);
    assert.ok(control.rect.left >= result.header.left - 1 && control.rect.right <= result.header.right + 1 && control.rect.top >= result.header.top - 1 && control.rect.bottom <= result.header.bottom + 1, `${label}: ${control.id} remains in the allocated header`);
  }
  for (let first = 0; first < result.controls.length; first += 1) for (const second of result.controls.slice(first + 1)) {
    const a = result.controls[first].rect, b = second.rect;
    assert.ok(Math.min(a.right, b.right) - Math.max(a.left, b.left) <= 1 || Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) <= 1, `${label}: ${result.controls[first].id} does not overlap ${second.id}`);
  }
  return result;
}
try {
  await mkdir(projectRoot); await mkdir(otherRoot); await mkdir(resolve('artifacts'), { recursive: true });
  for (const [path, content] of Object.entries(fixture)) { await mkdir(dirname(join(projectRoot, path)), { recursive: true }); await writeFile(join(projectRoot, path), content); }
  await writeFile(join(otherRoot, 'other-main.typ'), '= Another project\n');
  await cp(assets, fixtureAssets, { recursive: true }); await cp(binary, fixtureBinary);
  await startService();
  let project = await native({ action: 'add_project', root: projectRoot });
  const other = await native({ action: 'add_project', root: otherRoot });
  browser = await chromium.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox'] });
  page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  page.on('pageerror', error => errors.push(error.message));
  page.on('framenavigated', frame => { if (frame === page.mainFrame()) pendingApi.clear(); });
  page.on('request', request => {
    if (!/\/api\/(review|editor)$/.test(request.url())) return;
    const operation = request.postDataJSON(); operations.push(operation);
    if (!['editor_poll', 'review_changes'].includes(operation?.action)) pendingApi.add(request);
  });
  page.on('requestfinished', request => pendingApi.delete(request)); page.on('requestfailed', request => pendingApi.delete(request));
  page.on('response', async response => {
    if (!/\/api\/(review|editor)$/.test(response.url())) return;
    const result = await response.json().catch(() => null);
    if (result?.ok === false) apiFailures.push({ operation: response.request().postDataJSON(), error: result.error });
  });
  await page.goto(base + `/manuscript.html#session=${token}`, { waitUntil: 'domcontentloaded' }); await page.locator('#project-select').selectOption(project.id);
  await until(async () => (await paths()).includes(mainPath), 'Full inventory did not load.');
  assert.equal(await page.locator('#files-smart').getAttribute('role'), 'switch');
  assert.equal(await page.locator('#files-smart').getAttribute('aria-checked'), 'false', 'Full project view is the default');
  assert.ok((await paths()).includes('analysis/unused.typ'));
  assert.equal(await page.locator('#manuscript-files [data-path="figures/diagram.svg"]').count(), 1);
  await smart(true, 'Enter'); await expectPaths([]);
  assert.match(await page.locator('#manuscript-files [role="status"]').innerText(), /main document/i);
  await smart(false, 'Space');
  check('Default Full inventory includes assets and unused sources; keyboard Enter/Space switches expose actionable guidance when no main is marked.');

  await selectMain(mainPath);
  assert.equal((await native({ action: 'projects' })).find(item => item.id === project.id).mainDocument, mainPath);
  const folderState = await page.locator('#manuscript-files details').evaluateAll(nodes => nodes.map(node => [node.dataset.path, node.open]));
  await smart(true); await expectPaths(expected);
  assert.equal(await page.locator('#manuscript-files .file-asset').count(), 0);
  assert.ok((await page.locator('#manuscript-files details').evaluateAll(nodes => nodes.map(node => node.open))).every(Boolean), 'Smart ancestors are expanded for direct navigation');
  assert.match(await page.locator('#manuscript-files [role="status"]').innerText(), /thesis\.typ/);
  const graph = (await native({ action: 'project_tree', project: project.id })).typstSources;
  assert.deepEqual([...graph.paths].sort(), expected); assert.equal(graph.main, mainPath); assert.equal(graph.complete, true);
  await smart(false);
  assert.deepEqual(await page.locator('#manuscript-files details').evaluateAll(nodes => nodes.map(node => [node.dataset.path, node.open])), folderState, 'Full folder expansion survives Smart auto-expansion');
  await smart(true); await expectPaths(expected);
  check('The marked persisted main selects recursive include/import sources, prunes data/assets/unused Typst, opens ancestor folders, and preserves Full folder expansion.');

  await open(chapterPath);
  const original = await readFile(join(projectRoot, chapterPath), 'utf8');
  const metadataPath = join(projectRoot, chapterPath + '.undertree-review.json');
  const readMetadata = () => readFile(metadataPath).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  const metadata = await readMetadata();
  let held = false;
  const gate = new Promise(resolve => { releaseSave = resolve; });
  let continuedSave;
  const saveContinued = new Promise(resolve => { continuedSave = resolve; });
  const holdAutosave = async route => {
    if (route.request().postDataJSON()?.action !== 'save') return route.continue();
    pendingApi.delete(route.request()); held = true; await gate;
    try { await route.continue(); } finally { continuedSave(); }
  };
  await page.route('**/api/review', holdAutosave);
  const editor = await page.locator('.cm-content').elementHandle(), beforeEdit = await page.locator('.cm-content').innerText();
  await page.locator('.cm-content').focus(); await page.keyboard.press('Control+End'); await page.keyboard.insertText('\nUnsaved Smart-view draft.');
  await until(() => held, 'The genuine preexisting autosave was not held.');
  const dirty = await page.locator('.cm-content').innerText(), writesBefore = operations.filter(operation => ['save', 'editor_commit', 'compile', 'sync'].includes(operation?.action)).length;
  await smart(false); await smart(true); await expectPaths(expected);
  assert.equal(await page.locator('.cm-content').evaluate((node, previous) => node === previous, editor), true, 'Toggle retains the mounted CodeMirror editor');
  assert.equal(await page.locator('.cm-content').innerText(), dirty);
  assert.match(await page.locator('#save-label').innerText(), /Unsaved|Saving/);
  assert.equal(operations.filter(operation => ['save', 'editor_commit', 'compile', 'sync'].includes(operation?.action)).length, writesBefore, 'Toggle starts no Save, editor commit, build, or sync');
  assert.equal(await readFile(join(projectRoot, chapterPath), 'utf8'), original); assert.deepEqual(await readMetadata(), metadata);
  await page.locator('#source-undo').click(); assert.equal(await page.locator('.cm-content').innerText(), beforeEdit, 'Undo history survives both view changes');
  await page.locator('#source-redo').click(); assert.equal(await page.locator('.cm-content').innerText(), dirty, 'Redo history survives both view changes');
  releaseSave(); await saveContinued; await page.unroute('**/api/review', holdAutosave);
  await until(async () => (await readFile(join(projectRoot, chapterPath), 'utf8')).includes('Unsaved Smart-view draft.'), 'The released existing autosave did not complete.');
  await until(async () => /Saved locally/.test(await page.locator('#save-label').innerText()), 'The editor did not settle after releasing its existing autosave.');
  check('With genuine autosave explicitly held, toggling retains the dirty mounted editor, disk/policy bytes, and Undo/Redo while dispatching no new write or compilation.');

  // Retire the stressed editor's automatic build queue. Compile qualification gets
  // its own clean project and page, with no inherited PDF or pending autosave.
  await apiIdle(); await page.goto('about:blank');
  pendingApi.clear(); // The retired document's requests do not belong to the fresh fixture.
  await stopService(); await startService();
  const compileRoot = join(temporary, 'compile-project');
  await cp(projectRoot, compileRoot, { recursive: true });
  project = await native({ action: 'add_project', root: compileRoot });
  const compileInventory = await native({ action: 'project_tree', project: project.id });
  const compileMain = compileInventory.entries.find(entry => entry.path === mainPath);
  await native({ action: 'set_main_document', project: project.id, path: mainPath, sourceEpoch: compileMain.sourceEpoch, expectedRoot: compileInventory.expectedRoot });
  await page.goto(base + `/manuscript.html#session=${token}`, { waitUntil: 'domcontentloaded' });
  await page.locator('#project-select').selectOption(project.id);
  await until(async () => (await paths()).includes(mainPath), 'The clean compile project inventory did not load.');
  await smart(true); await expectPaths(expected);
  await open(mainPath); await open(chapterPath); await apiIdle();
  const addedPath = 'manuscript/typst/parts/nested/after-build.typ';
  await writeFile(join(compileRoot, addedPath), 'Added included source.\n');
  await writeFile(join(compileRoot, 'manuscript/typst/parts/nested/end.typ'), 'Final paragraph.\n#include "after-build.typ"\n');
  assert.equal((await paths()).includes(addedPath), false, 'The old graph predates the saved dependency edit');
  let refreshHeld = false;
  const refreshGate = new Promise(resolve => { releaseTree = resolve; });
  const holdTree = async route => {
    if (route.request().postDataJSON()?.action !== 'project_tree') return route.continue();
    const response = await route.fetch(); refreshHeld = true; await refreshGate; await route.fulfill({ response });
  };
  await page.route('**/api/review', holdTree);
  const compiled = page.waitForResponse(response => {
    try { return response.url().endsWith('/api/review') && response.request().postDataJSON()?.action === 'compile'; } catch { return false; }
  }, { timeout: 60000 });
  await page.locator('#source-compile').click(); assert.equal((await (await compiled).json()).ok, true, 'The real Typst compiler builds the selected main');
  await until(() => refreshHeld, 'The post-compile real inventory refresh was not received.');
  assert.equal(await page.locator('#source-compile').innerText(), 'Compiling…', 'Build admission remains busy until the native graph observation completes');
  await page.locator(`.file-button[data-path="${chapterPath}"]`).focus();
  releaseTree();
  await expectPaths([...expected, addedPath]);
  await until(async () => await page.locator('#source-compile').innerText() === 'Compile', 'Build admission did not finish after the source graph rendered.');
  assert.equal(await page.evaluate(() => document.activeElement?.dataset.path), chapterPath, 'Background graph refresh retains keyboard focus on the same source row');
  await page.unroute('**/api/review', holdTree);
  assert.equal(await page.locator('#manuscript-tabs [aria-selected="true"]').textContent(), chapterPath, 'Refreshing the compile graph preserves the active source');
  check('A real compile refresh discovers a newly saved recursive source without replacing the active chapter or losing focused source-row keyboard navigation.');

  for (const [width, height, text] of [[1600, 900, 14], [1600, 480, 28]]) {
    await page.setViewportSize({ width, height }); await page.evaluate(text => { document.documentElement.style.fontSize = `${text}px`; }, text);
    await page.locator('#files-splitter').focus(); await page.keyboard.press('Home'); await geometry(`${width}x${height}, ${text}px text, default pane`);
    for (let step = 0; step < 5; step += 1) await page.keyboard.press('ArrowLeft');
    const minimum = await geometry(`${width}x${height}, ${text}px text, 150px pane`); assert.ok(Math.abs(minimum.pane.width - 150) <= 1);
    for (let step = 0; step < 2; step += 1) await page.keyboard.press('ArrowRight'); await geometry(`${width}x${height}, ${text}px text, 190px pane`);
    await page.locator('#files-splitter').focus(); await page.keyboard.press('Home');
    await page.locator('#files-heading').evaluate(node => { node.textContent = 'Project manuscript source file tree'; });
    await geometry(`${width}x${height}, ${text}px text, long heading`);
    await page.locator('#files-heading').evaluate(node => { node.textContent = 'File tree'; });
  }
  await page.setViewportSize({ width: 320, height: 900 });
  await page.getByRole('button', { name: 'Files', exact: true }).click(); await geometry('320px reflow at 200% text');
  await smart(false, 'Space'); await smart(true, 'Enter'); await expectPaths([...expected, addedPath]);
  await page.setViewportSize({ width: 1600, height: 900 }); await page.evaluate(() => { document.documentElement.style.fontSize = '14px'; });
  await geometry('desktop regrowth'); await page.screenshot({ path: resolve('artifacts/smart-source-tree.png') });
  check('Actual measured heading/switch and rendered bounds fit 150–233px panes, wide-short 200% text, a long heading, 320px Files reflow, keyboard operation and regrowth.');

  await page.reload({ waitUntil: 'domcontentloaded' }); await page.locator('#project-select').selectOption(project.id); await expectPaths([...expected, addedPath]);
  assert.equal(await page.locator('#files-smart').getAttribute('aria-checked'), 'true');
  assert.equal(await page.evaluate(() => localStorage.getItem('undertree.smart-file-tree')), 'true');
  await page.locator('#project-select').selectOption(other.id); await expectPaths([]);
  assert.match(await page.locator('#manuscript-files [role="status"]').innerText(), /main document/i);
  await smart(false); await selectMain('other-main.typ'); await smart(true); await expectPaths(['other-main.typ']);
  await page.locator('#project-select').selectOption(project.id); await expectPaths([...expected, addedPath]);
  await apiIdle(); await page.goto('about:blank'); pendingApi.clear();
  const alternateInventory = await native({ action: 'project_tree', project: project.id });
  const alternateSource = alternateInventory.entries.find(entry => entry.path === 'manuscript/typst/alternate.typ');
  await native({ action: 'set_main_document', project: project.id, path: alternateSource.path, sourceEpoch: alternateSource.sourceEpoch, expectedRoot: alternateInventory.expectedRoot });
  await page.goto(base + `/manuscript.html#session=${token}`, { waitUntil: 'domcontentloaded' }); await page.locator('#project-select').selectOption(project.id);
  await expectPaths(['manuscript/typst/alternate.typ', 'manuscript/typst/other.typ']);
  // Main changes are already exercised through the real File menu above. Retire the
  // PDF/editor work before this separate native partial-graph fixture.
  await apiIdle(); await page.goto('about:blank'); pendingApi.clear();
  const partialInventory = await native({ action: 'project_tree', project: project.id });
  const partialSource = partialInventory.entries.find(entry => entry.path === 'manuscript/typst/partial.typ');
  await native({ action: 'set_main_document', project: project.id, path: partialSource.path, sourceEpoch: partialSource.sourceEpoch, expectedRoot: partialInventory.expectedRoot });
  await page.goto(base + `/manuscript.html#session=${token}`, { waitUntil: 'domcontentloaded' }); await page.locator('#project-select').selectOption(project.id);
  await expectPaths(['manuscript/typst/partial.typ']);
  const partial = (await native({ action: 'project_tree', project: project.id })).typstSources;
  assert.equal(partial.complete, false); assert.ok(partial.reason);
  assert.ok((await page.locator('#manuscript-files [role="status"]').innerText()).includes(partial.reason), 'Missing/dynamic includes expose the native partial-result explanation');
  await apiIdle(); await menu('clear-main-document'); await expectPaths([]);
  assert.match(await page.locator('#manuscript-files [role="status"]').innerText(), /main document/i);
  check('Smart preference survives reload, remains isolated across project changes, refreshes on main changes, and explains partial missing/dynamic dependencies and cleared mains.');
  assert.deepEqual(errors, []);
  assert.deepEqual(apiFailures.filter(receipt => receipt.error?.code === 'format'), [], 'The real native binary supports the served frontend protocol');
  console.log(`Smart source tree: ${checks.length} real-service browser checks and ${observations.length} rendered geometry observations passed.`);
} catch (error) {
  failure = error; await page?.screenshot({ path: resolve('artifacts/smart-source-tree-failure.png') }).catch(() => {}); throw error;
} finally {
  releaseSave?.(); releaseTree?.(); await page?.unrouteAll({ behavior: 'wait' }).catch(() => {}); await browser?.close();
  await stopService();
  await mkdir(dirname(evidence), { recursive: true });
  await writeFile(evidence, JSON.stringify({ result: failure ? 'failed' : 'passed', error: failure?.stack, binary, isolatedBinary: fixtureBinary, binarySha256: hash(await readFile(fixtureBinary)), assets, isolatedAssets: fixtureAssets, manuscriptHtmlSha256: hash(await readFile(join(fixtureAssets, 'manuscript.html'))), runnerSha256: hash(await readFile(new URL(import.meta.url))), browser: browser?.version(), checks, observations, errors, apiFailures, serviceLog: failure ? log : undefined }, null, 2) + '\n');
  await rm(temporary, { recursive: true, force: true });
}
