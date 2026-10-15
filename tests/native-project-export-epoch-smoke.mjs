// Real packaged Tauri -> native IPC -> Rust MCP -> renderer -> native window controls.
// Requires Linux WebKitGTK/WebDriver, Xvfb, xfwm4, xdotool and wmctrl. zrok alone is simulated.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, readlink, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { nativeFixtureContextScript } from './native-fixture-context.mjs';

assert.equal(process.platform, 'linux');
assert.notEqual(process.getuid(), 0, 'The failed-autosave proof requires a regular user.');
const binary = resolve(process.env.UNDERTREE_DESKTOP || 'target/debug/undertree-desktop');
const artifacts = resolve(process.env.UNDERTREE_NATIVE_APP_ARTIFACTS || 'artifacts/native-project-export-epoch');
const readOverlap=process.env.UNDERTREE_NATIVE_APP_READ_OVERLAP==='1';
const fixture = await mkdtemp(join(tmpdir(), 'undertree-native-zip-'));
const project = join(fixture, 'project'), data = join(fixture, 'data');
const state = join(data, 'io.github.georgefejer91.UnderTree', 'review');
const source = join(project, 'main.typ'), policy = source + '.undertree-review.json';
const targetFile = join(fixture, 'target'), zrok = join(fixture, 'zrok-fixture');
const processes = [], checks = [], secrets = [];
let session, driverUrl, displayEnv, nativeWindow, nativePid, log = '';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const evidence = { verifiedAt:new Date().toISOString(), application:binary, binarySha256:hash(await readFile(binary)), assertions:checks, qualification:'Actual native Tauri IPC, real Rust MCP, native renderer acknowledgements and X11 window state; fake zrok child only.', limitations:'No public ChatGPT/zrok account or route, other platform, system installation or signing.', display:'Private Xvfb display and disposable XDG state; existing desktop windows are untouched.' };
function child(command, args, env = {}) {
  const processChild = spawn(command, args, {env:{...process.env,...env},cwd:fixture,detached:true,stdio:['ignore','pipe','pipe']});
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
  const original='= Native App controls\r\n\r\nThe saved manuscript stays unchanged. Café UTF-8.\r\n';await writeFile(source,original);
  await mkdir(join(project,'.settings'));await mkdir(join(project,'assets'));await mkdir(join(project,'empty'));await mkdir(join(project,'.git'));await mkdir(join(project,'build'));
  await writeFile(join(project,'.settings/input.txt'),Buffer.from([0,1,254,255]));await writeFile(join(project,'assets/diagram.bin'),Buffer.from([137,80,78,71,0,255,13,10]));await writeFile(join(project,'notes.html'),'<p>Saved HTML</p>\r\n');await writeFile(join(project,'notes.html.undertree-review.json'),Buffer.from([255,0,123,10]));await writeFile(join(project,'notes.html.import-report.json'),'opaque report bytes\r\n');await writeFile(join(project,'.git/qa-ignored'),'excluded');await writeFile(join(project,'build/qa-ignored'),'excluded');await chmod(join(project,'notes.html'),0o640);
  await writeFile(join(state,'projects.json'),JSON.stringify({projects:[{id:'11111111-1111-4111-8111-111111111111',name:'Native App controls',root:project,mainDocument:'main.typ',repository:'',autoSync:false,pending:[],pendingRevisions:{}}]}));
  await writeFile(zrok,`#!/bin/sh\nprintf '%s' "$3" > ${quote(targetFile)}\nexec sleep 300\n`);await chmod(zrok,0o700);
  const xvfb=child(process.env.UNDERTREE_XVFB||'Xvfb',['-displayfd','1','-screen','0','1600x1000x24','-nolisten','tcp']);let display='';xvfb.stdout.on('data',bytes=>{display+=bytes;});
  await until(()=>display.trim()&&xvfb.exitCode===null,'Private Xvfb did not start.');
  displayEnv={DISPLAY:`:${display.trim()}`,XDG_DATA_HOME:data,XDG_CONFIG_HOME:join(fixture,'config'),XDG_CACHE_HOME:join(fixture,'cache'),SESSION_MANAGER:'',UNDERTREE_ZROK:zrok};
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
    window.__nativeZipChooses=[];window.__nativeZipOperations=[];window.__nativeZipReplies=[];window.__nativeZipEffects=0;
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
          if(name==='choose_project_export_destination')window.__nativeZipLastOwner=payload.ownerId;
          if(name==='choose_project_export_destination')window.__nativeZipChooses.push({requestId:payload.requestId,exportId:payload.exportId});
          if(name==='project_export_operation')window.__nativeZipOperations.push(payload.operation);
          if(name==='review_action'&&['compile','open','set_main_document','accept'].includes(payload.operation?.action))window.__nativeZipEffects++;
          if((name==='review_action'&&payload.operation?.action==='save')||(name==='editor_operation'&&payload.operation?.action==='editor_commit')){window.__nativeAppSaveAttempts++;window.__nativeAppLastSaveAttempt=performance.now();}
        }
      }catch{window.__nativeAppObservationErrors.push('Unsupported IPC observation body.');}
      const response=Reflect.apply(originalFetch,window,[input,init,...rest]);
      window.__nativeFixtureContext.observe(observedName,observedPayload,response);
      if(observedName==='prepare_project_export')return response.then(async value=>{window.__nativeZipPrepared=await value.clone().json();return value;});
      if(observedName==='project_export_operation')return response.then(async value=>{window.__nativeZipReplies.push({operation:observedPayload.operation,reply:await value.clone().json()});return value;});
      if(observedName==='choose_project_export_destination')return response.then(async value=>{
        const reply=await value.clone().json();window.__nativeZipReplies.push({requestId:observedPayload.requestId,reply});
        if(window.__nativeZipHold){window.__nativeZipHeldReply=reply;window.__nativeZipHeld=true;await new Promise(resolve=>window.__nativeZipRelease=resolve);
          if(window.__nativeZipRejectAck){const bytes=await value.arrayBuffer(),headers=new Headers(value.headers);headers.set('Tauri-Response','error');window.__nativeZipAckFault={headerOnly:true,body:reply};return new Response(bytes,{status:value.status,statusText:value.statusText,headers});}}
        return value;
      });
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
  await click('#review-toggle');await click('#manuscript-share');await until(async()=>(await review({action:'open',project:'11111111-1111-4111-8111-111111111111',path:'main.typ'})).shared===true,'Actual native UI did not share the manuscript.');
  await click('#connection-open');await execute('document.getElementById("zrok-name").value="native-app-test";document.getElementById("zrok-origin").value="https://native-app.example.invalid";');await click('#tunnel-start');
  await until(async()=>(await review({action:'connection'})).running,'The isolated fake-zrok tunnel did not start.');
  await click('#connection-tab-app');assert.equal(await execute('return document.getElementById("connection-app-enabled").checked'),false);
  await until(()=>execute('return !document.getElementById("connection-app-enabled").disabled'),'The actual App grant UI is unavailable.');await click('#connection-app-enabled');
  let connection;await until(async()=>{connection=await review({action:'connection'});return connection.appControls?.enabled;},'The actual native UI did not enable App controls.');
  const appUrl=connection.appControls.endpoint,reviewUrl=connection.endpoint;for(const url of[appUrl,reviewUrl]){secrets.push(url,new URL(url).pathname,new URL(url).pathname.split('/').pop());}
  assert.ok(appUrl&&reviewUrl&&appUrl!==reviewUrl,'Review and App grants have separate private capabilities.');
  await until(()=>execute('return document.getElementById("connection-app-url").value===arguments[0]',[appUrl]),'The actual native App endpoint did not finish rendering.');
  const target=await readFile(targetFile,'utf8'),appEndpoint=target+new URL(appUrl).pathname,reviewEndpoint=target+new URL(reviewUrl).pathname;
  const headers={'Content-Type':'application/json',Accept:'application/json, text/event-stream','MCP-Protocol-Version':'2025-06-18'};
  async function rpc(endpoint,method,params={}){const response=await fetch(endpoint,{method:'POST',headers,body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(10_000)});assert.equal(response.status,200,`${method} HTTP status`);const result=await response.json();assert.equal(result.error,undefined);return result.result;}
  for(const endpoint of[reviewEndpoint,appEndpoint])await rpc(endpoint,'initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'UnderTree native App qualification',version:'1'}});
  const reviewTools=(await rpc(reviewEndpoint,'tools/list')).tools.map(tool=>tool.name);assert.deepEqual(reviewTools,['list_manuscripts','read_manuscript','suggest_text']);
  const appTools=(await rpc(appEndpoint,'tools/list')).tools.map(tool=>tool.name);for(const forbidden of['save','save_editor','replace_source','suggest_text','set_policy','accept','sync'])assert.equal(appTools.includes(forbidden),false,forbidden);
  checks.push('Actual native UI explicitly enables a separate App capability; the Review catalogue retains exactly its three suggestion tools and App exposes no source-save/policy tools.');
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
  await until(()=>execute('return !document.getElementById("typst-compile").textContent.includes("Compiling")'),'Initial compile did not settle.');
  assert.equal(await readlink(`/proc/${nativePid}/cwd`),fixture,'The actual native process cwd must be disposable before any OS Save.');
  const destination=join(fixture,'exports');await mkdir(destination);
  async function inputInventory(directory,prefix=''){
    const files=[];for(const name of(await readdir(directory)).sort()){
      if(['.git','build'].includes(name))continue;const path=join(directory,name),relative=[prefix,name].filter(Boolean).join('/'),info=await stat(path);
      if(info.isDirectory()){files.push({path:relative+'/',kind:'directory',mode:info.mode&0o777});files.push(...await inputInventory(path,relative));}
      else{const bytes=await readFile(path);files.push({path:relative,kind:'file',mode:info.mode&0o777,bytes:bytes.length,sha256:hash(bytes)});}
    }return files.sort((a,b)=>a.path.localeCompare(b.path));
  }
  const expected=await inputInventory(project);
  const baseline=await execute('return {saves:window.__nativeAppSaveAttempts,effects:window.__nativeZipEffects||0};');
  const checkOriginal=async()=>{assert.equal(hash(await readFile(source)),sourceBefore);assert.equal(hash(await readFile(policy)),policyBefore);assert.deepEqual(await inputInventory(project),expected);};
  const picker=()=>{const found=spawnSync('xdotool',['search','--onlyvisible','--name','^Export saved project$'],{env:{...process.env,...displayEnv},encoding:'utf8',timeout:5000});return found.status===0?found.stdout.trim().split('\n')[0]:null;};
  const openFile=async()=>{if(!await execute('return document.getElementById("menu-file").open'))await click('#menu-file-toggle');await until(()=>execute('return document.getElementById("menu-file").open'),'File menu did not open.');};
  async function startExport(){await openFile();await click('#menu-file [data-command="download-project"]');return until(picker,'Actual native Export saved project OS Save picker did not open.');}
  function privateScreenshot(name){native('/usr/bin/python3',['-c','import gi,sys;gi.require_version("Gdk","3.0");from gi.repository import Gdk;root=Gdk.get_default_root_window();Gdk.pixbuf_get_from_window(root,0,0,root.get_width(),root.get_height()).savev(sys.argv[1],"png",[],[])',join(artifacts,name)]);}
  async function selectDestination(window,path,{allowCollision=false}={}){
    assert.ok(path.startsWith(destination+'/'));assert.equal(await readlink(`/proc/${nativePid}/cwd`),fixture);
    native('xdotool',['windowactivate','--sync',window,'key','--clearmodifiers','ctrl+l']);await delay(300);native('xdotool',['key','--clearmodifiers','ctrl+a']);native('xdotool',['type','--clearmodifiers','--delay','3',path]);await delay(200);native('xdotool',['key','--clearmodifiers','ctrl+a','ctrl+c']);
    const actual=native('/usr/bin/python3',['-c','import gi;gi.require_version("Gtk","3.0");from gi.repository import Gtk,Gdk;print(Gtk.Clipboard.get(Gdk.SELECTION_CLIPBOARD).wait_for_text() or "",end="")']);
    assert.equal(actual,path,'The actual GTK location entry must contain the exact absolute private destination before Save.');
    const geometry=Object.fromEntries(native('xdotool',['getwindowgeometry','--shell',window]).split('\n').map(item=>item.split('=')));
    privateScreenshot(`native-save-${++evidence.savePickerScreenshots}.png`);
    // GTK's completion popover can consume the first pointer click. The verified
    // entry can now be activated safely; click Save only if that same dialog remains active.
    native('xdotool',['key','--clearmodifiers','Return']);await delay(200);
    if(picker()&&Number(native('xdotool',['getactivewindow']))===Number(window))native('xdotool',['mousemove','--window',window,String(Number(geometry.WIDTH)-55),String(Number(geometry.HEIGHT)-25),'click','1']);
    if(allowCollision){await delay(500);if(picker()){privateScreenshot('native-overwrite-confirmation.png');native('xdotool',['key','--clearmodifiers','alt+r']);}}
    await until(()=>!picker(),'Actual native OS Save picker did not close.');
  }
  async function inspectArchive(path,prepared){
    const bytes=await readFile(path);assert.equal(hash(bytes),prepared.sha256);assert.equal(bytes.length,prepared.bytes);
    const parsed=JSON.parse(native('/usr/bin/python3',['-c','import json,sys,zipfile,hashlib\nwith zipfile.ZipFile(sys.argv[1]) as z:\n print(json.dumps({"comment":json.loads(z.comment),"entries":[{"path":i.filename,"kind":"directory" if i.is_dir() else "file","mode":(i.external_attr>>16)&511,**({} if i.is_dir() else {"bytes":i.file_size,"sha256":hashlib.sha256(z.read(i)).hexdigest()})} for i in z.infolist()]}))',path]));
    assert.deepEqual(parsed.entries.sort((a,b)=>a.path.localeCompare(b.path)),expected);assert.equal(parsed.comment.kind,'undertree-saved-project');assert.equal(parsed.comment.schema,1);assert.equal(parsed.comment.mainDocument,'main.typ');assert.equal(parsed.comment.snapshotId,prepared.snapshotId);assert.equal(parsed.entries.length,prepared.entries);
    return{sha256:hash(bytes),bytes:bytes.length,entries:parsed.entries,comment:parsed.comment};
  }
  async function deniedClose(requestId){
    const reply=await tool('set_window_state',{state:'close',requestId});if(reply.isError){assert.match(safeMessage(reply),/busy|pending|local buffers/i);return{state:'rejected',layer:'mcp_validation'};}
    let receipt=value(reply);await until(async()=>{receipt=value(await tool('get_control_result',{requestId}));return !['queued','dispatched'].includes(receipt.state);},'Pending ZIP remote Close did not settle.');assert.equal(receipt.state,'rejected');assert.equal(receipt.code,'busy');return{state:receipt.state,code:receipt.code};
  }
  const exportStatus=()=>execute('return document.querySelector("#menu-file [data-project-export-status]").textContent');
  evidence.savePickerScreenshots=0;


  const window=await startExport(),old=await execute('return {owner:window.__nativeZipLastOwner,request:window.__nativeZipChooses.at(-1)};');assert.ok(old.owner);secrets.push(old.owner);
  const exported=join(destination,'retired-native-page.zip');
  await execute('location.reload();return true;').catch(error=>{if(!/execution context|document unloaded|navigation/i.test(error.message))throw error;});
  await until(()=>execute('return document.readyState==="complete"&&window.__nativeZipPrepared===undefined&&!!document.querySelector(".file-button");'),'Actual native page did not reload while its OS Save picker remained open.');
  await execute(nativeFixtureContextScript);
  await execute(`
    const originalFetch=window.fetch;
    window.fetch=(input,init,...rest)=>{
      let name,payload;
      try{const url=new URL(typeof input==='string'?input:input.url);if(url.protocol==='ipc:'||url.hostname==='ipc.localhost'){name=decodeURIComponent(url.pathname.slice(1));payload=JSON.parse(typeof init?.body==='string'?init.body:new TextDecoder().decode(init?.body));}}catch{}
      const response=Reflect.apply(originalFetch,window,[input,init,...rest]);window.__nativeFixtureContext.observe(name,payload,response);return response;
    };
  `);
  await until(()=>execute('return window.__nativeFixtureContext.status().ownerObserved;'),'The new page did not expose its own successful genuine UI owner request.');
  assert.ok(picker(),'The original OS Save picker must remain open across page retirement.');
  const retired=await execute('return window.__TAURI_INTERNALS__.invoke("project_export_operation",{ownerId:arguments[0],operation:{action:"export_status",requestId:arguments[1]}}).then(result=>({ok:true}),error=>({ok:false,code:error.code}));',[old.owner,old.request.requestId]);assert.deepEqual(retired,{ok:false,code:'stale_session'});
  await selectDestination(window,exported);await assert.rejects(stat(exported),{code:'ENOENT'});assert.equal(Number(native('xdotool',['getwindowpid',nativeWindow])),nativePid);assert.ok(windowState().includes('Normal'));await checkOriginal();
  await click('.file-button[data-path="main.typ"]');await until(()=>execute('return document.querySelector(".cm-content")?.textContent.includes("The saved manuscript stays unchanged.")'),'New native page did not retain usable source opening.');
  const fresh=await startExport();native('xdotool',['windowactivate','--sync',fresh,'key','--clearmodifiers','Escape']);await until(async()=>(await exportStatus()).includes('download cancelled'),'A fresh local export was blocked after the retired operation.');await assert.rejects(stat(exported),{code:'ENOENT'});await checkOriginal();
  evidence.retiredPage={oldOwnerDenied:retired.code,oldRequestId:old.request.requestId,destinationAbsent:true,sameProcess:true,newExportUsable:true};evidence.result='passed';evidence.sourceSha256=sourceBefore;evidence.policySha256=policyBefore;
  checks.push('Actual native page reload retires an open OS Save request; its old owner is denied, accepting that picker writes no destination, and the same process can open source and start/cancel a fresh export.');
  console.log(`Native saved-project ZIP page retirement passed; evidence in ${artifacts}.`);
}catch(error){evidence.result='failed';evidence.error=error.message;if(nativeWindow)try{evidence.x11WindowState=windowState();}catch{}if(session){evidence.frontendErrors=await execute('return window.__nativeAppErrors||[]').catch(()=>[]);evidence.dom=await execute('return {zipStatus:document.querySelector("#menu-file [data-project-export-status]")?.textContent,zipChooses:window.__nativeZipChooses,zipOperations:window.__nativeZipOperations,zipReplies:window.__nativeZipReplies,zipPrepared:window.__nativeZipPrepared,ready:document.readyState,saveLabel:document.getElementById("save-label")?.textContent,status:document.getElementById("review-status")?.textContent,reviewOpen:document.querySelector(".review-workspace")?.dataset.reviewOpen,appEnabled:document.getElementById("connection-app-enabled")?.checked,observedCommands:window.__nativeAppObservedCommands?.slice(-12),observationErrors:window.__nativeAppObservationErrors};').catch(()=>null);await screenshot('native-app-failure.png').catch(()=>{});}throw error;}
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
