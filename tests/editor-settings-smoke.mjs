// Real Rust authority + actual CodeMirror/Pretext; no user project, native window or compiler.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { cp, mkdtemp, mkdir, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const root = await mkdtemp(join(tmpdir(), 'undertree-editor-settings-'));
const binary = resolve(process.env.UNDERTREE_REVIEW_BINARY || 'target/debug/undertree-review');
const inputAssets = resolve(process.env.UNDERTREE_REVIEW_ASSETS || 'dist');
const projectRoot = join(root, 'project'), assets = join(root, 'assets'), token = randomBytes(32).toString('hex');
const checks = [], observations = [], errors = [], operations = [];
const original = Array.from({ length: 60 }, (_, index) => `<p>Line ${index + 1}: editable manuscript text remains unchanged.</p>`).join('\n') + '\n';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
let service, browser, port, log = '', base;
async function until(check, message) {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) { if (await check()) return; if (service && service.exitCode !== null) throw Error(log); await new Promise(resolve => setTimeout(resolve, 25)); }
  throw Error(message);
}
async function native(operation) {
  const result = await fetch(base + '/api/review', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(operation) }).then(response => response.json());
  assert.equal(result.ok, true, result.error?.message); return result.result;
}
async function settings(page) {
  const desktop = await page.locator('#menu-view-toggle').isVisible();
  const menu = page.locator(desktop ? '#menu-view' : '#workspace-menu');
  if ((await menu.getAttribute('open')) === null) await menu.locator('summary').click();
  await menu.locator('[data-command="editor-settings"]').click(); await page.locator('#editor-settings-dialog').waitFor({ state: 'visible' });
}
async function apply(page, size, lineHeight, wrap) {
  await settings(page); await page.locator('#settings-font-size').fill(String(size));
  await page.locator('#settings-line-height').selectOption(lineHeight); await page.locator('#settings-word-wrap').setChecked(wrap);
  await page.locator('#settings-apply').click(); await page.locator('#editor-settings-dialog').waitFor({ state: 'hidden' });
}
const settle = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)))));
async function bufferContents(page) {
  const desktop = await page.locator('#menu-file-toggle').isVisible(), menu = page.locator(desktop ? '#menu-file' : '#workspace-menu');
  if ((await menu.getAttribute('open')) === null) await menu.locator('summary').click();
  const downloading = page.waitForEvent('download'); await menu.locator(desktop ? '#export-manuscript' : '[data-command="download"]').click();
  return readFile(await (await downloading).path(), 'utf8');
}
try {
  await mkdir(projectRoot); await cp(inputAssets, assets, { recursive: true });
  await writeFile(join(projectRoot, 'settings.html'), original);
  service = spawn(binary, [], { env: { ...process.env, UNDERTREE_REVIEW_STATE: join(root, 'state'), UNDERTREE_REVIEW_PORT: '0', UNDERTREE_REVIEW_TOKEN: token, UNDERTREE_REVIEW_ASSETS: assets }, stdio: ['ignore', 'pipe', 'pipe'] });
  service.stdout.on('data', bytes => { log = (log + bytes).slice(-16_000); port = Number(log.match(/127\.0\.0\.1:(\d+)/)?.[1]); });
  service.stderr.on('data', bytes => { log = (log + bytes).slice(-16_000); });
  await until(() => !!port, 'Isolated settings service did not start.'); base = `http://127.0.0.1:${port}`;
  const project = await native({ action: 'add_project', root: projectRoot });
  const snapshot = await native({ action: 'open', project: project.id, path: 'settings.html' });
  const from = original.indexOf('Line 3:');
  await native({ action: 'mark', project: project.id, path: 'settings.html', revision: snapshot.review.revision, from, to: from + 6, rule: 'protect', prompt: '' });
  const policy = await readFile(join(projectRoot, 'settings.html.undertree-review.json'));
  browser = await chromium.launch({ executablePath: process.env.UNDERTREE_CHROME || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  await context.addInitScript(() => { if (window.top === window && !localStorage.getItem('undertree.workspace-preferences')) localStorage.setItem('undertree.workspace-preferences', JSON.stringify({ version: 1, filesWidth: 300, editorFraction: .65, reviewOpen: true, editorFontSize: 12, wordWrap: true })); });
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (/\/api\/(review|editor)$/.test(request.url())) operations.push(request.postDataJSON()); });
  await page.route('**/api/review', route => route.request().postDataJSON()?.action === 'save' ? route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ ok: false, error: { code: 'busy', message: 'This isolated presentation fixture retains unsaved source.' } }) }) : route.continue());
  await page.goto(base + `/manuscript.html#session=${token}`);
  await page.locator('#project-select').selectOption(project.id); await page.locator('.file-button[data-path="settings.html"]').click();
  const content = page.locator('.cm-content'); await content.waitFor();
  const pdfEngines = [];
  for (const name of await readdir(join(assets, 'assets'))) {
    if (name.endsWith('.js') && (await readFile(join(assets, 'assets', name), 'utf8')).includes('Setting up fake worker failed')) pdfEngines.push(name);
  }
  assert.ok(pdfEngines.length, 'the production bundle contains the PDF engine');
  const startupPdfEngines = await page.evaluate(names => performance.getEntriesByType('resource').filter(entry => names.includes(new URL(entry.name).pathname.split('/').pop())).map(entry => entry.name), pdfEngines);
  observations.push({ check: 'deferred-pdf-engine', loaded: startupPdfEngines.length });
  assert.deepEqual(startupPdfEngines, [], 'HTML editing defers loading the PDF engine');
  checks.push('HTML startup does not load the PDF engine');
  const presentation = () => page.evaluate(() => {
    const content = document.querySelector('.cm-content'), source = content.querySelector('.cm-line'), gutter = [...document.querySelectorAll('.cm-lineNumbers .cm-gutterElement')].find(node => node.textContent === '1');
    return { font: parseFloat(getComputedStyle(content).fontSize), spacing: parseFloat(getComputedStyle(content).lineHeight), gutterSpacing: parseFloat(getComputedStyle(gutter).lineHeight), gutterTop: gutter.getBoundingClientRect().top, sourceTop: source.getBoundingClientRect().top, wrap: content.classList.contains('cm-lineWrapping'), reviewGap: document.querySelector('.review-card')?.style.marginTop };
  });
  const preferences = () => page.evaluate(() => JSON.parse(localStorage.getItem('undertree.workspace-preferences')));
  const changedContent = () => operations.filter(operation => ['save', 'editor_commit', 'compile', 'compile_saved'].includes(operation?.action)).length;
  for (const [name, ratio] of [['compact', 1.33], ['normal', 1.6], ['wide', 2]]) {
    await apply(page, 12, name, true); await settle(page);
    const state = await presentation(); observations.push({ check: 'source-gutter-review-geometry', name, ...state });
    assert.ok(Math.abs(state.spacing - 12 * ratio) < .1); assert.ok(Math.abs(state.gutterSpacing - state.spacing) < .1);
    assert.ok(Math.abs(state.gutterTop - state.sourceTop) < 1); assert.ok(parseFloat(state.reviewGap) >= 0);
  }
  assert.equal(changedContent(), 0, 'presentation changes never issue source saves or compilation');
  const compactGap = parseFloat(observations.find(item => item.name === 'compact').reviewGap), wideGap = parseFloat(observations.find(item => item.name === 'wide').reviewGap);
  assert.ok(wideGap > compactGap, 'source-linked Review positions remeasure for taller source lines');
  checks.push('pinned source/gutter spacing and Review alignment update without source operations');

  await content.focus(); await page.keyboard.press('Control+End'); await page.keyboard.insertText('Undoable unsaved text.');
  await until(() => operations.some(operation => operation?.action === 'save'), 'The isolated autosave refusal did not settle.'); await page.waitForTimeout(100);
  const savesBefore = changedContent(), edits = await bufferContents(page);
  await apply(page, 18, 'compact', false); await settle(page);
  assert.equal(changedContent(), savesBefore); assert.equal(await bufferContents(page), edits); assert.match(await page.locator('#manuscript-tabs').textContent(), /•/);
  await content.focus(); await page.keyboard.press('Control+z'); assert.doesNotMatch(await content.textContent(), /Undoable unsaved text/);
  await page.keyboard.press('Control+Shift+z'); assert.match(await content.textContent(), /Undoable unsaved text/);
  await settings(page); await page.locator('#settings-font-size').fill('22'); await page.locator('#settings-line-height').selectOption('wide');
  await page.locator('#editor-settings-dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal((await preferences()).editorFontSize, 18); assert.equal((await preferences()).editorLineHeight, 'compact');
  await settings(page); await page.locator('#settings-reset').click(); await page.keyboard.press('Escape');
  assert.equal((await preferences()).editorFontSize, 18); assert.equal((await preferences()).editorLineHeight, 'compact');
  await settings(page); assert.equal(await page.locator('#settings-font-size').inputValue(), '18'); assert.equal(await page.locator('#settings-line-height').inputValue(), 'compact');
  await page.locator('#settings-reset').click(); await page.locator('#settings-apply').click();
  const reset = await preferences(); assert.equal(reset.editorFontSize, 12); assert.equal(reset.editorLineHeight, 'normal'); assert.equal(reset.wordWrap, true);
  assert.equal(reset.filesWidth, 300); assert.equal(reset.editorFraction, .65); assert.equal(reset.reviewOpen, true);
  checks.push('dirty content/history survive settings, Cancel/Escape preserve applied state, Reset preserves panes');

  await apply(page, 16, 'wide', false); await content.focus(); await page.keyboard.press('Control+z');
  await page.waitForTimeout(550); // Let the independently scheduled Undo autosave finish before reload.
  page.on('dialog', dialog => dialog.accept()); await page.reload();
  await page.locator('#project-select').selectOption(project.id); await page.locator('.file-button[data-path="settings.html"]').click(); await content.waitFor(); await settle(page);
  let restored = await presentation(); assert.equal(restored.font, 16); assert.equal(restored.spacing, 32); assert.equal(restored.wrap, false);
  await settings(page); assert.equal(await page.locator('#settings-line-height').inputValue(), 'wide'); await page.keyboard.press('Escape');
  assert.equal(await page.locator('#menu-view-toggle').evaluate(node => node === document.activeElement), true, 'Escape returns focus to the visible menu');
  await content.evaluate(node => (node.editContext || node).dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })));
  const menu = page.locator('#menu-view'); await menu.locator('summary').click(); await menu.locator('[data-command="editor-settings"]').click();
  assert.equal(await page.locator('#editor-settings-dialog').isVisible(), false); assert.match(await page.locator('#review-status').textContent(), /Finish composing/);
  await content.evaluate(node => (node.editContext || node).dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })));
  checks.push('persisted old-store-compatible settings restore and IME cannot be interrupted by settings');

  const background = () => page.evaluate(() => ({ size: [document.documentElement.scrollWidth, document.documentElement.scrollHeight], scrollTop: document.scrollingElement.scrollTop, windowScrollY: scrollY,
    review: ['.manuscript-review', '.manuscript-review .pane-heading', '.share-toggle', '#review-list'].map(selector => {
      const node = document.querySelector(selector), ancestors = [];
      for (let parent = node.parentElement; parent; parent = parent.parentElement) ancestors.push({ id: parent.id || parent.className || parent.tagName, overflow: getComputedStyle(parent).overflowY, height: parent.clientHeight });
      return { selector, rect: node.getBoundingClientRect().toJSON(), ancestors };
    }) }));
  async function geometry(label, before) {
    await settle(page);
    const result = await page.locator('#editor-settings-dialog').evaluate(dialog => ({
      viewport: [innerWidth, innerHeight], text: getComputedStyle(document.documentElement).fontSize,
      sourceHeight: document.getElementById('manuscript-source').clientHeight,
      documentSize: [document.documentElement.scrollWidth, document.documentElement.scrollHeight],
      outside: [...document.querySelectorAll('body > :not(script),#review-app > *,.review-workspace > *,.text-details-slot')].filter(node => node.getClientRects().length).map(node => ({ id: node.id || node.className, rect: node.getBoundingClientRect().toJSON() })).filter(({ rect }) => rect.right > innerWidth + 1 || rect.bottom > innerHeight + 1 || rect.left < -1),
      spills: [...document.body.querySelectorAll('*')].filter(node => node.getClientRects().length && node.getBoundingClientRect().bottom > innerHeight + 1).filter(node => {
        for (let parent = node.parentElement; parent && parent !== document.body; parent = parent.parentElement) if (/auto|scroll|hidden|clip/.test(getComputedStyle(parent).overflowY)) return false;
        return true;
      }).slice(0, 12).map(node => ({ id: node.id || node.className, rect: node.getBoundingClientRect().toJSON() })),
      pageOverflow: document.documentElement.scrollWidth > innerWidth + 1 || document.documentElement.scrollHeight > innerHeight + 1,
      overflow: dialog.scrollWidth > dialog.clientWidth + 1 || dialog.scrollHeight > dialog.clientHeight + 2,
      boxesOutside: [...dialog.querySelectorAll('button,input,select')].filter(node => node.getClientRects().length).filter(node => { const a = node.getBoundingClientRect(), b = dialog.getBoundingClientRect(); return a.left < b.left || a.right > b.right || a.top < b.top || a.bottom > b.bottom; }).map(node => node.id || node.textContent),
      fits: [...dialog.querySelectorAll('[data-measure]')].filter(node => node.getClientRects().length).map(node => ({ text: node.textContent, fit: node.dataset.textFit, size: [node.clientWidth, node.clientHeight], scroll: [node.scrollWidth, node.scrollHeight], parentWidth: node.parentElement.clientWidth })),
    }));
    observations.push({ check: label, ...result });
    if (result.pageOverflow || result.overflow || result.boxesOutside.length) {
      const open = await background(); await page.screenshot({ path: resolve('artifacts/editor-settings-layout-failure.png') });
      await page.locator('#editor-settings-dialog').evaluate(dialog => dialog.close()); await settle(page);
      console.log(JSON.stringify({ label, result, background: { before, open, closed: await background() } }));
    }
    assert.equal(result.pageOverflow, false, `${label}: page`); assert.equal(result.overflow, false, `${label}: dialog`); assert.deepEqual(result.boxesOutside, [], label);
    assert.ok(result.sourceHeight > 0, `${label}: source retains usable height`);
    assert.ok(result.fits.length >= 6 && result.fits.every(item => ['fit', 'reflow', 'details', 'unavailable'].includes(item.fit)), `${label}: real Pretext and readable fallback`);
  }
  // Native-frame CSS allocation supplements the separate actual Tauri/WebKit gate.
  for (const [width, height, text, frame = false] of [[1600, 1000, 14], [1100, 480, 28], [1100, 480, 28, true], [901, 480, 28, true], [1100, 480, 14, true], [320, 900, 28, true], [320, 600, 14], [1600, 1000, 14]]) {
    await page.setViewportSize({ width, height }); await page.evaluate(({ text, frame }) => {
      document.documentElement.style.fontSize = `${text}px`;
      document.getElementById('review-app').classList.toggle('native-window', frame);
      document.getElementById('window-titlebar').hidden = !frame;
    }, { text, frame });
    await settle(page); const before = await background();
    await settings(page); await geometry(`${width}x${height} at ${text}px text`, before); await page.keyboard.press('Escape');
    await settle(page); const after = await background();
    for (const state of [before, after]) {
      assert.ok(state.size[0] <= width + 1 && state.size[1] <= height + 1, 'Background fits before showModal and after close at the same dimensions');
      if (width > 900) {
        const [pane, heading, sharing, list] = state.review.map(item => item.rect);
        assert.ok(heading.bottom <= pane.bottom + 1 && sharing.bottom <= pane.bottom + 1 && list.bottom <= pane.bottom + 1, 'Review chrome and content region stay inside their pane');
        assert.ok(list.height >= text * 1.6 + 8, 'Review content retains a full enlarged empty-state line plus padding');
        const widths = await page.evaluate(() => ['.manuscript-editor', '.manuscript-preview'].map(selector => document.querySelector(selector).getBoundingClientRect().width));
        assert.ok(widths.every(width => width >= 100), 'Review reflow preserves editor and PDF space');
      }
    }
    observations.push({ check: 'same-size-background-before-and-after-close', viewport: [width,height], text, frame, before, after });
  }
  await page.setViewportSize({ width: 320, height: 900 }); await page.evaluate(() => { document.documentElement.style.fontSize = '28px'; });
  await settings(page); await page.evaluate(() => {
    document.documentElement.style.letterSpacing = '.12em'; document.documentElement.style.wordSpacing = '.16em';
    document.querySelector('#editor-settings-title').textContent = 'Editor-Einstellungen';
    document.querySelector('#settings-apply').textContent = 'Anwenden';
    document.querySelector('#settings-reset').textContent = 'Auf Standardwerte';
  });
  await geometry('long localized labels and user text spacing'); await page.keyboard.press('Escape');
  checks.push('finite settings controls pass independent width/height,320px,200percent,regrowth and text spacing');

  const blocked = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  await blocked.addInitScript(() => { if (window.top === window) Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('Storage denied', 'SecurityError'); } }); });
  const blockedPage = await blocked.newPage(); blockedPage.on('pageerror', error => errors.push(error.message));
  await blockedPage.goto(base + `/manuscript.html#session=${token}`); await blockedPage.locator('#project-select').selectOption(project.id); await blockedPage.locator('.file-button[data-path="settings.html"]').click();
  await apply(blockedPage, 20, 'compact', true); assert.match(await blockedPage.locator('#review-status').textContent(), /this session.*not be restored/);
  assert.equal(await blockedPage.locator('.cm-content').evaluate(node => getComputedStyle(node).fontSize), '20px');
  await settings(blockedPage); assert.equal(await blockedPage.locator('#settings-line-height').inputValue(), 'compact'); await blockedPage.keyboard.press('Escape'); await blocked.close();
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.evaluate(() => { document.documentElement.style.fontSize = '14px'; });
  await content.focus(); await page.keyboard.press('Control+End'); await page.keyboard.insertText(' First performance edit.'); await settle(page);
  await page.evaluate(() => {
    window.typingTab = document.querySelector('#manuscript-tabs [role="tab"][aria-selected="true"]');
    window.typingLabel = document.getElementById('save-label').firstChild;
    window.typingMutations = 0;
    window.typingObserver = new MutationObserver(records => { window.typingMutations += records.length; });
    for (const id of ['manuscript-tabs', 'save-label']) window.typingObserver.observe(document.getElementById(id), { childList: true, subtree: true, characterData: true });
  });
  for (let index = 0; index < 20; index += 1) await page.keyboard.insertText('x');
  await settle(page);
  const typing = await page.evaluate(() => {
    window.typingObserver.disconnect();
    return { mutations: window.typingMutations, sameTab: window.typingTab === document.querySelector('#manuscript-tabs [role="tab"][aria-selected="true"]'), sameLabel: window.typingLabel === document.getElementById('save-label').firstChild };
  });
  observations.push({ check: 'continuous-dirty-typing', ...typing });
  assert.deepEqual(typing, { mutations: 0, sameTab: true, sameLabel: true }, 'continuous dirty typing retains tabs and save-label nodes without chrome mutations');
  assert.match(await content.textContent(), /First performance edit\.x{20}/, 'all real input remains in the editor');
  checks.push('continuous dirty typing preserves tab nodes and performs zero tab/save-label mutations');
  assert.equal(await readFile(join(projectRoot, 'settings.html'), 'utf8'), original); assert.deepEqual(await readFile(join(projectRoot, 'settings.html.undertree-review.json')), policy);
  assert.deepEqual(errors, []); checks.push('denied storage remains usable and truthful; exact source/policy preserved');
  await mkdir(resolve('artifacts'), { recursive: true });
  await writeFile(resolve(process.env.UNDERTREE_SETTINGS_RECEIPT || 'artifacts/editor-settings-smoke.json'), JSON.stringify({ binary, binarySha256: hash(await readFile(binary)), assets: inputAssets, runnerSha256: hash(await readFile(new URL(import.meta.url))), checks, observations, errors }, null, 2) + '\n');
  console.log(`Editor settings: ${checks.length} real-service checks passed; source/policy bytes unchanged.`);
} catch (error) {
  await mkdir(resolve('artifacts'), { recursive: true });
  await writeFile(resolve('artifacts/editor-settings-smoke-failure.json'), JSON.stringify({ binary, assets: inputAssets, runnerSha256: hash(await readFile(new URL(import.meta.url))), checks, observations, errors, failure: error.message }, null, 2) + '\n');
  throw error;
} finally {
  await browser?.close(); service?.kill('SIGINT');
  if (service) { await Promise.race([new Promise(resolve => { if (service.exitCode !== null) resolve(); else service.once('exit', resolve); }), new Promise(resolve => setTimeout(resolve, 3000))]); if (service.exitCode === null) service.kill('SIGKILL'); }
  await rm(root, { recursive: true, force: true });
}
