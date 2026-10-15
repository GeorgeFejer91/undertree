// Actual HTML worker/CodeMirror/Pretext. Typst native analysis needs its separate desktop gate.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { cp, mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const binary = resolve(process.env.UNDERTREE_REVIEW_BINARY || 'target/debug/undertree-review');
const inputAssets = resolve(process.env.UNDERTREE_REVIEW_ASSETS || 'dist');
const evidence = resolve(process.env.UNDERTREE_WORD_COUNT_RECEIPT || 'artifacts/word-count-smoke.json');
const root = await mkdtemp(join(tmpdir(), 'undertree-word-count-'));
const projectRoot = join(root, 'project'), assets = join(root, 'assets'), token = randomBytes(32).toString('hex');
const original = 'Alpha beta gamma', dirty = original + ' delta';
const longPath = 'long-file-'.repeat(18) + '.html';
const checks = [], observations = [], errors = [], operations = [], external = [];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
let service, browser, page, port, log = '', base, failure, releaseSave;
async function until(check, message) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) { if (await check()) return; if (service && service.exitCode !== null) throw Error(log); await new Promise(resolve => setTimeout(resolve, 20)); }
  throw Error(message);
}
async function native(operation) {
  const value = await fetch(base + '/api/review', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(operation) }).then(response => response.json());
  assert.equal(value.ok, true, value.error?.message); return value.result;
}
async function menu(command) {
  const desktop = await page.locator('#menu-file-toggle').isVisible(), target = page.locator(desktop ? '#menu-file' : '#workspace-menu');
  if ((await target.getAttribute('open')) === null) await target.locator('summary').click();
  await target.locator(`[data-command="${command}"]`).click();
}
async function count() { await menu('word-count'); await page.locator('#word-count-dialog').waitFor(); await page.locator('#word-count-results').waitFor(); }
async function close() { await page.locator('#word-count-dialog').getByRole('button', { name: 'Close', exact: true }).click(); }
async function open(path) {
  await page.locator(`.file-button[data-path="${path}"]`).click();
  await page.waitForFunction(path => document.querySelector('#manuscript-tabs [aria-selected="true"]')?.textContent === path, path);
}
const saves = () => operations.filter(operation => ['save', 'editor_commit', 'mark', 'decide', 'compile', 'sync'].includes(operation?.action));
try {
  await mkdir(projectRoot); await cp(inputAssets, assets, { recursive: true });
  await writeFile(join(projectRoot, 'current.html'), original);
  await writeFile(join(projectRoot, 'sample.typ'), '= Heading\nLocal words');
  await writeFile(join(projectRoot, longPath), '<head><title>ignore metadata</title><script>globalThis.wordCountExecuted=true</script></head><body><p><em>under</em>tree</p><script/src="https://invalid.test/">ignore script words</script><pre>ignore code</pre><p hidden>Visible structural words</p><img src="https://invalid.test/image" alt="ignore alternate text"></body>');
  await writeFile(join(projectRoot, 'large.html'), 'a '.repeat(1024 * 1024));
  service = spawn(binary, [], { env: { ...process.env, UNDERTREE_REVIEW_PORT: '0', UNDERTREE_REVIEW_TOKEN: token, UNDERTREE_REVIEW_STATE: join(root, 'state'), UNDERTREE_REVIEW_ASSETS: assets }, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [service.stdout, service.stderr]) stream.on('data', bytes => { log = (log + bytes).slice(-16000); port = Number(log.match(/127\.0\.0\.1:(\d+)/)?.[1]); });
  await until(() => !!port, 'Isolated Word count service did not start.'); base = `http://127.0.0.1:${port}`;
  const project = await native({ action: 'add_project', root: projectRoot });
  browser = await chromium.launch({ executablePath: process.env.UNDERTREE_CHROME || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (/\/api\/(review|editor)$/.test(request.url())) operations.push(request.postDataJSON()); if (request.url().startsWith('http') && !request.url().startsWith(base)) external.push(request.url()); });
  await page.route('https://invalid.test/**', route => route.abort());
  let saveHeld = false;
  const saveGate = new Promise(resolve => { releaseSave = resolve; });
  await page.route('**/api/review', async route => {
    if (route.request().postDataJSON()?.action === 'save') { saveHeld = true; await saveGate; }
    await route.continue();
  });
  await page.goto(base + `/manuscript.html#session=${token}`); await page.locator('#project-select').selectOption(project.id); await open('current.html');
  const policyPath = join(projectRoot, 'current.html.undertree-review.json');
  const readPolicy = () => readFile(policyPath).catch(error => { if(error.code==='ENOENT')return null;throw error; });
  const policy = await readPolicy();
  await page.locator('.cm-content').focus(); await page.keyboard.press('Control+End'); await page.keyboard.insertText(' delta');
  await until(() => saveHeld, 'The existing autosave was not held before Word count.');
  await page.keyboard.press('Control+Home'); await page.keyboard.press('ArrowRight', { delay: 1 });
  await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight');
  await page.keyboard.down('Shift'); for (let i=0;i<4;i++) await page.keyboard.press('ArrowRight'); await page.keyboard.up('Shift');
  const before = saves().length; await count();
  assert.equal(await page.locator('#word-count-prose').textContent(), '4 words'); assert.equal(await page.locator('#word-count-source').textContent(), '4 words'); assert.equal(await page.locator('#word-count-selection').textContent(), '1 word');
  assert.match(await page.locator('#word-count-state').textContent(), /Unsaved at capture/); assert.equal(saves().length,before);
  assert.equal(await readFile(join(projectRoot,'current.html'),'utf8'),original); assert.deepEqual(await readPolicy(),policy);
  await page.keyboard.press('Escape'); await page.locator('#word-count-dialog').waitFor({state:'hidden'});
  await page.locator('.cm-content').focus(); await page.keyboard.insertText('chosen');
  assert.equal(await page.locator('.cm-content').textContent(),'Alpha chosen gamma delta');
  await page.locator('#source-undo').click(); assert.equal(await page.locator('.cm-content').textContent(),dirty);
  await page.locator('#source-redo').click(); assert.equal(await page.locator('.cm-content').textContent(),'Alpha chosen gamma delta');
  checks.push('The actual worker counts dirty current source and the exact selected fragment without starting Save; Escape preserves selection and Undo/Redo history.');
  releaseSave(); await page.unrouteAll({behavior:'wait'}); await until(async()=>/Saved locally/.test(await page.locator('#save-label').textContent()),'The preexisting save did not quiesce.');
  await open('sample.typ'); const beforeTypst=saves().length; await count();
  assert.equal(await page.locator('#word-count-prose').textContent(),'Unavailable'); assert.match(await page.locator('#word-count-prose-reason').textContent(),/desktop/);
  assert.equal(await page.locator('#word-count-source').textContent(),'3 words'); assert.equal(saves().length,beforeTypst); await close();
  checks.push('Standalone Typst shows honest native-required prose while source counts work without an HTTP analysis fallback or compiler.');
  await open(longPath);
  await page.waitForFunction(()=>document.getElementById('manuscript-preview').srcdoc.includes('Visible structural words'));
  for(const frame of page.frames())if(frame.parentFrame())await frame.waitForLoadState('load');
  const beforeHtml=saves().length, beforeExternal=external.length; await count();
  assert.equal(await page.locator('#word-count-prose').textContent(),'4 words'); assert.equal(saves().length,beforeHtml);
  assert.equal(await page.locator('#word-count-path').textContent(),longPath);
  assert.equal(await page.evaluate(()=>globalThis.wordCountExecuted),undefined); assert.equal(external.length,beforeExternal);
  checks.push('HTML counting decodes full-body text, preserves inline words and excludes metadata/raw code without script execution or additional external requests beyond the existing preview.');
  for(const [width,height,text] of [[1100,480,28],[320,900,28],[1440,900,14]]) {
    await page.setViewportSize({width,height}); await page.evaluate(text=>{document.documentElement.style.fontSize=`${text}px`;},text);
    await page.locator('#word-count-dialog details summary').click();
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    const bounds=await page.evaluate(()=>{const dialog=document.getElementById('word-count-dialog'),body=dialog.querySelector('.word-count-body'),footer=dialog.querySelector('.dialog-actions');return{viewport:[innerWidth,innerHeight],page:[document.documentElement.scrollWidth,document.documentElement.scrollHeight],dialog:dialog.getBoundingClientRect().toJSON(),body:body.getBoundingClientRect().toJSON(),footer:footer.getBoundingClientRect().toJSON(),horizontal:body.scrollWidth>body.clientWidth+1,measurements:[...dialog.querySelectorAll('[data-measure]')].filter(node=>node.getClientRects().length).map(node=>({text:node.textContent.slice(0,60),fit:node.dataset.textFit}))};});
    observations.push(bounds); assert.ok(bounds.page[0]<=width+1&&bounds.page[1]<=height+1); assert.ok(bounds.dialog.top>=0&&bounds.dialog.bottom<=height+1);assert.ok(bounds.footer.bottom<=bounds.dialog.bottom&&bounds.body.bottom<=bounds.footer.top+1);assert.equal(bounds.horizontal,false);
    assert.ok(bounds.measurements.every(value=>['fit','reflow','unavailable'].includes(value.fit)));
  }
  await close(); checks.push('Actual Pretext/dialog bounds keep full scope, count labels, expanded method and Close accessible at320px/200percent,wide-short and regrowth.');
  await open('large.html'); await page.locator('.cm-content').waitFor(); await menu('word-count');
  const started=Date.now(); await page.keyboard.press('Escape'); await page.locator('#word-count-dialog').waitFor({state:'hidden'}); assert.ok(Date.now()-started<1500);
  assert.deepEqual(errors,[]);checks.push('Closing a count of the maximum2MiB source remains responsive and retires the worker without a source edit.');
  console.log(`Word count: ${checks.length} actual HTML-worker/CodeMirror checks passed.`);
} catch(error) {failure=error;await page?.screenshot({path:resolve('artifacts/word-count-failure.png')}).catch(()=>{});throw error;}
finally {
  releaseSave?.();await page?.unrouteAll({behavior:'wait'}).catch(()=>{});await browser?.close();service?.kill('SIGINT');
  if(service){await Promise.race([new Promise(resolve=>{if(service.exitCode!==null)resolve();else service.once('exit',resolve);}),new Promise(resolve=>setTimeout(resolve,3000))]);if(service.exitCode===null)service.kill('SIGKILL');}
  await mkdir(resolve('artifacts'),{recursive:true});await writeFile(evidence,JSON.stringify({result:failure?'failed':'passed',error:failure?.message,binary,binarySha256:hash(await readFile(binary)),assets:inputAssets,runnerSha256:hash(await readFile(new URL(import.meta.url))),checks,observations,errors},null,2)+'\n');await rm(root,{recursive:true,force:true});
}
