import { confirmNativeContextShare } from './context-fixture.mjs';
// Real packaged Tauri -> native IPC -> Rust MCP -> renderer -> native window controls.
// Requires Linux WebKitGTK/WebDriver, Xvfb, xfwm4, xdotool and wmctrl. zrok alone is simulated.
import assert from 'node:assert/strict';
import { createZrokFixture } from './zrok-fixture.mjs';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { nativeFixtureContextScript } from './native-fixture-context.mjs';

assert.equal(process.platform, 'linux');
assert.notEqual(process.getuid(), 0, 'The failed-autosave proof requires a regular user.');
const binary = resolve(process.env.UNDERTREE_DESKTOP || 'target/debug/undertree-desktop');
const artifacts = resolve(process.env.UNDERTREE_NATIVE_APP_ARTIFACTS || 'artifacts/native-app-controls');
const readOverlap=process.env.UNDERTREE_NATIVE_APP_READ_OVERLAP==='1';
const fixture = await mkdtemp(join(tmpdir(), 'undertree-native-app-'));
const project = join(fixture, 'project'), data = join(fixture, 'data');
const state = join(data, 'io.github.georgefejer91.UnderTree', 'review');
const source = join(project, 'main.typ'), policy = source + '.undertree-review.json';
const targetFile = join(fixture, 'target');
const processes = [], checks = [], secrets = [];
let session, driverUrl, displayEnv, nativeWindow, nativePid, log = '';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const evidence = { verifiedAt:new Date().toISOString(), application:binary, binarySha256:hash(await readFile(binary)), assertions:checks, qualification:'Actual native Tauri IPC, real Rust MCP, native renderer acknowledgements and X11 window state; fake zrok child only.', limitations:'No public ChatGPT/zrok account or route, other platform, system installation or signing.', display:'Private Xvfb display and disposable XDG state; existing desktop windows are untouched.' };
function child(command, args, env = {}) {
  const processChild = spawn(command, args, {env:{...process.env,...env},detached:true,stdio:['ignore','pipe','pipe']});
  processes.push(processChild);
  processChild.on('error', error => {log=(log+'\n'+error.message).slice(-32_000);});
  processChild.stderr.on('data', bytes => {log=(log+bytes).slice(-32_000);});
  return processChild;
}
async function until(check, message, timeout=20_000) {
  const deadline=Date.now()+timeout; let lastError;
  while(Date.now()<deadline){try{const value=await check();if(value)return value;}catch(error){lastError=error;}await delay(50);}
  throw Error(`${message}${lastError?`: ${lastError.message}`:''}`);
}
async function freePort(){const server=createServer();await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;}
function native(command,args){const result=spawnSync(command,args,{env:{...process.env,...displayEnv},encoding:'utf8',timeout:5000});assert.equal(result.status,0,`${command}: ${result.stderr}`);return result.stdout.trim();}
async function request(path,body,method='POST'){
  const response=await fetch(driverUrl+path,{method,headers:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(30_000)});
  const result=await response.json();if(result.value?.error)throw Error(`${result.value.error}: ${result.value.message}`);assert.ok(response.ok);return result.value;
}
const command=(path,body,method)=>request(`/session/${session}${path}`,body,method);
const execute=(script,args=[])=>command('/execute/sync',{script,args});
const find=async selector=>(await command('/element',{using:'css selector',value:selector}))['element-6066-11e4-a52e-4f735466cecf'];
const click=async selector=>command(`/element/${await find(selector)}/click`,{});
const review=operation=>execute('return window.__TAURI_INTERNALS__.invoke("review_action",{ownerId:window.__nativeFixtureContext.owner(),operation:arguments[0]});',[operation]);
const windowState=()=>native('xprop',['-id',nativeWindow,'WM_STATE']);
async function screenshot(name){const encoded=await command('/screenshot',undefined,'GET');await writeFile(join(artifacts,name),Buffer.from(encoded,'base64'));}
try{
  await stat(binary);await mkdir(project);await mkdir(state,{recursive:true});await mkdir(artifacts,{recursive:true});
  const original='= Native App controls\n\nThe saved manuscript stays unchanged.\n';await writeFile(source,original);
  await writeFile(join(state,'projects.json'),JSON.stringify({projects:[{id:'11111111-1111-4111-8111-111111111111',name:'Native App controls',root:project,repository:'',autoSync:false,pending:[],pendingRevisions:{}}]}));
  const zrokFixture = await createZrokFixture(fixture, targetFile, 'native-app.example.invalid');
  const xvfb=child(process.env.UNDERTREE_XVFB||'Xvfb',['-displayfd','1','-screen','0','1600x1000x24','-nolisten','tcp']);let display='';xvfb.stdout.on('data',bytes=>{display+=bytes;});
  await until(()=>display.trim()&&xvfb.exitCode===null,'Private Xvfb did not start.');
  displayEnv = { ...zrokFixture.environment, DISPLAY:`:${display.trim()}`,XDG_DATA_HOME:data,XDG_CONFIG_HOME:join(fixture,'config'),XDG_CACHE_HOME:join(fixture,'cache'),SESSION_MANAGER:'',UNDERTREE_ZROK: zrokFixture.executable};
  const wm=child(process.env.UNDERTREE_XFWM||'xfwm4',['--replace'],displayEnv);await until(()=>wm.exitCode===null&&native('xprop',['-root','_NET_SUPPORTING_WM_CHECK']).includes('window id'),'Private window manager did not start.');
  const port=await freePort(),nativePort=await freePort();driverUrl=`http://127.0.0.1:${port}`;
  const driver=child(process.env.UNDERTREE_TAURI_DRIVER||'tauri-driver',['--port',String(port),'--native-port',String(nativePort),'--native-host','127.0.0.1'],displayEnv);driver.stdout.on('data',bytes=>{log=(log+bytes).slice(-32_000);});
  await until(async()=>driver.exitCode===null&&await request('/status',undefined,'GET'),'Native WebDriver did not start.');
  const opened=await request('/session',{capabilities:{alwaysMatch:{'tauri:options':{application:binary}}}});session=opened.sessionId;evidence.webDriverCapabilities=opened.capabilities;
  await until(()=>execute('return !!document.querySelector(arguments[0])',['.file-button[data-path="main.typ"]']),'Native inventory did not render.');
  nativeWindow=native('xdotool',['search','--onlyvisible','--name','^UnderTree$']).split('\n')[0];nativePid=Number(native('xdotool',['getwindowpid',nativeWindow]));
  await execute(nativeFixtureContextScript);
  assert.equal(await execute(`
    window.__nativeAppErrors=[];
    addEventListener('error',event=>window.__nativeAppErrors.push(event.message));
    addEventListener('unhandledrejection',event=>window.__nativeAppErrors.push(event.reason?.message||String(event.reason)));
    window.__nativeAppSaveAttempts=0;
    window.__nativeAppLastSaveAttempt=performance.now();
    window.__nativeAppObservedCommands=[];
    window.__nativeAppObservationErrors=[];
    window.__nativeAppFallback=false;
    const originalFetch=window.fetch,originalWarn=console.warn;
    const observed=(input,init,...rest)=>{
      let observedName,observedPayload;
      try{
        const url=new URL(typeof input==='string'?input:input.url);
        if(url.protocol==='ipc:'||url.hostname==='ipc.localhost'){
          const name=decodeURIComponent(url.pathname.slice(1));
          window.__nativeAppObservedCommands.push(name);
          const body=typeof init?.body==='string'?init.body:new TextDecoder().decode(init?.body);
          const payload=JSON.parse(body);observedName=name;observedPayload=payload;
          if((name==='review_action'&&payload.operation?.action==='save')||(name==='editor_operation'&&payload.operation?.action==='editor_commit')){window.__nativeAppSaveAttempts++;window.__nativeAppLastSaveAttempt=performance.now();}
        }
      }catch{window.__nativeAppObservationErrors.push('Unsupported IPC observation body.');}
      const response=Reflect.apply(originalFetch,window,[input,init,...rest]);
      window.__nativeFixtureContext.observe(observedName,observedPayload,response);
      if(observedName==='review_action'&&observedPayload?.operation?.action==='review'&&window.__probeHoldReview)return response.then(async value=>{window.__probeReviewHeld=true;await new Promise(resolve=>window.__probeReleaseReview=resolve);return value;});
      if(observedName==='plugin:window|unminimize'&&window.__nativeAppReadOverlapEnabled)return response.then(async value=>{window.__probeHoldReview=true;document.getElementById('review-refresh').click();const deadline=performance.now()+5000;while(!window.__probeReviewHeld){if(performance.now()>deadline)throw Error('The real safe Review read did not reach its held response.');await new Promise(resolve=>setTimeout(resolve,10));}return value;});
      return response;
    };
    console.warn=(...args)=>{if(args.some(value=>String(value).includes('IPC custom protocol failed')))window.__nativeAppFallback=true;return Reflect.apply(originalWarn,console,args);};
    window.fetch=observed;
    return window.fetch===observed;
  `),true,'Passive IPC observation is installed without replacing native dispatch.');
  await until(()=>execute('return window.__nativeFixtureContext.status().ownerObserved;'),'A genuine successful native UI request did not reveal its existing page owner.');
  await execute('window.__nativeAppReadOverlapEnabled=arguments[0];',[readOverlap]);
  await click('.file-button[data-path="main.typ"]');await until(()=>execute('return document.querySelector(".cm-content")?.textContent.includes("The saved manuscript stays unchanged.")'),'Manuscript did not open.');
  await click('#menu-format-toggle');await click('#palette-open');await click('#palette-form button[type="submit"]');
  await until(()=>stat(policy),'The native policy setup did not persist its default color rules.');
  await until(()=>execute('return !document.getElementById("palette-dialog").open'),'The native policy save did not finish.');
  await click('#review-toggle');await click('#manuscript-share'); await confirmNativeContextShare(click, execute, until);await until(async()=>(await review({action:'open',project:'11111111-1111-4111-8111-111111111111',path:'main.typ'})).shared===true,'Actual native UI did not share the manuscript.');
  await click('#connection-open');await execute('document.getElementById("zrok-name").value="native-app-test";document.getElementById("zrok-origin").value="https://native-app.example.invalid";');await click('#tunnel-start');
  await until(async()=>(await review({action:'connection'})).running,'The isolated fake-zrok tunnel did not start.');
  await click('#connection-tab-app');assert.equal(await execute('return document.getElementById("connection-app-enabled").checked'),false);
  await until(()=>execute('return !document.getElementById("connection-app-enabled").disabled'),'The actual App grant UI is unavailable.');await click('#connection-app-enabled');
  let connection;await until(async()=>{connection=await review({action:'connection'});return connection.appControls?.enabled;},'The actual native UI did not enable App controls.');
  const appUrl=connection.appControls.endpoint,reviewUrl=connection.endpoint;for(const url of[appUrl,reviewUrl]){secrets.push(url,new URL(url).pathname,new URL(url).pathname.split('/').pop());}
  assert.ok(appUrl&&reviewUrl&&appUrl!==reviewUrl,'Review and App grants have separate private capabilities.');
  assert.equal(await execute('return document.getElementById("connection-app-url").value===arguments[0]',[appUrl]),true);
  const target=await readFile(targetFile,'utf8'),appEndpoint=target+new URL(appUrl).pathname,reviewEndpoint=target+new URL(reviewUrl).pathname;
  const headers={'Content-Type':'application/json',Accept:'application/json, text/event-stream','MCP-Protocol-Version':'2025-06-18'};
  async function rpc(endpoint,method,params={}){const response=await fetch(endpoint,{method:'POST',headers,body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(10_000)});assert.equal(response.status,200,`${method} HTTP status`);const result=await response.json();assert.equal(result.error,undefined);return result.result;}
  for(const endpoint of[reviewEndpoint,appEndpoint])await rpc(endpoint,'initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'UnderTree native App qualification',version:'1'}});
  const reviewTools=(await rpc(reviewEndpoint,'tools/list')).tools.map(tool=>tool.name);assert.deepEqual(reviewTools,['list_manuscripts','read_manuscript','suggest_text','highlight_text']);
  const appTools=(await rpc(appEndpoint,'tools/list')).tools.map(tool=>tool.name);for(const forbidden of['save','save_editor','replace_source','suggest_text','set_policy','accept','sync'])assert.equal(appTools.includes(forbidden),false,forbidden);
  checks.push('Actual native UI explicitly enables a separate App capability; the Review catalogue retains its closed Review tools and App exposes no source-save/policy tools.');
  const safeMessage=reply=>{let message=reply.content?.map(item=>item.text||'').join(' ')||'';for(const secret of secrets.filter(Boolean))message=message.replaceAll(secret,'[redacted]');return message;};
  const tool=async(name,args={})=>{const reply=await rpc(appEndpoint,'tools/call',{name,arguments:args});if(reply.isError)evidence.lastToolFailure={name,message:safeMessage(reply)};return reply;};
  const value=reply=>{assert.equal(reply.isError,false,safeMessage(reply));return reply.structuredContent.result;};
  await until(async()=>{const reply=await tool('get_workspace');if(reply.isError)throw Error(safeMessage(reply));return reply.structuredContent.result.workspace?.activeDocumentId;},'The real native App workspace did not attach before the first effect.');
  async function settled(name,args,id,allowBusyRejection=false){
    const reply=await tool(name,{...args,requestId:id});
    if(reply.isError&&allowBusyRejection){
      const message=reply.content?.map(item=>item.text||'').join(' ')||'';
      assert.match(message,/local buffers/i,'Dirty Close is rejected for its live buffer state.');
      return{state:'rejected',layer:'mcp_validation',message};
    }
    let receipt=value(reply);
    await until(async()=>{receipt=value(await tool('get_control_result',{requestId:id}));return !['queued','dispatched'].includes(receipt.state);},`Native ${name} was not acknowledged.`);
    evidence.lastControlReceipt={name,...receipt};
    return receipt;
  }
  await click('#connection-dialog [data-close]');const sourceBefore=hash(await readFile(source)),policyBefore=hash(await readFile(policy));
  const view=await settled('set_workspace_view',{reviewVisible:false},'native-safe-view');assert.equal(view.state,'applied');assert.equal(await execute('return document.querySelector(".review-workspace").dataset.reviewOpen'),'false');
  assert.equal(hash(await readFile(source)),sourceBefore);assert.equal(hash(await readFile(policy)),policyBefore);
  checks.push('Real MCP App view command reaches native control_operation, receives a renderer acknowledgement and changes the displayed pane without changing source or policy.');
  const minimized=await settled('set_window_state',{state:'minimize'},'native-minimize');assert.equal(minimized.state,'applied');assert.equal(minimized.result.applied,true);await until(()=>windowState().includes('Iconic'),'MCP acknowledged minimize without an iconic native window.');
  const restored=await settled('set_window_state',{state:'restore'},'native-restore');assert.equal(restored.state,'applied');assert.equal(restored.result.applied,true);await until(()=>windowState().includes('Normal'),'MCP acknowledged restore without a normal native window.');
  if(readOverlap){
    assert.equal(await execute('return window.__probeReviewHeld===true'),true);
    assert.equal(await execute('return window.__nativeAppSaveAttempts'),0);
    assert.equal(hash(await readFile(source)),sourceBefore);assert.equal(hash(await readFile(policy)),policyBefore);
    await execute('window.__probeHoldReview=false;window.__probeReleaseReview();return true;');
    evidence.readOverlap={heldDuringRestore:true,saveIpcDelta:0};
    checks.push('A real native Review response stays pending across unminimize and final Restore acknowledgement without blocking Restore or saving source.');
  }
  const focused=await settled('set_window_state',{state:'focus'},'native-focus');assert.equal(focused.state,'applied');assert.equal(focused.result.applied,true);await until(()=>Number(native('xprop',['-root','_NET_ACTIVE_WINDOW']).match(/0x[0-9a-f]+/i)?.[0])===Number(nativeWindow),'MCP acknowledged focus without X11 active-window focus.');
  checks.push('Real MCP minimize/restore/focus receipts agree with native GTK window properties and independent X11 window-manager state.');
  await screenshot('native-app-controls.png');
  await chmod(project,0o555);await click('.cm-content');native('xdotool',['windowactivate','--sync',nativeWindow,'key','--clearmodifiers','ctrl+End']);native('xdotool',['type','--clearmodifiers','--delay','3','Local dirty buffer stays unsaved.']);
  await until(()=>execute('return document.getElementById("save-label").textContent==="Unsaved changes"&&document.getElementById("review-status").classList.contains("error")'),'The deliberately denied local autosave did not settle.');
  await until(()=>execute('return window.__nativeAppSaveAttempts>0&&performance.now()-window.__nativeAppLastSaveAttempt>1100&&document.getElementById("save-label").textContent==="Unsaved changes"&&!document.getElementById("typst-compile").textContent.includes("Compiling")'),'Ordinary autosave and automatic compile did not become quiescent while writes were denied.');
  assert.equal(hash(await readFile(source)),sourceBefore);await chmod(project,0o755);
  // Both ordinary timers have settled under denial. Writable disk now exposes any remote-triggered save.
  const savesBefore=await execute('return window.__nativeAppSaveAttempts');assert.ok(savesBefore>0,'The passive observer captured the deliberately failed real autosave.');assert.equal(await execute('return window.__nativeAppObservedCommands.includes(\"control_operation\")'),true);const deniedClose=await settled('set_window_state',{state:'close'},'native-dirty-close',true);assert.equal(deniedClose.state,'rejected');if(deniedClose.layer!=='mcp_validation')assert.equal(deniedClose.code,'busy');
  assert.equal(await execute('return window.__nativeAppSaveAttempts'),savesBefore,'Remote Close must never invoke a source save or registered-editor commit.');
  assert.ok(windowState().includes('Normal'));assert.equal(await execute('return document.querySelector(".cm-content").textContent.includes("Local dirty buffer stays unsaved.")'),true);assert.equal(await execute('return document.getElementById("save-label").textContent'),'Unsaved changes');assert.equal(hash(await readFile(source)),sourceBefore);assert.equal(hash(await readFile(policy)),policyBefore);
  checks.push('A dirty native buffer rejects remote Close before any save IPC or window closure, with writable disk, source/policy hashes and the unsaved buffer preserved.');
  await click('#connection-open');await click('#connection-tab-app');await until(()=>execute('return !document.getElementById("connection-app-enabled").disabled'),'The revoke control is unavailable.');await click('#connection-app-enabled');await until(async()=>!(await review({action:'connection'})).appControls.enabled,'Native App grant did not revoke.');
  const revoked=await fetch(appEndpoint,{method:'POST',headers,body:JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/list'}),signal:AbortSignal.timeout(5000)});assert.equal(revoked.status,401);assert.deepEqual((await rpc(reviewEndpoint,'tools/list')).tools.map(tool=>tool.name),reviewTools);
  assert.equal(await execute('return window.__nativeAppSaveAttempts'),savesBefore);assert.equal(hash(await readFile(source)),sourceBefore);assert.equal(hash(await readFile(policy)),policyBefore);assert.deepEqual(await execute('return window.__nativeAppErrors'),[]);assert.deepEqual(await execute('return window.__nativeAppObservationErrors'),[]);assert.equal(await execute('return window.__nativeAppFallback'),false,'No IPC fallback may bypass passive save observation.');
  checks.push('Actual native UI revocation denies the former App capability while Review remains available, with no source/policy changes or hidden save.');
  evidence.result='passed';evidence.sourceSha256=sourceBefore;evidence.policySha256=policyBefore;evidence.windowAcknowledgements={minimize:minimized.result,restore:restored.result,focus:focused.result};evidence.remoteClose={state:deniedClose.state,code:deniedClose.code,layer:deniedClose.layer||'renderer_acknowledgement',saveIpcDelta:0};
  console.log(`Native MCP App controls passed: ${checks.length} real native/MCP/window checks; evidence in ${artifacts}. zrok simulated; public route untested.`);
}catch(error){evidence.result='failed';evidence.error=error.message;if(nativeWindow)try{evidence.x11WindowState=windowState();}catch{}if(session){evidence.frontendErrors=await execute('return window.__nativeAppErrors||[]').catch(()=>[]);evidence.dom=await execute('return {ready:document.readyState,saveLabel:document.getElementById("save-label")?.textContent,status:document.getElementById("review-status")?.textContent,reviewOpen:document.querySelector(".review-workspace")?.dataset.reviewOpen,appEnabled:document.getElementById("connection-app-enabled")?.checked,observedCommands:window.__nativeAppObservedCommands?.slice(-12),observationErrors:window.__nativeAppObservationErrors};').catch(()=>null);await screenshot('native-app-failure.png').catch(()=>{});}throw error;}
finally{
  await chmod(project,0o755).catch(()=>{});
  if(session)await review({action:'tunnel',enabled:false,reservation:'',public_url:''}).catch(()=>{});
  // Kill only this disposable application's PID; cleanup must not turn the deliberate dirty buffer into a local Close/save action.
  if(nativePid)try{process.kill(nativePid,'SIGTERM');}catch{}
  if(session)await command('',undefined,'DELETE').catch(()=>{});
  for(const processChild of [...processes].reverse())if(processChild.pid)try{process.kill(-processChild.pid,'SIGTERM');}catch{}
  await delay(200);for(const processChild of processes)if(processChild.exitCode===null&&processChild.pid)try{process.kill(-processChild.pid,'SIGKILL');}catch{}
  for(const secret of secrets.filter(Boolean))log=log.replaceAll(secret,'[redacted]');evidence.log=log;await mkdir(artifacts,{recursive:true});await writeFile(join(artifacts,'native-app-evidence.json'),JSON.stringify(evidence,null,2)+'\n');await rm(fixture,{recursive:true,force:true});
}
