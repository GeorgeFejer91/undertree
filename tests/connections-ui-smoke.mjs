import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';

const root = await mkdtemp(join(tmpdir(), 'undertree-connections-'));
const projectRoot = join(root, 'project');
await mkdir(projectRoot);
await writeFile(join(projectRoot, 'main.html'), '<p>Hello world.</p>');
const longPath = 'Ein Manuskript mit einer langen Bezeichnung für die gemeinsame Begutachtung '.repeat(2) + '🧑‍🔬.html';
await writeFile(join(projectRoot, longPath), '<p>Research notes.</p>');
const zrok = join(root, 'zrok test helper');
const targetFile = join(root, 'target');
const argsFile = join(root, 'args');
await writeFile(zrok, `#!/bin/sh\nprintf '%s\\n' "$@" > '${argsFile}'\nprintf '%s' "$3" > '${targetFile}'\ncase "$5" in\npublic:startup-failure) exit 3;;\npublic:late-failure) sleep 4; exit 7;;\n*) exec sleep 120;;\nesac\n`);
await chmod(zrok, 0o700);
const token = randomBytes(32).toString('hex');
const child = spawn(resolve(process.env.UNDERTREE_REVIEW_BINARY || 'target/debug/undertree-review'), [], {
  env: { ...process.env, UNDERTREE_REVIEW_PORT: '0', UNDERTREE_REVIEW_STATE: join(root, 'state'), UNDERTREE_REVIEW_TOKEN: token, UNDERTREE_ZROK: zrok },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '', port, browser;
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
  const base = `http://127.0.0.1:${port}`;
  async function call(operation, rejected = false) {
    const response = await fetch(base + '/api/review', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(operation) });
    const value = await response.json();
    assert.equal(value.ok, !rejected, value.error?.message);
    return rejected ? value.error : value.result;
  }
  const project = await call({ action: 'add_project', root: projectRoot });
  browser = await chromium.launch({ executablePath: process.env.UNDERTREE_CHROME || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${base}/manuscript.html#session=${token}`);
  await page.getByRole('button', { name: 'main.html', exact: true }).click();
  await page.locator('#review-toggle').click();
  await page.locator('#manuscript-share').check();
  await page.getByRole('button', { name: 'Connections', exact: true }).click();
  const dialog = page.locator('#connection-dialog');
  await dialog.waitFor();
  await page.locator('#connection-tab-zrok').focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.locator('#connection-tab-mcp').getAttribute('aria-selected'), 'true');
  await page.keyboard.press('End');
  assert.equal(await page.locator('#connection-tab-app').getAttribute('aria-selected'), 'true');
  await page.keyboard.press('Home');
  await page.locator('#zrok-name').fill('startup-failure');
  await page.locator('#zrok-origin').fill('https://review.example.org');
  await page.locator('#tunnel-start').click();
  await until(async () => (await page.locator('#connection-error').textContent()).includes('exited'), 'startup error is visible inside popup');
  assert.equal(await page.locator('#tunnel-start').isEnabled(), true);
  await page.locator('#zrok-name').fill('test-session');
  await page.locator('#tunnel-start').click();
  await until(async () => (await page.locator('#connection-url').inputValue()).startsWith('https://'), 'private URL');
  assert.equal(await page.locator('#connection-tab-mcp').getAttribute('aria-selected'), 'true');
  assert.equal(await page.locator('#tunnel-start').isDisabled(), true);
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
  assert.deepEqual((await listed.json()).result.tools.map(tool => tool.name), ['list_manuscripts', 'read_manuscript', 'suggest_text']);
  const manuscripts = await rpc('tools/call', { name: 'list_manuscripts', arguments: {} });
  assert.equal((await manuscripts.json()).result.isError, false);
  await page.locator('#connection-refresh').click();
  await until(async () => (await page.locator('#connection-mcp-status').textContent()).includes('1 tool calls'), 'observed MCP activity');
  const invalid = await call({ action: 'tunnel', enabled: true, reservation: '../bad', public_url: 'https://review.example.org' }, true);
  assert.equal(invalid.code, 'tunnel');
  assert.equal((await call({ action: 'connection' })).endpoint, connection.endpoint, 'bad setup preserves live session');
  await call({ action: 'tunnel', enabled: true, reservation: 'test-session', public_url: 'https://review.example.org' }, true);
  assert.equal((await call({ action: 'connection' })).endpoint, connection.endpoint, 'duplicate start preserves session');
  assert.deepEqual((await readFile(argsFile, 'utf8')).trim().split('\n'), ['share', 'public', await readFile(targetFile, 'utf8'), '-n', 'public:test-session', '--headless']);

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
  for (const [width, textSize] of [[1600, 14], [760, 14], [320, 14], [320, 28]]) {
    await page.setViewportSize({ width, height: 900 });
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
        return { fits: rect.left >= -1 && rect.right <= innerWidth + 1 && dialog.scrollWidth <= dialog.clientWidth + 1, clipped, stackedLabels, measured: dialog.querySelectorAll('[data-text-fit="fit"]').length };
      });
      assert.equal(geometry.fits, true, `${tab} at ${width}, text ${textSize}`);
      assert.deepEqual(geometry.clipped, [], `${tab} clipped text`);
      assert.deepEqual(geometry.stackedLabels, [], 'tabs reflow instead of stacking letters');
      assert.ok(geometry.measured > 0, 'real Pretext measurements');
      await page.screenshot({ path: resolve(`artifacts/connections-${tab}-${width}-${textSize}.png`) });
    }
  }
  await page.evaluate(() => { document.documentElement.style.fontSize = ''; });
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.locator('#tunnel-stop').click();
  await until(async () => !(await call({ action: 'connection' })).running, 'stop');
  assert.equal((await call({ action: 'connection' })).sharedCount, 0);
  assert.notEqual((await rpc('tools/list').catch(() => ({ status: 0 }))).status, 200, 'old capability revoked');
  await page.locator('#connection-tab-zrok').click();
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
  await page.locator('#connection-open').click();
  await until(async () => (await page.locator('#zrok-name').inputValue()) === 'late-failure', 'remember setup');
  assert.equal(await page.locator('#connection-url').inputValue(), '');
  assert.deepEqual(errors, []);
  console.log('Connection popup: native start/failure/stop, MCP activity, individual revocation, capability rotation, crash revocation, keyboard/focus, Pretext and 320px/200% text reflow passed. zrok simulated; public ChatGPT route untested.');
} finally {
  await browser?.close();
  child.kill('SIGINT');
  await new Promise(resolve => { if (child.exitCode !== null) resolve(); else { child.once('exit', resolve); setTimeout(resolve, 3000).unref(); } });
  await rm(root, { recursive: true, force: true });
}
