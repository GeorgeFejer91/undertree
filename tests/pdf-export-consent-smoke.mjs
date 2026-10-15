// Real native local consent; simulated zrok process, no public-route or OS-window claim.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmod, cp, mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const temporary = await mkdtemp(join(tmpdir(), 'undertree-pdf-consent-'));
const binary = resolve(process.env.UNDERTREE_REVIEW_BINARY || 'target/debug/undertree-review');
const assets = join(temporary, 'assets'), firstRoot = join(temporary, 'Project with saved inputs'), secondRoot = join(temporary, 'Another project with a long full path — bibliography and illustrations');
const token = randomBytes(32).toString('hex'), checks = [], geometry = [], errors = [], requests = [];
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
let service, browser, port, log = '', local, control, owner;
async function until(check, message) {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) { if (await check()) return; if (service?.exitCode !== null) throw new Error(log); await new Promise(resolve => setTimeout(resolve, 25)); }
  throw new Error(message);
}
try {
  await mkdir(firstRoot); await mkdir(secondRoot);
  const content = '<p>Saved shared manuscript.</p>\n';
  for (const root of [firstRoot, secondRoot]) await writeFile(join(root, 'main.html'), content);
  await cp(resolve(process.env.UNDERTREE_REVIEW_ASSETS || 'dist'), assets, { recursive: true });
  const zrok = join(temporary, 'zrok'); await writeFile(zrok, '#!/bin/sh\nexec sleep 180\n'); await chmod(zrok, 0o700);
  service = spawn(binary, [], { env: { ...process.env, UNDERTREE_REVIEW_PORT: '0', UNDERTREE_REVIEW_STATE: join(temporary, 'state'), UNDERTREE_REVIEW_TOKEN: token, UNDERTREE_REVIEW_ASSETS: assets, UNDERTREE_ZROK: zrok }, stdio: ['ignore', 'pipe', 'pipe'] });
  service.stdout.on('data', bytes => { log = (log + bytes).slice(-16_000); port = Number(log.match(/127\.0\.0\.1:(\d+)/)?.[1]); }); service.stderr.on('data', bytes => { log = (log + bytes).slice(-16_000); });
  await until(() => port, 'The isolated Rust service did not start.'); const base = `http://127.0.0.1:${port}`;
  async function post(path, operation, extra = {}) {
    const envelope = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...extra }, body: JSON.stringify(operation) }).then(response => response.json());
    assert.equal(envelope.ok, true, envelope.error?.message); return envelope.result;
  }
  local = operation => post('/api/review', operation); control = operation => post('/api/control', operation, { 'X-UnderTree-Editor': owner });
  const first = await local({ action: 'add_project', root: firstRoot }), second = await local({ action: 'add_project', root: secondRoot });
  async function share(project) {
    const snapshot = await local({ action: 'open', project: project.id, path: 'main.html' });
    await local({ action: 'palette', project: project.id, path: 'main.html', revision: snapshot.review.revision, rules: snapshot.review.rules });
    await local({ action: 'share', project: project.id, path: 'main.html', enabled: true });
  }
  await share(first); await local({ action: 'tunnel', enabled: true, reservation: 'consent-fixture', public_url: 'https://consent.example.org' });
  const policyBefore = await readFile(join(firstRoot, 'main.html.undertree-review.json'));
  browser = await chromium.launch({ executablePath: process.env.UNDERTREE_CHROME || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } }); page.on('pageerror', error => errors.push(error.message));
  const heartbeats = new Set();
  page.on('request', request => {
    if (!/\/api\/(control|editor|review)$/.test(request.url())) return;
    const operation = request.postDataJSON(); requests.push(operation);
    if (request.url().endsWith('/api/control')) owner = request.headers()['x-undertree-editor'];
  });
  page.on('response', async response => {
    if (!response.url().endsWith('/api/control') || response.request().postDataJSON()?.action !== 'control_poll') return;
    const envelope = await response.json().catch(() => null); if (envelope?.ok && envelope.result.enabled) heartbeats.add(envelope.result.generation);
  });
  await page.goto(base + `/manuscript.html#session=${token}`); await page.locator('#project-select').selectOption(first.id);
  await page.locator('.file-button[data-path="main.html"]').click(); await page.locator('.cm-content').waitFor();
  await page.locator('#connection-open').click(); await page.locator('#connection-tab-app').click();
  const disclosure = page.locator('#connection-pdf-export'), apply = page.locator('#connection-pdf-export-apply'), disable = page.locator('#connection-pdf-export-disable');
  assert.equal(await disclosure.evaluate(node => node.open), false);
  assert.equal(await apply.isEnabled(), false);
  await page.locator('#connection-app-enabled').check();
  let status; await until(async () => { status = (await local({ action: 'connection' })).appControls; return status.enabled && heartbeats.has(status.generation); }, 'The native App grant did not attach to its renderer.');
  assert.equal(status.pdfExport.enabled, false); assert.deepEqual(status.pdfExport.projects, []);
  await disclosure.locator(':scope > summary').click();
  const input = project => page.locator(`#connection-pdf-export-projects input[value=${JSON.stringify(project.id)}]`);
  await input(first).waitFor(); assert.equal(await input(first).isChecked(), false); assert.equal(await apply.isEnabled(), false);
  assert.match(await page.locator('#connection-pdf-export-scope').innerText(), /current or future saved.*even from unshared files/);
  assert.match(await page.locator('#connection-pdf-export-scope').innerText(), /Unsaved editor changes are excluded/);
  assert.equal(await page.locator('.pdf-export-root').first().innerText(), firstRoot);
  await input(first).check(); await apply.click();
  await until(async () => { status = (await local({ action: 'connection' })).appControls; return status.pdfExport.enabled; }, 'The selected native root permission did not apply.');
  assert.deepEqual(status.pdfExport.projects, [first.id]);
  assert.ok(requests.some(operation => operation.action === 'control_pdf_export' && operation.generation === status.generation && operation.exportGeneration && operation.enabled && operation.projects.length === 1));
  checks.push('App controls do not imply PDF permission; explicit local consent sends only a selected approved project and rendered grant generation');

  await share(second); await page.locator('#connection-refresh').click(); await input(second).waitFor();
  assert.equal(await input(first).isChecked(), true); assert.equal(await input(second).isChecked(), false);
  assert.deepEqual((await local({ action: 'connection' })).appControls.pdfExport.projects, [first.id]);
  await disable.click(); await until(async () => !(await local({ action: 'connection' })).appControls.pdfExport.enabled, 'Native export revocation did not apply.');
  checks.push('a newly shared eligible project stays unchecked and explicit revocation clears native export permission');

  // Commit succeeds but its HTTP response is lost: UI must show uncertainty until Refresh.
  await input(first).check(); let loseOnce = true;
  await page.route('**/api/control', async route => {
    if (!loseOnce || route.request().postDataJSON()?.action !== 'control_pdf_export') return route.fallback();
    loseOnce = false; const response = await route.fetch(); assert.equal((await response.json()).ok, true); await route.abort('failed');
  });
  await apply.click(); await until(() => page.locator('#connection-pdf-export-summary').innerText().then(text => /Check status/.test(text)), 'Lost acknowledgement did not display unconfirmed permission.');
  assert.equal(await apply.isEnabled(), false); assert.equal((await local({ action: 'connection' })).appControls.pdfExport.enabled, true);
  await page.locator('#connection-refresh').click(); await until(() => disable.isEnabled(), 'Refresh did not restore authoritative native permission status.');
  checks.push('lost permission acknowledgement does not fabricate success and Refresh recovers the committed native state');

  const held = deferred(), release = deferred(); let holdOnce = true;
  await page.route('**/api/control', async route => {
    if (!holdOnce || route.request().postDataJSON()?.action !== 'control_pdf_export') return route.fallback();
    holdOnce = false; const response = await route.fetch(); assert.equal((await response.json()).ok, true); held.resolve(); await release.promise; await route.fulfill({ response });
  });
  await input(second).check(); await apply.click();
  await Promise.race([held.promise, new Promise((_, reject) => setTimeout(() => reject(new Error('Permission response was not held.')), 12_000))]);
  const oldGeneration = (await local({ action: 'connection' })).appControls.generation;
  await control({ action: 'control_enable', enabled: false }); await control({ action: 'control_enable', enabled: true });
  release.resolve();
  await until(async () => { const current = (await local({ action: 'connection' })).appControls; return current.generation !== oldGeneration && !current.pdfExport.enabled && !(await page.locator('#connection-pdf-export-summary').innerText()).includes('2 projects') && !(await input(second).isChecked()) && await apply.isDisabled(); }, 'A late response restored permission or selections from the replaced grant.');
  checks.push('a delayed permission acknowledgement cannot carry selected roots into a replacement App grant');

  for (const [width, height, text] of [[1100, 480, 28], [320, 900, 28]]) {
    await page.setViewportSize({ width, height }); await page.evaluate(size => { document.documentElement.style.fontSize = `${size}px`; }, text);
    if (await disclosure.evaluate(node => node.open)) await disclosure.locator(':scope > summary').click();
    await until(() => disclosure.locator(':scope > summary').getAttribute('data-text-fit').then(value => ['fit', 'reflow'].includes(value)), 'Pretext did not measure the collapsed PDF control.');
    await disclosure.locator(':scope > summary').click(); await input(second).scrollIntoViewIfNeeded();
    const rootBox = await input(second).locator('..').locator('.pdf-export-root').evaluate(node => ({ width: node.clientWidth, scroll: node.scrollWidth, value: node.textContent, fit: node.dataset.textFit }));
    assert.equal(rootBox.value, secondRoot); assert.ok(rootBox.scroll <= rootBox.width + 1, 'approved local root remains fully wrapped');
    await apply.scrollIntoViewIfNeeded();
    const measured = await page.evaluate(() => ({ viewport: [innerWidth, innerHeight], text: getComputedStyle(document.documentElement).fontSize, pageOverflow: document.documentElement.scrollWidth > innerWidth + 1 || document.documentElement.scrollHeight > innerHeight + 1, summaryFit: document.getElementById('connection-pdf-export-summary').dataset.textFit, applyFit: document.getElementById('connection-pdf-export-apply').dataset.textFit, dialog: document.getElementById('connection-dialog').getBoundingClientRect().toJSON() }));
    geometry.push(measured); assert.equal(measured.pageOverflow, false); assert.ok(measured.dialog.width <= width); assert.ok(['fit', 'reflow'].includes(measured.applyFit));
  }
  checks.push('collapsed controls and expanded consent/root inventory retain full values and reachable actions at short height, 320px and 200% text');
  assert.equal(requests.filter(operation => ['save', 'editor_commit'].includes(operation.action)).length, 0);
  assert.equal(await readFile(join(firstRoot, 'main.html'), 'utf8'), content); assert.deepEqual(await readFile(join(firstRoot, 'main.html.undertree-review.json')), policyBefore);
  assert.deepEqual(errors, []); await mkdir(resolve('artifacts'), { recursive: true }); await writeFile(resolve('artifacts/pdf-export-consent-smoke.json'), JSON.stringify({ browser: browser.version(), checks, geometry, errors, scope: 'real local native consent; HTML fixtures, no compiler/public route or OS-window qualification' }, null, 2) + '\n');
  console.log(`PDF export consent: ${checks.length} real native/rendered checks passed.`);
} finally {
  await browser?.close();
  if (service?.exitCode === null) { await local?.({ action: 'tunnel', enabled: false, reservation: '', public_url: '' }).catch(() => {}); service.kill('SIGINT'); await Promise.race([new Promise(resolve => service.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 2000))]); if (service.exitCode === null) service.kill('SIGKILL'); }
  await rm(temporary, { recursive: true, force: true });
}
