import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';

const html = (await readFile('manuscript.html', 'utf8')).replace('<script type="module" src="/src/manuscript.js"></script>', '');
const cacheDir = await mkdtemp(resolve(tmpdir(), 'undertree-hub-ui-cache-'));
const server = await createServer({ configFile: false, root: resolve('.'), cacheDir, logLevel: 'error', optimizeDeps: { noDiscovery: true, include: ['@chenglou/pretext'] }, server: { host: '127.0.0.1', port: 0, watch: null }, plugins: [{
  name: 'hub-ui-fixture',
  configureServer(vite) { vite.middlewares.use((request, response, next) => { if (request.url === '/__hub_ui.html') { response.setHeader('Content-Type', 'text/html'); response.end(html); } else next(); }); },
}] });
let browser, failure;
const observations = [];
try {
  await server.listen();
  browser = await chromium.launch({ executablePath: process.env.UNDERTREE_CHROME || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__hub_ui.html`);
  await page.evaluate(async () => {
    await import('/src/manuscript.css');
    const { setupConnectionManager } = await import('/src/connection-manager.js');
    const { observeReviewText } = await import('/modules/frontend/review-text-layout.js');
    const reviewTools = ['list_manuscripts', 'read_manuscript', 'suggest_text'].map(name => ({ name }));
    window.fixture = { operations: [], holdEnable: true, failLink: false, messages: [], state: { running: true, enabled: false, apps: [] } };
    const gateway = () => ({ enabled: fixture.state.enabled, mcpInitialized: Boolean(fixture.state.gatewayInitialized), endpoint: fixture.state.enabled ? 'https://gateway.example/mcp/private-gateway-capability' : '', apps: structuredClone(fixture.state.apps), tools: fixture.state.enabled ? [...reviewTools, { name: 'list_connected_apps' }, ...fixture.state.apps.flatMap(app => [{ name: `app_${app.id}_read` }, { name: `app_${app.id}_suggest` }])] : [] });
    const connection = () => ({ running: fixture.state.running, endpoint: fixture.state.running ? fixture.state.sameAddress && fixture.state.enabled ? gateway().endpoint : 'https://review.example/mcp/private-review-capability' : '', textOnlyConnector: true, mcpInitialized: false, sharedCount: 0, shared: [], lastError: '', config: {}, protocolVersion: '2025-06-18', tools: reviewTools, appControls: { enabled: false }, gateway: gateway() });
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw Error('Clipboard unavailable'); } } });
    fixture.manager = setupConnectionManager({ onRevoked() {}, onShares() {}, controlRequest: async () => { throw Error('App permissions were not requested by this fixture.'); }, status: message => fixture.messages.push(message), request: async operation => {
      fixture.operations.push(structuredClone(operation));
      if (operation.action === 'connection') return connection();
      if (operation.action === 'hub_status') return gateway();
      if (operation.action === 'hub_enable') {
        if (fixture.holdEnable) await new Promise(resolve => { fixture.releaseEnable = resolve; });
        fixture.state.enabled = operation.enabled; if (!operation.enabled) fixture.state.apps = []; return gateway();
      }
      if (operation.action === 'hub_link') {
        if (fixture.failLink) throw { message: 'The app did not respond.' };
        fixture.state.apps.push({ id: 'notes', label: operation.label, toolCount: 2 }); return gateway();
      }
      if (operation.action === 'hub_unlink') { fixture.state.apps = fixture.state.apps.filter(app => app.id !== operation.id); return gateway(); }
      if (operation.action === 'tunnel' && !operation.enabled) { fixture.state = { running: false, enabled: false, apps: [] }; return connection(); }
      throw Error(`Unexpected fixture operation: ${operation.action}`);
    } });
    for (const button of document.querySelectorAll('[data-close]')) button.onclick = () => button.closest('dialog').close();
    fixture.stopMeasurement = observeReviewText(document.body);
    await document.fonts.ready;
  });
  await page.locator('#connection-open').click(); await page.waitForFunction(() => document.querySelector('#connection-status').textContent === 'zrok running');
  assert.equal(await page.evaluate(() => fixture.operations.some(operation => operation.action === 'hub_status')), false);
  assert.equal(await page.locator('#connection-url').inputValue(), 'https://review.example/mcp/private-review-capability');
  assert.equal(await page.locator('#connection-tab-app').isDisabled(), true);
  await page.locator('#connection-tab-apps').click(); await page.locator('#connection-hub-enabled').waitFor({ state: 'visible' });
  await page.locator('#connection-hub-enabled').click();
  await page.waitForFunction(() => typeof fixture.releaseEnable === 'function');
  assert.equal(await page.locator('#connection-hub-enabled').isChecked(), false, 'gateway permission is never displayed optimistically');
  assert.equal(await page.locator('#connection-hub-link').isDisabled(), true);
  await page.evaluate(() => { fixture.holdEnable = false; fixture.releaseEnable(); });
  await page.waitForFunction(() => document.querySelector('#connection-hub-enabled').checked && !document.querySelector('#connection-hub-link').disabled);
  assert.equal(await page.locator('#connection-tab-app').isDisabled(), false); assert.equal(await page.locator('#connection-app-enabled').isDisabled(), false);
  await page.evaluate(async () => { fixture.state.gatewayInitialized = true; await fixture.manager.refresh(); });
  assert.equal(await page.locator('#connection-overview-mcp').textContent(), 'Initialized · public route unverified');
  assert.equal(await page.locator('#connection-hub-url').inputValue(), 'https://gateway.example/mcp/private-gateway-capability');
  await page.locator('#connection-tab-mcp').click();
  assert.equal(await page.locator('#connection-url').inputValue(), 'https://gateway.example/mcp/private-gateway-capability');
  assert.equal(await page.locator('#connection-review-address').isVisible(), true);
  await page.evaluate(async () => { fixture.state.sameAddress = true; await fixture.manager.refresh(); });
  assert.equal(await page.locator('#connection-review-address').isVisible(), false, 'a shared imported address is not mislabeled as Review-only');
  await page.evaluate(async () => { fixture.state.sameAddress = false; await fixture.manager.refresh(); });
  assert.deepEqual(await page.locator('#connection-tools li').allTextContents(), ['list_manuscripts', 'read_manuscript', 'suggest_text', 'list_connected_apps']);
  await page.locator('#connection-tab-apps').click();
  const label = 'Forschungsnotizen mit ausführlicher deutscher Bezeichnung 🧑‍🔬';
  const upstream = 'https://remote.example/mcp/private-upstream-capability';
  await page.locator('#connection-hub-label').fill(label); await page.locator('#connection-hub-upstream').fill(upstream);
  await page.locator('#connection-hub-link').click(); await page.getByRole('button', { name: `Remove ${label}`, exact: true }).waitFor();
  assert.equal(await page.locator('#connection-hub-upstream').inputValue(), '');
  assert.match(await page.locator('#connection-hub-apps').textContent(), /2 tools/);
  assert.doesNotMatch(await page.locator('#connection-hub-apps').textContent(), /private-upstream-capability/);
  assert.deepEqual(await page.evaluate(() => fixture.operations.find(operation => operation.action === 'hub_link')), { action: 'hub_link', label, url: upstream });
  await page.locator('#connection-hub-copy').click();
  assert.match(await page.locator('#connection-error').textContent(), /Copy the selected URL/);
  assert.deepEqual(await page.locator('#connection-hub-url').evaluate(input => [input.selectionStart, input.selectionEnd]), [0, 'https://gateway.example/mcp/private-gateway-capability'.length]);
  await page.locator('#connection-tab-mcp').click();
  assert.deepEqual(await page.locator('#connection-tools li').allTextContents(), ['list_manuscripts', 'read_manuscript', 'suggest_text', 'list_connected_apps', 'app_notes_read', 'app_notes_suggest']);
  await page.locator('#connection-tab-apps').click();
  for (const [width, height, text] of [[1440, 900, 14], [1100, 480, 14], [901, 480, 28], [320, 900, 28], [667, 375, 14], [1440, 900, 14]]) {
    await page.setViewportSize({ width, height }); await page.evaluate(text => { document.documentElement.style.fontSize = `${text}px`; }, text);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const result = await page.evaluate(() => {
      const dialog = document.querySelector('#connection-dialog'), panel = document.querySelector('#connection-panel-apps');
      return { viewport: [innerWidth, innerHeight], page: [document.documentElement.scrollWidth, document.documentElement.scrollHeight], dialog: dialog.getBoundingClientRect().toJSON(), horizontal: dialog.scrollWidth > dialog.clientWidth + 1, labels: [...panel.querySelectorAll('[data-measure]')].filter(element => element.getClientRects().length).map(element => ({ text: element.textContent, fit: element.dataset.textFit, overflow: element.scrollWidth > element.clientWidth + 1 || element.scrollHeight > element.clientHeight + 2 })) };
    });
    observations.push(result); assert.equal(result.horizontal, false); assert.ok(result.page[0] <= width + 1 && result.page[1] <= height + 1);
    assert.ok(result.dialog.left >= -1 && result.dialog.right <= width + 1 && result.dialog.top >= -1 && result.dialog.bottom <= height + 1);
    for (const measured of result.labels) { assert.ok(['fit', 'reflow', 'unavailable'].includes(measured.fit), JSON.stringify(measured)); assert.equal(measured.overflow, false, JSON.stringify(measured)); }
  }
  const spacing = await page.addStyleTag({ content: '#connection-panel-apps [data-measure] { line-height: 1.5 !important; letter-spacing: .12em !important; word-spacing: .16em !important; } #connection-panel-apps p { margin-bottom: 2em !important; }' });
  await page.setViewportSize({ width: 320, height: 900 }); await page.evaluate(() => { document.documentElement.style.fontSize = '28px'; });
  await page.locator('#connection-hub-link').scrollIntoViewIfNeeded();
  await page.waitForFunction(() => [...document.querySelectorAll('#connection-panel-apps [data-measure]')].filter(element => element.getClientRects().length).every(element => ['fit', 'reflow', 'unavailable'].includes(element.dataset.textFit)));
  assert.equal(await page.locator('#connection-dialog').evaluate(dialog => dialog.scrollWidth <= dialog.clientWidth + 1), true);
  await spacing.evaluate(style => style.remove());
  await page.setViewportSize({ width: 1440, height: 900 }); await page.evaluate(() => { document.documentElement.style.fontSize = '14px'; });
  await page.getByRole('button', { name: `Remove ${label}`, exact: true }).click(); await page.locator('#connection-hub-apps li').waitFor({ state: 'detached' });
  await page.evaluate(() => { fixture.failLink = true; });
  await page.locator('#connection-hub-label').fill('Unavailable app'); await page.locator('#connection-hub-upstream').fill(upstream); await page.locator('#connection-hub-link').click();
  await page.getByText('The app did not respond.', { exact: true }).waitFor();
  await page.locator('#connection-dialog [data-close]').click();
  // The dialog queues its close event after the real Close click.
  await page.waitForFunction(() => !document.querySelector('#connection-dialog').open && document.querySelector('#connection-hub-upstream').value === '' && document.querySelector('#connection-hub-label').value === '', null, { timeout: 15000 });
  assert.equal(await page.locator('#connection-hub-upstream').inputValue(), '');
  assert.equal(await page.locator('#connection-hub-label').inputValue(), '');
  await page.locator('#connection-open').click(); await page.locator('#connection-tab-apps').click();
  await page.locator('#connection-hub-enabled').click(); await page.waitForFunction(() => !document.querySelector('#connection-hub-enabled').checked && !document.querySelector('#connection-dialog').getAttribute('aria-busy').includes('true'));
  await page.locator('#connection-tab-mcp').click();
  assert.equal(await page.locator('#connection-url').inputValue(), 'https://review.example/mcp/private-review-capability');
  assert.equal(await page.locator('#connection-tab-app').isDisabled(), true); assert.equal(await page.locator('#connection-app-enabled').isDisabled(), true);
  assert.equal(await page.locator('#connection-overview-mcp').textContent(), 'No initialization observed');
  assert.equal(await page.locator('#connection-review-address').isVisible(), false);
  assert.deepEqual(await page.locator('#connection-tools li').allTextContents(), ['list_manuscripts', 'read_manuscript', 'suggest_text']);
  await page.locator('#tunnel-stop').click(); await page.locator('#connection-tab-apps').click();
  assert.equal(await page.locator('#connection-hub-enabled').isDisabled(), true); assert.equal(await page.locator('#connection-hub-url').inputValue(), '');
  assert.deepEqual(errors, []);
  console.log('Gateway UI: native-confirmed permission, explicit linking/removal, one gateway URL/catalogue, clipboard fallback, transient private input and rendered width/height/200% checks passed. Native gateway routing and public zrok are not qualified by this fixture.');
} catch (error) { failure = error; throw error; }
finally {
  await browser?.close(); await server.close(); await rm(cacheDir, { recursive: true, force: true });
  await mkdir('artifacts', { recursive: true }); await writeFile('artifacts/mcp-hub-ui-smoke.json', JSON.stringify({ result: failure ? 'failed' : 'passed', error: failure?.message, scope: 'Rendered UI with an explicit native-API fixture; no live gateway routing or public tunnel.', observations }, null, 2) + '\n');
}
