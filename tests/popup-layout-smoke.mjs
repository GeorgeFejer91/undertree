import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';

const cacheDir = await mkdtemp(resolve(tmpdir(), 'undertree-popup-layout-'));
const markup = (await readFile('manuscript.html', 'utf8')).replace(/<script type="module" src="\/src\/manuscript.js"><\/script>/, `<script type="module">
import '/src/manuscript.css';
import '/src/dialog-layout.css';
import { setupDialogLayout } from '/modules/frontend/dialog-layout.js';
import { observeReviewText } from '/modules/frontend/review-text-layout.js';
import { setupConnectionManager } from '/src/connection-manager.js';
const shares = Array.from({length: 15}, (_, index) => ({project:'fixture', projectName:'Research project', path:'chapters/long-manuscript-section-'+index+'.typ'}));
const apps = Array.from({length: 12}, (_, index) => ({id:String(index), label:'Research application '+index, toolCount:3}));
const projects = Array.from({length:12}, (_, index) => ({project:String(index), name:'Research project '+index, root:'C:/Research/long-manuscript-project-'+index, sharedCount:3}));
const snapshot = {running:true, sharedCount:shares.length, shared:shares, protocolVersion:'2025-06-18', endpoint:'https://fixture.invalid/private-review', tools:[{name:'list_manuscripts'},{name:'read_manuscript'},{name:'suggest_text'}], config:{reservation:'fixture',publicUrl:'https://fixture.invalid'}, appControls:{enabled:true,generation:1,endpoint:'https://fixture.invalid/private-app',pdfExport:{generation:1,enabled:false,projects:[],eligibleProjects:projects}},gateway:{enabled:true,endpoint:'https://fixture.invalid/private-gateway',apps,tools:[{name:'fixture__read'}]}};
const manager=setupConnectionManager({request:async operation=>operation.action==='hub_status'?snapshot.gateway:snapshot, controlRequest:async()=>snapshot.appControls, onRevoked:()=>{},onShares:()=>{},status:()=>{}});
await manager.refresh();
document.getElementById('palette-rules').innerHTML = Array.from({length:12}, (_,index)=>'<div class="palette-row"><input type="color" aria-label="Color '+index+'"><input aria-label="Rule name" value="Color rule '+index+'"><select aria-label="Rule action"><option>Follow wording instructions</option></select><textarea rows="2" aria-label="Custom prompt">Keep the scientific meaning.</textarea><select aria-label="AI access"><option>Suggestions</option></select></div>').join('');
setupDialogLayout(document); observeReviewText(document.body);
document.body.dataset.popupReady = 'true';
</script>`);
const server = await createServer({ configFile: false, root: resolve('.'), cacheDir,
  optimizeDeps: { noDiscovery: true, include: ['@chenglou/pretext'] }, logLevel: 'error',
  server: { host: '127.0.0.1', port: 0, watch: null },
  plugins: [{ name: 'popup-layout-fixture', configureServer(vite) {
    vite.middlewares.use((request, response, next) => {
      if (request.url === '/__popup_layout_fixture.html') { response.setHeader('Content-Type', 'text/html'); response.end(markup); }
      else next();
    });
  } }],
});
let browser;
const observations = [];
async function settle(page, id) {
  await page.locator(`#${id}`).evaluate(async dialog => {
    let last = '', stable = 0;
    for (let frame = 0; frame < 60; frame++) {
      await new Promise(resolve => requestAnimationFrame(resolve));
      const body = dialog.querySelector('.popup-body');
      const state = JSON.stringify([dialog.dataset.popupPage, dialog.dataset.popupPages, dialog.dataset.popupFit, body.clientHeight, body.scrollHeight, body.querySelectorAll('.text-details-active').length]);
      stable = state === last ? stable + 1 : 0; last = state;
      if (stable >= 3) return;
    }
    throw new Error('Popup layout did not settle');
  });
}
async function inspectPages(page, id, label) {
  console.log(label);
  await page.evaluate(() => document.fonts.ready);
  await settle(page, id);
  const expected = await page.locator(`#${id} .popup-body`).evaluate((body, id) => {
    return [...body.querySelectorAll('input, select, textarea, button, summary')].filter(element => {
      if (element.matches('.text-details-button')) return false;
      if (element.closest('[hidden]')) return false;
      for (let parent = element.parentElement; parent && parent !== body; parent = parent.parentElement) if (parent.matches('details:not([open])') && element !== parent.querySelector('summary')) return false;
      return true;
    }).map(element => element.dataset.popupFixtureControl ||= `${id}-${window.popupFixtureSequence = (window.popupFixtureSequence || 0) + 1}`);
  }, id);
  const previous = page.locator(`#${id} .popup-pager button`).first();
  for (let index = 0; await previous.isVisible() && !await previous.isDisabled(); index++) {
    assert.ok(index < 100, `${label}: Previous reaches the first page`);
    await previous.click();
    await settle(page, id);
  }
  const seen = new Set();
  for (let index = 0; index < 100; index++) {
    const bounds = await page.locator(`#${id}`).evaluate(dialog => {
      const box = dialog.getBoundingClientRect(), body = dialog.querySelector('.popup-body');
      return { fit: dialog.dataset.popupFit, pages: dialog.dataset.popupPages,
        width: dialog.scrollWidth - dialog.clientWidth, height: dialog.scrollHeight - dialog.clientHeight,
        bodyWidth: body.scrollWidth - body.clientWidth, bodyHeight: body.scrollHeight - body.clientHeight,
        availableHeight: body.clientHeight, headerHeight:dialog.querySelector('.popup-heading').getBoundingClientRect().height, footerHeight:dialog.querySelector(':scope > .dialog-actions')?.getBoundingClientRect().height, pagerHeight:dialog.querySelector('.popup-pager').getBoundingClientRect().height,
        outside: box.left < 0 || box.right > innerWidth + 1 || box.top < 0 || box.bottom > innerHeight + 1,
        groups: body.scrollHeight > body.clientHeight + 2 ? [...body.querySelectorAll('*')].filter(element => element.getClientRects().length && getComputedStyle(element).display !== 'contents').map(element => ({tag:element.tagName,id:element.id,cls:element.className,height:element.getBoundingClientRect().height})).slice(0,15) : [],
        controls: [...dialog.querySelectorAll('[data-popup-fixture-control]')].filter(element => element.getClientRects().length).map(element => element.dataset.popupFixtureControl) };
    });
    assert.equal(bounds.outside, false, `${label}: dialog stays within viewport`);
    assert.ok(bounds.width <= 2 && bounds.height <= 2 && bounds.bodyWidth <= 2 && bounds.bodyHeight <= 2,
      `${label}: no overflow: ${JSON.stringify(bounds)}`);
    assert.equal(await page.locator(`#${id} .text-details-slot .text-details-slot`).count(), 0, `${label}: full-value routes never wrap their own generated slots`);
    if (id === 'palette-dialog') assert.equal(await page.locator('#palette-rules .palette-row:not(.popup-flow)').evaluateAll(rows => rows.some(row => {
      const controls = [...row.querySelectorAll('input, select, textarea')];
      const visible = controls.filter(control => control.getClientRects().length).length;
      return visible && visible !== controls.length;
    })), false, `${label}: fitting color rule rows remain together`);
    bounds.controls.forEach(value => seen.add(value));
    const next = page.locator(`#${id} .popup-pager button`).last();
    if (!(await next.isVisible()) || await next.isDisabled()) break;
    await next.click();
    await settle(page, id);
  }
  for (const control of expected) assert.ok(seen.has(control), `${label}: control ${control} remains reachable`);
  observations.push({ label, reachableControls: seen.size });
}
try {
  await server.listen();
  browser = await chromium.launch({ ...(process.env.UNDERTREE_CHROME ? { executablePath: process.env.UNDERTREE_CHROME } : { channel: 'chrome' }), headless: true });
  const page = await browser.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__popup_layout_fixture.html`);
  await page.waitForFunction(() => document.body.dataset.popupReady === 'true');
  const ids = await page.locator('dialog.stretch-popup').evaluateAll(dialogs => dialogs.map(dialog => dialog.id));
  assert.ok(ids.includes('color-rule-dialog') && ids.includes('connection-dialog') && ids.includes('new-dialog'));
  for (const viewport of process.env.UNDERTREE_POPUP_CONNECTIONS_ONLY ? [] : [{ width: 1280, height: 900 }, { width: 1280, height: 480 }, { width: 320, height: 720 }, { width: 600, height: 900 }]) {
    await page.setViewportSize(viewport);
    for (const id of ids) {
      await page.evaluate(id => document.getElementById(id).showModal(), id);
      await page.waitForFunction(id => document.getElementById(id).dataset.popupPage, id);
      await inspectPages(page, id, `${id} ${viewport.width}×${viewport.height}`);
      await page.evaluate(id => document.getElementById(id).close(), id);
    }
  }
  for (const [width, height, fontSize] of process.env.UNDERTREE_POPUP_APP_ONLY ? [[320,900,28]] : [[1280,900,14], [1280,480,14], [320,900,14], [901,480,28], [320,900,28]]) {
    await page.setViewportSize({width,height});
    await page.evaluate(fontSize => document.documentElement.style.fontSize = `${fontSize}px`, fontSize);
    await page.evaluate(() => document.getElementById('connection-dialog').showModal());
    for (const tab of process.env.UNDERTREE_POPUP_APP_ONLY ? ['app'] : ['mcp','zrok','shared','apps','app']) {
      await page.locator(`#connection-tab-${tab}`).click();
      await inspectPages(page, 'connection-dialog', `Connections ${tab} ${width}×${height}/${fontSize}px`);
      await page.locator(`#connection-panel-${tab} details`).evaluateAll(details => details.forEach(detail => detail.open = true));
      await inspectPages(page, 'connection-dialog', `Connections ${tab} expanded ${width}×${height}/${fontSize}px`);
    }
    await page.evaluate(() => document.getElementById('connection-dialog').close());
  }
  await page.evaluate(() => document.documentElement.style.fontSize = '14px');
  await page.setViewportSize({ width: 320, height: 720 });
  await page.evaluate(() => {
    const dialog = document.getElementById('color-rule-dialog');
    document.getElementById('color-rule-label').value = 'A preserved color name';
    document.getElementById('color-rule-prompt').value = 'Preserve this exact prompt.';
    dialog.showModal();
  });
  await page.waitForFunction(() => Number(document.getElementById('color-rule-dialog').dataset.popupPages) > 1);
  await page.locator('#color-rule-dialog .popup-pager button').last().click();
  assert.equal(await page.locator('#color-rule-prompt').inputValue(), 'Preserve this exact prompt.');
  assert.equal(await page.locator('#color-rule-label').inputValue(), 'A preserved color name');
  assert.equal(await page.locator('#color-rule-prompt').evaluate(input => input.form.id), 'color-rule-form');
  await page.evaluate(() => { document.getElementById('color-rule-label').value = ''; document.getElementById('color-rule-form').reportValidity(); });
  assert.equal(await page.locator('#color-rule-label').isVisible(), true, 'native invalid field returns to its page');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#color-rule-dialog').evaluate(dialog => dialog.open), false);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: 'PASS', observations }, null, 2));
} finally { await browser?.close(); await server.close(); await rm(cacheDir, { recursive: true, force: true }); }
