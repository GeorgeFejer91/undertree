// Linux qualification: bundled Tauri WebView, real Rust IPC/Typst, and native window lifecycle.
// Requires tauri-driver, WebKitWebDriver, Xvfb, xfwm4, xdotool, wmctrl and a built custom-protocol binary.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, chmod, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { createHash } from 'node:crypto';

assert.equal(process.platform, 'linux', 'This qualification uses Linux WebKitGTK and X11.');
assert.notEqual(process.getuid(), 0, 'Run the native save-denial check as a regular user.');
const binary = resolve(process.env.UNDERTREE_DESKTOP || 'target/debug/undertree-desktop');
const cli = resolve(process.env.UNDERTREE_REVIEW_CLI || 'target/debug/undertree-review');
await stat(binary);
await stat(cli);
const fixture = await mkdtemp(join(tmpdir(), 'undertree-native-ui-'));
const project = join(fixture, 'project');
const artifacts = resolve(process.env.UNDERTREE_NATIVE_ARTIFACTS || 'artifacts');
const processes = [];
const checks = [];
let session;
let driverUrl;
let nativeWindow;
let localDescriptor;
let log = '';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const evidence = {
  application: binary,
  binarySha256: hash(await readFile(binary)),
  cliSha256: hash(await readFile(cli)),
  verifiedAt: new Date().toISOString(),
  architecture: process.arch,
  platform: process.platform,
  assertions: checks,
  display: 'Private Xvfb display with xfwm4; existing desktop windows are untouched.',
  projectSetup: 'Disposable project inventory seeded in isolated XDG app state; native folder picker is outside this check.',
};
try { evidence.webKitGtkPackage = execFileSync('dpkg-query', ['-W', '-f=${Version}', 'libwebkit2gtk-4.1-0'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch {}

function child(executable, args, env = {}) {
  const processChild = spawn(executable, args, { env: { ...process.env, ...env }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  processes.push(processChild);
  processChild.on('error', error => { log = `${log}\n${error.message}`.slice(-32_000); });
  processChild.stderr.on('data', bytes => { log = `${log}${bytes}`.slice(-32_000); });
  return processChild;
}

async function waitFor(check, message, timeout = 15_000) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeout) {
    try { const value = await check(); if (value) return value; } catch (error) { lastError = error; }
    await delay(50);
  }
  throw new Error(`${message}${lastError ? `: ${lastError.message}` : ''}`);
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function request(path, body, method = 'POST') {
  const response = await fetch(`${driverUrl}${path}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20_000) });
  const result = await response.json();
  if (result.value?.error) throw new Error(`${result.value.error}: ${result.value.message}`);
  assert.ok(response.ok, JSON.stringify(result));
  return result.value;
}
const command = (path, body, method) => request(`/session/${session}${path}`, body, method);
const execute = (script, args = []) => command('/execute/sync', { script, args });
const find = async selector => (await command('/element', { using: 'css selector', value: selector }))['element-6066-11e4-a52e-4f735466cecf'];
async function click(selector) {
  const menu = await execute(`
    const parent = document.querySelector(arguments[0])?.closest('details:not([open])');
    return parent?.id ? '#' + CSS.escape(parent.id) + ' > summary' : null;
  `, [selector]);
  if (menu) await command(`/element/${await find(menu)}/click`, {});
  return command(`/element/${await find(selector)}/click`, {});
}
async function append(text) {
  const editor = await find('.cm-content');
  await command(`/element/${editor}/click`, {});
  native('xdotool', ['windowactivate', '--sync', nativeWindow, 'key', '--clearmodifiers', 'ctrl+End']);
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index++) {
    if (index) native('xdotool', ['key', '--clearmodifiers', 'Return']);
    if (lines[index]) native('xdotool', ['type', '--clearmodifiers', '--delay', '4', lines[index]]);
  }
  const last = lines.findLast(line => line.length);
  await waitFor(() => execute('return document.querySelector(".cm-content").textContent.includes(arguments[0])', [last]), 'Native key events did not reach the editor.');
}
async function screenshot(name) {
  const encoded = await command('/screenshot', undefined, 'GET');
  await writeFile(join(artifacts, name), Buffer.from(encoded, 'base64'));
}

let displayEnv;
const native = (executable, args) => execFileSync(executable, args.map(String), { env: { ...process.env, ...displayEnv }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

async function chromeGeometry() {
  return execute(`
    const rect = element => element.getBoundingClientRect();
    const visible = element => element.getClientRects().length && rect(element).width && rect(element).height;
    const inside = (inner, outer) => inner.left >= outer.left - 1 && inner.right <= outer.right + 1 && inner.top >= outer.top - 1 && inner.bottom <= outer.bottom + 1;
    const failures = [];
    for (const panel of document.querySelectorAll('#window-titlebar,.review-topbar,.manuscript-toolbar,.pdf-toolbar,.mobile-views')) {
      if (!visible(panel)) continue;
      if (panel.scrollWidth > panel.clientWidth + 1 || panel.scrollHeight > panel.clientHeight + 1) failures.push({panel:panel.id || panel.className,reason:'panel overflow'});
      for (const control of panel.querySelectorAll('button,select,input')) {
        if (!visible(control) || control.closest('details:not([open])')) continue;
        const box = rect(control);
        if (!inside(box, rect(panel)) || !inside(box,{left:0,top:0,right:innerWidth,bottom:innerHeight})) failures.push({control:control.id || control.getAttribute('aria-label') || control.textContent,reason:'control outside its finite panel'});
        if (control.scrollWidth > control.clientWidth + 1 || control.scrollHeight > control.clientHeight + 1) failures.push({control:control.id || control.textContent,reason:'control content overflow'});
      }
    }
    const icons = ['window-minimize','window-close'].map(id => {
      const button = document.getElementById(id), path = button.querySelector('path'), box = rect(button), ink = path.getBBox(), point = path.ownerSVGElement.createSVGPoint();
      point.x = ink.x + ink.width/2; point.y = ink.y + ink.height/2;
      const center = point.matrixTransform(path.getScreenCTM());
      return {id,dx:center.x-(box.left+box.width/2),dy:center.y-(box.top+box.height/2),width:box.width,height:box.height};
    });
    const editorStyle = getComputedStyle(document.querySelector('.cm-content'));
    const sourceMinimum = (parseFloat(editorStyle.lineHeight) || parseFloat(editorStyle.fontSize)*1.5) + parseFloat(editorStyle.paddingTop) + parseFloat(editorStyle.paddingBottom);
    return {width:innerWidth,height:innerHeight,fontSize:getComputedStyle(document.documentElement).fontSize,pageWidth:document.documentElement.scrollWidth,pageHeight:document.documentElement.scrollHeight,sourceHeight:rect(document.getElementById('manuscript-source')).height,sourceMinimum,failures,icons};
  `);
}

async function qualifyChrome() {
  evidence.layouts = [];
  for (const [width,height,fontSize] of [[320,900,14],[320,900,28],[1100,480,14],[1100,480,28]]) {
    await command('/window/rect', { width, height });
    await execute('document.documentElement.style.fontSize = arguments[0] + "px";', [fontSize]);
    await delay(250);
    const geometry = await chromeGeometry();
    evidence.layouts.push(geometry);
    assert.ok(geometry.pageWidth <= geometry.width + 1 && geometry.pageHeight <= geometry.height + 1, `Native page reflow ${width}×${height}, ${fontSize}px: ${JSON.stringify(geometry)}`);
    assert.deepEqual(geometry.failures, [], `Finite native controls ${width}×${height}, ${fontSize}px`);
    for (const icon of geometry.icons) assert.ok(Math.abs(icon.dx) <= 1 && Math.abs(icon.dy) <= 1, `Native frame SVG ink center: ${JSON.stringify(icon)}`);
    assert.ok(geometry.sourceHeight >= geometry.sourceMinimum, `Native source retains a full readable line ${width}×${height}, ${fontSize}px: ${JSON.stringify(geometry)}`);
  }
  await execute('document.documentElement.style.fontSize = "";');
  await command('/window/rect', { width:1440, height:900 });
  await delay(250);
}

try {
  await mkdir(project);
  await mkdir(artifacts, { recursive: true });
  const source = join(project, 'main.typ');
  const original = '#set page(paper: "a4")\n\n= Native manuscript\n\nHello from the real Tauri WebView.\n';
  await writeFile(source, original);
  const crlfSource = join(project, 'windows.typ');
  const crlfOriginal = '= Windows manuscript\r\n\r\nSecond 😀 passage.\r\n';
  await writeFile(crlfSource, crlfOriginal);
  const data = join(fixture, 'data');
  const state = join(data, 'io.github.georgefejer91.UnderTree', 'review');
  const descriptor = join(state, 'cli', 'instance.json');
  const cliEnvironment = { ...process.env, UNDERTREE_REVIEW_STATE: state };
  delete cliEnvironment.UNDERTREE_REVIEW_ENDPOINT;
  delete cliEnvironment.UNDERTREE_REVIEW_TOKEN;
  const runCli = args => spawnSync(cli, args, { env: cliEnvironment, encoding: 'utf8', timeout: 35_000, maxBuffer: 1_000_000 });
  await mkdir(state, { recursive: true });
  await writeFile(join(state, 'projects.json'), JSON.stringify({ projects: [{ id: 'native-smoke', name: 'Native smoke', root: project, repository: '', autoSync: false, pending: [], pendingRevisions: {} }] }));
  const compiler = join(fixture, 'typst');
  const compilerCalls = join(fixture, 'compiler-calls');
  // A delay makes concurrent typing observable; the actual native Typst compiler produces the PDF.
  await writeFile(compiler, `#!/bin/sh\nprintf '1\\n' >> ${quote(compilerCalls)}\nsleep 1.5\nexec ${quote(process.env.UNDERTREE_TYPST || 'typst')} "$@"\n`);
  await chmod(compiler, 0o700);
  const xvfb = child(process.env.UNDERTREE_XVFB || 'Xvfb', ['-displayfd', '1', '-screen', '0', '1600x1000x24', '-nolisten', 'tcp']);
  let display = '';
  xvfb.stdout.on('data', bytes => { display += bytes; });
  await waitFor(() => display.trim() && xvfb.exitCode === null, 'The isolated X display did not start.');
  displayEnv = { DISPLAY: `:${display.trim()}`, XDG_DATA_HOME: data, XDG_CONFIG_HOME: join(fixture, 'config'), XDG_CACHE_HOME: join(fixture, 'cache'), SESSION_MANAGER: '', UNDERTREE_TYPST: compiler };
  const wm = child(process.env.UNDERTREE_XFWM || 'xfwm4', ['--replace'], displayEnv);
  await waitFor(() => wm.exitCode === null && native('xprop', ['-root', '_NET_SUPPORTING_WM_CHECK']).includes('window id'), 'The isolated window manager did not start.');
  const port = await freePort();
  const nativePort = await freePort();
  driverUrl = `http://127.0.0.1:${port}`;
  const driver = child(process.env.UNDERTREE_TAURI_DRIVER || 'tauri-driver', ['--port', String(port), '--native-port', String(nativePort), '--native-host', '127.0.0.1'], displayEnv);
  driver.stdout.on('data', bytes => { log = `${log}${bytes}`.slice(-32_000); });
  await waitFor(async () => driver.exitCode === null && await request('/status', undefined, 'GET'), 'The loopback WebDriver did not start.');
  const opened = await request('/session', { capabilities: { alwaysMatch: { 'tauri:options': { application: binary } } } });
  session = opened.sessionId;
  evidence.webDriverCapabilities = opened.capabilities;
  assert.equal(opened.capabilities.platformName, 'linux');
  assert.equal(opened.capabilities.browserName, 'wry');
  await waitFor(() => execute('return document.querySelector(".file-button")?.dataset.path === "main.typ"'), 'Native project inventory did not render.');
  assert.equal(await execute('return !!window.__TAURI_INTERNALS__ && !document.getElementById("window-titlebar").hidden'), true);
  await execute(`
    window.__undertreeNativeErrors = [];
    const record = error => window.__undertreeNativeErrors.push({message:error?.message || String(error),stack:error?.stack || ''});
    window.addEventListener('error', event => record(event.error || event.message));
    window.addEventListener('unhandledrejection', event => record(event.reason));
    const originalError = console.error;
    console.error = (...args) => { args.forEach(record); originalError.apply(console, args); };
  `);
  checks.push('Bundled custom-protocol HTML runs inside the real Tauri WebView with native controls visible.');
  await waitFor(async () => { localDescriptor = JSON.parse(await readFile(descriptor, 'utf8')); return true; }, 'The native authority did not publish its private CLI descriptor.');
  assert.equal((await stat(descriptor)).mode & 0o077, 0, 'The local CLI descriptor is private to its owner.');
  const nativeCapabilities = await execute('return window.__TAURI_INTERNALS__.invoke("review_action", {operation:{action:"capabilities"}});');
  const discovered = runCli(['capabilities']);
  assert.equal(discovered.status, 0, 'The named CLI discovers the running desktop without a supplied token or endpoint.');
  assert.equal(discovered.stdout.includes(localDescriptor.token), false, 'CLI output does not disclose the local session credential.');
  const capabilities = JSON.parse(discovered.stdout);
  assert.equal(capabilities.ok, true);
  assert.equal(capabilities.result.instanceId, nativeCapabilities.instanceId, 'Native IPC and the CLI reach one Rust authority.');
  assert.equal(capabilities.result.instanceId, localDescriptor.instanceId);
  assert.equal(capabilities.result.caller, 'local_cli');
  assert.equal(capabilities.result.access.readOnly, false);
  assert.ok(capabilities.result.localOperations.length > 0);
  assert.deepEqual(capabilities.result.localOperations.filter(operation => operation.mutates).map(operation => operation.action), ['save_editor'], 'The local CLI can only mutate through the registered editor save barrier.');
  const cliProjects = runCli(['call', JSON.stringify({action:'projects'})]);
  assert.equal(cliProjects.status, 0);
  assert.equal(JSON.parse(cliProjects.stdout).result.some(project => project.id === 'native-smoke'), true, 'CLI reads the desktop-approved inventory.');
  const denied = runCli(['call', JSON.stringify({action:'save',project:'native-smoke',path:'main.typ',revision:hash(original),content:'Unauthorized CLI replacement.'})]);
  assert.notEqual(denied.status, 0, 'The discovery listener refuses raw replacement text even when registered-editor saves are available.');
  assert.equal(JSON.parse(denied.stdout).error.code, 'unsupported_capability');
  assert.equal(await readFile(source, 'utf8'), original);
  const unauthenticated = await fetch(localDescriptor.endpoint, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'capabilities'}),signal:AbortSignal.timeout(2000)});
  assert.equal(unauthenticated.status, 401);
  const retiredOwner = await execute('return window.__TAURI_INTERNALS__.invoke("editor_operation", {ownerId:"retired-native-smoke-owner",operation:{action:"editor_poll"}}).then(() => ({accepted:true}), error => ({accepted:false,code:error.code}));');
  assert.deepEqual(retiredOwner, { accepted:false, code:'stale_session' }, 'A retired renderer cannot invoke registered-editor operations.');
  evidence.localCli = { sameNativeInstance: true, readOnly: false, allowedMutation:'save_editor', descriptorPrivate: true, rawMutationDenied: true, anonymousDenied: true, stalePageDenied:true };
  checks.push('The named CLI privately discovers the real desktop authority, reports the native IPC instance, exposes only registered-editor save mutation, and denies raw replacement text, anonymous access and retired-renderer callbacks.');
  nativeWindow = native('xdotool', ['search', '--onlyvisible', '--name', '^UnderTree$']).split('\n')[0];
  evidence.nativePid = Number(native('xdotool', ['getwindowpid', nativeWindow]));
  await click('.file-button[data-path="main.typ"]');
  await waitFor(() => execute('return document.querySelector(".cm-content")?.textContent.includes("Hello from the real Tauri WebView.")'), 'Typst manuscript did not open.');
  await click('.file-button[data-path="windows.typ"]');
  await waitFor(() => execute('return document.querySelector(".cm-content")?.textContent.includes("Second 😀 passage.")'), 'The CRLF fixture did not open.');
  await click('.cm-content');
  native('xdotool', ['windowactivate', '--sync', nativeWindow, 'key', '--clearmodifiers', 'ctrl+Home', 'Down', 'Down', 'Home', 'shift+End']);
  await click('#highlight-selection');
  const selectedQuote = await execute('return document.getElementById("highlight-quote").textContent');
  assert.equal(selectedQuote.trim(), 'Second 😀 passage.');
  await click('#highlight-form button[type="submit"]');
  let crlfReview;
  await waitFor(async () => { crlfReview = JSON.parse(await readFile(`${crlfSource}.undertree-review.json`, 'utf8')); return crlfReview.markers.length === 1; }, 'Native CRLF highlight was not saved.');
  const crlfAnchor = crlfReview.markers[0].anchor;
  assert.equal(crlfAnchor.from, crlfOriginal.indexOf('Second'));
  assert.equal(crlfOriginal.slice(crlfAnchor.from, crlfAnchor.to), selectedQuote);
  assert.equal(crlfAnchor.quote, selectedQuote);
  assert.equal(await readFile(crlfSource, 'utf8'), crlfOriginal, 'Highlighting leaves the original CRLF source bytes unchanged.');
  await click('#review-close');
  await click('.file-button[data-path="main.typ"]');
  await waitFor(() => execute('return document.querySelector(".cm-content")?.textContent.includes("Hello from the real Tauri WebView.")'), 'Main Typst manuscript did not reopen.');
  checks.push('Native source selection and Rust highlight anchors agree on UTF-16 offsets across CRLF and emoji without changing manuscript bytes.');
  await append('\nSaved from native key input.\n');
  await click('#manuscript-save');
  await waitFor(async () => (await readFile(source, 'utf8')).includes('Saved from native key input.'), 'Native save did not persist the editor buffer.');
  checks.push('Native key input opens, edits and atomically saves an ordinary .typ manuscript through real Rust IPC.');
  await click('#typst-compile');
  await waitFor(() => execute('return document.getElementById("typst-compile").textContent.includes("Compiling")'), 'Typst compilation did not start.');
  assert.equal(await execute('return document.querySelector(".cm-content").contentEditable'), 'true');
  await append('\nTyping continued during compilation.\n');
  assert.equal(await execute('return document.querySelector(".cm-content").textContent.includes("Typing continued during compilation.")'), true);
  assert.equal(await execute('return document.getElementById("typst-compile").textContent.includes("Compiling")'), true);
  checks.push('Real editor input remains enabled while the supervised Typst process is running.');
  await click('#manuscript-save');
  await waitFor(async () => (await readFile(source, 'utf8')).includes('Typing continued during compilation.'), 'Typing during compilation was not saved.');
  await click('#typst-compile');
  await waitFor(() => execute('return document.querySelector("#typst-pages canvas")?.width > 0 && document.getElementById("typst-preview-status").textContent.startsWith("Current PDF") && document.getElementById("typst-compile").textContent === "Recompile"'), 'Native WebView did not render a current real Typst PDF.', 30_000);
  assert.equal((await execute('return document.querySelector("#typst-pages canvas").height')) > 0, true);
  const cache = await readFile(join(state, 'pdfs', `${hash('native-smoke:main.typ')}.json`), 'utf8');
  const pdfMetadata = JSON.parse(cache);
  assert.equal(pdfMetadata.revision, hash(await readFile(source)));
  assert.equal((await readFile(join(state, 'pdfs', pdfMetadata.pdf))).subarray(0, 5).toString(), '%PDF-');
  assert.equal(await execute('return document.getElementById("review-status").classList.contains("error")'), false, 'Native automatic compilation and release finish without a status error.');
  assert.deepEqual(await execute('return window.__undertreeNativeErrors'), [], 'Native JavaScript has no uncaught errors.');
  checks.push('Real Typst PDF bytes and PDF.js canvases agree with the saved source revision inside native WebKitGTK.');
  const callsBeforeAutomatic = (await readFile(compilerCalls, 'utf8')).trim().split('\n').length;
  await append('\nAutomatically compiled in native WebView.\n');
  await waitFor(async () => {
    const saved = await readFile(source, 'utf8');
    if (!saved.includes('Automatically compiled in native WebView.')) return false;
    const metadata = JSON.parse(await readFile(join(state, 'pdfs', `${hash('native-smoke:main.typ')}.json`), 'utf8'));
    return metadata.revision === hash(saved) && await execute('return document.getElementById("typst-preview-status").textContent.startsWith("Current PDF") && document.getElementById("typst-compile").textContent === "Recompile"');
  }, 'Automatic native save and Typst scheduling did not publish the newest edited revision.', 30_000);
  assert.ok((await readFile(compilerCalls, 'utf8')).trim().split('\n').length > callsBeforeAutomatic);
  assert.equal(await execute('return document.getElementById("review-status").classList.contains("error")'), false);
  assert.deepEqual(await execute('return window.__undertreeNativeErrors'), [], 'Native automatic scheduling uses valid Window timer receivers.');
  checks.push('A new native edit autosaves and automatically compiles its latest revision, without clicking Save or Recompile or reporting a Window timer error.');
  await execute(`
    window.__cliProbe={saved:0,committed:0,last:performance.now(),fallback:false,errors:[]};
    const originalFetch=window.fetch,originalWarn=console.warn;
    window.fetch=(input,init,...rest)=>{
      try{const url=new URL(typeof input==='string'?input:input.url);if(url.protocol==='ipc:'||url.hostname==='ipc.localhost'){const name=decodeURIComponent(url.pathname.slice(1));const body=typeof init?.body==='string'?init.body:new TextDecoder().decode(init?.body);const operation=JSON.parse(body).operation;if(name==='review_action'&&operation?.action==='save'){window.__cliProbe.saved++;window.__cliProbe.last=performance.now();}if(name==='editor_operation'&&operation?.action==='editor_commit'){window.__cliProbe.committed++;window.__cliProbe.last=performance.now();}}}catch{window.__cliProbe.errors.push('Unsupported IPC body.');}
      return Reflect.apply(originalFetch,window,[input,init,...rest]);
    };
    console.warn=(...args)=>{if(args.some(v=>String(v).includes('IPC custom protocol failed')))window.__cliProbe.fallback=true;return Reflect.apply(originalWarn,console,args);};
  `);
  const beforeCliSave = await readFile(source, 'utf8');
  await chmod(project, 0o555);
  await append('\nSaved explicitly through the native CLI barrier.\n');
  await waitFor(() => execute('return document.getElementById("review-status").classList.contains("error") && document.getElementById("save-label").textContent === "Unsaved changes"'), 'The deliberately denied autosave did not leave a dirty native buffer.');
  assert.equal(await readFile(source, 'utf8'), beforeCliSave, 'A failed autosave cannot satisfy the explicit CLI save assertion.');
  await waitFor(() => execute('return window.__cliProbe.saved>0&&performance.now()-window.__cliProbe.last>1100&&document.getElementById("save-label").textContent==="Unsaved changes"&&document.getElementById("typst-compile").textContent==="Recompile"'), 'Ordinary autosave and automatic compile must settle under denied writes before explicit CLI save.');
  const beforeExplicit=await execute('return {...window.__cliProbe}');
  await chmod(project, 0o755);
  const editorSaved = runCli(['save', 'native-smoke', 'main.typ']);
  assert.equal(editorSaved.status, 0, 'The named CLI save reaches the registered native editor through editor_connect and editor_operation.');
  const committed = JSON.parse(editorSaved.stdout);
  assert.equal(committed.result.status, 'committed');
  assert.ok(committed.result.requestId);
  let saveReceipt;
  await waitFor(() => {
    const result = runCli(['save-receipt', committed.result.requestId]);
    if (result.status !== 0) return false;
    saveReceipt = JSON.parse(result.stdout).result;
    return saveReceipt.status === 'committed' && saveReceipt.bufferStatus === 'saved';
  }, 'The native editor did not confirm its durable CLI save receipt.');
  assert.ok((await readFile(source, 'utf8')).includes('Saved explicitly through the native CLI barrier.'));
  assert.equal(await execute('return document.getElementById("save-label").textContent'), 'Saved locally');
  const afterExplicit=await execute('return {...window.__cliProbe}');
  assert.equal(afterExplicit.saved,beforeExplicit.saved,'No ordinary timer supplied the explicit CLI save.');
  assert.equal(afterExplicit.committed-beforeExplicit.committed,1,'Exactly one registered editor commit supplies the named CLI save.');
  assert.deepEqual(afterExplicit.errors,[]);assert.equal(afterExplicit.fallback,false);
  const replay = runCli(['save-receipt', committed.result.requestId]);
  assert.equal(replay.status, 0);
  assert.deepEqual(JSON.parse(replay.stdout).result, saveReceipt, 'A durable native save receipt replays exactly.');
  evidence.localCli.registeredEditorSave = { committed:true, dirtyBufferSaved:true, receiptReplayed:true, nativeCommands:['review_action','editor_connect','editor_operation'] };
  checks.push('After a real denied autosave, explicit named CLI save commits the dirty native buffer through its registered renderer, clears its dirty state, and returns a durable replayable receipt.');
  await qualifyChrome();
  assert.deepEqual(await execute('return window.__undertreeNativeErrors'), [], 'Native resize and text enlargement have no uncaught errors.');
  checks.push('Native 320 px reflow, 200% text, short-height finite controls and visible frame SVG ink centers pass without page scrolling.');
  await screenshot('native-typst-workspace.png');
  const buffer = await execute('return document.querySelector(".cm-content").textContent');
  await click('#window-minimize');
  await waitFor(() => native('xprop', ['-id', nativeWindow, 'WM_STATE']).includes('Iconic'), 'Custom minimize did not change native window state.');
  native('wmctrl', ['-ia', nativeWindow]);
  await waitFor(() => native('xprop', ['-id', nativeWindow, 'WM_STATE']).includes('Normal'), 'The native window did not restore.');
  assert.equal(await execute('return document.querySelector(".cm-content").textContent'), buffer);
  checks.push('Custom Minimize reaches the native window manager; restore preserves the editor buffer.');
  const saved = await readFile(source, 'utf8');
  await chmod(project, 0o555);
  await append('\nClose preserves this dirty buffer.\n');
  native('wmctrl', ['-ic', nativeWindow]);
  await waitFor(() => execute('return !document.getElementById("window-error").hidden && !!document.getElementById("window-error").textContent'), 'Native close did not report the denied save.');
  assert.equal(await readFile(source, 'utf8'), saved);
  assert.equal(await execute('return document.querySelector(".cm-content").textContent.includes("Close preserves this dirty buffer.")'), true);
  assert.equal(await execute('return document.querySelector(".cm-content").contentEditable'), 'true');
  assert.equal(await execute('return document.querySelector(".review-workspace").inert'), false);
  await screenshot('native-close-save-error.png');
  checks.push('A real OS close request is blocked when saving fails; disk and dirty buffer remain intact and editing resumes.');
  await chmod(project, 0o755);
  await click('#window-close').catch(error => { if (!/no such window|invalid session id|unknown error/i.test(error.message)) throw error; });
  await waitFor(async () => (await readFile(source, 'utf8')).includes('Close preserves this dirty buffer.'), 'Custom Close did not flush the preserved buffer.');
  await waitFor(() => { try { native('xdotool', ['getwindowname', nativeWindow]); return false; } catch { return true; } }, 'Custom Close did not remove the native window.');
  checks.push('Custom Close retries the protected save, flushes the dirty manuscript, then closes the real native window.');
  await waitFor(async () => { try { await stat(descriptor); return false; } catch (error) { return error.code === 'ENOENT'; } }, 'Native exit did not remove its private CLI descriptor.');
  await waitFor(async () => {
    try {
      const response = await fetch(localDescriptor.endpoint, {method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${localDescriptor.token}`,'X-UnderTree-Instance':localDescriptor.instanceId},body:JSON.stringify({action:'capabilities'}),signal:AbortSignal.timeout(1000)});
      return response.status === 401;
    } catch (error) { return ['ECONNREFUSED', 'ECONNRESET'].includes(error.cause?.code); }
  }, 'The exited native authority still accepts its old CLI session.');
  const stopped = runCli(['capabilities']);
  assert.notEqual(stopped.status, 0);
  assert.equal(stopped.stdout, '');
  assert.ok(stopped.stderr.includes('instance_unavailable'), 'CLI returns an explicit unavailable error after desktop shutdown.');
  evidence.localCli.revokedAfterNativeExit = true;
  checks.push('Native shutdown removes CLI discovery, revokes its former authenticated endpoint, and makes the named CLI report instance_unavailable.');
  evidence.result = 'passed';
  await rm(join(artifacts, 'native-ui-failure.png'), { force: true });
  console.log(`Native Linux Tauri qualification passed: ${checks.length} checks; screenshots and binary-linked evidence in ${artifacts}.`);
} catch (error) {
  evidence.result = 'failed';
  evidence.error = error.message;
  if (session) evidence.frontendErrors = await execute('return window.__undertreeNativeErrors || []').catch(() => []);
  if (session) await screenshot('native-ui-failure.png').catch(() => {});
  throw error;
} finally {
  if (session) await command('', undefined, 'DELETE').catch(() => {});
  await chmod(project, 0o755).catch(() => {});
  for (const processChild of [...processes].reverse()) {
    if (processChild.pid) { try { process.kill(-processChild.pid, 'SIGTERM'); } catch {} }
  }
  await delay(300);
  for (const processChild of processes) {
    if (processChild.exitCode === null && processChild.pid) { try { process.kill(-processChild.pid, 'SIGKILL'); } catch {} }
  }
  evidence.log = localDescriptor ? log.replaceAll(localDescriptor.token, '[redacted]') : log;
  await mkdir(artifacts, { recursive: true });
  await writeFile(join(artifacts, 'native-ui-evidence.json'), JSON.stringify(evidence, null, 2));
  await rm(fixture, { recursive: true, force: true });
}
