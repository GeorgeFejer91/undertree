import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const temporary = await mkdtemp(join(tmpdir(), 'undertree-workspace-layout-'));
const projectRoot = join(temporary, 'project'), token = randomBytes(32).toString('hex');
await mkdir(projectRoot); await writeFile(join(projectRoot, 'fixture.html'), '<h1>Pane geometry</h1><p>The editor remains usable beside Review.</p>\n');
const child = spawn(resolve('target/debug/undertree-review'), [], { env: { ...process.env, UNDERTREE_REVIEW_PORT: '0', UNDERTREE_REVIEW_STATE: join(temporary, 'state'), UNDERTREE_REVIEW_TOKEN: token }, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '', port, browser;
child.stdout.on('data', bytes => { log = (log + bytes).slice(-16_000); port = Number(log.match(/127\.0\.0\.1:(\d+)/)?.[1]); });
child.stderr.on('data', bytes => { log = (log + bytes).slice(-16_000); });
const observations = [], errors = [];
try {
  for (let index = 0; index < 100 && !port; index += 1) { if (child.exitCode !== null) throw new Error(log); await new Promise(resolve => setTimeout(resolve, 50)); }
  assert.ok(port, 'isolated native service starts');
  const base = `http://127.0.0.1:${port}`;
  const response = await fetch(base + '/api/review', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ action: 'add_project', root: projectRoot }) });
  assert.equal((await response.json()).ok, true);
  browser = await chromium.launch({ executablePath: process.env.UNDERTREE_CHROME || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1100, height: 800 } });
  await context.addInitScript(() => { if (window.top === window) localStorage.setItem('undertree.workspace-preferences', JSON.stringify({ version: 1, filesWidth: 1200, reviewOpen: true })); });
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  await page.goto(base + `/manuscript.html#session=${token}`);
  await page.getByRole('button', { name: 'fixture.html', exact: true }).click();
  await page.locator('.cm-content').waitFor();
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
  assert.deepEqual(errors, []);
  await mkdir(resolve('artifacts'), { recursive: true });
  await writeFile(resolve('artifacts/workspace-layout-smoke.json'), JSON.stringify({ browser: browser.version(), observations, errors }, null, 2) + '\n');
  console.log(`Workspace layout: ${observations.length} real-service geometry/reflow observations passed.`);
} finally {
  await browser?.close(); child.kill('SIGINT');
  await Promise.race([new Promise(resolve => { if (child.exitCode !== null) resolve(); else child.once('exit', resolve); }), new Promise(resolve => setTimeout(resolve, 3000))]);
  if (child.exitCode === null) { child.kill('SIGKILL'); await new Promise(resolve => child.once('exit', resolve)); }
  await rm(temporary, { recursive: true, force: true });
}
