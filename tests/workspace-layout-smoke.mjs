import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const temporary = await mkdtemp(join(tmpdir(), 'undertree-workspace-layout-'));
const projectRoot = join(temporary, 'project'), token = randomBytes(32).toString('hex');
await mkdir(projectRoot); await writeFile(join(projectRoot, 'fixture.html'), '<h1>Pane geometry</h1><p>The editor remains usable beside Review.</p>\n');
await writeFile(join(projectRoot, 'main.typ'), '= Split preview\n\nCompile button fixture.\n');
const child = spawn(resolve(process.env.UNDERTREE_REVIEW_BINARY || 'target/debug/undertree-review'), [], { env: { ...process.env, UNDERTREE_REVIEW_PORT: '0', UNDERTREE_REVIEW_STATE: join(temporary, 'state'), UNDERTREE_REVIEW_TOKEN: token }, stdio: ['ignore', 'pipe', 'pipe'] });
const childStopped = new Promise(resolve => child.once('exit', resolve));
let log = '', port, browser;
child.stdout.on('data', bytes => { log = (log + bytes).slice(-16_000); port = Number(log.match(/127\.0\.0\.1:(\d+)/)?.[1]); });
child.stderr.on('data', bytes => { log = (log + bytes).slice(-16_000); });
const observations = [], errors = [];
try {
  for (let index = 0; index < 100 && !port; index += 1) { if (child.exitCode !== null) throw new Error(log); await new Promise(resolve => setTimeout(resolve, 50)); }
  assert.ok(port, 'isolated native service starts');
  console.log('Workspace service ready.');
  const base = `http://127.0.0.1:${port}`;
  const response = await fetch(base + '/api/review', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ action: 'add_project', root: projectRoot }), signal: AbortSignal.timeout(15_000) });
  assert.equal((await response.json()).ok, true);
  browser = await chromium.launch({ executablePath: process.env.UNDERTREE_CHROME || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1100, height: 800 } });
  await context.addInitScript(() => { if (window.top === window) localStorage.setItem('undertree.workspace-preferences', JSON.stringify({ version: 1, filesWidth: 1200, reviewOpen: true, previewCollapsed: true, editorCollapsed: true })); });
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  await page.goto(base + `/manuscript.html#session=${token}`);
  await page.getByRole('button', { name: 'fixture.html', exact: true }).click();
  await page.locator('.cm-content').waitFor();
  console.log('Workspace editor ready.');
  assert.equal(await page.locator('.manuscript-editor').isVisible(), true, 'saved collapsed content panes recover on opening');
  assert.equal(await page.locator('.manuscript-preview').isVisible(), true, 'saved collapsed preview recovers on opening');
  assert.equal(await page.locator('#source-compile').isVisible(), false, 'HTML without a Typst main cannot compile');
  assert.equal(await page.locator('#editor-collapse,#preview-collapse').count(), 0, 'no accidental content-pane collapse arrows');
  async function inspect(label, desktop = true) {
    await page.waitForTimeout(100);
    const result = await page.evaluate(() => {
      const width = selector => document.querySelector(selector).getBoundingClientRect().width;
      const workspace = document.querySelector('.review-workspace');
      return { viewport: [innerWidth, innerHeight], rootText: getComputedStyle(document.documentElement).fontSize, files: width('.manuscript-files'), editor: width('.manuscript-editor'), preview: width('.manuscript-preview'), review: width('.manuscript-review'), sourceHeight: document.getElementById('manuscript-source').clientHeight, fileHeadingFit: document.getElementById('files-heading').dataset.textFit, preferred: JSON.parse(localStorage.getItem('undertree.workspace-preferences')).filesWidth, maximum: Number(document.getElementById('files-splitter').getAttribute('aria-valuemax')), actual: Number(document.getElementById('files-splitter').getAttribute('aria-valuenow')), reviewOpen: workspace.dataset.reviewOpen === 'true', overflow: [...document.querySelectorAll('.review-topbar,.pane-heading,.manuscript-toolbar,.review-status')].filter(node => node.getClientRects().length).filter(node => node.scrollWidth > node.clientWidth + 1 || node.scrollHeight > node.clientHeight + 2).map(node => node.className), pageOverflow: document.documentElement.scrollWidth > innerWidth + 1 || document.documentElement.scrollHeight > innerHeight + 1 };
    });
    observations.push({ label, ...result });
    assert.equal(result.preferred, 1200, `${label}: effective clamps preserve preferred width`);
    assert.equal(result.pageOverflow, false, `${label}: workspace stays within the viewport`);
    assert.deepEqual(result.overflow, [], `${label}: finite chrome has no internal overflow`);
    assert.ok(result.sourceHeight > 0, `${label}: source remains usable`);
    if (desktop) {
      assert.ok(['fit', 'reflow'].includes(result.fileHeadingFit), `${label}: actual Pretext checks the bounded file heading`);
      assert.ok(result.editor + result.preview >= 399, `${label}: editor and preview retain their 400px shared minimum, got ${result.editor + result.preview}`);
      assert.ok(result.actual <= result.maximum && Math.abs(result.files - result.actual) <= 1, `${label}: splitter describes the effective width`);
    }
    return result;
  }
  const narrow = await inspect('large stored width with Review');
  console.log('Workspace initial geometry checked.');
  for (const fraction of [.2, .5, .8]) for (const hidden of ['editor', 'preview']) {
    await page.evaluate(({ fraction, hidden }) => {
      const workspace = document.querySelector('.review-workspace');
      workspace.style.setProperty('--editor-size', `${fraction}fr`); workspace.style.setProperty('--preview-size', `${1 - fraction}fr`);
      workspace.dataset.editorCollapsed = String(hidden === 'editor'); workspace.dataset.previewCollapsed = String(hidden === 'preview');
    }, { fraction, hidden });
    const gap = await page.evaluate(hidden => {
      const workspace = document.querySelector('.review-workspace').getBoundingClientRect();
      const visible = document.querySelector(hidden === 'editor' ? '.manuscript-preview' : '.manuscript-editor').getBoundingClientRect();
      const review = document.querySelector('.manuscript-review').getBoundingClientRect();
      return workspace.right - visible.right - (hidden === 'preview' ? review.width : 0);
    }, hidden);
    assert.ok(Math.abs(gap) <= 1, `${hidden} hidden at ${fraction}: the visible pane fills its available track, gap ${gap}`);
    await page.locator(hidden === 'editor' ? '#rail-editor' : '#rail-preview').click();
    assert.equal(await page.locator('.manuscript-editor').isVisible(), true, 'navigation restores both panes');
    assert.equal(await page.locator('.manuscript-preview').isVisible(), true, 'navigation restores the PDF pane');
  }
  await page.locator('#review-toggle').click(); const closed = await inspect('Review closed');
  assert.ok(closed.files > narrow.files, 'closing Review returns its space to the preferred file panel');
  await page.locator('#review-toggle').click();
  const reopened = await inspect('Review reopened'); assert.ok(Math.abs(reopened.files - narrow.files) <= 1);
  for (const [width, height, text] of [[901, 800, 14], [1100, 480, 28], [2200, 1000, 28], [1100, 800, 14]]) {
    await page.setViewportSize({ width, height }); await page.evaluate(size => { document.documentElement.style.fontSize = `${size}px`; }, text);
    const measured = await inspect(`${width}x${height} at ${text}px text`);
    if (width === 2200) assert.ok(Math.abs(measured.files - 1200) <= 1, 'expansion restores the full user-owned width');
  }
  await page.setViewportSize({ width: 320, height: 900 }); await page.evaluate(() => { document.documentElement.style.fontSize = '28px'; });
  await page.getByRole('button', { name: 'Editor', exact: true }).click(); await inspect('320px reflow at 200% text', false);
  await page.setViewportSize({ width: 2200, height: 1000 }); await page.evaluate(() => { document.documentElement.style.fontSize = '14px'; });
  assert.ok(Math.abs((await inspect('regrowth after mobile reflow')).files - 1200) <= 1);
  await page.getByRole('button', { name: 'main.typ', exact: true }).click();
  console.log('Workspace Typst compilation checks.');
  await page.waitForFunction(() => !document.getElementById('source-compile').hidden);
  for (const [width, height, text] of [[901, 800, 28], [320, 900, 28], [1600, 480, 14]]) {
    await page.setViewportSize({ width, height }); await page.evaluate(size => { document.documentElement.style.fontSize = `${size}px`; }, text);
    await page.getByRole('button', { name: 'Editor', exact: true }).isVisible().then(visible => visible && page.getByRole('button', { name: 'Editor', exact: true }).click());
    await inspect(`Compile control ${width}x${height} at ${text}px`, width > 900);
    assert.equal(await page.locator('#source-compile').isVisible(), true);
    await page.waitForFunction(() => ['fit', 'reflow'].includes(document.getElementById('source-compile').dataset.textFit));
  }
  await page.setViewportSize({ width: 2200, height: 1000 });
  const compilation = () => page.waitForResponse(response => {
    try { return response.url().endsWith('/api/review') && response.request().postDataJSON()?.action === 'compile'; } catch { return false; }
  }, { timeout: 60_000 });
  const built = compilation(); await page.locator('#source-compile').click();
  assert.equal((await (await built).json()).ok, true, 'source Compile uses the real Rust/Typst build');
  await page.locator('#typst-pages canvas').first().waitFor();
  await page.waitForFunction(() => document.getElementById('source-compile').textContent === 'Compile');
  const canvas = await page.locator('#typst-pages canvas').first().evaluate(node => node.toDataURL());
  await page.locator('.cm-content').click(); await page.keyboard.press('Control+End'); await page.keyboard.insertText('\n#missing_split_fixture()\n');
  const failed = compilation(); await page.locator('#source-compile').click();
  const failure = await (await failed).json();
  assert.equal(failure.ok, false, 'compiler failure is reported');
  assert.equal(failure.error.code, 'typst', 'the invalid source reaches the compiler rather than an unrelated busy guard');
  await page.waitForFunction(() => document.getElementById('source-compile').textContent === 'Compile');
  assert.match(await readFile(join(projectRoot, 'main.typ'), 'utf8'), /missing_split_fixture/, 'explicit Compile saves the current source');
  assert.match(await page.locator('.cm-content').innerText(), /missing_split_fixture/, 'failed build keeps the editor text');
  assert.equal(await page.locator('#typst-pages canvas').first().evaluate(node => node.toDataURL()), canvas, 'failed build retains the last good PDF');
  await inspect('failed compilation keeps split and toolbar');
  await page.screenshot({ path: resolve('artifacts/workspace-split-compile.png') });
  assert.deepEqual(errors, []);
  await mkdir(resolve('artifacts'), { recursive: true });
  await writeFile(resolve('artifacts/workspace-layout-smoke.json'), JSON.stringify({ browser: browser.version(), observations, errors }, null, 2) + '\n');
  console.log(`Workspace layout: ${observations.length} real-service geometry/reflow observations passed.`);
} finally {
  await browser?.close(); child.kill('SIGINT');
  await Promise.race([childStopped, new Promise(resolve => setTimeout(resolve, 3000))]);
  if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await childStopped; }
  await rm(temporary, { recursive: true, force: true });
}
