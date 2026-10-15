import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';

// This renders the production manager, CSS and Pretext observer. Request mocks qualify
// dialog behavior only; they do not establish native/MCP/zrok authorization or reachability.
const artifacts = resolve('artifacts/connection-controls-ui');
await mkdir(artifacts, { recursive: true });
const source = await readFile(resolve('manuscript.html'), 'utf8');
const dialog = source.match(/<dialog id="connection-dialog"[\s\S]*?<\/dialog>/)?.[0];
assert.ok(dialog, 'the production Connections dialog exists');
const route = '/__connection-controls-fixture.html';
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Connections control UI qualification</title></head><body>
<button id="connection-open" type="button">Connections</button><span id="tunnel-label"></span>${dialog}
<script type="module">
import '/src/manuscript.css';
import { setupConnectionManager } from '/src/connection-manager.js';
import { observeReviewText } from '/modules/frontend/review-text-layout.js';
const calls = [];
let grants = 0, failGrant = false;
const state = { running:false, endpoint:'', externallyVerified:false, mcpInitialized:false,
  lastActivityMs:0, toolCalls:0, lastError:'', sharedCount:0, shared:[],
  config:{reservation:'undertree-test',publicUrl:'https://review.example.invalid'},protocolVersion:'2025-06-18',
  tools:['list_manuscripts','read_manuscript','suggest_text'].map(name=>({name})),
  appControls:{enabled:false,endpoint:''} };
const reviewUrl = 'https://review.example.invalid/mcp/review-capability';
const request = async operation => {
  calls.push(structuredClone(operation));
  if (operation.action === 'connection') return structuredClone(state);
  if (operation.action === 'tunnel') {
    state.running = operation.enabled; state.endpoint = state.running ? reviewUrl : '';
    state.config = { reservation:operation.reservation, publicUrl:operation.public_url };
    if (!state.running) state.appControls = {enabled:false,endpoint:''};
    return structuredClone(state);
  }
  throw new Error('Unexpected local operation: ' + operation.action);
};
const controlRequest = async operation => {
  calls.push(structuredClone(operation));
  if (operation.action !== 'control_enable') throw new Error('Unexpected app control');
  if (failGrant) { failGrant=false; throw new Error('The mock grant was denied.'); }
  state.appControls = {enabled:operation.enabled, endpoint:operation.enabled
    ? 'https://review.example.invalid/mcp-control/' + (++grants) + '-private-capability-' + 'a'.repeat(64) : ''};
  return structuredClone(state.appControls);
};
const manager = setupConnectionManager({request,
  controlRequest:new URL(location.href).searchParams.has('no-control-wrapper') ? undefined : controlRequest,
  onRevoked:()=>{},onShares:()=>{},status:()=>{}});
for (const button of document.querySelectorAll('[data-close]')) button.onclick = () => button.closest('dialog').close();
observeReviewText(document.body);
window.fixture = {calls,refresh:manager.refresh,state:()=>structuredClone(state),failNextGrant:()=>{failGrant=true;},
  running:async()=>{state.running=true;state.endpoint=reviewUrl;await manager.refresh();}};
window.fixtureReady = true;
</script></body></html>`;

const server = await createServer({
  configFile: false, root: resolve('.'), cacheDir: join(artifacts, 'vite-cache'), logLevel: 'error',
  optimizeDeps: { noDiscovery: true, include: ['@chenglou/pretext'] },
  server: { host: '127.0.0.1', port: 0, strictPort: true },
  plugins: [{ name: 'connection-controls-fixture', configureServer(server) {
    server.middlewares.use(async (request, response, next) => {
      if (new URL(request.url, 'http://localhost').pathname !== route) return next();
      try {
        response.setHeader('Content-Type', 'text/html');
        response.end(await server.transformIndexHtml(route, html));
      } catch (error) { next(error); }
    });
  } }],
});
let browser;
const observations = [], errors = [];
const fullValueRoute = {};
try {
  await server.listen();
  const base = `http://127.0.0.1:${server.httpServer.address().port}${route}`;
  browser = await chromium.launch({ executablePath: process.env.UNDERTREE_CHROME || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(base).origin });
  page.on('pageerror', error => errors.push(error.message));
  async function open(query = '') {
    await page.goto(base + query);
    await page.waitForFunction(() => window.fixtureReady);
    await page.locator('#connection-open').click();
    await page.waitForFunction(() => document.getElementById('connection-refresh').disabled === false
      && document.getElementById('connection-status').textContent.includes('Tunnel stopped'));
    await page.locator('#connection-tab-app').click();
  }
  async function settled() {
    await page.waitForFunction(() => document.getElementById('connection-dialog').getAttribute('aria-busy') === 'false');
  }
  async function reviewUnchanged(url) {
    assert.equal(await page.locator('#connection-url').inputValue(), url, 'app grants preserve the Review capability');
    assert.deepEqual(await page.locator('#connection-tools li').allTextContents(), ['list_manuscripts', 'read_manuscript', 'suggest_text']);
  }

  await open('?no-control-wrapper');
  await page.evaluate(() => window.fixture.running());
  assert.equal(await page.locator('#connection-app-enabled').isDisabled(), true, 'missing wrapper cannot enable controls');
  assert.match(await page.locator('#connection-app-status').textContent(), /unavailable/i);
  await open();
  assert.equal(await page.getByRole('tab', {name:'App controls',exact:true}).count(), 1, 'compact tabs retain complete accessible names');
  assert.equal(await page.getByRole('tab', {name:'Shared manuscripts',exact:true}).count(), 1);
  assert.equal(await page.getByRole('button', {name:'Stop tunnel and revoke all access',exact:true}).count(), 1);
  assert.equal(await page.locator('#connection-app-enabled').isDisabled(), true, 'a stopped tunnel cannot enable controls');
  await page.locator('#connection-tab-zrok').focus();
  for (const [key, expected] of [['ArrowRight', 'mcp'], ['ArrowRight', 'shared'], ['ArrowRight', 'app'], ['Home', 'zrok'], ['ArrowLeft', 'app']]) {
    await page.keyboard.press(key);
    assert.equal(await page.locator(`#connection-tab-${expected}`).getAttribute('aria-selected'), 'true');
    assert.equal(await page.locator(`#connection-tab-${expected}`).evaluate(element => document.activeElement === element), true);
  }
  await page.locator('#connection-tab-zrok').click();
  await page.locator('#zrok-name').fill('undertree-test');
  await page.locator('#zrok-origin').fill('https://review.example.invalid');
  await page.locator('#tunnel-start').click();
  await settled();
  const reviewUrl = await page.locator('#connection-url').inputValue();
  assert.match(reviewUrl, /^https:\/\/review\.example\.invalid\/mcp\//);
  await page.locator('#connection-tab-app').click();
  assert.equal(await page.locator('#connection-app-enabled').isEnabled(), true);
  assert.equal(await page.locator('#connection-app-result').isHidden(), true);
  assert.equal(await page.evaluate(() => window.fixture.calls.some(call => call.action === 'control_enable')), false, 'starting a tunnel never grants app controls');
  await page.locator('#connection-app-enabled').check();
  await settled();
  const firstUrl = await page.locator('#connection-app-url').inputValue();
  assert.match(firstUrl, /\/mcp-control\//);
  assert.notEqual(firstUrl, reviewUrl);
  await reviewUnchanged(reviewUrl);
  assert.equal(await page.locator('#connection-app-result > summary').textContent(), 'URL');
  await page.locator('#connection-app-result > summary').click();
  assert.equal(await page.locator('#connection-app-url').isVisible(), true, 'the disclosure exposes the complete selectable URL');
  assert.equal(await page.locator('#connection-app-url').evaluate(element => element.readOnly), true);
  await page.locator('#connection-app-copy').click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), firstUrl, 'copy returns the full capability value');
  Object.assign(fullValueRoute, { selectable:true,copy:true });
  await page.locator('#connection-app-url').evaluate(element => { element.focus(); element.setSelectionRange(5, 25); });
  await page.evaluate(() => window.fixture.refresh());
  assert.deepEqual(await page.locator('#connection-app-url').evaluate(element => [document.activeElement === element, element.selectionStart, element.selectionEnd]), [true, 5, 25], 'status refresh preserves URL selection and focus');
  await page.locator('#connection-app-enabled').uncheck();
  await settled();
  assert.equal(await page.locator('#connection-app-result').isHidden(), true);
  assert.equal(await page.locator('#connection-app-url').inputValue(), '', 'revoked capability is removed from the DOM value');
  await reviewUnchanged(reviewUrl);
  await page.evaluate(() => window.fixture.failNextGrant());
  await page.locator('#connection-app-enabled').click();
  await settled();
  assert.equal(await page.locator('#connection-app-enabled').isChecked(), false, 'failed grants roll back the checkbox');
  assert.match(await page.locator('#connection-error').textContent(), /mock grant was denied/);
  await page.locator('#connection-app-enabled').check();
  await settled();
  assert.notEqual(await page.locator('#connection-app-url').inputValue(), firstUrl, 're-enabling issues a fresh mocked capability');
  await reviewUnchanged(reviewUrl);
  const scope = page.locator('#connection-panel-app > details').last();
  assert.equal(await scope.locator('summary').textContent(), 'Help');
  await scope.locator('summary').click();
  assert.equal(await scope.locator('p').isVisible(), true, 'the full authority explanation is reachable through Help');
  assert.match(await scope.locator('p').textContent(), /File editing and suggestion acceptance stay in UnderTree/);
  fullValueRoute.scopeExplanation = true;
  await page.screenshot({ path:join(artifacts,'expanded-content-route.png') });
  for (const details of await page.locator('#connection-panel-app > details').all()) {
    if (await details.evaluate(element => element.open)) await details.locator('summary').click();
  }
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#connection-dialog').evaluate(element => element.open), false);
  assert.equal(await page.locator('#connection-open').evaluate(element => document.activeElement === element), true, 'Escape returns focus to Connections');
  await page.locator('#connection-open').click();

  async function inspect(label) {
    await page.evaluate(async () => { await document.fonts.ready; await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
    const observation = await page.locator('#connection-dialog').evaluate(dialog => {
      const rect = dialog.getBoundingClientRect();
      const visible = [...dialog.querySelectorAll('button,[data-measure]')].filter(element => element.getClientRects().length);
      const app = dialog.querySelector('#connection-panel-app');
      return { viewport:[innerWidth,innerHeight], textSize:getComputedStyle(document.documentElement).fontSize,
        bounds:{left:rect.left,right:rect.right,top:rect.top,bottom:rect.bottom},
        clientHeight:dialog.clientHeight,scrollHeight:dialog.scrollHeight,
        groups:[...dialog.children,...app.children].filter(element=>element.getClientRects().length).map(element=>({
          label:element.id || element.className || element.textContent.trim().slice(0,55),
          height:element.getBoundingClientRect().height,clientHeight:element.clientHeight,scrollHeight:element.scrollHeight,
          marginTop:getComputedStyle(element).marginTop,marginBottom:getComputedStyle(element).marginBottom })),
        horizontalOverflow:dialog.scrollWidth > dialog.clientWidth + 1,
        verticalOverflow:dialog.scrollHeight > dialog.clientHeight + 2,
        clipped:visible.filter(element => element.scrollWidth > element.clientWidth + 2).map(element => element.id || element.textContent.slice(0, 50)),
        measured:visible.filter(element => ['fit','reflow'].includes(element.dataset.textFit)).length,
        appMeasured:dialog.querySelector('#connection-panel-app [data-measure]')?.dataset.textFit,
        noFit:visible.filter(element => element.dataset.textFit === 'no-fit').map(element => element.id || element.textContent.slice(0, 50)) };
    });
    observations.push({ label, ...observation });
    await page.screenshot({ path: join(artifacts, `${label}.png`) });
  }
  for (const [label, width, height, size] of [
    ['expanded',1440,1000,14], ['narrow-tall',320,1000,14], ['wide-short',1440,480,14],
    ['both-small',320,480,14], ['narrow-200-text',320,1000,28], ['wide-200-text',1440,1000,28], ['regrowth',1440,1000,14],
  ]) {
    await page.setViewportSize({ width, height });
    await page.evaluate(size => { document.documentElement.style.fontSize = `${size}px`; }, size);
    await inspect(label);
  }
  await page.evaluate(() => {
    document.documentElement.lang = 'de';
    document.getElementById('connection-tab-app').textContent = 'Anwendungssteuerung';
    document.querySelector('#connection-panel-app .checkbox-label span').textContent = 'Anwendungssteuerung für diese Sitzung ausdrücklich zulassen';
  });
  await page.setViewportSize({ width: 320, height: 1000 });
  await inspect('localized-narrow');
  await page.addStyleTag({ content: '#connection-dialog * { line-height:1.5 !important; letter-spacing:.12em !important; word-spacing:.16em !important; } #connection-dialog p { margin-bottom:2em !important; }' });
  await inspect('text-spacing-narrow');
  const issues = observations.filter(item => item.horizontalOverflow || item.verticalOverflow || item.clipped.length || item.noFit.length
    || item.bounds.left < -1 || item.bounds.right > item.viewport[0] + 1 || item.bounds.top < -1 || item.bounds.bottom > item.viewport[1] + 1);
  await writeFile(join(artifacts, 'report.json'), JSON.stringify({ scope:'mocked connection/grant requests; production manager/CSS/Pretext; finite matrix uses closed details; expanded full-value route checked separately; no native/MCP integration claim', functionalChecks:'passed',fullValueRoute,browser:browser.version(), observations, errors, issues }, null, 2) + '\n');
  assert.deepEqual(errors, [], 'the real manager and measurement observer have no browser errors');
  assert.ok(observations.filter(item => item.label !== 'text-spacing-narrow').every(item => item.measured > 0 && ['fit','reflow'].includes(item.appMeasured)), 'production Pretext measures the App controls labels');
  assert.equal(observations.at(-1).appMeasured, 'unavailable', 'unsupported word spacing retains the browser-verified readable fallback');
  assert.equal(issues.length, 0, `Finite App controls geometry gaps: ${issues.map(item => item.label).join(', ')}; inspect artifacts/connection-controls-ui/report.json`);
  console.log(`Connection controls: request/grant/keyboard/focus checks and ${observations.length} production-CSS/Pretext geometry observations passed (mocked requests only).`);
} finally {
  await browser?.close();
  await server.close();
}
