import { confirmContextShareUi } from './context-fixture.mjs';
import { consentToFixtureShare } from './context-fixture.mjs';
import assert from 'node:assert/strict';
import { createZrokFixture } from './zrok-fixture.mjs';
import { mkdtemp, mkdir, writeFile, readFile, realpath, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, toNamespacedPath } from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';

const root = await mkdtemp(join(tmpdir(), 'undertree-connections-'));
const projectRoot = join(root, 'project');
await mkdir(projectRoot);
await writeFile(join(projectRoot, 'main.html'), '<p>Hello world.</p>');
const longPath = 'Ein Manuskript mit einer langen Bezeichnung für die gemeinsame Begutachtung '.repeat(2) + '🧑‍🔬.html';
await writeFile(join(projectRoot, longPath), '<p>Research notes.</p>');
const targetFile = join(root, 'target');
const argsFile = join(root, 'args');
const stateRoot = join(root, 'state');
const importedHome = join(stateRoot, 'zrok-home-fixture');
const childHomeFile = join(root, 'child-home');
const childActivationFile = join(root, 'child-activation');
const parentHome = process.env.HOME;
const parentUserProfile = process.env.USERPROFILE;
const zrokFixture = await createZrokFixture(root, targetFile, 'review.example.org', { executableName: 'zrok test helper' });
const token = randomBytes(32).toString('hex');
const child = spawn(resolve(process.env.UNDERTREE_REVIEW_BINARY || 'target/debug/undertree-review'), [], {
  env: { ...process.env, ...zrokFixture.environment, UNDERTREE_REVIEW_PORT: '0', UNDERTREE_REVIEW_STATE: stateRoot, UNDERTREE_REVIEW_TOKEN: token, UNDERTREE_ZROK: zrokFixture.executable },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '', port, browser, base;
child.stdout.on('data', bytes => { log += bytes; port = Number(log.match(/127\.0\.0\.1:(\d+)/)?.[1]); });
child.stderr.on('data', bytes => { log += bytes; });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, message) {
  for (let i = 0; i < 60; i++) { if (await check()) return; await delay(100); }
  assert.fail(message);
}
try {
  await until(() => port || child.exitCode !== null, 'native startup');
  assert.ok(port, log);
  base = `http://127.0.0.1:${port}`;
  async function call(operation, rejected = false) {
    if (!rejected) operation = await consentToFixtureShare(operation, call);
    for (let attempt = 0; attempt < 20; attempt++) {
      const response = await fetch(base + '/api/review', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(operation) });
      const value = await response.json();
      // Service::local_source_context denies this exact lock failure before executing Share.
      if (!rejected && operation.action === 'share' && value.error?.code === 'busy'
        && value.error.message === 'A local document operation is running. Retry this action.' && attempt < 19) {
        await delay(100);
        continue;
      }
      assert.equal(value.ok, !rejected, value.error?.message);
      return rejected ? value.error : value.result;
    }
  }
  const project = await call({ action: 'add_project', root: projectRoot });
  browser = await chromium.launch({ executablePath: process.env.UNDERTREE_CHROME || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${base}/manuscript.html#session=${token}`);
  await page.getByRole('button', { name: 'main.html', exact: true }).click();
  const dialog = page.locator('#connection-dialog');
  const chatgpt = page.getByRole('button', { name: 'ChatGPT MCP setup', exact: true });
  const icon = await page.locator('#chatgpt-open').evaluate(button => {
    const box = button.getBoundingClientRect(), svg = button.querySelector('svg').getBoundingClientRect();
    return { width: svg.width, height: svg.height, x: Math.abs((svg.left + svg.right - box.left - box.right) / 2), y: Math.abs((svg.top + svg.bottom - box.top - box.bottom) / 2) };
  });
  assert.ok(icon.width > 12 && icon.width === icon.height && icon.x < 1 && icon.y < 1, 'ChatGPT SVG is centered in its toolbar button');
  await chatgpt.focus();
  await page.keyboard.press('Enter');
  await dialog.waitFor();
  assert.equal(await page.locator('#connection-tab-mcp').getAttribute('aria-selected'), 'true', 'ChatGPT opens the connection overview');
  assert.equal(await page.locator('#connection-configure').isVisible(), true);
  assert.equal(await page.locator('.connection-chatgpt-setup li').count(), 3, 'setup is available before starting a tunnel');
  assert.equal(await page.locator('#connection-result').isVisible(), false);
  const unopened = await call({ action: 'connection' });
  assert.equal(unopened.running, false, 'opening setup never starts a tunnel');
  assert.equal(unopened.sharedCount, 0, 'opening setup never shares a manuscript');
  assert.equal(unopened.appControls.enabled, false, 'opening setup never enables App controls');
  await page.locator('#connection-configure').click();
  assert.equal(await page.locator('#connection-tab-zrok').getAttribute('aria-selected'), 'true');
  await page.keyboard.press('Escape');
  assert.equal(await chatgpt.evaluate(button => document.activeElement === button), true, 'Escape restores focus to ChatGPT');
  await chatgpt.click();
  assert.equal(await page.locator('#connection-tab-mcp').getAttribute('aria-selected'), 'true', 'ChatGPT resets to MCP after another tab was selected');
  await page.locator('#connection-configure').click();
  await page.keyboard.press('Escape');
  await page.locator('#review-toggle').click();
  await page.locator('#manuscript-share').check(); await confirmContextShareUi(page);
  await until(async () => (await call({ action: 'connection' })).sharedCount === 1, 'initial manuscript sharing committed before tunnel setup');
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  await dialog.waitFor();
  await page.locator('#connection-tab-zrok').focus();
  await page.keyboard.press('ArrowLeft');
  assert.equal(await page.locator('#connection-tab-mcp').getAttribute('aria-selected'), 'true');
  await page.keyboard.press('End');
  assert.equal(await page.locator('#connection-tab-app').getAttribute('aria-selected'), 'true');
  await page.keyboard.press('Home');
  assert.equal(await page.locator('#connection-tab-mcp').getAttribute('aria-selected'), 'true', 'Home selects the overview');
  await page.locator('#connection-tab-zrok').click();
  await writeFile(join(root, 'mode'), 'startup-failure');
  await page.locator('#zrok-name').fill('startup-failure');
  await page.locator('#zrok-origin').fill('https://review.example.org');
  await page.locator('#tunnel-start').click();
  await until(async () => (await page.locator('#connection-error').textContent()).includes('exited'), 'startup error is visible inside popup');
  assert.equal(await page.locator('#tunnel-start').isEnabled(), true);
  assert.equal((await call({ action: 'connection' })).sharedCount, 0, 'failed startup retires earlier manuscript grants');
  // Establish a fresh local grant after verified retirement, for the separate
  // successful-session and individual-revocation checks below.
  await call({ action: 'share', project: project.id, path: 'main.html', enabled: true });
  await writeFile(join(root, 'mode'), '');
  await page.locator('#zrok-name').fill('test-session');
  await page.locator('#tunnel-start').click();
  await until(async () => (await page.locator('#connection-url').inputValue()).startsWith('https://'), 'private URL');
  assert.equal(await page.locator('#connection-tab-mcp').getAttribute('aria-selected'), 'true');
  assert.equal(await page.locator('#tunnel-start').isDisabled(), true);
  const privateUrl = await page.locator('#connection-url').inputValue();
  await page.locator('#connection-url').focus();
  await page.locator('#connection-url').evaluate(input => input.select());
  await delay(2200);
  assert.deepEqual(await page.locator('#connection-url').evaluate(input => [input.selectionStart, input.selectionEnd]), [0, privateUrl.length], 'refresh preserves the full selectable MCP address');
  const connection = await call({ action: 'connection' });
  assert.equal(connection.externallyVerified, false);
  assert.equal(connection.mcpInitialized, false);
  const endpoint = (await readFile(targetFile, 'utf8')) + new URL(connection.endpoint).pathname;
  const mcpHeaders = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-06-18' };
  async function rpc(method, params = {}, headers = {}) {
    return fetch(endpoint, { method: 'POST', headers: { ...mcpHeaders, ...headers }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  }
  assert.equal((await rpc('initialize', {}, { Origin: base })).status, 403);
  const initialized = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'UnderTree connection test', version: '1' } });
  assert.equal((await initialized.json()).result.protocolVersion, '2025-06-18');
  const listed = await rpc('tools/list');
  assert.deepEqual((await listed.json()).result.tools.map(tool => tool.name), ['list_manuscripts', 'read_manuscript', 'suggest_text', 'highlight_text']);
  const manuscripts = await rpc('tools/call', { name: 'list_manuscripts', arguments: {} });
  assert.equal((await manuscripts.json()).result.isError, false);
  await page.locator('#connection-refresh').click();
  await until(async () => (await page.locator('#connection-mcp-status').textContent()).includes('1 tool calls'), 'observed MCP activity');
  const invalid = await call({ action: 'tunnel', enabled: true, reservation: '../bad', public_url: 'https://review.example.org' }, true);
  assert.equal(invalid.code, 'tunnel');
  assert.equal((await call({ action: 'connection' })).endpoint, connection.endpoint, 'bad setup preserves live session');
  await call({ action: 'tunnel', enabled: true, reservation: 'test-session', public_url: 'https://review.example.org' }, true);
  assert.equal((await call({ action: 'connection' })).endpoint, connection.endpoint, 'duplicate start preserves session');
  assert.deepEqual((await readFile(argsFile, 'utf8')).trim().split('\n'), ['share', 'public', await readFile(targetFile, 'utf8'), '-n', 'public:test-session', '--headless', '--force-local']);

  await call({ action: 'share', project: project.id, path: longPath, enabled: true });
  await page.locator('#connection-tab-shared').click();
  await page.locator('#connection-refresh').click();
  await page.getByRole('button', { name: `Revoke access to ${longPath}`, exact: true }).waitFor();
  // Status refresh preserves focus on the same grant control.
  const revoke = page.getByRole('button', { name: `Revoke access to ${longPath}`, exact: true });
  await revoke.focus();
  await delay(2200);
  assert.equal(await revoke.evaluate(button => document.activeElement === button), true);
  await revoke.click();
  await until(async () => (await call({ action: 'connection' })).sharedCount === 1, 'individual revocation');
  await call({ action: 'share', project: project.id, path: longPath, enabled: true });
  await page.locator('#connection-refresh').click();
  await revoke.waitFor();

  await mkdir(resolve('artifacts'), { recursive: true });
  for (const [width, height, textSize] of [[1600, 900, 14], [760, 900, 14], [320, 900, 14], [320, 900, 28], [1600, 480, 14], [320, 480, 14], [1600, 900, 14]]) {
    await page.setViewportSize({ width, height });
    await page.evaluate(size => { document.documentElement.style.fontSize = `${size}px`; }, textSize);
    for (const tab of ['zrok', 'mcp', 'shared', 'app']) {
      await page.locator(`#connection-tab-${tab}`).click();
      await delay(120);
      const geometry = await dialog.evaluate(dialog => {
        const rect = dialog.getBoundingClientRect();
        const clipped = [...dialog.querySelectorAll('button,[data-measure]')].filter(element => element.getClientRects().length && element.scrollWidth > element.clientWidth + 2).map(element => element.id || element.tagName);
        const stackedLabels = [...dialog.querySelectorAll('[role="tab"]')].filter(element => {
          const range = document.createRange(); range.selectNodeContents(element);
          return range.getBoundingClientRect().height > parseFloat(getComputedStyle(element).lineHeight) * 2;
        }).map(element => element.id);
        return { fits: rect.left >= -1 && rect.right <= innerWidth + 1 && rect.top >= -1 && rect.bottom <= innerHeight + 1 && dialog.scrollWidth <= dialog.clientWidth + 1, clipped, stackedLabels, measured: dialog.querySelectorAll('[data-text-fit="fit"]').length };
      });
      assert.equal(geometry.fits, true, `${tab} at ${width}, text ${textSize}`);
      assert.deepEqual(geometry.clipped, [], `${tab} clipped text`);
      assert.deepEqual(geometry.stackedLabels, [], 'tabs reflow instead of stacking letters');
      assert.ok(geometry.measured > 0, 'real Pretext measurements');
      for (const selector of ['.connection-heading [data-close]', '#tunnel-stop']) {
        const action = dialog.locator(selector);
        await action.scrollIntoViewIfNeeded();
        assert.equal(await action.evaluate(button => {
          const rect = button.getBoundingClientRect();
          return rect.top >= 0 && rect.bottom <= innerHeight;
        }), true, `${tab} dialog actions remain reachable at ${width}×${height}, text ${textSize}`);
      }
      await dialog.evaluate(element => { element.scrollTop = 0; });
      await page.screenshot({ path: resolve(`artifacts/connections-${tab}-${width}-${height}-${textSize}.png`) });
    }
  }
  await page.evaluate(() => { document.documentElement.style.fontSize = ''; });
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.locator('#tunnel-stop').click();
  await until(async () => !(await call({ action: 'connection' })).running, 'stop');
  assert.equal((await call({ action: 'connection' })).sharedCount, 0);
  assert.notEqual((await rpc('tools/list').catch(() => ({ status: 0 }))).status, 200, 'old capability revoked');
  await page.locator('#connection-tab-zrok').click();
  await writeFile(join(root, 'mode'), 'late-failure');
  await page.locator('#zrok-name').fill('late-failure');
  await page.locator('#tunnel-start').click();
  await until(async () => (await call({ action: 'connection' })).running, 'second session');
  assert.notEqual((await call({ action: 'connection' })).endpoint, connection.endpoint, 'fresh session capability');
  await call({ action: 'share', project: project.id, path: 'main.html', enabled: true });
  await until(async () => !(await call({ action: 'connection' })).running, 'child exit detected');
  assert.equal((await call({ action: 'connection' })).sharedCount, 0, 'child exit revokes grants');
  await page.locator('#connection-refresh').click();
  await until(async () => (await page.locator('#connection-status').textContent()).includes('exited'), 'child exit visible');
  await page.keyboard.press('Escape');
  assert.equal(await dialog.evaluate(node => node.open), false);
  assert.equal(await page.locator('#connection-open').evaluate(button => document.activeElement === button), true, 'focus restored');
  await page.reload();
  await page.setViewportSize({ width: 320, height: 900 });
  await page.locator('.workspace-menu > summary').click();
  await page.getByRole('menuitem', { name: 'ChatGPT MCP setup', exact: true }).click();
  assert.equal(await page.locator('#connection-tab-mcp').getAttribute('aria-selected'), 'true', 'mobile menu opens MCP setup');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#workspace-menu-toggle').evaluate(button => document.activeElement === button), true, 'mobile Escape restores the menu trigger');
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.locator('#connection-open').click();
  await page.locator('#connection-tab-zrok').click();
  await until(async () => (await page.locator('#zrok-name').inputValue()) === 'late-failure', 'remember setup');
  assert.equal(await page.locator('#connection-url').inputValue(), '');
  // Import only a disposable activation fixture after all ordinary-session checks.
  await call({ action: 'tunnel', enabled: false, reservation: '', public_url: '' });
  await writeFile(join(root, 'mode'), '');
  const activation = join(importedHome, '.zrok2');
  await mkdir(activation, { recursive: true, mode: 0o700 });
  await chmod(importedHome, 0o700);
  await chmod(activation, 0o700);
  const activationMarker = JSON.stringify({ fixtureActivation: randomBytes(24).toString('hex') });
  await writeFile(join(activation, 'metadata.json'), activationMarker, { mode: 0o600 });
  await writeFile(join(activation, 'environment.json'), JSON.stringify({ ziti_identity: 'fixture-enrollment' }), { mode: 0o600 });
  const importedToken = randomBytes(24).toString('hex');
  const importedOrigin = 'https://imported.example.org';
  await writeFile(join(stateRoot, 'secret-tunnel-connector.json'), JSON.stringify({
    version: 1, reservation: 'imported-session', publicUrl: importedOrigin,
    publicPathToken: importedToken, zrokHome: importedHome,
  }), { mode: 0o600 });
  await page.locator('#connection-refresh').click();
  await until(async () => (await page.locator('#connection-tab-app').isDisabled()), 'imported profile disables App controls before starting');
  await writeFile(join(root, 'public-host'), new URL(importedOrigin).hostname);
  await page.locator('#zrok-name').fill('imported-session');
  await page.locator('#zrok-origin').fill(importedOrigin);
  await page.locator('#tunnel-start').click();
  await until(async () => (await call({ action: 'connection' })).running, 'imported session started');
  const imported = await call({ action: 'connection' });
  assert.equal(imported.endpoint, `${importedOrigin}/t/${importedToken}/mcp`, 'the existing Secret Tunnel URL is retained exactly');
  assert.equal(imported.textOnlyConnector, true);
  assert.equal(imported.appControls.enabled, false);
  assert.equal(imported.sharedCount, 0, 'importing the connector never restores manuscript grants');
  assert.deepEqual(imported.config, { reservation: 'imported-session', publicUrl: importedOrigin });
  assert.equal(JSON.stringify(imported).includes(importedHome), false, 'status never exposes the private activation home');
  assert.equal(JSON.stringify(imported).includes(activationMarker), false, 'status never exposes activation contents');
  assert.equal(await readFile(childHomeFile, 'utf8'), toNamespacedPath(await realpath(importedHome)), 'only the owned zrok child uses the canonical imported activation home');
  assert.equal(await readFile(childActivationFile, 'utf8'), activationMarker, 'the started child reads the dedicated fixture identity');
  assert.equal(process.env.HOME, parentHome, 'the test parent HOME is unchanged');
  assert.equal(process.env.USERPROFILE, parentUserProfile, 'the test parent USERPROFILE is unchanged');
  assert.deepEqual((await readFile(argsFile, 'utf8')).trim().split('\n'), ['share', 'public', await readFile(targetFile, 'utf8'), '-n', 'public:imported-session', '--headless', '--force-local']);
  await page.locator('#connection-refresh').click();
  assert.equal(await page.locator('#connection-url').inputValue(), imported.endpoint);
  assert.equal(await page.locator('#connection-tab-app').isDisabled(), true);
  assert.equal(await page.locator('#connection-app-enabled').isDisabled(), true);
  await page.locator('#connection-tab-mcp').focus();
  await page.keyboard.press('End');
  assert.equal(await page.locator('#connection-tab-apps').getAttribute('aria-selected'), 'true', 'imported-mode End selects Apps and skips disabled App controls');
  assert.equal(await page.locator('#connection-tab-app').getAttribute('aria-selected'), 'false', 'keyboard navigation never selects disabled App controls');
  const importedLocal = await readFile(targetFile, 'utf8');
  const importedEndpoint = importedLocal + new URL(imported.endpoint).pathname;
  async function importedRpc(method, params = {}) {
    return fetch(importedEndpoint, { method: 'POST', headers: mcpHeaders, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  }
  const importedInitialized = await importedRpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'Isolated imported connector fixture', version: '1' } });
  assert.equal((await importedInitialized.json()).result.protocolVersion, '2025-06-18');
  const importedTools = await importedRpc('tools/list');
  assert.deepEqual((await importedTools.json()).result.tools.map(tool => tool.name), ['list_manuscripts', 'read_manuscript', 'suggest_text', 'highlight_text']);
  for (const path of [`/mcp/${importedToken}`, `/mcp/control/${importedToken}`, `/t/${importedToken}/mcp/control`, '/api/review', '/api/control', '/api/editor']) {
    const denied = await fetch(importedLocal + path, { method: 'POST', headers: mcpHeaders, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) });
    assert.equal(denied.status, 404, `imported listener does not mount ${path}`);
  }
  for (const path of [`/artifacts/pdf/${importedToken}/document.pdf`, '/manuscript.html', '/health']) {
    assert.equal((await fetch(importedLocal + path)).status, 404, `imported listener does not mount ${path}`);
  }
  await call({ action: 'share', project: project.id, path: 'main.html', enabled: true });
  const importedManuscripts = await importedRpc('tools/call', { name: 'list_manuscripts', arguments: {} });
  assert.equal((await importedManuscripts.json()).result.isError, false, 'the imported route serves the closed Review catalogue');
  await page.locator('#tunnel-stop').click();
  await until(async () => !(await call({ action: 'connection' })).running, 'imported stop');
  assert.equal((await call({ action: 'connection' })).sharedCount, 0, 'stopping imported access revokes manuscript grants');
  assert.notEqual((await importedRpc('tools/list').catch(() => ({ status: 0 }))).status, 200, 'stopping imported access closes the existing bearer route');
  assert.deepEqual(errors, []);
  console.log('ChatGPT SVG/main MCP menu, desktop/mobile entry, read-only opening, selectable URL, native start/failure/stop, MCP activity, revocation, keyboard/focus, Pretext, narrow/short/regrown and 200% text layouts, imported connector exact URL/private child HOME/Review-only routes/App denial/revocation passed. zrok simulated; public ChatGPT route untested.');
} catch (error) {
  console.error('Connections smoke failed:', error.message);
  throw error;
} finally {
  if (base && child.exitCode === null && child.signalCode === null) {
    await fetch(base + '/api/review', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ action: 'tunnel', enabled: false, reservation: '', public_url: '' }),
      signal: AbortSignal.timeout(10_000),
    }).catch(() => {});
  }
  await browser?.close();
  child.kill('SIGINT');
  await new Promise(resolve => { if (child.exitCode !== null) resolve(); else { child.once('exit', resolve); setTimeout(resolve, 3000).unref(); } });
  await rm(root, { recursive: true, force: true });
}
