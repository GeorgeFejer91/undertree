// Real Rust policy witness + CodeMirror. File changes below affect only a disposable project.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { cp, mkdtemp, mkdir, readFile, writeFile, unlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const binary = resolve(process.env.UNDERTREE_REVIEW_BINARY || 'target/debug/undertree-review');
const inputAssets = resolve(process.env.UNDERTREE_REVIEW_ASSETS || 'dist');
const receiptPath = resolve(process.env.UNDERTREE_POLICY_RECEIPT || 'artifacts/review-policy-smoke.json');
const root = await mkdtemp(join(tmpdir(), 'undertree-policy-continuity-'));
const projectRoot = join(root, 'project'), assets = join(root, 'assets'), token = randomBytes(32).toString('hex');
const source = '<p>Alpha target.</p>\n', otherSource = '<p>Another local manuscript.</p>\n';
const sidecar = join(projectRoot, 'main.html.undertree-review.json');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const operations = [], checks = [], observations = [], errors = [];
let service, browser, page, port, base, log = '', failure, activeGate;
async function until(check, message) {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) { if (await check()) return; if (service?.exitCode !== null && service?.exitCode !== undefined) throw Error(log); await new Promise(resolve => setTimeout(resolve, 20)); }
  throw Error(message);
}
async function call(operation) {
  const value = await fetch(base + '/api/review', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(operation), signal: AbortSignal.timeout(10_000) }).then(response => response.json());
  assert.equal(value.ok, true, value.error?.message); return value.result;
}
const writes = () => operations.filter(operation => ['save','mark','unmark','reanchor','palette','decide','editor_commit','compile','import_tex'].includes(operation?.action));
async function open(path) {
  await page.locator(`.file-button[data-path="${path}"]`).click();
  await page.waitForFunction(path => document.querySelector('#manuscript-tabs [aria-selected="true"]')?.textContent === path, path);
}
async function buffer() {
  const downloading = page.waitForEvent('download');
  await page.locator('#review-policy-problem').getByRole('button', { name: 'Export my buffer', exact: true }).click();
  return readFile(await (await downloading).path(), 'utf8');
}
async function checkProblem() {
  await page.locator('#review-policy-problem').getByRole('button', { name: 'Check review data', exact: true }).click();
}
async function holdReview(expected) {
  const gate = deferred(); let ready = false, observed;
  activeGate = gate;
  const handler = async route => {
    const operation = route.request().postDataJSON();
    if (operation.action !== 'review' || operation.path !== 'main.html' || ready) return route.continue();
    const response = await route.fetch({ timeout: 10_000 }); observed = await response.json(); ready = true;
    await gate.promise; await route.fulfill({ response });
  };
  await page.route('**/api/review', handler);
  return { wait: async () => { await until(() => ready, 'The actual native Review response was not held.'); assert.equal(observed.ok, expected === 'success'); if (expected !== 'success') assert.equal(observed.error?.code, expected); }, release: async () => { gate.resolve(); await page.unrouteAll({ behavior: 'wait' }); activeGate = null; } };
}
try {
  await mkdir(projectRoot); await cp(inputAssets, assets, { recursive: true });
  await writeFile(join(projectRoot, 'main.html'), source); await writeFile(join(projectRoot, 'other.html'), otherSource);
  service = spawn(binary, [], { env: { ...process.env, UNDERTREE_REVIEW_PORT: '0', UNDERTREE_REVIEW_STATE: join(root, 'state'), UNDERTREE_REVIEW_ASSETS: assets, UNDERTREE_REVIEW_TOKEN: token }, stdio: ['ignore','pipe','pipe'] });
  for (const stream of [service.stdout, service.stderr]) stream.on('data', bytes => { log = (log + bytes).slice(-16_000); port = Number(log.match(/127\.0\.0\.1:(\d+)/)?.[1]); });
  await until(() => !!port, 'The isolated policy service did not start.'); base = `http://127.0.0.1:${port}`;
  const project = await call({ action: 'add_project', root: projectRoot });
  const observed = await call({ action: 'open', project: project.id, path: 'main.html' });
  const binding = Object.freeze({ sourceEpoch: observed.sourceEpoch, expectedRoot: Object.freeze({ ...observed.expectedRoot }) });
  const initial = await call({ action: 'open', project: project.id, path: 'main.html', ...binding });
  assert.deepEqual(initial.expectedRoot, binding.expectedRoot); assert.equal(initial.sourceEpoch, binding.sourceEpoch);
  await call({ action: 'mark', project: project.id, path: 'main.html', ...binding, revision: initial.review.revision, from: source.indexOf('target'), to: source.indexOf('target') + 6, rule: 'protect', prompt: 'Keep the approved target.' });
  const policy = await readFile(sidecar);
  browser = await chromium.launch({ executablePath: process.env.UNDERTREE_CHROME || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } }); page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (/\/api\/(review|editor)$/.test(request.url())) operations.push(request.postDataJSON()); });
  await page.goto(base + `/manuscript.html#session=${token}`); await page.locator('#project-select').selectOption(project.id); await open('main.html');
  await page.locator('#review-toggle').click(); await page.locator('#manuscript-share').check();
  await until(async () => (await call({ action: 'connection' })).shared.some(share => share.documentId === initial.documentId), 'The real local UI did not share the protected source.');
  const nativeWritesBefore = writes().length;

  await unlink(sidecar);
  const lateError = await holdReview('policy_missing'); await page.locator('#review-refresh').click(); await lateError.wait();
  await open('other.html'); const otherStatus = await page.locator('#review-status').textContent();
  await lateError.release(); await page.waitForTimeout(100);
  assert.equal(await page.locator('#review-policy-problem').count(), 0); assert.equal(await page.locator('#review-status').textContent(), otherStatus);
  assert.equal(await page.locator('.review-card').count(), 0); assert.match(await page.locator('.cm-content').textContent(), /Another local manuscript/);
  await open('main.html'); await page.locator('#review-policy-problem[data-problem="policy_missing"]').waitFor();
  assert.match(await page.locator('#review-passages').textContent(), /target/); assert.match(await page.locator('#review-passages').textContent(), /Last known protection/);
  assert.equal(await page.getByRole('button', { name: 'Remove highlight', exact: true }).isDisabled(), true);
  assert.equal(writes().length, nativeWritesBefore);
  checks.push('A held actual policy_missing response stays bound to its old tab; last-known protection is retained without source or metadata writes.');

  await page.locator('.cm-content').focus(); await page.keyboard.press('Control+Home'); await page.keyboard.insertText('X');
  await page.locator('#source-undo').click(); assert.doesNotMatch(await page.locator('.cm-content').textContent(), /^X/);
  await page.locator('#source-redo').click(); assert.match(await page.locator('.cm-content').textContent(), /^X<p>/);
  assert.equal(await buffer(), 'X' + source);
  if (await page.locator('#manuscript-share').isChecked()) await page.locator('#manuscript-share').uncheck();
  await until(async () => !(await call({ action: 'connection' })).shared.some(share => share.documentId === initial.documentId), 'Native sharing did not revoke.');
  await page.waitForTimeout(600); assert.equal(writes().length, nativeWritesBefore);
  await assert.rejects(readFile(sidecar), error => error.code === 'ENOENT'); assert.equal(await readFile(join(projectRoot, 'main.html'), 'utf8'), source);
  assert.equal(await page.locator('#review-policy-problem').count(), 1);
  checks.push('Blocked typing, Undo/Redo, exact buffer export and restrictive native-confirmed revoke preserve source bytes and never autosave or recreate policy.');

  for (const [width,height,text] of [[1100,480,28],[901,480,28],[320,900,28],[1440,900,14]]) {
    await page.setViewportSize({ width,height }); await page.evaluate(text => { document.documentElement.style.fontSize = `${text}px`; }, text);
    if (width <= 900) await page.locator('[data-view="review"]').click();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const bounds = await page.evaluate(() => {
      const pane=document.querySelector('.manuscript-review'), list=document.getElementById('review-list');
      const filesHeading=document.getElementById('files-heading');
      return { viewport:[innerWidth,innerHeight],page:[document.documentElement.scrollWidth,document.documentElement.scrollHeight],pane:pane.getBoundingClientRect().toJSON(),list:list.getBoundingClientRect().toJSON(),filesHeading:filesHeading.getBoundingClientRect().toJSON(),horizontal:list.scrollWidth>list.clientWidth+1,shareFit:document.querySelector('.share-toggle span').dataset.textFit,problemFit:document.querySelector('#review-policy-problem h3').dataset.textFit };
    });
    observations.push(bounds); assert.ok(bounds.page[0]<=width+1&&bounds.page[1]<=height+1); assert.equal(bounds.horizontal,false);
    assert.ok(bounds.list.bottom<=bounds.pane.bottom+1); assert.ok(bounds.list.height>0);
    assert.ok(['fit','reflow','unavailable'].includes(bounds.problemFit)); assert.ok(['fit','reflow','unavailable'].includes(bounds.shareFit));
  }
  checks.push('The full policy warning remains in the independent Review scroll region at320px,200percent,desktop edge and regrowth.');
  await page.locator('[data-view="editor"]').evaluate(button => { if(button.getClientRects().length)button.click(); });

  await writeFile(sidecar, policy); const beforeRetry = writes().length;
  await checkProblem(); await page.locator('#review-policy-problem').waitFor({ state:'detached' });
  await page.waitForTimeout(600); assert.equal(writes().length,beforeRetry); assert.match(await page.locator('.cm-content').textContent(),/^X<p>/);
  assert.equal(await readFile(join(projectRoot,'main.html'),'utf8'),source); assert.deepEqual(await readFile(sidecar),policy);
  assert.match(await page.locator('#save-label').textContent(),/Unsaved changes/);
  checks.push('Exact metadata restoration followed by explicit pure Review clears only the policy block and keeps the dirty draft without saving.');

  await unlink(sidecar); await page.locator('.cm-content').focus(); await page.keyboard.press('Control+s');
  await page.locator('#review-policy-problem[data-problem="policy_missing"]').waitFor();
  await writeFile(sidecar,policy); const retry = await holdReview('success'); await checkProblem(); await retry.wait();
  await page.locator('.cm-content').focus(); await page.keyboard.press('Control+Home'); await page.keyboard.insertText('Y');
  const beforeLate = writes().length; await retry.release(); await page.waitForTimeout(100);
  assert.equal(await page.locator('#review-policy-problem').count(),1); assert.equal(await buffer(),'YX'+source);
  await checkProblem(); await page.locator('#review-policy-problem').waitFor({state:'detached'}); await page.waitForTimeout(600);
  assert.equal(writes().length,beforeLate); assert.equal(await readFile(join(projectRoot,'main.html'),'utf8'),source); assert.deepEqual(await readFile(sidecar),policy);
  checks.push('A held successful native retry cannot clear a problem after newer typing; a fresh explicit read resolves it without a Save.');

  const corrupt = Buffer.from('{"unexpected":"review policy bytes"}\n');
  await writeFile(sidecar,corrupt); await page.locator('.cm-content').focus(); await page.keyboard.press('Control+s');
  await page.locator('#review-policy-problem[data-problem="recovery_conflict"]').waitFor();
  assert.match(await page.locator('#review-passages').textContent(),/target/);
  const beforeCorruptRetry = writes().length; await checkProblem(); await page.waitForTimeout(100);
  assert.equal(await page.locator('#review-policy-problem[data-problem="recovery_conflict"]').count(),1);
  assert.equal(writes().length,beforeCorruptRetry); assert.equal(await buffer(),'YX'+source);
  assert.equal(await readFile(join(projectRoot,'main.html'),'utf8'),source); assert.deepEqual(await readFile(sidecar),corrupt);
  await writeFile(sidecar,policy); await checkProblem(); await page.locator('#review-policy-problem').waitFor({state:'detached'});
  await page.waitForTimeout(600); assert.equal(writes().length,beforeCorruptRetry);
  assert.equal(await readFile(join(projectRoot,'main.html'),'utf8'),source); assert.deepEqual(await readFile(sidecar),policy);
  assert.deepEqual(errors,[]);
  checks.push('A real corrupt-sidecar recovery_conflict preserves the exact unexpected bytes and dirty draft; pure retry never repairs or saves them.');
  console.log(`Policy continuity: ${checks.length} real-service/CodeMirror checks passed.`);
} catch(error) { failure=error; if(page)await page.screenshot({path:resolve('artifacts/review-policy-failure.png')}).catch(()=>{}); throw error; }
finally {
  activeGate?.resolve(); if(page)await page.unrouteAll({behavior:'wait'}).catch(()=>{}); await browser?.close(); service?.kill('SIGINT');
  if(service){await Promise.race([new Promise(resolve=>{if(service.exitCode!==null)resolve();else service.once('exit',resolve);}),new Promise(resolve=>setTimeout(resolve,3000))]);if(service.exitCode===null)service.kill('SIGKILL');}
  await mkdir(resolve('artifacts'),{recursive:true}); await writeFile(receiptPath,JSON.stringify({result:failure?'failed':'passed',error:failure?.message,binary,binarySha256:hash(await readFile(binary)),assets:inputAssets,runnerSha256:hash(await readFile(new URL(import.meta.url))),checks,observations,errors},null,2)+'\n');
  await rm(root,{recursive:true,force:true});
}
