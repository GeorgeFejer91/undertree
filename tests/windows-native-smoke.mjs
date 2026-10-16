// Direct WebDriver: https://v2.tauri.app/develop/tests/webdriver/manual-setup/
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, stat, rm, realpath } from 'node:fs/promises';
import { resolve, join, toNamespacedPath } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { createHash } from 'node:crypto';
import { nativeFixtureContextScript } from './native-fixture-context.mjs';

assert.equal(process.platform, 'win32', 'This smoke test requires real Windows WebView2.');
assert.ok(process.env.UNDERTREE_DESKTOP, 'Set UNDERTREE_DESKTOP to the installed executable.');
assert.ok(process.env.UNDERTREE_TYPST, 'Set UNDERTREE_TYPST to the real Typst executable.');
assert.equal(process.env.UNDERTREE_ALLOW_FRESH_DEFAULT_STATE_TEST, '1', 'Explicitly allow a disposable test of absent default app state.');
const binary = resolve(process.env.UNDERTREE_DESKTOP);
const compiler = resolve(process.env.UNDERTREE_TYPST);
const tools = resolve('artifacts/windows-qa');
const driver = resolve(process.env.UNDERTREE_TAURI_DRIVER || join(tools, 'tools/bin/tauri-driver.exe'));
const edgeDriver = resolve(process.env.UNDERTREE_EDGE_DRIVER || join(tools, 'edge-driver/msedgedriver.exe'));
for (const path of [binary, compiler, driver, edgeDriver]) await stat(path);
await mkdir(tools, { recursive: true });
const fixture = await mkdtemp(join(tools, 'run-'));
const project = join(fixture, 'project');
function powershell(script) {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...process.env, UNDERTREE_QA_BINARY: binary }, encoding: 'utf8', windowsHide: true, timeout: 15_000,
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
const roaming = powershell('[Environment]::GetFolderPath("ApplicationData")');
assert.ok(roaming);
const state = resolve(roaming, 'io.github.georgefejer91.UnderTree/review');
const nativePids = () => powershell('Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $env:UNDERTREE_QA_BINARY } | Select-Object -ExpandProperty ProcessId');
assert.equal(nativePids(), '', 'Close existing instances of this executable before the disposable state test.');
assert.equal(await stat(state).catch(error => { if (error.code === 'ENOENT') return null; throw error; }), null, 'Default review state must not already exist.');
const projectId = '33333333-3333-4333-8333-333333333333';
const original = '#set page(paper: "a4")\n\n= Windows native manuscript\n\nSaved through the installed Tauri application.\n';
const addition = 'Windows WebView2 edit persisted.\n';
const expected = original + addition;
const source = join(project, 'main.typ');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
let session, driverUrl, child, approvedRoot, stateCreated = false, driverLog = '';
const evidence = {
  result: 'running', application: binary, binarySha256: hash(await readFile(binary)),
  verifiedAt: new Date().toISOString(), platform: process.platform, architecture: process.arch,
  projectSetup: 'Default state was absent and created solely for this disposable inventory; native folder picker is outside this check.',
  compilerVersion: spawnSync(compiler, ['--version'], { encoding: 'utf8', windowsHide: true }).stdout?.trim(),
  edgeDriverVersion: spawnSync(edgeDriver, ['--version'], { encoding: 'utf8', windowsHide: true }).stdout?.trim(),
  assertions: [],
};

async function until(check, message, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try { const result = await check(); if (result) return result; } catch (error) { last = error; }
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
  }
  throw new Error(`${message}${last ? `: ${last.message}` : ''}`);
}
async function freePort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolveListen); });
  const port = server.address().port;
  await new Promise(resolveClose => server.close(resolveClose));
  return port;
}
async function request(path, body, method = 'POST') {
  const response = await fetch(driverUrl + path, { method, headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(45_000) });
  const result = await response.json();
  if (result.value?.error) throw new Error(`${result.value.error}: ${result.value.message}`);
  assert.ok(response.ok, JSON.stringify(result));
  return result.value;
}
const command = (path, body, method) => request(`/session/${session}${path}`, body, method);
const execute = (script, args = []) => command('/execute/sync', { script, args });
const find = async selector => (await command('/element', { using: 'css selector', value: selector }))['element-6066-11e4-a52e-4f735466cecf'];
async function click(selector) {
  const menu = await execute('return document.querySelector(arguments[0])?.closest("details:not([open])")?.id;', [selector]);
  if (menu) await command(`/element/${await find('#' + menu + ' > summary')}/click`, {});
  await command(`/element/${await find(selector)}/click`, {});
}
async function screenshot(name) {
  const encoded = await command('/screenshot', undefined, 'GET');
  await writeFile(join(fixture, name), Buffer.from(encoded, 'base64'));
}
async function open() {
  const opened = await request('/session', { capabilities: { alwaysMatch: { 'tauri:options': { application: binary } } } });
  session = opened.sessionId;
  evidence.webView = { browser: opened.capabilities.browserName, version: opened.capabilities.browserVersion, platform: opened.capabilities.platformName };
  assert.equal(opened.capabilities.browserName, 'webview2');
  await until(() => execute('return !!window.__TAURI_INTERNALS__ && !!document.querySelector(arguments[0]);', ['[data-path="main.typ"]']), 'Installed native project inventory did not render.');
  await until(async () => JSON.parse(await readFile(join(state, 'cli/instance.json'), 'utf8')).instanceId, 'Native process did not use the disposable default state.');
  await click('[data-path="main.typ"]');
  await until(() => execute('return document.querySelector("[role=textbox][contenteditable=true]")?.textContent.includes("Windows native manuscript");'), 'Native source did not open.');
}

try {
  await mkdir(project);
  approvedRoot = toNamespacedPath(await realpath(project));
  await mkdir(join(state, '..'), { recursive: true });
  await mkdir(state);
  stateCreated = true;
  await writeFile(source, original);
  await writeFile(join(state, 'projects.json'), JSON.stringify({ projects: [{ id: projectId, name: 'Windows smoke', root: approvedRoot,
    repository: '', autoSync: false, pending: [], pendingRevisions: {} }] }));
  await writeFile(join(fixture, 'seed-projects.json'), await readFile(join(state, 'projects.json')));
  driverUrl = `http://127.0.0.1:${await freePort()}`;
  child = spawn(driver, ['--port', new URL(driverUrl).port, '--native-port', String(await freePort()), '--native-driver', edgeDriver], {
    env: { ...process.env, UNDERTREE_TYPST: compiler, WEBVIEW2_USER_DATA_FOLDER: join(fixture, 'webview') },
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.on('error', error => { driverLog = `${driverLog}\n${error.message}`.slice(-32_000); });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { driverLog = `${driverLog}${bytes}`.slice(-32_000); });
  await until(async () => child.exitCode === null && await request('/status', undefined, 'GET'), 'Native WebDriver did not start.');
  await open();
  await execute(nativeFixtureContextScript);
  await execute(`
    window.__windowsSmoke = { calls: [], errors: [] };
    const originalFetch = window.fetch;
    window.fetch = function(input, init, ...rest) {
      let name, payload;
      const url = new URL(typeof input === 'string' ? input : input.url);
      if (url.protocol === 'ipc:' || url.hostname === 'ipc.localhost') {
        name = decodeURIComponent(url.pathname.slice(1));
        payload = JSON.parse(typeof init?.body === 'string' ? init.body : new TextDecoder().decode(init?.body));
      }
      const reply = Reflect.apply(originalFetch, this, [input, init, ...rest]);
      window.__nativeFixtureContext.observe(name, payload, reply);
      void reply.then(response => {
        if (name && response.headers.get('Tauri-Response') === 'ok') window.__windowsSmoke.calls.push({name, action: payload?.operation?.action});
      }, () => {});
      return reply;
    };
    window.addEventListener('error', event => window.__windowsSmoke.errors.push(String(event.message)));
    window.addEventListener('unhandledrejection', event => window.__windowsSmoke.errors.push(String(event.reason?.message || event.reason)));
  `);
  const editor = await find('[role=textbox][contenteditable=true]');
  await command(`/element/${editor}/click`, {});
  await command('/actions', { actions: [{ type: 'key', id: 'keyboard', actions: [
    { type: 'keyDown', value: '\uE009' }, { type: 'keyDown', value: '\uE010' },
    { type: 'keyUp', value: '\uE010' }, { type: 'keyUp', value: '\uE009' },
  ] }] });
  await command(`/element/${editor}/value`, { text: addition });
  await until(() => execute('return document.querySelector("[role=textbox][contenteditable=true]")?.textContent.includes(arguments[0]);', [addition.trim()]), 'Native keyboard edit did not reach CodeMirror.');
  await click('#manuscript-save');
  await until(async () => (await readFile(source, 'utf8')) === expected, 'Native save did not persist exact source bytes.');
  evidence.assertions.push('Native WebDriver key input and the application Save action persist exact UTF-8 bytes through real Rust IPC.');
  await click('#typst-compile');
  await until(() => execute('return document.getElementById("typst-preview-status").textContent.startsWith("Current PDF") && document.querySelector("#typst-pages canvas")?.width > 0 && document.getElementById("typst-compile").textContent === "Recompile";'), 'Real Typst PDF did not render in WebView2.', 45_000);
  const metadata = JSON.parse(await readFile(join(state, 'pdfs', `${hash(projectId + ':main.typ')}.json`), 'utf8'));
  assert.equal(metadata.revision, hash(expected));
  const pdf = await readFile(join(state, 'pdfs', metadata.pdf));
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  await writeFile(join(fixture, 'compiled.pdf'), pdf);
  evidence.pdf = { sha256: hash(pdf), bytes: pdf.length, sourceRevision: metadata.revision };
  const observation = await execute('return window.__windowsSmoke;');
  assert.deepEqual(observation.errors, []);
  assert.ok(observation.calls.some(call => call.name === 'review_action' && call.action === 'save'));
  assert.ok(observation.calls.some(call => call.name === 'review_action' && call.action === 'compile'));
  evidence.nativeCalls = observation.calls;
  evidence.assertions.push('The real Typst process produces a PDF for the exact saved revision, and PDF.js renders a nonempty native WebView2 canvas.');
  await screenshot('compiled.png');
  await command('', undefined, 'DELETE');
  session = undefined;
  await until(() => nativePids() === '', 'The first native application session did not exit.');
  await open();
  assert.equal(await execute('return document.querySelector("[role=textbox][contenteditable=true]").textContent.includes(arguments[0]);', [addition.trim()]), true);
  assert.equal(await readFile(source, 'utf8'), expected);
  evidence.assertions.push('A fresh native application session reopens the saved manuscript with the persisted edit.');
  await screenshot('reopened.png');
  evidence.result = 'passed';
} catch (error) {
  evidence.result = 'failed';
  evidence.error = error.stack || String(error);
  if (session) await screenshot('failure.png').catch(() => {});
  throw error;
} finally {
  if (session) await command('', undefined, 'DELETE').catch(() => {});
  child?.kill();
  await writeFile(join(fixture, 'driver.log'), driverLog);
  try {
    if (stateCreated) {
      await until(() => nativePids() === '', 'Native processes remain alive; disposable state was retained.');
      assert.equal(state, resolve(roaming, 'io.github.georgefejer91.UnderTree/review'));
      const inventory = JSON.parse(await readFile(join(state, 'projects.json'), 'utf8'));
      assert.equal(inventory.projects.length, 1, 'Unexpected inventory; disposable state was retained.');
      assert.equal(inventory.projects[0].id, projectId);
      assert.equal(inventory.projects[0].root, approvedRoot);
      await rm(state, { recursive: true });
      evidence.disposableStateRemoved = true;
    }
  } catch (error) {
    evidence.result = 'failed';
    evidence.cleanupError = error.stack || String(error);
    throw error;
  } finally {
    await writeFile(join(fixture, 'result.json'), JSON.stringify(evidence, null, 2));
  }
}
process.stdout.write(`Windows installed-app smoke passed. Evidence: ${fixture}\n`);
