// Real Linux Tauri/WebKit Word count acceptance; qualify an explicitly selected binary.
// No builds, default target, tunnel, project picker, user windows or external compiler are used.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';

assert.equal(process.platform, 'linux');
assert.notEqual(process.getuid(), 0, 'Run the private native WebKit qualification as a regular desktop user.');
assert.equal(process.env.UNDERTREE_NATIVE_WORD_COUNT_LAUNCH, '1', 'Launch only after root assigns a matching captured candidate.');
assert.ok(process.env.UNDERTREE_DESKTOP, 'Supply the captured desktop; there is no default-target fallback.');
assert.match(process.env.UNDERTREE_EXPECTED_DESKTOP_SHA256 || '', /^[a-f0-9]{64}$/, 'Supply root-confirmed captured binary identity.');
const binary = resolve(process.env.UNDERTREE_DESKTOP);
const artifacts = resolve(process.env.UNDERTREE_NATIVE_WORD_COUNT_ARTIFACTS || 'artifacts/native-word-count');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
assert.equal(hash(await readFile(binary)), process.env.UNDERTREE_EXPECTED_DESKTOP_SHA256);
const fixture = await mkdtemp(join(tmpdir(), 'undertree-native-word-count-'));
const project = join(fixture, 'project'), data = join(fixture, 'data');
const state = join(data, 'io.github.georgefejer91.UnderTree', 'review');
const compilerCalls = join(fixture, 'compiler-calls');
const chapterPath = 'chapters/current.typ', chapter = join(project, chapterPath), policy = chapter + '.undertree-review.json';
const original = '= Heading\n\nAlpha beta gamma\n' + '\n'.repeat(60) + '#let ignored = "seven ignored source words"\n';
const dirty = original + 'delta', chosen = dirty.replace('beta', 'chosen');
const otherPath = 'other.typ', other = '= Other\n\nDifferent current words\n';
const htmlPath = 'long-file-'.repeat(18) + '.html';
const htmlSource = '<head><title>ignore metadata</title><script>globalThis.wordCountExecuted=true</script></head><body><p><em>under</em>tree</p><pre>ignore code</pre><p hidden>Visible structural words</p></body>';
const maxBytes = 2 * 1024 * 1024, unit = 'a '.repeat(31) + '\n';
const large = unit.repeat(Math.floor(maxBytes / unit.length)) + unit.slice(0, maxBytes % unit.length);
const denseEnabled = process.env.UNDERTREE_NATIVE_WORD_COUNT_DENSE === '1';
const denseUnit = '#strong[x]\n', denseRepetitions = Math.floor(maxBytes / denseUnit.length);
const dense = denseUnit.repeat(denseRepetitions) + ' '.repeat(maxBytes % denseUnit.length);
const processes = [], checks = [], layouts = [];
let session, driverUrl, displayEnv, nativeWindow, nativePid, log = '', failure;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const evidence = { state: 'running', verifiedAt: new Date().toISOString(), application: binary, binarySha256: hash(await readFile(binary)), runnerSha256: hash(await readFile(new URL(import.meta.url))), assertions: checks, layouts,
  scope: 'Actual captured Tauri/WebKit, real supplied-source Typst IPC and real HTML module worker. Fetch observation only delays exact dispatch/replies; it never fabricates analysis.',
  limits: 'Linux only; maximum-source Close holds the genuine completed Rust reply and proves pending-controller dismissal/no late worker creation, not native CPU-in-flight responsiveness or completed max-source segmentation latency. Optional dense completion records its real UI outcome. No main/include/rendered total, public MCP, picker or compiler qualification.' };
if (process.env.UNDERTREE_REVIEW_CLI) evidence.cliSha256 = hash(await readFile(resolve(process.env.UNDERTREE_REVIEW_CLI)));
function child(executable, args, env = {}) {
  const value = spawn(executable, args, { env: { ...process.env, ...env }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  processes.push(value); value.on('error', error => { log = (log + '\n' + error.message).slice(-32000); });
  value.stderr.on('data', bytes => { log = (log + bytes).slice(-32000); }); return value;
}
async function until(check, message, timeout = 20000) {
  const deadline = Date.now() + timeout; let last;
  while (Date.now() < deadline) { try { const value = await check(); if (value) return value; } catch (error) { last = error; } await delay(40); }
  throw Error(message + (last ? ': ' + last.message : ''));
}
async function freePort() { const server = createServer(); await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); }); const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port; }
function native(executable, args) { const result = spawnSync(executable, args.map(String), { env: { ...process.env, ...displayEnv }, encoding: 'utf8', timeout: 5000 }); assert.equal(result.status, 0, `${executable}: ${result.stderr}`); return result.stdout.trim(); }
async function request(path, body, method = 'POST') {
  const response = await fetch(driverUrl + path, { method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30000) });
  const result = await response.json(); if (typeof result.value?.error === 'string') throw Error(result.value.error + ': ' + result.value.message); assert.ok(response.ok); return result.value;
}
const command = (path, body, method) => request(`/session/${session}${path}`, body, method);
const execute = (script, args = []) => command('/execute/sync', { script, args });
const find = async selector => (await command('/element', { using: 'css selector', value: selector }))['element-6066-11e4-a52e-4f735466cecf'];
async function click(selector) { return command(`/element/${await find(selector)}/click`, {}); }
const review = operation => execute('return window.__TAURI_INTERNALS__.invoke("review_action",{operation:arguments[0]});', [operation]);
async function screenshot(name) { await writeFile(join(artifacts, name), Buffer.from(await command('/screenshot', undefined, 'GET'), 'base64')); }
async function open(path) {
  await until(()=>execute('return !!document.querySelector(arguments[0]);',[`.file-button[data-path="${path}"]`]),'Native source row was not inventoried.');
  await execute('let node=document.querySelector(arguments[0]);while(node){if(node.tagName==="DETAILS")node.open=true;node=node.parentElement;}return true;', [`.file-button[data-path="${path}"]`]);
  const deadline=Date.now()+30000;
  for(let attempt=0;attempt<8&&Date.now()<deadline;attempt++){
    const start=await traceLength();await click(`.file-button[data-path="${path}"]`);
    const outcome=await until(()=>execute(`
      if(document.querySelector('#manuscript-tabs [aria-selected=true]')?.textContent===arguments[0])return {opened:true};
      const call=window.__wcTrace.slice(arguments[1]).find(item=>item.name==='review_action'&&item.action==='open'&&item.project==='native-word-count'&&item.path===arguments[0]);
      if(!call?.finished||call.status!=='error'||call.error===undefined)return false;
      const reads=window.__wcTrace.filter(item=>item.name==='review_action'&&item.action==='review'&&item.project===call.project&&item.started<=call.started&&(!item.finished||item.finished>=call.started));
      return {opened:false,errorCode:call.error?.code,errorMessage:call.error?.message,priorReadStarts:reads.map(item=>item.started)};
    `,[path,start]),'The intended native file did not open or return an observed terminal refusal.',Math.max(1000,deadline-Date.now()));
    if(outcome.opened)return;
    assert.equal(outcome.errorCode,'busy','Only a genuine typed busy Open refusal may be retried.');
    assert.equal(outcome.errorMessage,'A local document operation is running. Retry this action.','Only a proved local admission refusal may be retried.');
    assert.ok(outcome.priorReadStarts.length>0,'A retry requires an observed prior native Review read, not an unexplained Open failure.');
    await until(()=>execute('return arguments[0].every(start=>window.__wcTrace.some(item=>item.started===start&&item.finished))&&window.__wcInFlight===0;',[outcome.priorReadStarts]),'The specific prior native read did not finish before a fresh Open click.',Math.max(1000,deadline-Date.now()));
    evidence.navigationBusyRetries??=[];evidence.navigationBusyRetries.push({path,attempt:attempt+1,code:outcome.errorCode,priorReadStarts:outcome.priorReadStarts});
  }
  throw Error('The intended native file remained busy after bounded observed-read retries.');
}
const sourceScroll=()=>execute('const n=document.querySelector(".cm-scroller");return {top:n.scrollTop,left:n.scrollLeft};');
async function wordCount(waitReady = true) {
  const diagnoseScroll=await execute('return window.__wcPhase==="count-dirty-chapter"');
  if(diagnoseScroll)evidence.initialScrollStages.push({phase:'before-file-menu',...await sourceScroll()});
  await execute('window.__wcCountTimerStart=window.__wcTimerEvents.length;');
  const desktop = await execute('return document.getElementById("menu-file-toggle").getClientRects().length>0');
  const menu = desktop ? '#menu-file' : '#workspace-menu';
  if (!(await execute('return document.querySelector(arguments[0]).open', [menu]))) await click(menu + ' > summary');
  if(diagnoseScroll)evidence.initialScrollStages.push({phase:'after-file-summary',...await sourceScroll()});
  await click(menu + ' [data-command="word-count"]');
  await until(() => execute('return document.getElementById("word-count-dialog").open'), 'Word count did not open.');
  if(diagnoseScroll)evidence.initialScrollStages.push({phase:'after-dialog-open',...await sourceScroll()});
  if (waitReady) await until(() => execute('return !document.getElementById("word-count-results").hidden'), 'Word count did not return finite source results.');
}
async function dismiss(escape = false) {
  if (escape) native('xdotool', ['windowactivate', '--sync', nativeWindow, 'key', '--clearmodifiers', 'Escape']);
  else await click('#word-count-dialog [data-close]');
  await until(() => execute('return !document.getElementById("word-count-dialog").open'), 'Native count did not close.');
}
async function append(text) { await click('.cm-content'); native('xdotool', ['windowactivate', '--sync', nativeWindow, 'key', '--clearmodifiers', 'ctrl+End']); native('xdotool', ['type', '--clearmodifiers', '--delay', '3', text]); }
const result = () => execute('return {path:document.getElementById("word-count-path").textContent,prose:document.getElementById("word-count-prose").textContent,source:document.getElementById("word-count-source").textContent,selection:document.getElementById("word-count-selection").textContent,reason:document.getElementById("word-count-prose-reason").textContent,state:document.getElementById("word-count-state").textContent,locale:document.getElementById("word-count-locale").textContent};');
const traceLength = () => execute('return window.__wcTrace.length');
const queryCount = () => execute('return window.__wcTrace.filter(item=>item.name==="word_count_typst_text").length');
const snapshotFiles = async () => {
  const value = {}, directories = [project];
  while (directories.length) {
    const directory=directories.pop();value[directory.slice(fixture.length)]='directory';
    for(const entry of await readdir(directory,{withFileTypes:true})) {
      const path=join(directory,entry.name);
      if(entry.isDirectory())directories.push(path);
      else { assert.ok(entry.isFile(),'The disposable saved project must contain regular files only.');value[path.slice(fixture.length)]=hash(await readFile(path)); }
    }
  }
  for (const path of [join(state, 'projects.json'), compilerCalls]) value[path.slice(fixture.length)] = await readFile(path).then(hash, error => { if (error.code === 'ENOENT') return null; throw error; });
  return value;
};
async function noCountWrites(start, before) {
  const writes = await execute('return window.__wcTrace.slice(arguments[0]).filter(item=>item.name==="review_action"&&["save","open","mark","unmark","reanchor","palette","decide","compile","import_tex","sync","set_main_document","share"].includes(item.action)||item.name==="editor_operation"&&item.action==="editor_commit").map(item=>({name:item.name,action:item.action,phase:item.phase}));', [start]);
  const newTimers = await execute('return window.__wcTimerEvents.slice(window.__wcCountTimerStart).map(item=>({delay:item.delay,phase:item.phase}));');
  assert.deepEqual(newTimers, [], 'Counting must not schedule a deferred source save/compile.');
  assert.deepEqual(writes, []); assert.deepEqual(await snapshotFiles(), before);
}
async function quiescent() {
  await until(() => execute('return window.__wcTimers.size===0&&window.__wcInFlight===0&&!document.getElementById("typst-compile").textContent.includes("Compiling")&&document.getElementById("save-label").textContent==="Saved locally"'), 'Preexisting user autosave/compile did not settle.');
}
try {
  await mkdir(join(project, 'chapters'), { recursive: true }); await mkdir(state, { recursive: true }); await mkdir(artifacts, { recursive: true });
  await writeFile(chapter, original); await writeFile(join(project, 'main.typ'), '#include "chapters/current.typ"\n= Unrelated main source words\n');
  await writeFile(join(project, otherPath), other); await writeFile(join(project, 'incomplete.typ'), '#strong[\nAlpha words\n');
  await writeFile(join(project, htmlPath), htmlSource); await writeFile(join(project, 'large.typ'), large);
  if(denseEnabled)await writeFile(join(project,'dense.typ'),dense);
  await writeFile(join(state, 'projects.json'), JSON.stringify({ projects: [{ id: 'native-word-count', name: 'Native Word count', root: project, repository: '', autoSync: false, pending: [], pendingRevisions: {} }] }));
  const compiler = join(fixture, 'compiler-must-not-run-for-count');
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  await writeFile(compiler, `#!/bin/sh\nprintf 'preexisting-user-compile\\n' >> ${quote(compilerCalls)}\nexit 1\n`); await chmod(compiler, 0o700);
  const xvfb = child(process.env.UNDERTREE_XVFB || 'Xvfb', ['-displayfd', '1', '-screen', '0', '1600x1000x24', '-nolisten', 'tcp', '-noreset']); let display = '';
  xvfb.stdout.on('data', bytes => { display += bytes; }); await until(() => display.trim() && xvfb.exitCode === null, 'Private Xvfb did not start.');
  displayEnv = { DISPLAY: ':' + display.trim(), XDG_DATA_HOME: data, XDG_CONFIG_HOME: join(fixture, 'config'), XDG_CACHE_HOME: join(fixture, 'cache'), SESSION_MANAGER: '', UNDERTREE_TYPST: compiler };
  const wm = child(process.env.UNDERTREE_XFWM || 'xfwm4', ['--replace'], displayEnv); await until(() => wm.exitCode === null && native('xprop', ['-root', '_NET_SUPPORTING_WM_CHECK']).includes('window id'), 'Private window manager did not start.');
  const port = await freePort(), nativePort = await freePort(); driverUrl = `http://127.0.0.1:${port}`;
  const driver = child(process.env.UNDERTREE_TAURI_DRIVER || 'tauri-driver', ['--port', String(port), '--native-port', String(nativePort), '--native-host', '127.0.0.1'], displayEnv);
  driver.stdout.on('data', bytes => { log = (log + bytes).slice(-32000); }); await until(async () => driver.exitCode === null && await request('/status', undefined, 'GET'), 'Native WebDriver did not start.');
  const opened = await request('/session', { capabilities: { alwaysMatch: { 'tauri:options': { application: binary } } } }); session = opened.sessionId; evidence.webDriverCapabilities = opened.capabilities;
  assert.equal(opened.capabilities.browserName, 'wry'); assert.equal(opened.capabilities.platformName, 'linux');
  await until(() => execute('return !!document.getElementById("word-count-dialog")&&!!document.querySelector(".file-button")&&!!window.__TAURI_INTERNALS__'), 'Captured native Word count UI did not load.');
  nativeWindow = native('xdotool', ['search', '--onlyvisible', '--name', '^UnderTree$']).split('\n')[0]; nativePid = Number(native('xdotool', ['getwindowpid', nativeWindow]));
  await command('/window/rect',{width:1440,height:900});
  assert.equal(await execute(`
    window.__wcTrace=[];window.__wcErrors=[];window.__wcObservationErrors=[];window.__wcFallback=false;window.__wcTimers=new Map();window.__wcTimerEvents=[];window.__wcInFlight=0;window.__wcPhase='setup';window.__wcHeldWrites=[];window.__wcWorkerEvents=[];
    addEventListener('error',e=>window.__wcErrors.push(e.message));addEventListener('unhandledrejection',e=>window.__wcErrors.push(e.reason?.message||String(e.reason)));
    const originalFetch=window.fetch,originalWarn=console.warn,originalTimeout=window.setTimeout,originalClear=window.clearTimeout;
    const NativeWorker=window.Worker;window.Worker=new Proxy(NativeWorker,{construct(target,args){const worker=Reflect.construct(target,args);window.__wcWorkerEvents.push({created:performance.now(),url:String(args[0]),native:worker instanceof NativeWorker});return worker;}});
    window.setTimeout=(fn,ms,...args)=>{if(typeof fn==='function'&&[450,700].includes(ms)){let id;const entry={delay:ms,phase:window.__wcPhase,scheduled:performance.now()};id=Reflect.apply(originalTimeout,window,[(...a)=>{window.__wcTimers.delete(id);entry.fired=performance.now();return Reflect.apply(fn,window,a);},ms,...args]);window.__wcTimers.set(id,entry);window.__wcTimerEvents.push(entry);return id;}return Reflect.apply(originalTimeout,window,[fn,ms,...args]);};
    window.clearTimeout=id=>{window.__wcTimers.delete(id);return Reflect.apply(originalClear,window,[id]);};
    const observed=(input,init,...rest)=>{
      let name,payload;try{const url=new URL(typeof input==='string'?input:input.url);if(url.protocol==='ipc:'||url.hostname==='ipc.localhost'){name=decodeURIComponent(url.pathname.slice(1));payload=JSON.parse(typeof init?.body==='string'?init.body:new TextDecoder().decode(init.body));}}catch{window.__wcObservationErrors.push('IPC observation could not decode this body.');}
      const entry=name?{name,action:payload.operation?.action,project:payload.operation?.project,path:payload.operation?.path,phase:window.__wcPhase,started:performance.now()}:null;
      if(entry)window.__wcTrace.push(entry);
      if(name==='word_count_typst_text'){entry.request=payload.request;entry.sourceBytes=new TextEncoder().encode(payload.request.source).length;window.__wcOwner=payload.request.ownerId;}
      const dispatch=()=>{if(entry)window.__wcInFlight++;return Reflect.apply(originalFetch,window,[input,init,...rest]).then(async response=>{if(entry){window.__wcInFlight--;entry.finished=performance.now();entry.status=response.headers.get('Tauri-Response');if(entry.status==='error')entry.error=await response.clone().json();if(name==='word_count_typst_text'){entry.reply=await response.clone().json();if(window.__wcHoldNext){window.__wcHoldNext=false;window.__wcHeldCount=entry;await new Promise(resolve=>window.__wcReleaseCount=resolve);}}}return response;},error=>{if(entry){window.__wcInFlight--;entry.transportError=String(error);}throw error;});};
      if(name==='review_action'&&['save','compile'].includes(payload.operation?.action)&&window.__wcHoldWrites)return new Promise(resolve=>{window.__wcHeldWrites.push(()=>resolve(dispatch()));});
      return dispatch();
    };
    window.fetch=observed;console.warn=(...args)=>{if(args.some(value=>String(value).includes('IPC custom protocol failed')))window.__wcFallback=true;return Reflect.apply(originalWarn,console,args);};return window.fetch===observed;
  `), true);
  await review({ action: 'set_main_document', project: 'native-word-count', path: 'main.typ' });
  await open(chapterPath); await click('#menu-format-toggle'); await click('#palette-open'); await click('#palette-form button[type=submit]');
  await until(() => stat(policy), 'Native setup did not establish portable policy bytes.'); await until(() => execute('return !document.getElementById("palette-dialog").open'), 'Palette setup did not finish.');
  const originalFiles = await snapshotFiles(); await execute('window.__wcPhase="prior-user-edit";window.__wcHoldWrites=true;'); await append('delta');
  await until(() => execute('return window.__wcHeldWrites.length>0'), 'The genuine450ms autosave did not reach the held dispatch.');
  await click('.cm-content'); native('xdotool', ['windowactivate', '--sync', nativeWindow, 'key', '--clearmodifiers', 'ctrl+Home', 'Down', 'Down', 'Home', 'Right', 'Right', 'Right', 'Right', 'Right', 'Right', 'shift+Right', 'shift+Right', 'shift+Right', 'shift+Right']);
  await execute('return new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))));');
  const assignedScroll = await execute('const n=document.querySelector(".cm-scroller");n.scrollTop=80;return {top:n.scrollTop,left:n.scrollLeft};');
  const scrollBefore=await execute('return new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>{const n=document.querySelector(".cm-scroller");resolve({top:n.scrollTop,left:n.scrollLeft});})));');
  evidence.initialScrollStages=[{phase:'assigned-after-selection-settled',...assignedScroll},{phase:'stable-before-count',...scrollBefore}];
  assert.deepEqual(scrollBefore,assignedScroll,'Selection-driven native editor scroll must settle before the count baseline.');assert.equal(scrollBefore.top,80);
  const beforeCount = await traceLength(); await execute('window.__wcPhase="count-dirty-chapter";'); await wordCount();
  const counted = await result(); assert.equal(counted.path, chapterPath); assert.equal(counted.prose, '5 words'); assert.equal(counted.source, '11 words'); assert.equal(counted.selection, '1 word'); assert.match(counted.state, /Unsaved at capture/);
  const realReply = await execute('return window.__wcTrace.filter(item=>item.name==="word_count_typst_text").at(-1);');
  assert.equal(realReply.request.source, dirty); assert.equal(realReply.reply.requestId, realReply.request.requestId); assert.equal(realReply.reply.status, 'ready'); assert.equal(realReply.reply.method, 'typst-literal-v1');
  await noCountWrites(beforeCount, originalFiles);evidence.initialScrollStages.push({phase:'before-escape',...await sourceScroll()}); await dismiss(true);
  const restoredScroll=await sourceScroll();evidence.initialScrollStages.push({phase:'after-escape',...restoredScroll});assert.deepEqual(restoredScroll,scrollBefore);
  await delay(850);await noCountWrites(beforeCount,originalFiles);
  await execute('window.__wcPhase="intentional-selection-replacement-history";');
  await execute('document.querySelector(".cm-content").focus({preventScroll:true});return true;'); native('xdotool', ['windowactivate', '--sync', nativeWindow, 'type', '--clearmodifiers', '--delay', '3', 'chosen']);
  await until(() => execute('return document.querySelector(".cm-content").textContent.includes("Alpha chosen gamma")'), 'Close did not retain the exact beta source selection.');
  await click('#source-undo'); await until(() => execute('return document.querySelector(".cm-content").textContent.includes("Alpha beta gamma")'), 'Count inserted an unexpected Undo boundary.');
  await click('#source-redo'); await until(() => execute('return document.querySelector(".cm-content").textContent.includes("Alpha chosen gamma")'), 'Count destroyed native Redo.');
  checks.push('Real Typst IPC counts the dirty active chapter (not configured main) and exact selected source, keeps saved source/policy bytes, Escape scroll/selection and actual Undo/Redo, with no count-induced Save/Open/compile.');
  await execute('window.__wcPhase="release-prior-user-work";window.__wcHoldWrites=false;for(const release of window.__wcHeldWrites.splice(0))release();return true;'); await quiescent();
  assert.equal(await readFile(chapter, 'utf8'), chosen);

  await open('incomplete.typ'); const incompleteFiles = await snapshotFiles(), incompleteStart = await traceLength(); await execute('window.__wcPhase="count-incomplete";'); await wordCount();
  const incomplete = await result(); assert.equal(incomplete.prose, 'Unavailable'); assert.equal(incomplete.source, '3 words'); assert.match(incomplete.reason, /syntax/i);
  const nativeIncomplete = await execute('return window.__wcTrace.filter(item=>item.name==="word_count_typst_text").at(-1).reply;'); assert.equal(nativeIncomplete.status, 'unavailable'); assert.equal(nativeIncomplete.reasonCode, 'incomplete_syntax');
  await noCountWrites(incompleteStart, incompleteFiles); await dismiss(); checks.push('Real incomplete Typst produces native incomplete_syntax while full-source counts remain available and saved bytes stay unchanged.');

  await open(htmlPath); const htmlFiles = await snapshotFiles(), htmlStart = await traceLength(), beforeHtmlQueries = await queryCount(); await execute('window.__wcPhase="count-html";'); await wordCount();
  assert.equal((await result()).prose, '4 words'); assert.equal(await queryCount(), beforeHtmlQueries); assert.equal(await execute('return globalThis.wordCountExecuted===undefined'), true); await noCountWrites(htmlStart, htmlFiles);
  checks.push('Actual WebKit module worker counts decoded structural HTML and exclusions without invoking native Typst, executing script or changing source/policy.');
  for (const [width, height, text] of [[1100,480,28],[320,900,28],[1440,900,14]]) {
    await command('/window/rect', { width, height }); await execute('document.documentElement.style.fontSize=arguments[0]+"px";document.querySelector("#word-count-dialog details").open=true;', [text]);
    await until(() => execute('return [...document.querySelectorAll("#word-count-dialog [data-measure]")].filter(n=>n.getClientRects().length).every(n=>["fit","reflow","unavailable"].includes(n.dataset.textFit));'), 'Actual Pretext has a no-fit or unresolved native count label.');
    const geometry = await execute('const d=document.getElementById("word-count-dialog"),b=d.querySelector(".word-count-body"),f=d.querySelector(".dialog-actions"),c=f.querySelector("[data-close]"),bs=getComputedStyle(b),ds=getComputedStyle(d),range=document.createRange();range.selectNodeContents(c);return {viewport:[innerWidth,innerHeight],page:[document.documentElement.scrollWidth,document.documentElement.scrollHeight],dialog:d.getBoundingClientRect().toJSON(),body:b.getBoundingClientRect().toJSON(),footer:f.getBoundingClientRect().toJSON(),close:c.getBoundingClientRect().toJSON(),closeLabel:[...range.getClientRects()].map(r=>r.toJSON()),readableLine:(parseFloat(bs.lineHeight)||parseFloat(bs.fontSize)*1.4286)+(parseFloat(bs.paddingTop)||0)+(parseFloat(bs.paddingBottom)||0),bodyBudget:d.clientHeight-(parseFloat(ds.paddingTop)||0)-(parseFloat(ds.paddingBottom)||0)-d.querySelector("h2").getBoundingClientRect().height-f.getBoundingClientRect().height-2*(parseFloat(ds.rowGap)||0),horizontal:b.scrollWidth>b.clientWidth+1,path:document.getElementById("word-count-path").textContent,measurements:[...d.querySelectorAll("[data-measure]")].filter(n=>n.getClientRects().length).map(n=>({text:n.textContent.slice(0,100),fit:n.dataset.textFit}))};');
    const inside=(a,b)=>a.left>=b.left-1&&a.right<=b.right+1&&a.top>=b.top-1&&a.bottom<=b.bottom+1;
    layouts.push(geometry); assert.equal(geometry.path, htmlPath); assert.ok(geometry.page[0] <= geometry.viewport[0]+1 && geometry.page[1] <= geometry.viewport[1]+1); assert.ok(geometry.dialog.top>=0 && geometry.dialog.bottom<=geometry.viewport[1]+1); assert.ok(geometry.body.height>0&&geometry.body.bottom<=geometry.footer.top+1 && geometry.footer.bottom<=geometry.dialog.bottom); assert.equal(geometry.horizontal,false);
    if(geometry.bodyBudget>=geometry.readableLine)assert.ok(geometry.body.height>=geometry.readableLine-1,'Native count body must retain a complete readable line.');
    assert.ok(geometry.close.width>0&&geometry.close.height>0&&inside(geometry.close,geometry.footer)&&inside(geometry.close,geometry.dialog));assert.ok(geometry.closeLabel.length>0&&geometry.closeLabel.every(rect=>rect.width>0&&rect.height>0&&inside(rect,geometry.close)),'The full Close label must fit its positive control.');assert.ok(geometry.measurements.some(item=>['fit','reflow'].includes(item.fit)),'At least one real Pretext measurement must succeed.');
    await screenshot(`word-count-${width}-${height}-${text}.png`);
  }
  await dismiss();await delay(850);await noCountWrites(htmlStart,htmlFiles);checks.push('Actual native frame/WebKit/Pretext keeps185-character path, readable body, expanded explanation, full count labels and Close within320px/200percent,wide-short and regrowth bounds.');

  await open(chapterPath); await execute('window.__wcPhase="late-before-newer-edit";window.__wcHoldNext=true;'); await wordCount(false);
  await until(() => execute('return !!window.__wcHeldCount&&window.__wcHeldCount.reply?.status==="ready"'), 'An actual native ready reply was not held after Rust.');
  const firstId = await execute('return window.__wcHeldCount.request.requestId;'); await dismiss(true); await execute('window.__wcHeldCount=null;window.__wcHoldWrites=true;window.__wcPhase="newer-user-edit";'); await append(' newer');
  await until(() => execute('return window.__wcHeldWrites.length>0'), 'Newer edit autosave did not reach its independent held dispatch.');
  const newerFiles = await snapshotFiles(), newerStart = await traceLength(); await wordCount(); assert.equal((await result()).prose,'6 words');
  const newerId = await execute('return window.__wcTrace.filter(item=>item.name==="word_count_typst_text").at(-1).request.requestId;'); assert.notEqual(newerId,firstId);
  await execute('window.__wcReleaseCount();return true;'); await delay(150); assert.equal((await result()).prose,'6 words'); await noCountWrites(newerStart,newerFiles); await dismiss();
  await execute('window.__wcHoldWrites=false;for(const release of window.__wcHeldWrites.splice(0))release();return true;'); await quiescent();
  await execute('window.__wcHoldNext=true;window.__wcHeldCount=null;'); await wordCount(false); await until(() => execute('return !!window.__wcHeldCount?.reply;'), 'Second native reply did not reach its real held boundary.'); await dismiss(true);
  await open(otherPath); const otherFiles=await snapshotFiles(),otherStart=await traceLength(); await wordCount(); const otherResult=await result(); assert.equal(otherResult.path,otherPath); assert.equal(otherResult.prose,'4 words');
  await execute('window.__wcReleaseCount();return true;'); await delay(150); assert.deepEqual(await result(),otherResult); await noCountWrites(otherStart,otherFiles); await dismiss();
  checks.push('Exact Rust replies held after analysis cannot repaint a newer dirty reopened snapshot or another file after Close/navigation; no fabricated analysis or automatic recount is used.');

  await open('large.typ'); const maxStart=await queryCount(),maxFiles=await snapshotFiles(),maxTrace=await traceLength(); await execute('window.__wcPhase="maximum-source";window.__wcHoldNext=true;window.__wcHeldCount=null;'); await wordCount(false);
  await until(() => execute('return window.__wcTrace.filter(item=>item.name==="word_count_typst_text").length>arguments[0]&&!!window.__wcHeldCount?.reply;',[maxStart]), 'The actual maximum-source Rust response was not held.',30000);
  const pending=await execute('return {counting:document.getElementById("word-count-status").textContent.startsWith("Counting"),hidden:document.getElementById("word-count-results").hidden,workers:window.__wcWorkerEvents.length};');assert.equal(pending.counting,true);assert.equal(pending.hidden,true);
  const closeStarted=Date.now(); await dismiss(true); evidence.maximumSourceCloseMs=Date.now()-closeStarted; assert.ok(evidence.maximumSourceCloseMs<1500);
  await execute('window.__wcReleaseCount();return true;');await delay(850);
  assert.deepEqual(await execute('return {closed:!document.getElementById("word-count-dialog").open,hidden:document.getElementById("word-count-results").hidden,workers:window.__wcWorkerEvents.length};'),{closed:true,hidden:true,workers:pending.workers});
  const maxReply=await execute('return window.__wcTrace.filter(item=>item.name==="word_count_typst_text").at(-1);'); assert.equal(maxReply.sourceBytes,maxBytes); assert.equal(maxReply.status,'ok'); assert.ok(['ready','unavailable'].includes(maxReply.reply.status)); await noCountWrites(maxTrace,maxFiles);
  checks.push('A real2MiB Rust reply held after analysis leaves controller counting; responsive Escape then genuine late completion keep it closed without result repaint or worker construction. Native CPU-in-flight responsiveness is not claimed.');

  if(denseEnabled){
    await open('dense.typ');const denseFiles=await snapshotFiles(),denseTrace=await traceLength(),priorQueries=await queryCount();
    await execute('window.__wcPhase="dense-completion-diagnostic";');const started=Date.now();await wordCount(false);
    await until(()=>execute('const visible=!document.getElementById("word-count-results").hidden,status=document.getElementById("word-count-status");return visible||(!status.hidden&&!status.textContent.startsWith("Counting"));'),'Dense source did not expose a terminal controller outcome under its unchanged15s deadline.',22000);
    const observedMs=Date.now()-started;
    const ui=await execute('const ready=!document.getElementById("word-count-results").hidden;return {ready,status:document.getElementById("word-count-status").textContent,prose:ready?document.getElementById("word-count-prose").textContent:null,source:ready?document.getElementById("word-count-source").textContent:null,reason:ready?document.getElementById("word-count-prose-reason").textContent:null,locale:ready?document.getElementById("word-count-locale").textContent:null};');
    await until(()=>execute('const queries=window.__wcTrace.filter(item=>item.name==="word_count_typst_text");return queries.length>arguments[0]&&queries.at(-1).reply;',[priorQueries]),'Dense native reply did not arrive within the observation window.',45000);
    const reply=await execute('return window.__wcTrace.filter(item=>item.name==="word_count_typst_text").at(-1);');
    assert.equal(reply.sourceBytes,maxBytes);assert.equal(hash(reply.request.source),hash(dense));assert.equal(reply.reply.requestId,reply.request.requestId);assert.equal(reply.reply.method,'typst-literal-v1');assert.equal(reply.status,'ok');assert.equal(reply.reply.status,'ready');
    evidence.denseCompletion={enabled:true,uiOutcome:ui.ready?'ready':'unavailable',ui,controllerObservedMs:observedMs,nativeRoundTripMs:reply.finished-reply.started,requestId:reply.request.requestId,sourceBytes:maxBytes,sourceSha256:hash(dense),literalSha256:hash(reply.reply.literalText),expectedProseWords:denseRepetitions,expectedSourceWords:denseRepetitions*2,needsReview:!ui.ready,productDeadlineMs:15000,scope:'Observed actual captured native/IPC/WebKit/controller/segmentation outcome; no development-probe timing inference or changed performance threshold.'};
    if(ui.ready){const locale=ui.locale.replace('Word segmentation locale: ','');assert.equal(ui.prose,`${denseRepetitions.toLocaleString(locale)} words`);assert.equal(ui.source,`${(denseRepetitions*2).toLocaleString(locale)} words`);}
    else assert.ok(ui.status,'An unavailable diagnostic must retain its actual finite controller message.');
    await noCountWrites(denseTrace,denseFiles);await screenshot('word-count-dense-diagnostic.png');await dismiss();
    console.log(`Dense completion diagnostic: ${evidence.denseCompletion.uiOutcome}; actual native and controller observations retained.`);
  }

  const oldOwner=await execute('return window.__wcOwner;'); assert.match(oldOwner,/^[a-f0-9-]{36}$/);
  const badField=await execute('return window.__TAURI_INTERNALS__.invoke("word_count_typst_text",{request:{ownerId:arguments[0],requestId:crypto.randomUUID(),source:"local words",path:"forbidden.typ"}}).then(()=>({accepted:true}),e=>({accepted:false,code:e?.code||null,message:e?.message||String(e)}));',[oldOwner]);
  assert.equal(badField.accepted,false); assert.match(badField.message,/unknown field|invalid args|unexpected|deserialize/i);
  evidence.strictRequest={extraPathFieldRejected:true,code:badField.code};
  const connectBefore=await execute('return window.__wcTrace.filter(item=>item.name==="editor_connect").length;');
  const raceFiles=await snapshotFiles(),raceStart=await traceLength();await execute('window.__wcPhase="native-post-analysis-owner";window.__wcCountTimerStart=window.__wcTimerEvents.length;');
  const ownerRace=await execute(`return (async()=>{
    const ownerId=arguments[0],source=arguments[1],invoke=(name,args)=>window.__TAURI_INTERNALS__.invoke(name,args),firstId=crypto.randomUUID();let settled=false;
    const first=invoke('word_count_typst_text',{request:{ownerId,requestId:firstId,source}}).then(result=>({accepted:true,result}),e=>({accepted:false,code:e?.code||null})).finally(()=>{settled=true;});
    await new Promise(resolve=>setTimeout(resolve,50));const probes=[];let busy;
    for(let i=0;i<20&&!settled;i++){const requestId=crypto.randomUUID();const probe=await invoke('word_count_typst_text',{request:{ownerId,requestId,source:'tiny probe'}}).then(()=>({accepted:true}),e=>({accepted:false,code:e?.code||null}));probes.push({requestId,...probe});if(probe.code==='busy'){busy=probe;break;}await new Promise(resolve=>setTimeout(resolve,10));}
    if(!busy)return {admitted:false,firstId,probes,first:await first};
    const replacement=await invoke('editor_connect',{});return {admitted:true,firstId,probes,replacementOwner:replacement.ownerId,first:await first};
  })();`,[oldOwner,dense]);
  assert.equal(ownerRace.admitted,true,'Fixture needs a genuine tiny busy response proving dense admission before owner rotation; otherwise no post-check claim.');assert.notEqual(ownerRace.replacementOwner,oldOwner);assert.deepEqual(ownerRace.first,{accepted:false,code:'stale_session'});await noCountWrites(raceStart,raceFiles);
  evidence.postAnalysisOwner={positiveBusy:true,firstRequestId:ownerRace.firstId,probes:ownerRace.probes,originalOutcome:ownerRace.first,replacementOwnerSha256:hash(ownerRace.replacementOwner)};
  const stale=await execute('return window.__TAURI_INTERNALS__.invoke("word_count_typst_text",{request:{ownerId:arguments[0],requestId:crypto.randomUUID(),source:"local words"}}).then(()=>({accepted:true}),e=>({accepted:false,code:e?.code||null}));',[oldOwner]); assert.deepEqual(stale,{accepted:false,code:'stale_session'});
  await open(otherPath);const retiredFiles=await snapshotFiles(),retiredStart=await traceLength();await wordCount(); const retired=await result(); assert.equal(retired.prose,'Unavailable'); assert.equal(retired.source,'4 words'); assert.equal(await execute('return window.__wcTrace.filter(item=>item.name==="editor_connect").length;'),connectBefore+1);await noCountWrites(retiredStart,retiredFiles);await dismiss();
  checks.push('Real dense native admission plus an actual tiny busy response precedes owner rotation; the first call then returns stale_session, and extra-field/start-owner denials plus UI source fallback never reconnect or write.');
  assert.equal(await execute('return window.__wcFallback'),false); assert.deepEqual(await execute('return window.__wcObservationErrors'),[]); assert.deepEqual(await execute('return window.__wcErrors'),[]);
  const genuineWorkers=await execute('return window.__wcWorkerEvents;');assert.ok(genuineWorkers.length>0&&genuineWorkers.every(item=>item.native===true));
  const successfulReplies=await execute('return window.__wcTrace.filter(item=>item.name==="word_count_typst_text"&&item.status==="ok");');
  for(const item of successfulReplies){assert.equal(item.reply.requestId,item.request.requestId);assert.equal(item.reply.method,'typst-literal-v1');if(item.reply.status==='ready')assert.ok(Buffer.byteLength(item.reply.literalText,'utf8')<=maxBytes);else assert.ok(['incomplete_syntax','literal_limit'].includes(item.reply.reasonCode));}
  assert.equal(Number(native('xdotool',['getwindowpid',nativeWindow])),nativePid,'All assertions must belong to the same original disposable native process.');
  evidence.state='passed'; evidence.sameNativePid=nativePid; evidence.ownerScope='Exact opaque owners and supplied text are retained only in mode0600 private provenance; public receipt contains hashes.';
  console.log(`Native Word count: ${checks.length} checks passed; evidence in ${artifacts}.`);
} catch(error) {
  failure=error;evidence.state='failed';evidence.error=error.message;
  if(session){evidence.frontendErrors=await execute('return window.__wcErrors||[]').catch(()=>[]);evidence.dom=await result().catch(()=>null);await screenshot('native-word-count-failure.png').catch(()=>{});}throw error;
} finally {
  if(session)try{
    const trace=await execute('return window.__wcTrace||[]').catch(()=>[]), timers=await execute('return window.__wcTimerEvents||[]').catch(()=>[]);
    const privateBytes=Buffer.from(JSON.stringify({trace,timers},null,2)+'\n');
    if(privateBytes.length<=12*1024*1024){await mkdir(artifacts,{recursive:true});const file=join(artifacts,'private-provenance.json');await writeFile(file,privateBytes,{mode:0o600});await chmod(file,0o600);evidence.privateProvenanceSha256=hash(privateBytes);}
    else throw Error('Native trace exceeded its12MiB fixture bound.');
    evidence.analysis=trace.filter(item=>item.name==='word_count_typst_text').map(item=>({requestId:item.request?.requestId,ownerSha256:item.request?.ownerId?hash(item.request.ownerId):null,sourceSha256:typeof item.request?.source==='string'?hash(item.request.source):null,sourceBytes:item.sourceBytes,status:item.status,method:item.reply?.method,analysisStatus:item.reply?.status,errorCode:item.reply?.code,reasonCode:item.reply?.reasonCode,literalSha256:typeof item.reply?.literalText==='string'?hash(item.reply.literalText):null,phase:item.phase,started:item.started,finished:item.finished}));
    evidence.timerCauses=timers;evidence.fallback=await execute('return window.__wcFallback').catch(()=>null);
  }catch(error){evidence.provenanceError=error.message;evidence.state='failed';failure ||= error;}
  // Never click local Close/Save during cleanup; pending user edits belong only to this disposable PID.
  if(nativePid)try{process.kill(nativePid,'SIGTERM');}catch{}
  if(session)await command('',undefined,'DELETE').catch(()=>{});
  for(const processChild of [...processes].reverse())if(processChild.pid)try{process.kill(-processChild.pid,'SIGTERM');}catch{}
  await delay(200);for(const processChild of processes)if(processChild.exitCode===null&&processChild.pid)try{process.kill(-processChild.pid,'SIGKILL');}catch{}
  evidence.log=log;evidence.completedAt=new Date().toISOString();evidence.failure=!!failure;
  await mkdir(artifacts,{recursive:true});await writeFile(join(artifacts,'native-word-count-evidence.json'),JSON.stringify(evidence,null,2)+'\n');await rm(fixture,{recursive:true,force:true});
  if(failure)throw failure;
}
