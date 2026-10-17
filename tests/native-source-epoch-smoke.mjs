// Explicit captured Linux Tauri gate. Registry fixtures change ONLY while its desktop is stopped.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { nativeFixtureContextScript } from './native-fixture-context.mjs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

assert.equal(process.platform, 'linux');
assert.notEqual(process.getuid(), 0, 'A regular user is required for the real autosave permission refusal.');
assert.equal(process.env.UNDERTREE_NATIVE_SOURCE_EPOCH_LAUNCH, '1', 'Root must assign the exact captured desktop and native lane before launch.');
for (const key of ['UNDERTREE_DESKTOP', 'UNDERTREE_REVIEW_CLI', 'UNDERTREE_SOURCE_EPOCH_MANIFEST', 'UNDERTREE_TYPST']) assert.ok(process.env[key], `Supply ${key}; no build/target fallback is allowed.`);
for (const key of ['UNDERTREE_EXPECTED_DESKTOP_SHA256', 'UNDERTREE_EXPECTED_CLI_SHA256', 'UNDERTREE_EXPECTED_MANIFEST_SHA256']) assert.match(process.env[key] || '', /^[a-f0-9]{64}$/);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const binary = await realpath(resolve(process.env.UNDERTREE_DESKTOP));
const cli = await realpath(resolve(process.env.UNDERTREE_REVIEW_CLI));
const typst = await realpath(resolve(process.env.UNDERTREE_TYPST));
const manifestPath = resolve(process.env.UNDERTREE_SOURCE_EPOCH_MANIFEST);
const manifestBytes = await readFile(manifestPath), manifest = JSON.parse(manifestBytes);
const selected = { desktop: process.env.UNDERTREE_EXPECTED_DESKTOP_SHA256, cli: process.env.UNDERTREE_EXPECTED_CLI_SHA256, manifest: process.env.UNDERTREE_EXPECTED_MANIFEST_SHA256, typst: hash(await readFile(typst)) };
assert.equal(hash(await readFile(binary)), selected.desktop); assert.equal(hash(await readFile(cli)), selected.cli); assert.equal(hash(manifestBytes), selected.manifest);
assert.equal(manifest.cli.sha256, selected.cli);
const candidate = await realpath(manifest.root);
assert.match(await readFile(join(candidate, 'modules/review/src/service.rs'), 'utf8'), /#\[serde\(rename_all = "camelCase"\)\]\s*pub struct Project/, 'The fixture must match the captured Rust Project serde contract.');
const artifacts = resolve(process.env.UNDERTREE_NATIVE_SOURCE_EPOCH_ARTIFACTS || 'artifacts/native-source-epoch');
assert.ok(artifacts !== candidate && !artifacts.startsWith(candidate + sep), 'Evidence must not mutate the selected copied candidate.');
async function verifyInputs() {
  assert.equal(hash(await readFile(binary)), selected.desktop); assert.equal(hash(await readFile(cli)), selected.cli); assert.equal(hash(await readFile(manifestPath)), selected.manifest); assert.equal(hash(await readFile(typst)), selected.typst);
  for (const [path, expected] of Object.entries({ ...manifest.hashes, ...manifest.assets })) {
    assert.ok(!path.startsWith('/') && !path.split('/').some(part => ['.', '..', ''].includes(part)));
    assert.equal(hash(await readFile(join(candidate, path))), expected, `The captured input changed: ${path}`);
  }
}
await verifyInputs();
const fixture = await mkdtemp(join(tmpdir(), 'undertree-native-source-epoch-'));
const projectRoot = join(fixture, 'project'), data = join(fixture, 'data');
const state = join(data, 'io.github.georgefejer91.UnderTree', 'review');
const registryPath = join(state, 'projects.json'), descriptorPath = join(state, 'cli', 'instance.json');
const project = randomUUID(), compilerCalls = join(fixture, 'compiler-calls'), refuseBuild = join(fixture, 'refuse-new-builds');
const mainSource = '#include "chapter.typ"\n= Main identity two\n', chapterSource = '= Chapter identity seven\n\nSaved chapter words.\n';
const processes = [], nativePids = [], checks = [], phases = [], privateTrace = [], cliRuns = [], secrets = new Set();
let session, driverUrl, displayEnv, nativeWindow, nativePid, failure, log = '', phase = 'setup';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const evidence = { state: 'not-run', runnerSha256: hash(await readFile(new URL(import.meta.url))), selected, candidate, assertions: checks, phases,
  scope: 'Real captured Tauri/WebKit IPC, real native keys and Typst, positive startup epochs, strict native DTO and live-editor CLI save; stopped startup ledger replacement only.',
  limitations: 'Linux only. Native Value cannot preserve duplicate JSON fields erased by the framework; raw HTTP duplicates and same-instance in-flight retirement are separate core tests. No Move/live rotation, held same-page last-good parse proof, root-incarnation, History, real MCP/tunnel, picker, install or signing qualification.' };
function child(executable, args, env = {}) {
  const value = spawn(executable, args, { cwd: fixture, env: { ...process.env, ...env }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] }); processes.push(value);
  value.on('error', error => { log = (log + '\n' + error.message).slice(-32000); });
  for (const stream of [value.stdout, value.stderr]) stream.on('data', bytes => { log = (log + bytes).slice(-32000); });
  return value;
}
async function until(check, message, timeout = 20000) {
  const deadline = Date.now() + timeout; let last;
  while (Date.now() < deadline) { try { const value = await check(); if (value) return value; } catch (error) { last = error; } await delay(50); }
  throw Error(message + (last ? ': ' + last.message : ''));
}
async function freePort() { const server = createServer(); await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); }); const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port; }
function native(executable, args) { const result = spawnSync(executable, args.map(String), { env: { ...process.env, ...displayEnv }, encoding: 'utf8', timeout: 5000 }); assert.equal(result.status, 0, `${executable}: ${result.stderr}`); return result.stdout.trim(); }
async function request(path, body, method = 'POST') {
  const response = await fetch(driverUrl + path, { method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30000) });
  const result = await response.json(); if (typeof result.value?.error === 'string') throw Error(`${result.value.error}: ${result.value.message}`); assert.ok(response.ok); return result.value;
}
const command = (path, body, method) => request(`/session/${session}${path}`, body, method);
const execute = (script, args = []) => command('/execute/sync', { script, args });
const invokeReview = operation => execute('return window.__TAURI_INTERNALS__.invoke("review_action",{ownerId:window.__nativeFixtureContext.owner(),operation:arguments[0]}).then(result=>({ok:true,result}),error=>({ok:false,error:typeof error==="string"?{message:error}:error}));', [operation]);
async function review(operation) { const result = await invokeReview(operation); assert.equal(result.ok, true, result.error?.message); return result.result; }
async function find(selector) { return (await command('/element', { using: 'css selector', value: selector }))['element-6066-11e4-a52e-4f735466cecf']; }
async function click(selector) {
  const summary = await execute('const n=document.querySelector(arguments[0])?.closest("details:not([open])");return n?.id?"#"+CSS.escape(n.id)+">summary":null;', [selector]);
  if (summary) await command(`/element/${await find(summary)}/click`, {});
  return command(`/element/${await find(selector)}/click`, {});
}
async function append(text) {
  await click('.cm-content'); native('xdotool', ['windowactivate', '--sync', nativeWindow, 'key', '--clearmodifiers', 'ctrl+End']);
  for (const [index, line] of text.split('\n').entries()) { if (index) native('xdotool', ['key', '--clearmodifiers', 'Return']); if (line) native('xdotool', ['type', '--clearmodifiers', '--delay', '3', line]); }
  await until(() => execute('return document.querySelector(".cm-content").textContent.includes(arguments[0]);', [text.split('\n').findLast(Boolean)]), 'Actual native key input did not reach CodeMirror.');
}
const trace = () => execute('return window.__epochTrace||[];');
async function quiescent() { await until(() => execute('return window.__epochInFlight===0&&window.__epochTimers.size===0&&!document.getElementById("typst-compile").textContent.includes("Compiling");'), 'Preexisting native source/compile activity did not settle.', 60000); }
async function open(path, expectedEpoch) {
  const selector = `.file-button[data-path="${path}"]`;
  await until(() => execute('return !!document.querySelector(arguments[0]);', [selector]), 'The native inventory omitted the source.');
  assert.equal(await execute('return document.querySelector(arguments[0]).dataset.sourceEpoch;', [selector]), String(expectedEpoch));
  for (let attempt = 0; attempt < 5; attempt++) {
    const start = (await trace()).length; await click(selector);
    const outcome = await until(() => execute('if(document.querySelector(arguments[2])?.getAttribute("aria-current")==="true"&&document.querySelector("#manuscript-tabs [aria-selected=true]")?.textContent===arguments[0]&&!!document.querySelector(".cm-content"))return {opened:true};const call=window.__epochTrace.slice(arguments[1]).find(v=>v.name==="review_action"&&v.operation?.action==="open"&&v.operation.path===arguments[0]);return call?.finished&&call.status==="error"?{opened:false,error:call.error}:false;', [path, start, selector]), 'Open did not mount the requested source or reach a typed terminal error.');
    if (outcome.opened) return;
    assert.equal(outcome.error?.code, 'busy', 'Only an actual typed no-effect admission refusal may be retried.');
    assert.equal(outcome.error?.message, 'A local document operation is running. Retry this action.');
    await quiescent(); phases.push({ phase, observedOpenAdmissionRetry: path, attempt: attempt + 1 });
  }
  throw Error('Native Open stayed busy after finite observed-admission retries.');
}
async function projectHashes() {
  const result = {}, queue = [projectRoot];
  while (queue.length) { const directory = queue.pop(); for (const entry of await readdir(directory, { withFileTypes: true })) { const path = join(directory, entry.name); if (entry.isDirectory()) queue.push(path); else { assert.ok(entry.isFile()); result[path.slice(projectRoot.length + 1)] = hash(await readFile(path)); } } }
  return result;
}
async function observedFiles() { return { project: await projectHashes(), registry: hash(await readFile(registryPath)), compiler: await readFile(compilerCalls).then(hash, error => { if (error.code === 'ENOENT') return null; throw error; }) }; }
function runCli(args) {
  const env = { ...process.env, UNDERTREE_REVIEW_STATE: state }; delete env.UNDERTREE_REVIEW_ENDPOINT; delete env.UNDERTREE_REVIEW_TOKEN;
  const result = spawnSync(cli, args, { cwd: fixture, env, encoding: 'utf8', timeout: 35000, maxBuffer: 1024 * 1024 }); cliRuns.push({phase,args,status:result.status,stdout:result.stdout,stderr:result.stderr,error:result.error?.message}); assert.equal(result.status, 0, 'The named CLI failed; exact stdout/stderr remains private.');
  return JSON.parse(result.stdout).result;
}
async function collectPage() {
  if (!session) return;
  const entries = await trace();
  for (const item of entries) for (const value of [item.payload?.ownerId, item.reply?.ownerId]) if (typeof value === 'string') secrets.add(value);
  privateTrace.push({ phase, nativePid, entries, timers: await execute('return window.__epochTimerEvents;'), errors: await execute('return window.__epochErrors;'), observationErrors: await execute('return window.__epochObservationErrors;') });
  assert.deepEqual(privateTrace.at(-1).errors, []); assert.deepEqual(privateTrace.at(-1).observationErrors, []); assert.equal(await execute('return window.__epochFallback;'), false);
}
async function stopDesktop() {
  if (!nativePid) return;
  assert.equal(await realpath(`/proc/${nativePid}/exe`), binary, 'Only the exact selected disposable desktop may be stopped.');
  assert.ok((await readFile(`/proc/${nativePid}/environ`, 'utf8')).split('\0').includes(`XDG_DATA_HOME=${data}`));
  // A deliberate clean-window exit is part of the stopped fixture, not cleanup.
  assert.equal(await execute('return document.getElementById("save-label").textContent;'), 'Saved locally');
  await click('#window-close').catch(error => { if (!/no such window|invalid session id|unknown error/i.test(error.message)) throw error; });
  await until(async () => { try { return /^State:\s+Z/m.test(await readFile(`/proc/${nativePid}/status`, 'utf8')); } catch (error) { return error.code === 'ENOENT'; } }, 'The owned clean desktop did not stop.', 10000);
  if (session) await command('', undefined, 'DELETE').catch(() => {}); session = undefined;
  await until(async () => { try { await stat(`/proc/${nativePid}`); return false; } catch (error) { return error.code === 'ENOENT'; } }, 'The stopped desktop PID was not reaped.', 8000); nativePid = undefined;
  await until(async () => { try { await stat(descriptorPath); return false; } catch (error) { return error.code === 'ENOENT'; } }, 'The stopped desktop retained its discovery descriptor.');
}
async function startDesktop(label) {
  phase = label;
  const opened = await request('/session', { capabilities: { alwaysMatch: { 'tauri:options': { application: binary } } } }); session = opened.sessionId;
  assert.equal(opened.capabilities.browserName, 'wry'); assert.equal(opened.capabilities.platformName, 'linux');
  await until(() => execute('return !!window.__TAURI_INTERNALS__&&!!document.querySelector(".file-button");'), 'The captured native UI did not load.');
  nativeWindow = native('xdotool', ['search', '--onlyvisible', '--name', '^UnderTree$']).split('\n')[0]; nativePid = Number(native('xdotool', ['getwindowpid', nativeWindow])); nativePids.push(nativePid);
  await command('/window/rect', { width: 1440, height: 900 });
  await execute(nativeFixtureContextScript);
  assert.equal(await execute(`
    window.__epochTrace=[];window.__epochErrors=[];window.__epochObservationErrors=[];window.__epochTimers=new Map();window.__epochTimerEvents=[];window.__epochInFlight=0;window.__epochWorkers=[];window.__epochFallback=false;
    addEventListener('error',e=>window.__epochErrors.push(e.message));addEventListener('unhandledrejection',e=>window.__epochErrors.push(e.reason?.message||String(e.reason)));
    const originalFetch=window.fetch,originalTimeout=window.setTimeout,originalClear=window.clearTimeout,originalWarn=console.warn,NativeWorker=window.Worker;
    window.Worker=new Proxy(NativeWorker,{construct(target,args){const w=Reflect.construct(target,args);window.__epochWorkers.push({created:performance.now(),native:w instanceof NativeWorker});return w;}});
    window.setTimeout=(fn,ms,...args)=>{if(typeof fn==='function'&&[450,700].includes(ms)){let id;const event={delay:ms,started:performance.now()};id=Reflect.apply(originalTimeout,window,[(...values)=>{window.__epochTimers.delete(id);event.fired=performance.now();return Reflect.apply(fn,window,values);},ms,...args]);window.__epochTimers.set(id,event);window.__epochTimerEvents.push(event);return id;}return Reflect.apply(originalTimeout,window,[fn,ms,...args]);};
    window.clearTimeout=id=>{window.__epochTimers.delete(id);return Reflect.apply(originalClear,window,[id]);};
    const observed=(input,init,...rest)=>{let name,payload;try{const url=new URL(typeof input==='string'?input:input.url);if(url.protocol==='ipc:'||url.hostname==='ipc.localhost'){name=decodeURIComponent(url.pathname.slice(1));payload=JSON.parse(typeof init?.body==='string'?init.body:new TextDecoder().decode(init.body));}}catch{window.__epochObservationErrors.push('Undecodable IPC observation.');}
      const entry=name?{name,payload,operation:payload.operation,started:performance.now()}:null;if(entry){if(window.__epochTrace.length>=4096)throw Error('Native observation bound exceeded.');window.__epochTrace.push(entry);window.__epochInFlight++;}
      const response=Reflect.apply(originalFetch,window,[input,init,...rest]);window.__nativeFixtureContext.observe(name,payload,response);return response.then(async response=>{if(entry){window.__epochInFlight--;entry.finished=performance.now();entry.status=response.headers.get('Tauri-Response');const body=await response.clone().json();if(entry.status==='error')entry.error=typeof body==='string'?{message:body}:body;else entry.reply=body;}return response;},error=>{if(entry){window.__epochInFlight--;entry.finished=performance.now();entry.error={message:String(error)};}throw error;});};
    window.fetch=observed;console.warn=(...args)=>{if(args.some(v=>String(v).includes('IPC custom protocol failed')))window.__epochFallback=true;return Reflect.apply(originalWarn,console,args);};return window.fetch===observed;
  `), true);
  await until(() => execute('return window.__nativeFixtureContext.status().ownerObserved;'), 'A genuine successful native UI request did not reveal its existing page owner.');
  const descriptor = await until(async () => JSON.parse(await readFile(descriptorPath, 'utf8')), 'The native authority did not publish CLI discovery.'); secrets.add(descriptor.token);
  assert.equal((await stat(descriptorPath)).mode & 0o777, 0o600);
  const nativeCapabilities = await review({ action: 'capabilities' }), cliCapabilities = runCli(['capabilities']); assert.equal(nativeCapabilities.instanceId, cliCapabilities.instanceId); assert.equal(nativeCapabilities.instanceId, descriptor.instanceId);
  assert.deepEqual([...nativeCapabilities.review.tools].sort(), ['highlight_text', 'list_manuscripts', 'read_manuscript', 'suggest_text']); assert.equal(nativeCapabilities.appControls.sourceEditing, false); assert.deepEqual(cliCapabilities.localOperations.filter(value=>value.mutates).map(value=>value.action), ['save_editor']);
  const approved = (await review({action:'projects'})).find(value=>value.id===project); assert.equal(approved.mainDocument, 'main.typ', 'The actual native serde roundtrip must retain the configured main.'); assert.equal(approved.autoSync, false); assert.deepEqual(approved.pendingRevisions, JSON.parse(await readFile(registryPath,'utf8')).projects[0].pendingRevisions);
  phases.push({ phase, instanceSha256: hash(descriptor.instanceId), nativePid, sourceEpochs: JSON.parse(await readFile(registryPath, 'utf8')).sourceEpochs[project] });
}
async function compileMain() {
  await quiescent();
  const expectedRoot = await execute('return window.__nativeFixtureContext.root(arguments[0]);', [project]);
  const mainRevision = hash(await readFile(join(projectRoot, 'main.typ')));
  const start = (await trace()).length; await click('#typst-compile');
  await until(() => execute('return document.querySelector("#typst-pages canvas")?.width>0&&document.getElementById("typst-preview-status").dataset.state==="current"&&!document.getElementById("typst-compile").textContent.includes("Compiling");'), 'Real Typst PDF did not become current in native WebKit.', 60000);
  const pdf = await review({ action: 'pdf', project, path: 'main.typ' }); assert.equal(pdf.available, true); assert.equal(pdf.current, true); assert.equal(pdf.sourceEpoch, 2);
  const actions = (await trace()).slice(start).filter(item => item.operation?.action === 'compile'); assert.ok(actions.length > 0);
  for (const item of actions) {
    assert.equal(item.payload.compileDiagnosticsVersion, 1); assert.equal(item.status, 'ok');
    assert.equal(item.operation.project, project); assert.equal(item.operation.path, 'main.typ'); assert.equal(item.operation.sourceEpoch, 2);
    assert.equal(item.operation.revision, mainRevision); assert.deepEqual(item.operation.expectedRoot, expectedRoot);
    assert.equal(item.reply.compileDiagnosticsVersion, 1); assert.equal(item.reply.status, 'succeeded');
    assert.equal(item.reply.preview.available, true); assert.equal(item.reply.preview.sourceEpoch, 2); assert.equal(item.reply.preview.revision, mainRevision); assert.deepEqual(item.reply.preview.expectedRoot, expectedRoot);
    const provenance = item.reply.report.provenance;
    assert.equal(provenance.project, project); assert.equal(provenance.path, 'main.typ'); assert.equal(provenance.sourceEpoch, 2);
    assert.deepEqual(provenance.expectedRoot, expectedRoot); assert.equal(provenance.sourceDigest, mainRevision); assert.equal(provenance.mainRevision, mainRevision);
  }
  return pdf;
}
const overall = setTimeout(() => { failure ||= Error('Native source-epoch gate exceeded its finite six-minute observation budget.'); for (const value of processes) if (value.pid) try { process.kill(-value.pid, 'SIGTERM'); } catch {} }, 360000);
try {
  evidence.state = 'running'; await mkdir(projectRoot); await mkdir(state, { recursive: true }); await mkdir(artifacts, { recursive: true });
  await writeFile(join(projectRoot, 'main.typ'), mainSource); await writeFile(join(projectRoot, 'chapter.typ'), chapterSource); await writeFile(join(projectRoot, 'legacy.typ'), '= Legacy zero\n\nOriginal legacy words.\n');
  await writeFile(registryPath, JSON.stringify({ projects: [{ id: project, name: 'Native source epochs', root: projectRoot, mainDocument: 'main.typ', repository: '', autoSync: false, pending: [], pendingRevisions: {} }], sourceEpochs: { [project]: { 'main.typ': 2, 'chapter.typ': 7 } } }));
  const compiler = join(fixture, 'typst-observed');
  await writeFile(compiler, `#!/bin/sh\nprintf 'compile\\n' >> ${quote(compilerCalls)}\nif [ -f ${quote(refuseBuild)} ]; then printf 'New builds disabled for stopped-startup artifact fixture\\n' >&2; exit 1; fi\nexec ${quote(typst)} "$@"\n`); await chmod(compiler, 0o700);
  const xvfb = child(process.env.UNDERTREE_XVFB || 'Xvfb', ['-displayfd', '1', '-screen', '0', '1600x1000x24', '-nolisten', 'tcp', '-noreset']); let display = ''; xvfb.stdout.on('data', bytes => { display += bytes; });
  await until(() => display.trim() && xvfb.exitCode === null, 'Private Xvfb did not start.');
  displayEnv = { DISPLAY: ':' + display.trim(), XDG_DATA_HOME: data, XDG_CONFIG_HOME: join(fixture, 'config'), XDG_CACHE_HOME: join(fixture, 'cache'), SESSION_MANAGER: '', UNDERTREE_TYPST: compiler };
  const wm = child(process.env.UNDERTREE_XFWM || 'xfwm4', ['--replace'], displayEnv); await until(() => wm.exitCode === null && native('xprop', ['-root', '_NET_SUPPORTING_WM_CHECK']).includes('window id'), 'Private window manager did not start.');
  const port = await freePort(), nativePort = await freePort(); driverUrl = `http://127.0.0.1:${port}`;
  const driver = child(process.env.UNDERTREE_TAURI_DRIVER || 'tauri-driver', ['--port', String(port), '--native-port', String(nativePort), '--native-host', '127.0.0.1'], displayEnv);
  await until(async () => driver.exitCode === null && await request('/status', undefined, 'GET'), 'Private native WebDriver did not start.');
  await startDesktop('startup-main2-chapter7');
  await open('chapter.typ', 7); await append('\nSaved explicitly at epoch seven.\n'); assert.equal(await execute('return document.getElementById("save-label").textContent;'), 'Unsaved changes'); await click('#manuscript-save');
  await until(async () => (await readFile(join(projectRoot, 'chapter.typ'), 'utf8')).includes('Saved explicitly at epoch seven.') && await execute('return document.getElementById("save-label").textContent==="Saved locally";'), 'Dirty native chapter7 Save did not commit.');
  await quiescent(); const initialTrace = await trace();
  assert.ok(initialTrace.some(item => item.operation?.action === 'save' && item.operation.path === 'chapter.typ' && item.operation.sourceEpoch === 7 && item.reply?.sourceEpoch === 7));
  assert.ok(initialTrace.some(item => item.operation?.action === 'editor_register' && item.operation.path === 'chapter.typ' && item.operation.sourceEpoch === 7 && item.reply?.sourceEpoch === 7));
  await compileMain();
  const infoPath = join(state, 'pdfs', hash(`${project}:main.typ`) + '.json'), metadata = JSON.parse(await readFile(infoPath, 'utf8'));
  assert.equal(metadata.source_epoch, 2); assert.equal(metadata.dependencies.find(item => item.path === 'chapter.typ').source_epoch, 7);
  checks.push('Actual native chapter7 registration/dirty Save and configured main2 real-Typst PDF retain main/dependency epochs and paint a current canvas.');
  assert.equal((await review({ action: 'open', project, path: 'legacy.typ' })).sourceEpoch, 0);
  await open('legacy.typ', 0); await append('\nOrdinary native legacy zero save.\n'); await click('#manuscript-save'); await quiescent();
  assert.ok((await readFile(join(projectRoot, 'legacy.typ'), 'utf8')).includes('Ordinary native legacy zero save.'));
  assert.ok((await trace()).some(item => item.operation?.action === 'save' && item.operation.path === 'legacy.typ' && item.operation.sourceEpoch === 0 && item.reply?.sourceEpoch === 0));
  checks.push('Missing legacy epoch on native Open and ordinary real UI epoch0 Save remain successful.');
  const main = await review({ action: 'review', project, path: 'main.typ' }); await quiescent(); const before = await observedFiles();
  const originalRoot = await execute('return window.__nativeFixtureContext.root(arguments[0]);', [project]);
  const invalid = [null, '2', true, -1, 1.5, 9007199254740992].map(sourceEpoch => ({ action: 'save', project, path: 'main.typ', sourceEpoch, revision: main.review.revision, content: mainSource + 'FORBIDDEN' }));
  invalid.push({ action: 'open', project, path: 'main.typ', sourceEpoch: 2, unexpected: true }, { action: 'palette', project, path: 'main.typ', sourceEpoch: 2, revision: main.review.revision, rules: [{ id: 'r', label: 'r', color: '#abcdef', action: 'protect', prompt: 'p', unexpected: true }] });
  for (const operation of invalid) { const result = await invokeReview({ expectedRoot: originalRoot, ...operation }); assert.equal(result.ok, false, 'Native malformed identity/unknown fields must be refused.'); assert.deepEqual(await observedFiles(), before); }
  const stale = [{ action: 'open' }, { action: 'save', revision: main.review.revision, content: mainSource + 'FORBIDDEN' }, { action: 'compile', revision: main.review.revision }, { action: 'share', enabled: true }, { action: 'set_main_document' }];
  for (const action of stale) { const result = await invokeReview({ ...action, project, path: 'main.typ', sourceEpoch: 0, expectedRoot: originalRoot }); assert.equal(result.ok, false); assert.equal(result.error.code, 'stale_document'); assert.deepEqual(await observedFiles(), before); }
  checks.push('Real native DTO malformed/null/string/bool/negative/fraction/unsafe/unknown fields and same-byte stale0 effects refuse before any project/registry/compiler change.');
  await open('chapter.typ', 7); await quiescent(); const beforeCli = await readFile(join(projectRoot, 'chapter.typ'), 'utf8'); await chmod(projectRoot, 0o555);
  const denialStart = (await trace()).length; await append('\nNamed CLI saves this epoch seven buffer.\n');
  await until(() => execute('const calls=window.__epochTrace.slice(arguments[0]).filter(v=>v.operation?.action==="save");return calls.some(v=>v.operation.path==="chapter.typ"&&v.operation.project===arguments[1]&&v.finished&&v.status==="error"&&v.error?.code==="io")&&window.__epochInFlight===0&&window.__epochTimers.size===0&&document.getElementById("save-label").textContent==="Unsaved changes"&&!document.getElementById("typst-compile").textContent.includes("Compiling");', [denialStart, project]), 'The actual denied autosave/compile did not settle with a dirty buffer.', 60000);
  assert.equal(await readFile(join(projectRoot, 'chapter.typ'), 'utf8'), beforeCli); await chmod(projectRoot, 0o755);
  const cliStart = (await trace()).length, receipt = runCli(['save', project, 'chapter.typ']); assert.equal(receipt.status, 'committed'); assert.equal(receipt.sourceEpoch, 7);
  await until(() => execute('return document.getElementById("save-label").textContent==="Saved locally";'), 'Native editor did not confirm the queued CLI save.');
  const confirmed = await until(() => { const value = runCli(['save-receipt', receipt.requestId]); return value.bufferStatus === 'saved' && value; }, 'Durable CLI receipt did not confirm saved buffer.');
  assert.equal(confirmed.sourceEpoch, 7); assert.equal(confirmed.savedRevision, hash(await readFile(join(projectRoot, 'chapter.typ')))); assert.deepEqual(runCli(['save-receipt', receipt.requestId]), confirmed);
  const cliActions = (await trace()).slice(cliStart); assert.equal(cliActions.filter(item => item.operation?.action === 'save').length, 0); const commits = cliActions.filter(item => item.operation?.action === 'editor_commit'); assert.equal(commits.length, 1); assert.equal(commits[0].reply.snapshot.sourceEpoch, 7); assert.equal(commits[0].reply.receipt.sourceEpoch, 7);
  checks.push('After a real denied autosave, named discovered CLI saves the native registered dirty buffer through one editor_commit and replays an exact durable epoch7 receipt.');
  const pdf2 = await compileMain(), pdfHash = hash(Buffer.from(pdf2.base64, 'base64')), pointerHash = hash(await readFile(infoPath)), savedProject = await projectHashes();
  evidence.artifact = { sourceEpoch: 2, pdfSha256: pdfHash, pointerSha256: pointerHash, dependencyEpoch: 7 }; await collectPage(); await stopDesktop(); assert.deepEqual(await projectHashes(), savedProject);
  // Deliberate historical fixture ONLY while no desktop owns or has loaded this Registry.
  const registry = JSON.parse(await readFile(registryPath, 'utf8')); registry.sourceEpochs[project]['main.typ'] = 3; await writeFile(registryPath, JSON.stringify(registry)); await writeFile(refuseBuild, 'No new PDF may mask the real retained epoch2 artifact.');
  assert.deepEqual(await projectHashes(), savedProject); await startDesktop('stopped-startup-main3-retained-pdf2');
  const workers = await execute(`
    const cached=arguments[0],original=window.atob;window.__epochCachedPdfDecodeCalls=0;
    window.atob=new Proxy(original,{apply(target,receiver,args){if(args[0]===cached)window.__epochCachedPdfDecodeCalls++;return Reflect.apply(target,receiver,args);}});
    return window.__epochWorkers.length;
  `, [pdf2.base64]);
  const negativeStart = (await trace()).length;
  assert.equal(await execute(`return document.querySelector('.file-button[data-path="main.typ"]').dataset.sourceEpoch;`), '3');
  await click('.file-button[data-path="main.typ"]');
  // Expected preview refusal stops final aria-current; observe this negative outcome explicitly.
  await until(() => execute(`
    const calls=window.__epochTrace.slice(arguments[0]);
    const opened=calls.some(v=>v.operation?.action==='open'&&v.operation.project===arguments[1]&&v.operation.path==='main.typ'&&v.operation.sourceEpoch===3&&v.status==='ok'&&v.reply?.sourceEpoch===3&&v.reply.content===arguments[2]);
    const pdf=calls.some(v=>v.operation?.action==='pdf'&&v.operation.path==='main.typ'&&v.status==='ok'&&v.reply?.available===true&&v.reply.sourceEpoch===2&&v.reply.current===false);
    return opened&&pdf&&document.querySelector('#manuscript-tabs [aria-selected=true]')?.textContent==='main.typ'&&[...document.querySelectorAll('.cm-content .cm-line')].map(node=>node.textContent).join('\\n')===arguments[2]&&document.getElementById('review-status').textContent.includes('This PDF belongs to another source identity.');
  `, [negativeStart, project, mainSource]), 'The negative artifact phase did not observe exact native source3/editor plus PDF2 refusal.');
  await quiescent(); const stalePdf = await review({ action: 'pdf', project, path: 'main.typ' }); assert.equal(stalePdf.sourceEpoch, 2); assert.equal(stalePdf.current, false); assert.equal(hash(Buffer.from(stalePdf.base64, 'base64')), pdfHash);
  assert.equal(hash(await readFile(infoPath)), pointerHash); assert.deepEqual(await projectHashes(), savedProject);
  assert.deepEqual(await execute('return {canvases:document.querySelectorAll("#typst-pages canvas").length,workers:window.__epochWorkers.length,decodeCalls:window.__epochCachedPdfDecodeCalls,exportHidden:document.getElementById("export-pdf").hidden,identityProblem:document.querySelectorAll("#review-policy-problem").length};'), { canvases: 0, workers, decodeCalls: 0, exportHidden: true, identityProblem: 0 });
  assert.equal((await review({ action: 'review', project, path: 'main.typ' })).sourceEpoch, 3);
  checks.push('A stopped-startup same-byte main3 fixture preserves real PDF2 bytes yet refuses new PDF worker/canvas/export adoption; it is not live Move or same-instance retirement.');
  evidence.state = 'passed';
} catch (error) { failure = error; evidence.state = 'failed'; }
finally {
  clearTimeout(overall);
  if (session) { await collectPage().catch(error => { failure ||= error; }); await command('/screenshot', undefined, 'GET').then(encoded => writeFile(join(artifacts, 'native-source-epoch.png'), Buffer.from(encoded, 'base64'))).catch(() => {}); }
  await chmod(projectRoot, 0o755).catch(() => {});
  if (nativePid) {
    try { if (await realpath(`/proc/${nativePid}/exe`) === binary && (await readFile(`/proc/${nativePid}/environ`, 'utf8')).split('\0').includes(`XDG_DATA_HOME=${data}`)) process.kill(nativePid, 'SIGTERM'); } catch {}
  }
  if (session) await command('', undefined, 'DELETE').catch(() => {});
  for(const pid of nativePids)try{if(await realpath(`/proc/${pid}/exe`)===binary&&(await readFile(`/proc/${pid}/environ`,'utf8')).split('\0').includes(`XDG_DATA_HOME=${data}`))process.kill(pid,'SIGKILL');}catch{}
  await delay(50);
  for (const value of [...processes].reverse()) if (value.pid) try { process.kill(-value.pid, 'SIGTERM'); } catch {}
  await delay(250); for (const value of processes) if (value.exitCode === null && value.pid) try { process.kill(-value.pid, 'SIGKILL'); } catch {}
  try {
    const pids=[...new Set([...nativePids,...processes.map(value=>value.pid).filter(Boolean)])];
    await until(async()=>{const alive=await Promise.all(pids.map(async pid=>{try{await stat(`/proc/${pid}`);return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}}));return alive.every(value=>!value);},'Owned native/helper PIDs remain after bounded TERM/KILL cleanup.',8000);
    evidence.cleanup={ownedPidCount:pids.length,allOwnedPidsGone:true};
  } catch(error) { failure ||= error; evidence.cleanup={allOwnedPidsGone:false}; }
  try { await verifyInputs(); evidence.selectedInputsUnchanged = true; } catch (error) { failure ||= error; evidence.selectedInputsUnchanged = false; }
  try {
    await mkdir(artifacts, { recursive: true });
    const raw = Buffer.from(JSON.stringify({ trace: privateTrace, cliRuns, log, failure: failure?.message }, null, 2) + '\n');
    if (raw.length <= 12 * 1024 * 1024) { const path = join(artifacts, 'private-provenance.json'); await writeFile(path, raw, { mode: 0o600 }); await chmod(path, 0o600); evidence.privateProvenanceSha256 = hash(raw); } else { failure ||= Error('Native provenance exceeded its12MiB bound.'); }
    evidence.actions = privateTrace.flatMap(page => page.entries.map(item => ({ phase: page.phase, name: item.name, action: item.operation?.action, path: item.operation?.path, sourceEpoch: item.operation?.sourceEpoch, responseEpoch: item.reply?.sourceEpoch ?? item.reply?.snapshot?.sourceEpoch, receiptEpoch: item.reply?.receipt?.sourceEpoch, status: item.status, errorCode: item.error?.code })));
    let message = failure?.message || null; for (const secret of secrets) if (message) message = message.replaceAll(secret, '[redacted]');
    evidence.error = message; evidence.completedAt = new Date().toISOString(); if (failure) evidence.state = 'failed';
    await writeFile(join(artifacts, 'native-source-epoch-evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
  } catch (error) { failure ||= error; }
  finally { if(evidence.cleanup?.allOwnedPidsGone)await rm(fixture, { recursive: true, force: true }).catch(error => { failure ||= error; }); else evidence.fixtureRetainedForRunningProcess=true; }
  if (failure) { let message = failure.message; for (const secret of secrets) message = message.replaceAll(secret, '[redacted]'); throw Error(message); } console.log(`Native source epoch qualification passed: ${checks.length} checks; binary-linked evidence in ${artifacts}.`);
}
