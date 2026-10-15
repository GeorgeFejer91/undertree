// Focused actual Linux Tauri/WebKit compiler-diagnostics gate; run only on a matching capture.
// Reuses the native source/session harness and passive IPC context. No source navigation authority.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { nativeFixtureContextScript } from './native-fixture-context.mjs';

assert.equal(process.platform, 'linux');
assert.equal(process.env.UNDERTREE_NATIVE_DIAGNOSTICS_LAUNCH, '1', 'Root must assign a matching immutable candidate and native lane.');
for (const name of ['UNDERTREE_DESKTOP','UNDERTREE_REVIEW_CLI','UNDERTREE_NATIVE_DIAGNOSTICS_MANIFEST','UNDERTREE_TYPST']) assert.ok(process.env[name], `Supply ${name}; this gate never builds or falls back to live targets.`);
for (const name of ['UNDERTREE_EXPECTED_DESKTOP_SHA256','UNDERTREE_EXPECTED_CLI_SHA256','UNDERTREE_EXPECTED_MANIFEST_SHA256']) assert.match(process.env[name] || '', /^[a-f0-9]{64}$/);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const binary = await realpath(resolve(process.env.UNDERTREE_DESKTOP)), cli = await realpath(resolve(process.env.UNDERTREE_REVIEW_CLI)), typst = await realpath(resolve(process.env.UNDERTREE_TYPST));
const manifestPath = resolve(process.env.UNDERTREE_NATIVE_DIAGNOSTICS_MANIFEST), manifestBytes = await readFile(manifestPath), manifest = JSON.parse(manifestBytes);
const candidate = await realpath(manifest.root), artifacts = resolve(process.env.UNDERTREE_NATIVE_DIAGNOSTICS_ARTIFACTS || 'artifacts/native-diagnostics');
assert.ok(artifacts !== candidate && !artifacts.startsWith(candidate + sep), 'Evidence must not mutate captured inputs.');
const selected = { desktop:process.env.UNDERTREE_EXPECTED_DESKTOP_SHA256, cli:process.env.UNDERTREE_EXPECTED_CLI_SHA256, manifest:process.env.UNDERTREE_EXPECTED_MANIFEST_SHA256, typst:hash(await readFile(typst)) };
// The two established immutable-capture formats differ only in the asset key prefix.
const assetHashes = manifest.assets || Object.fromEntries(Object.entries(manifest.dist || {}).map(([path,value])=>['dist/'+path,value]));
assert.ok(Object.keys(manifest.hashes || {}).length && Object.keys(assetHashes).length, 'Supply the source/asset inventory, not only binary hashes.');
async function verifyInputs() {
  for (const [path,expected] of [[binary,selected.desktop],[cli,selected.cli],[manifestPath,selected.manifest],[typst,selected.typst]]) assert.equal(hash(await readFile(path)),expected,`Selected input changed: ${path}`);
  for (const [path,expected] of Object.entries({ ...manifest.hashes, ...assetHashes })) {
    assert.ok(!path.startsWith('/') && !path.split('/').some(part=>['.','..',''].includes(part)));
    assert.equal(hash(await readFile(join(candidate,path))),expected,`Captured source/asset changed: ${path}`);
  }
}
await verifyInputs();
const fixture = await mkdtemp(join(tmpdir(),'undertree-native-diagnostics-')), projectRoot = join(fixture,'project'), data = join(fixture,'data');
const state = join(data,'io.github.georgefejer91.UnderTree','review'), registryPath = join(state,'projects.json'), descriptorPath = join(state,'cli','instance.json');
const project = randomUUID(), chapterPath = 'chapters/Unicode-雪-'+'unbroken-context-'.repeat(7)+'chapter.typ';
const source = join(projectRoot,'main.typ'), chapter = join(projectRoot,chapterPath), policy = chapter+'.undertree-review.json';
const mainSource = '#include "'+chapterPath+'"\n';
const initial = '= Included chapter\n\nPréface 😀 雪 works here.\n';
const broken = initial.slice(0,-1)+' #diagnostics_native_missing_symbol\n';
const qualifiedTypst = '29273eaa04f6d00edd0c2bec578f565fc9c65be856bfbffc894567c68ed0b237';
assert.equal(selected.typst,qualifiedTypst,'Use the direct pinned Typst executable; a wrapper cannot qualify diagnostic locations.');
const processes = [], nativePids = [], checks = [], privateTrace = [], secrets = new Set(), cliRuns = [];
let session, driverUrl, displayEnv, nativeWindow, nativePid, descriptor, log='', phase='setup', expectedRoot, failureSnapshot;
const delay = ms => new Promise(resolve=>setTimeout(resolve,ms));
const uuid = value => assert.match(value,/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
const evidence = { state:'not-run', runnerSha256:hash(await readFile(new URL(import.meta.url))), selected, assertions:checks, cliRuns,
  scope:'Actual version1 compile success/included Unicode failure, provenance/offsets, active clean Inspect pure read, held late Review and readable bounded native presentation.',
  limitations:'Linux WebKit only; no physical OS IME, exhaustive dirty/hash/epoch fault matrix, CPU-inflight performance, alternate compiler profile, live source/root rotation, system install/signing or other platforms.' };
function child(executable,args,env={}) {
  const value=spawn(executable,args,{cwd:fixture,env:{...process.env,...env},detached:true,stdio:['ignore','pipe','pipe']});processes.push(value);
  value.on('error',error=>{log=(log+'\n'+error.message).slice(-32000);});for(const stream of[value.stdout,value.stderr])stream.on('data',bytes=>{log=(log+bytes).slice(-32000);});return value;
}
async function until(check,message,timeout=20000) {
  const deadline=Date.now()+timeout;let last;
  while(Date.now()<deadline){try{const value=await check();if(value)return value;}catch(error){last=error;}await delay(50);}throw Error(message+(last?': '+last.message:''));
}
async function freePort(){const server=createServer();await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;}
function native(executable,args){const value=spawnSync(executable,args.map(String),{env:{...process.env,...displayEnv},encoding:'utf8',timeout:5000});assert.equal(value.status,0,`${executable}: ${value.stderr}`);return value.stdout.trim();}
async function request(path,body,method='POST') {
  const response=await fetch(driverUrl+path,{method,headers:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(30000)});
  const value=await response.json();if(typeof value.value?.error==='string')throw Error(`${value.value.error}: ${value.value.message}`);assert.ok(response.ok);return value.value;
}
const command=(path,body,method)=>request(`/session/${session}${path}`,body,method), execute=(script,args=[])=>command('/execute/sync',{script,args});
async function find(selector){return(await command('/element',{using:'css selector',value:selector}))['element-6066-11e4-a52e-4f735466cecf'];}
async function click(selector){const summary=await execute('return document.querySelector(arguments[0])?.closest("details:not([open])")?.querySelector(":scope > summary")||null;',[selector]);if(summary)await command(`/element/${summary['element-6066-11e4-a52e-4f735466cecf']}/click`,{});return command(`/element/${await find(selector)}/click`,{});}
const review=operation=>execute('return window.__TAURI_INTERNALS__.invoke("review_action",{ownerId:window.__nativeFixtureContext.owner(),operation:arguments[0]});',[operation]);
const trace=()=>execute('return window.__diagnosticsTrace;');
const liveText=()=>execute('return [...document.querySelectorAll("#manuscript-source .cm-line")].map(n=>n.textContent).join("\\n");');
async function screenshot(name){await writeFile(join(artifacts,name),Buffer.from(await command('/screenshot',undefined,'GET'),'base64'));}
async function snapshot(directory,prefix='') {
  const rows={};for(const entry of(await readdir(directory,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){const path=join(directory,entry.name),key=prefix+entry.name,info=await stat(path);assert.ok(entry.isFile()||entry.isDirectory());if(entry.isDirectory())Object.assign(rows,await snapshot(path,key+'/'));else rows[key]={sha256:hash(await readFile(path)),bytes:info.size,mode:info.mode&0o777,mtimeMs:info.mtimeMs};}return rows;
}
const diskSnapshot=async()=>({project:await snapshot(projectRoot),state:await snapshot(state)});
async function quiescent(){await until(()=>execute('return window.__diagnosticsInFlight===0&&window.__diagnosticsTimers.size===0&&!document.getElementById("typst-compile").textContent.includes("Compiling");'),'Ordinary editor/compiler activity did not settle.',60000);}
async function open(path,epoch){
  const selector=`.file-button[data-path="${path}"]`;await until(()=>execute('return !!document.querySelector(arguments[0]);',[selector]),'Source row is absent.');assert.equal(await execute('return document.querySelector(arguments[0]).dataset.sourceEpoch;',[selector]),String(epoch));
  // Reuse the source-epoch fixture's bounded, real no-effect Open admission handling.
  for(let attempt=0;attempt<5;attempt++){
    const start=(await trace()).length;await click(selector);
    const outcome=await until(()=>execute('if(document.querySelector(arguments[1])?.getAttribute("aria-current")==="true"&&document.querySelector("#manuscript-tabs [aria-selected=true]")?.textContent===arguments[0]&&!!document.querySelector("#manuscript-source .cm-content"))return {opened:true};const call=window.__diagnosticsTrace.slice(arguments[2]).find(item=>item.operation?.action==="open"&&item.operation.path===arguments[0]);return call?.finished&&call.status==="error"?{opened:false,error:call.error}:false;',[path,selector,start]),'Native Open did not mount or reach a typed terminal refusal.');
    if(outcome.opened)return;assert.equal(outcome.error?.code,'busy');assert.equal(outcome.error?.message,'A local document operation is running. Retry this action.');await quiescent();
  }
  throw Error('Native Open stayed busy after finite observed-admission retries.');
}
function cliEnvelope(args){const env={...process.env,UNDERTREE_REVIEW_STATE:state};delete env.UNDERTREE_REVIEW_ENDPOINT;delete env.UNDERTREE_REVIEW_TOKEN;const value=spawnSync(cli,args,{env,encoding:'utf8',timeout:35000,maxBuffer:4*1024*1024});cliRuns.push({command:args[0],exit:value.status});assert.equal(value.stdout.includes(descriptor.token),false);return{process:value,value:JSON.parse(value.stdout)};}
function runCli(args){const result=cliEnvelope(args);assert.equal(result.process.status,0,result.process.stderr);assert.equal(result.value.ok,true,result.value.error?.message);return result.value.result;}
async function startDesktop(label) {
  phase=label;const opened=await request('/session',{capabilities:{alwaysMatch:{'tauri:options':{application:binary}}}});session=opened.sessionId;assert.equal(opened.capabilities.browserName,'wry');assert.equal(opened.capabilities.platformName,'linux');
  await until(()=>execute('return !!window.__TAURI_INTERNALS__&&!!document.querySelector(".file-button");'),'Native inventory did not load.');nativeWindow=native('xdotool',['search','--onlyvisible','--name','^UnderTree$']).split('\n')[0];nativePid=Number(native('xdotool',['getwindowpid',nativeWindow]));nativePids.push(nativePid);assert.equal(await realpath(`/proc/${nativePid}/exe`),binary);assert.ok((await readFile(`/proc/${nativePid}/environ`,'utf8')).split('\0').includes('XDG_DATA_HOME='+data));await command('/window/rect',{width:1440,height:900});
  await execute(nativeFixtureContextScript);
  await execute(`
    window.__diagnosticsTrace=[];window.__diagnosticsErrors=[];window.__diagnosticsTimers=new Set();window.__diagnosticsInFlight=0;window.__diagnosticsWorkers=0;window.__diagnosticsPhase='setup';window.__diagnosticsHoldReview=false;window.__diagnosticsFallback=false;
    addEventListener('error',e=>window.__diagnosticsErrors.push(e.message));addEventListener('unhandledrejection',e=>window.__diagnosticsErrors.push(e.reason?.message||String(e.reason)));
    const originalFetch=window.fetch,originalTimeout=window.setTimeout,originalClear=window.clearTimeout,originalWarn=console.warn,NativeWorker=window.Worker;
    window.Worker=new Proxy(NativeWorker,{construct(target,args){window.__diagnosticsWorkers++;return Reflect.construct(target,args);}});
    window.setTimeout=(fn,ms,...args)=>{if(typeof fn==='function'&&[450,700].includes(ms)){let id;id=Reflect.apply(originalTimeout,window,[(...values)=>{window.__diagnosticsTimers.delete(id);return Reflect.apply(fn,window,values);},ms,...args]);window.__diagnosticsTimers.add(id);return id;}return Reflect.apply(originalTimeout,window,[fn,ms,...args]);};
    window.clearTimeout=id=>{window.__diagnosticsTimers.delete(id);return Reflect.apply(originalClear,window,[id]);};
    window.fetch=(input,init,...rest)=>{let name,payload;try{const url=new URL(typeof input==='string'?input:input.url);if(url.protocol==='ipc:'||url.hostname==='ipc.localhost'){name=decodeURIComponent(url.pathname.slice(1));payload=JSON.parse(typeof init?.body==='string'?init.body:new TextDecoder().decode(init.body));}}catch{window.__diagnosticsErrors.push('Undecodable native IPC observation.');}
      const entry=name&&payload?{name,payload,operation:payload.operation,query:payload.query,phase:window.__diagnosticsPhase,started:performance.now()}:null;
      if(entry){if(window.__diagnosticsTrace.length>=4096)throw Error('Diagnostics observation bound exceeded.');window.__diagnosticsTrace.push(entry);window.__diagnosticsInFlight++;}
      const response=Reflect.apply(originalFetch,window,[input,init,...rest]);window.__nativeFixtureContext.observe(name,payload,response);
      return response.then(async value=>{if(entry){window.__diagnosticsInFlight--;entry.finished=performance.now();entry.status=value.headers.get('Tauri-Response');const body=await value.clone().json();if(entry.status==='error')entry.error=typeof body==='string'?{message:body}:body;else entry.reply=body;
        if(name==='review_action'&&payload.operation.action==='review'&&payload.operation.path===window.__diagnosticsChapter&&Object.hasOwn(payload.operation,'expectedRoot')&&payload.operation.sourceEpoch===7&&window.__diagnosticsHoldReview){window.__diagnosticsHoldReview=false;window.__diagnosticsHeld=entry;await new Promise(resolve=>window.__diagnosticsRelease=resolve);window.__diagnosticsHeldReleased=true;}}
        return value;},error=>{if(entry){window.__diagnosticsInFlight--;entry.error={message:String(error)};}throw error;});};
    console.warn=(...args)=>{if(args.some(value=>String(value).includes('IPC custom protocol failed')))window.__diagnosticsFallback=true;return Reflect.apply(originalWarn,console,args);};
  `);
  await until(()=>execute('return window.__nativeFixtureContext.status().ownerObserved;'),'No successful genuine UI owner observation.');descriptor=await until(async()=>JSON.parse(await readFile(descriptorPath,'utf8')),'Native CLI discovery did not appear.');secrets.add(descriptor.token);assert.equal((await stat(descriptorPath)).mode&0o077,0);assert.equal(runCli(['capabilities']).instanceId,descriptor.instanceId);
}
async function stopDesktop(){await quiescent();assert.equal(await execute('return window.__diagnosticsFallback;'),false);assert.deepEqual(await execute('return window.__diagnosticsErrors;'),[]);privateTrace.push({phase,entries:await trace()});await click('#window-close').catch(error=>{if(!/no such window|invalid session id|unknown error/i.test(error.message))throw error;});await until(async()=>{try{return /^State:\s+Z/m.test(await readFile(`/proc/${nativePid}/status`,'utf8'));}catch(error){return error.code==='ENOENT';}},'Owned clean native window did not stop.');await command('',undefined,'DELETE').catch(()=>{});session=undefined;await until(async()=>{try{await stat(`/proc/${nativePid}`);return false;}catch(error){return error.code==='ENOENT';}},'Stopped native PID was not reaped.');nativePid=undefined;await until(async()=>{try{await stat(descriptorPath);return false;}catch(error){return error.code==='ENOENT';}},'Native descriptor was not revoked.');}

// shortcut: the owned fixture has four short lines, so every source line is rendered.
const caret = () => execute(`
  const content=document.querySelector('#manuscript-source .cm-content'),selection=getSelection();
  function offset(node,position){if(!node||!content?.contains(node))return null;const line=(node.nodeType===1?node:node.parentElement).closest('.cm-line');if(!line)return null;const lines=[...content.querySelectorAll('.cm-line')],index=lines.indexOf(line);if(index<0)return null;const range=document.createRange();range.setStart(line,0);range.setEnd(node,position);return lines.slice(0,index).reduce((sum,line)=>sum+line.textContent.length+1,0)+range.toString().length;}
  return {anchor:offset(selection?.anchorNode,selection?.anchorOffset),focus:offset(selection?.focusNode,selection?.focusOffset),collapsed:selection?.isCollapsed,focused:content?.contains(document.activeElement),source:[...content.querySelectorAll('.cm-line')].map(line=>line.textContent).join('\\n'),scrollTop:document.querySelector('#manuscript-source .cm-scroller')?.scrollTop,scrollLeft:document.querySelector('#manuscript-source .cm-scroller')?.scrollLeft};
`);
const clickElement = element => { assert.ok(element?.['element-6066-11e4-a52e-4f735466cecf'],'The actual native element must exist.');return command(`/element/${element['element-6066-11e4-a52e-4f735466cecf']}/click`,{}); };
async function logs(show=true){if(await execute('return !document.getElementById("compile-log").hidden;')!==show)await click('#compile-log-toggle');await until(()=>execute('return document.getElementById("compile-log").hidden!==arguments[0];',[show]),'Local compilation log visibility did not match the requested state.');}
async function clickInspect(index){const element=await execute('return [...document.querySelectorAll("#compile-diagnostics .compile-diagnostic")][arguments[0]]&&[...[...document.querySelectorAll("#compile-diagnostics .compile-diagnostic")][arguments[0]].querySelectorAll("button")].find(button=>/^Inspect line [0-9]+$/.test(button.textContent)&&!button.disabled)||null;',[index]);return clickElement(element);}
async function pureSince(start,before){
  await quiescent();assert.deepEqual(await diskSnapshot(),before,'Inspect/presentation must not alter saved source/policy/PDF/private state.');
  const calls=(await trace()).slice(start),effects=calls.filter(item=>item.name==='review_action'&&!['review','pdf','connection','projects','capabilities','git_status','shared','project_tree'].includes(item.operation?.action)||item.name==='editor_operation'&&['editor_register','editor_commit'].includes(item.operation?.action));
  assert.deepEqual(effects,[],'No implicit native Open/Save/Register/compile/sync or source effect.');
}
function assertEnvelope(item,status){
  assert.equal(item.name,'review_action');assert.equal(item.status,'ok');assert.equal(item.payload.compileDiagnosticsVersion,1);
  assert.equal(item.operation.action,'compile');assert.equal(item.operation.project,project);assert.equal(item.operation.path,'main.typ');assert.equal(item.operation.sourceEpoch,2);assert.deepEqual(item.operation.expectedRoot,expectedRoot);assert.equal(item.operation.revision,hash(mainSource));
  const reply=item.reply;assert.equal(reply.compileDiagnosticsVersion,1);assert.equal(reply.status,status);const report=reply.report;
  assert.equal(report.captureComplete,true);assert.equal(report.truncated,false);assert.ok(report.rows.length<=128&&report.sourceCandidates.length<=128);assert.ok(Buffer.byteLength(JSON.stringify(report))<=128*1024);
  const provenance=report.provenance;assert.equal(provenance.project,project);assert.deepEqual(provenance.expectedRoot,expectedRoot);assert.equal(provenance.path,'main.typ');assert.equal(provenance.sourceEpoch,2);assert.equal(provenance.sourceDigest,hash(mainSource));assert.equal(provenance.mainRevision,hash(mainSource));uuid(provenance.nativeBuildId);assert.equal(provenance.instanceId,descriptor.instanceId);
  assert.equal(JSON.stringify(report).includes(projectRoot),false);assert.equal(JSON.stringify(report).includes(state),false);
  if(status==='succeeded'){assert.equal(reply.preview.available,true);assert.equal(reply.preview.sourceEpoch,2);assert.deepEqual(reply.preview.expectedRoot,expectedRoot);assert.equal(reply.preview.revision,hash(mainSource));assert.equal(reply.preview.current,true);assert.equal(Object.hasOwn(reply,'error'),false);}
  else{assert.equal(Object.hasOwn(reply,'preview'),false);assert.equal(reply.error.code,'typst');}
  return report;
}
async function capturePdfView(){await until(()=>execute('return document.querySelector("#typst-pages canvas")?.width>0;'),'The last-good PDF did not finish its ordinary file-navigation reload.');await execute('window.__diagnosticsCanvas=document.querySelector("#typst-pages canvas");window.__diagnosticsWorkersBeforeFailure=window.__diagnosticsWorkers;');}
async function compile(status){
  await quiescent();const start=(await trace()).length;await click('#typst-compile');
  await until(()=>execute('const call=window.__diagnosticsTrace.slice(arguments[0]).find(item=>item.operation?.action==="compile");return call?.finished&&call.reply?.compileDiagnosticsVersion===1&&!document.getElementById("typst-compile").textContent.includes("Compiling")&&document.getElementById("compile-report-status").textContent.includes("Compiler locations are untrusted suggestions");',[start]),'The actual version1 compile report did not reach its native/UI terminal state.',60000);
  await quiescent();const calls=(await trace()).slice(start).filter(item=>item.operation?.action==='compile');assert.equal(calls.length,1,'One explicit local build has one actual Compile request.');assertEnvelope(calls[0],status);return calls[0];
}
function candidateRow(item){
  const rows=item.reply.report.rows,index=rows.findIndex(row=>row.severity==='error'&&row.locationCandidate?.projectPath===chapterPath&&row.message.includes('diagnostics_native_missing_symbol'));assert.ok(index>=0,'The real pinned compiler must identify the included Unicode source.');
  const point=rows[index].locationCandidate,expectedOffset=broken.indexOf('diagnostics_native_missing_symbol'),prefix=broken.slice(0,expectedOffset),lastNewline=prefix.lastIndexOf('\n');
  assert.equal(point.sourceDigest,hash(broken));assert.equal(point.byteOffset,Buffer.byteLength(prefix));assert.equal(point.utf16Offset,expectedOffset);assert.equal(point.line1,prefix.split('\n').length);assert.equal(point.columnScalar0,[...prefix.slice(lastNewline+1)].length);
  assert.notEqual(point.byteOffset,point.utf16Offset,'The real Unicode fixture distinguishes UTF-8 bytes from UTF-16 editor positions.');
  assert.ok(item.reply.report.sourceCandidates.some(source=>source.projectPath===chapterPath&&source.sourceDigest===hash(broken)&&source.sourceEpoch===7));return{index,point};
}
async function localStart(){await click('#manuscript-source .cm-content');native('xdotool',['windowactivate','--sync',nativeWindow,'key','--clearmodifiers','ctrl+Home']);await until(async()=>{const value=await caret();return value.anchor===0&&value.focus===0&&value.collapsed&&value.focused;},'The real native caret did not reach the source start.');}
async function viewport(width,height){
  const outer=await command('/window/rect',undefined,'GET'),inner=await execute('return {width:innerWidth,height:innerHeight};');
  await command('/window/rect',{width:outer.width+width-inner.width,height:outer.height+height-inner.height});
  await until(()=>execute('return innerWidth===arguments[0]&&innerHeight===arguments[1];',[width,height]),'The actual native viewport did not reach the bounded requested dimensions.');
}
async function fullValue(index,kind){
  const selector=kind==='location'?`#compile-diagnostics .compile-diagnostic:nth-child(${index+1}) [data-text-details="Compiler location candidate"]`:'#compile-report-status';
  await until(()=>execute('return ["fit","reflow","details"].includes(document.querySelector(arguments[0])?.dataset.textFit);',[selector]),'The actual Pretext observer did not measure the diagnostic text.');
  const value=await execute('const source=document.querySelector(arguments[0]),box=source.getBoundingClientRect(),button=source.closest(".text-details-slot")?.querySelector(".text-details-button");return {text:source.textContent,fit:source.dataset.textFit,width:source.clientWidth,height:source.clientHeight,scrollWidth:source.scrollWidth,scrollHeight:source.scrollHeight,box:box.toJSON(),details:!!button&&!button.hidden};',[selector]);
  if(value.fit==='details'){
    assert.equal(value.details,true);await clickElement(await execute('return document.querySelector(arguments[0]).closest(".text-details-slot").querySelector(".text-details-button");',[selector]));
    await until(()=>execute('return !!document.querySelector(".text-details-dialog[open]");'),'The ordinary full-value action did not open its native-rendered dialog.');
    const dialog=await execute('const dialog=document.querySelector(".text-details-dialog[open]"),message=dialog.querySelector(".text-details-message");return {text:message.textContent,width:dialog.clientWidth,scrollWidth:dialog.scrollWidth,box:dialog.getBoundingClientRect().toJSON()};');assert.equal(dialog.text,value.text);assert.ok(dialog.scrollWidth<=dialog.width+2);assert.ok(dialog.box.left>=-1&&dialog.box.right<=widthNow+1);
    await click('.text-details-dialog[open] > button');
  }else{assert.ok(value.scrollWidth<=value.width+2);assert.ok(value.scrollHeight<=value.height+2);}
  if(kind==='location')assert.ok(value.text.startsWith(chapterPath+' · line '));return value;
}
let widthNow=1440;
try {
  evidence.state='running';await mkdir(join(projectRoot,'chapters'),{recursive:true});await mkdir(state,{recursive:true});await mkdir(artifacts,{recursive:true});await writeFile(source,mainSource);await writeFile(chapter,initial);
  await writeFile(registryPath,JSON.stringify({projects:[{id:project,name:'Native compiler diagnostics',root:projectRoot,mainDocument:'main.typ',repository:'',autoSync:false,pending:[],pendingRevisions:{}}],sourceEpochs:{[project]:{'main.typ':2,[chapterPath]:7}}}));
  const xvfb=child(process.env.UNDERTREE_XVFB||'Xvfb',['-displayfd','1','-screen','0','1600x1000x24','-nolisten','tcp','-noreset']);let display='';xvfb.stdout.on('data',bytes=>{display+=bytes;});await until(()=>display.trim()&&xvfb.exitCode===null,'Private Xvfb did not start.');
  displayEnv={DISPLAY:':'+display.trim(),XDG_DATA_HOME:data,XDG_CONFIG_HOME:join(fixture,'config'),XDG_CACHE_HOME:join(fixture,'cache'),SESSION_MANAGER:'',UNDERTREE_TYPST:typst};
  const wm=child(process.env.UNDERTREE_XFWM||'xfwm4',['--replace'],displayEnv);await until(()=>wm.exitCode===null&&native('xprop',['-root','_NET_SUPPORTING_WM_CHECK']).includes('window id'),'Private window manager did not start.');const port=await freePort(),nativePort=await freePort();driverUrl='http://127.0.0.1:'+port;const driver=child(process.env.UNDERTREE_TAURI_DRIVER||'tauri-driver',['--port',String(port),'--native-port',String(nativePort),'--native-host','127.0.0.1'],displayEnv);await until(async()=>driver.exitCode===null&&await request('/status',undefined,'GET'),'Native driver did not start.');
  await startDesktop('diagnostics');await execute('window.__diagnosticsChapter=arguments[0];',[chapterPath]);await open('main.typ',2);await quiescent();expectedRoot=await execute('return window.__nativeFixtureContext.root(arguments[0]);',[project]);const originalOwner=await execute('return window.__nativeFixtureContext.owner();');secrets.add(originalOwner);
  const good=await compile('succeeded');await until(()=>execute('return document.querySelector("#typst-pages canvas")?.width>0&&document.getElementById("typst-preview-status").dataset.state==="current";'),'A successful real Typst native build did not render a current PDF.');const pdf=await review({action:'pdf',project,path:'main.typ'});assert.equal(pdf.available,true);assert.equal(pdf.current,true);assert.equal(pdf.sourceEpoch,2);const pdfSha=hash(Buffer.from(pdf.base64,'base64'));assert.equal(hash(Buffer.from(good.reply.preview.base64,'base64')),pdfSha);await execute('window.__diagnosticsCanvas=document.querySelector("#typst-pages canvas");window.__diagnosticsWorkersBeforeFailure=window.__diagnosticsWorkers;');
  checks.push('Direct SHA-pinned Typst produces one genuine native version1 successful report and current rendered PDF with exact main2/root/revision/instance provenance.');

  await open(chapterPath,7);await click('#manuscript-source .cm-content');native('xdotool',['windowactivate','--sync',nativeWindow,'key','--clearmodifiers','ctrl+End','BackSpace']);native('xdotool',['type','--clearmodifiers','--delay','3',' #diagnostics_native_missing_symbol']);native('xdotool',['key','--clearmodifiers','Return']);await until(async()=>(await liveText())===broken,'Ordinary native keys did not create the exact Unicode-included error source.');await click('#manuscript-save');await until(async()=>(await readFile(chapter,'utf8'))===broken&&await execute('return document.getElementById("save-label").textContent==="Saved locally";'),'The intentional local edit did not save exactly.');await quiescent();await open('main.typ',2);await capturePdfView();const failedOther=await compile('failed'),otherRow=candidateRow(failedOther);await logs(true);
  const guidance=await execute('const row=document.querySelectorAll("#compile-diagnostics .compile-diagnostic")[arguments[0]];return {inspect:[...row.querySelectorAll("button")].filter(button=>/^Inspect line [0-9]+$/.test(button.textContent)).length,guidance:[...row.querySelectorAll("p")].some(node=>node.textContent==="Open this file locally and recompile to inspect its location.")};',[otherRow.index]);assert.deepEqual(guidance,{inspect:0,guidance:true});let before=await diskSnapshot(),start=(await trace()).length;await clickElement(await execute('return [...document.querySelectorAll("#compile-diagnostics .compile-diagnostic")[arguments[0]].querySelectorAll("p")].find(node=>node.textContent==="Open this file locally and recompile to inspect its location.");',[otherRow.index]));await pureSince(start,before);assert.equal(await liveText(),mainSource);const kept=await review({action:'pdf',project,path:'main.typ'});assert.equal(kept.available,true);assert.equal(kept.current,false);assert.equal(hash(Buffer.from(kept.base64,'base64')),pdfSha);assert.equal(await execute('return window.__diagnosticsCanvas===document.querySelector("#typst-pages canvas")&&window.__diagnosticsCanvas.isConnected&&window.__diagnosticsWorkers===window.__diagnosticsWorkersBeforeFailure;'),true);
  checks.push('A genuine included Unicode error has exact staged digest/epoch7/scalar/byte/UTF16 offsets; other-file guidance cannot open/save a source and the original last-good PDF/canvas survives.');

  await open(chapterPath,7);assert.equal(await execute('return [...document.querySelectorAll("#compile-diagnostics button")].filter(button=>/^Inspect line [0-9]+$/.test(button.textContent)&&!button.disabled).length;'),0,'Local navigation cannot retain an enabled old report action.');await logs(false);await capturePdfView();const failedActive=await compile('failed'),activeRow=candidateRow(failedActive);assert.equal(await execute('return window.__diagnosticsCanvas===document.querySelector("#typst-pages canvas")&&window.__diagnosticsCanvas.isConnected&&window.__diagnosticsWorkers===window.__diagnosticsWorkersBeforeFailure;'),true);await logs(true);await localStart();await quiescent();before=await diskSnapshot();start=(await trace()).length;await clickInspect(activeRow.index);await until(async()=>{const value=await caret();return value.anchor===activeRow.point.utf16Offset&&value.focus===activeRow.point.utf16Offset&&value.collapsed&&value.focused;},'The actual local Inspect did not select the verified native Unicode location.');await pureSince(start,before);
  const selectedReads=(await trace()).slice(start).filter(item=>item.operation?.action==='review'&&Object.hasOwn(item.operation,'expectedRoot'));assert.equal(selectedReads.length,1);const selectedRead=selectedReads[0];assert.equal(selectedRead.status,'ok');assert.equal(selectedRead.payload.ownerId,originalOwner);assert.deepEqual(selectedRead.operation,{action:'review',project,path:chapterPath,sourceEpoch:7,expectedRoot});assert.equal(selectedRead.reply.content,broken);assert.equal(selectedRead.reply.sourceEpoch,7);assert.deepEqual(selectedRead.reply.expectedRoot,expectedRoot);assert.equal(selectedRead.reply.review.revision,hash(broken));assert.equal(await liveText(),broken);evidence.selectedLocation=activeRow.point;
  checks.push('An already active clean candidate Inspect performs exactly one same-owner/root/epoch7 pure Review and changes only the real native caret/scroll to the verified UTF16 offset, with no Open/Save/Register/compile/sync.');

  await quiescent();const priorCaret=await caret();assert.equal(priorCaret.anchor,activeRow.point.utf16Offset);assert.equal(priorCaret.focus,activeRow.point.utf16Offset);assert.ok(priorCaret.anchor>0);before=await diskSnapshot();start=(await trace()).length;await execute('window.__diagnosticsHoldReview=true;');await clickInspect(activeRow.index);await until(()=>execute('return window.__diagnosticsHeld?.status==="ok"&&window.__diagnosticsHeld.reply?.content===arguments[0];',[broken]),'The actual Inspect Review response did not reach its post-Rust hold.');assert.deepEqual(await execute('return window.__diagnosticsHeld.operation;'),{action:'review',project,path:chapterPath,sourceEpoch:7,expectedRoot});assert.equal((await caret()).anchor,priorCaret.anchor);assert.equal((await caret()).focus,priorCaret.focus);await localStart();assert.notEqual((await caret()).anchor,priorCaret.anchor);await logs(false);const newerStatus=await execute('return document.getElementById("review-status").textContent;');await execute('window.__diagnosticsRelease();return true;');await until(()=>execute('return window.__diagnosticsHeldReleased===true;'),'The genuine held Review response was not released.');await execute('return new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))));');assert.equal((await caret()).anchor,0);assert.equal((await caret()).focus,0);assert.equal(await execute('return document.getElementById("compile-log").hidden;'),true);assert.equal(await execute('return document.getElementById("review-status").textContent;'),newerStatus);await pureSince(start,before);assert.equal((await trace()).slice(start).filter(item=>item.operation?.action==='review'&&Object.hasOwn(item.operation,'expectedRoot')).length,1);await logs(true);await screenshot('native-diagnostics-held-review.png');
  checks.push('A real post-Rust Inspect Review held across a newer actual caret move and local Hide log action cannot override caret/visibility/status, write metadata, or replay a read/effect.');

  before=await diskSnapshot();start=(await trace()).length;evidence.geometry=[];
  for(const[width,height,text]of[[1440,900,14],[1100,480,28],[320,740,14],[320,740,28],[1440,900,14]]){
    widthNow=width;await viewport(width,height);await execute('document.documentElement.style.fontSize=arguments[0]+"px";',[text]);if(width<=900)await click('.mobile-views button[data-view="preview"]');await logs(true);
    const location=await fullValue(activeRow.index,'location'),note=await fullValue(activeRow.index,'status');const geometry=await execute('const log=document.getElementById("compile-log"),box=log.getBoundingClientRect(),style=getComputedStyle(log);return {innerWidth,innerHeight,font:parseFloat(getComputedStyle(document.documentElement).fontSize),pageWidth:document.documentElement.scrollWidth,log:box.toJSON(),logClientHeight:log.clientHeight,logReadableHeight:parseFloat(style.lineHeight)+parseFloat(style.paddingTop)+parseFloat(style.paddingBottom),textFits:[...document.querySelectorAll("#compile-log [data-text-fit]")].map(node=>node.dataset.textFit)};');assert.equal(geometry.font,text);assert.ok(geometry.pageWidth<=width+1);assert.ok(geometry.logClientHeight>=geometry.logReadableHeight);assert.ok(geometry.log.width>12&&geometry.log.height>12&&geometry.log.left>=-1&&geometry.log.right<=width+1&&geometry.log.top>=-1&&geometry.log.bottom<=height+1);assert.ok(geometry.textFits.some(value=>['fit','reflow','details'].includes(value)));evidence.geometry.push({width,height,text,geometry,location,note});await screenshot(`native-diagnostics-${width}-${height}-${text}.png`);
  }
  await pureSince(start,before);assert.equal(await readFile(source,'utf8'),mainSource);assert.equal(await readFile(chapter,'utf8'),broken);assert.equal(hash(Buffer.from((await review({action:'pdf',project,path:'main.typ'})).base64,'base64')),pdfSha);await stopDesktop();
  checks.push('Actual WebKit diagnostics remain finite/readable at exact320CSSpx,200%root text,short1100viewport and regrowth, using real Pretext/full-value routes without source/policy/PDF/compiler effects.');
  evidence.state='passed';evidence.project=project;evidence.expectedRoot=expectedRoot;evidence.chapterPath=chapterPath;evidence.lastGoodPdfSha256=pdfSha;evidence.sourceDigests={main:hash(mainSource),chapter:hash(broken)};
} catch(error){
  evidence.state='failed';evidence.error={name:error.name,message:error.message};failureSnapshot={inventory:await diskSnapshot().catch(()=>null),source:await readFile(source,'utf8').catch(()=>null),chapter:await readFile(chapter,'utf8').catch(()=>null),policy:await readFile(policy,'utf8').catch(()=>null),registry:await readFile(registryPath,'utf8').catch(()=>null)};
  if(session){evidence.frontendErrors=await execute('return window.__diagnosticsErrors||[];').catch(()=>[]);evidence.ui=await execute('return {tab:document.querySelector("#manuscript-tabs [aria-selected=true]")?.textContent,saved:document.getElementById("save-label")?.textContent,status:document.getElementById("review-status")?.textContent,report:document.getElementById("compile-report-status")?.textContent,logHidden:document.getElementById("compile-log")?.hidden};').catch(()=>null);await screenshot('native-diagnostics-failure.png').catch(()=>{});}throw error;
} finally {
  if(session){await execute('window.__diagnosticsRelease?.();return true;').catch(()=>{});privateTrace.push({phase,entries:await trace().catch(()=>[])});}
  if(nativePid){assert.equal(await realpath(`/proc/${nativePid}/exe`).catch(()=>binary),binary);const environment=await readFile(`/proc/${nativePid}/environ`,'utf8').catch(()=>'');if(environment){assert.ok(environment.split('\0').includes('XDG_DATA_HOME='+data));try{process.kill(nativePid,'SIGTERM');}catch{}}}
  if(session)await command('',undefined,'DELETE').catch(()=>{});for(const value of[...processes].reverse())if(value.pid&&value.exitCode===null&&value.signalCode===null)try{process.kill(-value.pid,'SIGTERM');}catch{}
  await until(()=>processes.every(value=>!value.pid||value.exitCode!==null||value.signalCode!==null),'Owned native helpers did not exit.',10000).catch(error=>{evidence.cleanupError=error.message;});for(const pid of nativePids){try{await stat(`/proc/${pid}`);evidence.cleanupError='An owned native PID remains after cleanup.';}catch(error){if(error.code!=='ENOENT')throw error;}}
  await verifyInputs();evidence.selectedInputsUnchanged=true;for(const secret of secrets)if(secret)log=log.replaceAll(secret,'[redacted]');evidence.log=log;await mkdir(artifacts,{recursive:true});await writeFile(join(artifacts,'native-diagnostics-private.json'),JSON.stringify({project,expectedRoot,trace:privateTrace,failureSnapshot},null,2)+'\n',{mode:0o600});await writeFile(join(artifacts,'native-diagnostics-evidence.json'),JSON.stringify(evidence,null,2)+'\n');await rm(fixture,{recursive:true,force:true});if(evidence.cleanupError)throw Error(evidence.cleanupError);
}
