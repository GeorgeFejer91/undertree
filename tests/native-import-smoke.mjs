// Real packaged Tauri -> native IPC -> Rust MCP -> renderer -> native window controls.
// Requires Linux WebKitGTK/WebDriver, Xvfb, xfwm4, xdotool and wmctrl. zrok alone is simulated.
import assert from 'node:assert/strict';
import { createZrokFixture } from './zrok-fixture.mjs';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { nativeFixtureContextScript } from './native-fixture-context.mjs';

assert.equal(process.platform, 'linux');
assert.notEqual(process.getuid(), 0, 'The failed-autosave proof requires a regular user.');
const binary = resolve(process.env.UNDERTREE_DESKTOP || 'target/debug/undertree-desktop');
const artifacts = resolve(process.env.UNDERTREE_NATIVE_APP_ARTIFACTS || 'artifacts/native-import');
const readOverlap=process.env.UNDERTREE_NATIVE_APP_READ_OVERLAP==='1';
const fixture = await mkdtemp(join(tmpdir(), 'undertree-native-import-'));
const project = join(fixture, 'project'), data = join(fixture, 'data');
const state = join(data, 'io.github.georgefejer91.UnderTree', 'review');
const source = join(project, 'main.typ'), policy = source + '.undertree-review.json';
const targetFile = join(fixture, 'target');
const processes = [], checks = [], secrets = [];
let session, driverUrl, displayEnv, nativeWindow, nativePid, log = '';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const evidence = { verifiedAt:new Date().toISOString(), application:binary, binarySha256:hash(await readFile(binary)), assertions:checks, qualification:'Actual native OS file picker, Tauri IPC, Rust-owned staging/import and real MCP pending guards; fake zrok child only.', limitations:'No physical OS IME, public ChatGPT/zrok account or route, other platform, installation or signing. ACK fault changes routing header only after real Rust completion.', display:'Private Xvfb display and disposable XDG state; existing desktop windows are untouched.' };
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
  const original='= Native App controls\r\n\r\nThe saved manuscript stays unchanged. Café UTF-8.\r\n';await writeFile(source,original);
  const incoming=join(fixture,'incoming');await mkdir(incoming);
  const importedSource=Buffer.from('= Imported chapter\r\n\r\nExact Café UTF-8 bytes.\r\n'),importedAsset=Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000b49444154789c636000020000050001a5f645400000000049454e44ae426082','hex');
  await writeFile(join(incoming,'chapter.typ'),importedSource);await writeFile(join(incoming,'diagram.png'),importedAsset);
  await writeFile(join(incoming,'dirty-import.typ'),'= Additional import\r\n');
  await writeFile(join(incoming,'stale-import.typ'),'= Stale destination must not receive this\r\n');
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
    window.__nativeImportCalls=[];window.__nativeImportReplies=[];window.__nativeImportHold=false;
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
          if(name==='import_operation')window.__nativeImportCalls.push(payload.operation);
          if(name==='review_action'&&['compile','set_main_document','accept'].includes(payload.operation?.action))window.__nativeImportEffects=(window.__nativeImportEffects||0)+1;
          if((name==='review_action'&&payload.operation?.action==='save')||(name==='editor_operation'&&payload.operation?.action==='editor_commit')){window.__nativeAppSaveAttempts++;window.__nativeAppLastSaveAttempt=performance.now();}
        }
      }catch{window.__nativeAppObservationErrors.push('Unsupported IPC observation body.');}
      const response=Reflect.apply(originalFetch,window,[input,init,...rest]);
      window.__nativeFixtureContext.observe(observedName,observedPayload,response);
      if(observedName==='choose_import_files')return response.then(async value=>{window.__nativeImportSelection=await value.clone().json();return value;});
      if(observedName==='import_operation')return response.then(async value=>{
        const reply=await value.clone().json();window.__nativeImportReplies.push({operation:observedPayload.operation,reply});
        if(observedPayload.operation?.action==='import_files'&&window.__nativeImportHold){
          window.__nativeImportHeldReply=reply;window.__nativeImportHeld=true;
          await new Promise(resolve=>window.__nativeImportRelease=resolve);
          if(window.__nativeImportRejectAck){
            // Preserve Rust's exact committed body, but route this one renderer acknowledgement to
            // its error callback. Rejecting fetch itself would cause Tauri's fallback to re-dispatch.
            const bytes=await value.arrayBuffer(),headers=new Headers(value.headers);headers.set('Tauri-Response','error');
            window.__nativeImportAckFault={headerOnly:true,body:reply};
            return new Response(bytes,{status:value.status,statusText:value.statusText,headers});
          }
        }
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
  assert.equal(await execute('return document.getElementById("connection-app-url").value===arguments[0]',[appUrl]),true);
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

  await until(()=>execute('return !document.getElementById("typst-compile").textContent.includes("Compiling")'),'Initial native compile did not settle.');
  const registryBefore=JSON.parse(await readFile(join(state,'projects.json'),'utf8'));
  const mainBefore=registryBefore.projects[0].mainDocument??null;
  const editor=()=>execute('return {text:document.querySelector(".cm-content").textContent,active:document.querySelector(".file-button[aria-current=\\"true\\"]")?.dataset.path,save:document.getElementById("save-label").textContent};');
  const openImport=async()=>{await click('#menu-file-toggle');await until(()=>execute('return document.getElementById("menu-file").open'),'File menu did not open.');await click('#menu-file [data-command="import-files"]');await until(()=>execute('return document.getElementById("file-import-dialog").open'),'Native Import dialog did not open.');};
  const picker=()=>{const found=spawnSync('xdotool',['search','--onlyvisible','--name','^Import files$'],{env:{...process.env,...displayEnv},encoding:'utf8',timeout:5000});return found.status===0?found.stdout.trim().split('\n')[0]:null;};
  let pickerSequence=0;
  async function chooseFiles(paths){
    const chosen=join(fixture,`picker-selection-${++pickerSequence}`);await mkdir(chosen);
    for(const path of paths)await copyFile(path,join(chosen,path.split('/').pop()));
    await click('#file-import-choose');const window=await until(picker,'Actual native OS Import files picker did not open.');
    native('xdotool',['windowactivate','--sync',window,'key','--clearmodifiers','ctrl+l']);await delay(300);
    native('xdotool',['key','--clearmodifiers','ctrl+a']);
    native('xdotool',['type','--clearmodifiers','--delay','1',chosen+'/']);
    native('xdotool',['key','--clearmodifiers','Return']);await delay(2000);
    const dimensions=Object.fromEntries(native('xdotool',['getwindowgeometry','--shell',window]).split('\n').map(item=>item.split('=')));
    const open=()=>native('xdotool',['mousemove','--window',window,String(Number(dimensions.WIDTH)-55),String(Number(dimensions.HEIGHT)-25),'click','1']);
    open();await delay(2000);
    native('/usr/bin/python3',['-c','import gi,sys;gi.require_version("Gdk","3.0");from gi.repository import Gdk;root=Gdk.get_default_root_window();Gdk.pixbuf_get_from_window(root,0,0,root.get_width(),root.get_height()).savev(sys.argv[1],"png",[],[])',join(artifacts,`native-picker-${pickerSequence}.png`)]);
    native('xdotool',['mousemove','--window',window,'400','230','click','1','key','--clearmodifiers','ctrl+a']);open();
    await until(()=>!picker(),'Actual native OS picker did not close after selecting disposable files.');
    await until(()=>execute('return document.getElementById("file-import-dialog").getAttribute("aria-busy")==="false"'),'Native picker staging did not finish.');
    const staged=await execute('return window.__nativeImportSelection');assert.deepEqual(staged.files?.map(file=>file.name).sort(),paths.map(path=>path.split('/').pop()).sort(),'Actual OS picker must stage exactly the intended disposable files.');
  }
  async function closeImport(){await click('#file-import-close');await until(()=>execute('return !document.getElementById("file-import-dialog").open'),'Import dialog did not close.');}
  const countImports=()=>execute('return window.__nativeImportCalls.filter(item=>item.action==="import_files").length');
  const assertOriginal=async()=>{assert.equal(hash(await readFile(source)),sourceBefore);assert.equal(hash(await readFile(policy)),policyBefore);const registry=JSON.parse(await readFile(join(state,'projects.json'),'utf8'));assert.equal(registry.projects[0].mainDocument??null,mainBefore);assert.equal((await editor()).active,'main.typ');};
  const remoteDenied=async requestId=>{
    const reply=await tool('set_workspace_view',{reviewVisible:false,requestId});
    if(reply.isError){assert.match(safeMessage(reply),/busy|pending|local buffers/i);return{state:'rejected',layer:'mcp_validation'};}
    let receipt=value(reply);await until(async()=>{receipt=value(await tool('get_control_result',{requestId}));return !['queued','dispatched'].includes(receipt.state);},'Pending import App effect did not settle.');
    assert.equal(receipt.state,'rejected');assert.equal(receipt.code,'busy');return{state:receipt.state,code:receipt.code};
  };

  await openImport();assert.equal(await execute('return document.getElementById("file-import-parent").value'),'');
  await click('#file-import-choose');const cancelledWindow=await until(picker,'Native picker did not open for cancellation.');native('xdotool',['windowactivate','--sync',cancelledWindow,'key','--clearmodifiers','Escape']);
  await until(()=>execute('return document.getElementById("file-import-dialog").getAttribute("aria-busy")==="false"'),'Canceled native picker did not release its UI.');
  assert.equal(await execute('return document.getElementById("file-import-list").children.length'),0);assert.equal(await countImports(),0);await assertOriginal();
  checks.push('The actual OS picker cancels without staging visible files, dispatching import_files or changing the active source/main/policy.');

  await chooseFiles([join(incoming,'chapter.typ'),join(incoming,'diagram.png')]);
  assert.equal(await execute('return document.getElementById("file-import-list").children.length'),2);
  const selection=await execute('return window.__nativeImportSelection');assert.equal(selection.project,'11111111-1111-4111-8111-111111111111');assert.equal(selection.parent,'');
  assert.deepEqual(selection.files.map(file=>[file.name,file.kind,file.bytes,file.sha256]).sort(),[['chapter.typ','source',importedSource.length,hash(importedSource)],['diagram.png','asset',importedAsset.length,hash(importedAsset)]].sort());
  assert.equal(await execute('return document.getElementById("file-import-submit").disabled'),false);const cleanBefore=await editor();assert.equal(cleanBefore.save,'Saved locally');
  const baseline=await execute('return {saves:window.__nativeAppSaveAttempts,effects:window.__nativeImportEffects||0};');
  await execute('window.__nativeImportHold=true;window.__nativeImportRejectAck=true;');await click('#file-import-submit');
  await until(()=>execute('return window.__nativeImportHeld===true'),'Real import did not reach held acknowledgement after Rust completion.');
  const committed=await execute('return window.__nativeImportHeldReply');assert.equal(committed.status,'committed');assert.equal(committed.gitOwnership,'undertree');
  assert.ok((await readFile(join(project,'chapter.typ'))).equals(importedSource));assert.ok((await readFile(join(project,'diagram.png'))).equals(importedAsset));await stat(join(project,'chapter.typ.undertree-review.json'));await assert.rejects(stat(join(project,'diagram.png.undertree-review.json')),{code:'ENOENT'});
  assert.equal(await execute('return document.getElementById("file-import-close").disabled'),true);assert.equal(await countImports(),1);await assertOriginal();
  const deniedPending=await remoteDenied('import-held-ack');assert.equal(await execute('return document.querySelector(".review-workspace").dataset.reviewOpen'),'true');
  await execute('window.__nativeImportHold=false;window.__nativeImportRelease();');
  await until(()=>execute('return document.getElementById("file-import-dialog").getAttribute("aria-busy")==="false"&&!document.getElementById("file-import-check").hidden'),'Rejected renderer acknowledgement did not retain Check import.');
  assert.equal(await execute('return window.__nativeAppFallback'),false,'ACK loss must not trigger native mutation re-dispatch.');await closeImport();await openImport();
  assert.equal(await execute('return document.getElementById("file-import-check").hidden'),false);assert.equal(await execute('return document.getElementById("file-import-submit").disabled'),true);assert.equal(await execute('return document.getElementById("file-import-choose").disabled'),true);
  const deniedUnconfirmed=await remoteDenied('import-unconfirmed-reopened');
  await click('#file-import-check');await until(()=>execute('return document.getElementById("file-import-status").textContent.startsWith("Imported 2 files")'),'Status did not confirm the same committed import.');
  assert.equal(await countImports(),1);const observations=await execute('return {calls:window.__nativeImportCalls,replies:window.__nativeImportReplies,fault:window.__nativeImportAckFault};');
  const statusCalls=observations.calls.filter(operation=>operation.action==='import_status');assert.ok(statusCalls.length>0);assert.ok(statusCalls.every(operation=>operation.requestId===committed.requestId));
  assert.deepEqual(observations.fault.body,committed);assert.equal(observations.fault.headerOnly,true);assert.ok(observations.replies.some(item=>item.operation.action==='import_status'&&item.reply.status==='committed'&&item.reply.requestId===committed.requestId));
  await assertOriginal();assert.deepEqual(await editor(),cleanBefore);assert.deepEqual(await execute('return {saves:window.__nativeAppSaveAttempts,effects:window.__nativeImportEffects||0};'),baseline);
  const registryAfter=JSON.parse(await readFile(join(state,'projects.json'),'utf8')).projects[0];for(const path of['chapter.typ','chapter.typ.undertree-review.json','diagram.png'])assert.ok(registryAfter.pending.includes(path));
  evidence.lostAcknowledgement={requestId:committed.requestId,dispatches:1,headerOnly:true,statusConfirmed:true,deniedPending,deniedUnconfirmed};evidence.importedFiles=committed.files;
  checks.push('The actual multi-file picker stages source/asset metadata; Rust imports exact CRLF/UTF-8 and binary bytes, a source sidecar and owned Git-pending entries without opening/saving/compiling or changing main.');
  checks.push('A held then renderer-rejected real committed ACK keeps App effects denied across dialog close/reopen; Check confirms the same request with exactly one import_files dispatch and no fallback.');
  await closeImport();

  const collisionBytes=await readFile(join(project,'chapter.typ')),collisionSidecar=hash(await readFile(join(project,'chapter.typ.undertree-review.json')));const beforeCollision=await countImports();await openImport();await chooseFiles([join(incoming,'chapter.typ')]);
  if(!await execute('return document.getElementById("file-import-submit").disabled')){await click('#file-import-submit');await until(()=>execute('return document.getElementById("file-import-dialog").getAttribute("aria-busy")==="false"'),'Collision commit did not settle.');}
  assert.match(await execute('return document.getElementById("file-import-status").textContent'),/exist|conflict|preserv|destination/i);assert.ok((await readFile(join(project,'chapter.typ'))).equals(collisionBytes));assert.equal(hash(await readFile(join(project,'chapter.typ.undertree-review.json'))),collisionSidecar);await assertOriginal();
  assert.ok(await countImports()<=beforeCollision+1);checks.push('An actual picker selection that collides with an existing project source is rejected and preserves existing source/sidecar bytes.');await closeImport();

  await chmod(project,0o555);await click('.cm-content');native('xdotool',['windowactivate','--sync',nativeWindow,'key','--clearmodifiers','ctrl+End']);native('xdotool',['type','--clearmodifiers','--delay','3','Dirty native buffer survives import.']);
  await until(()=>execute('return window.__nativeAppSaveAttempts>0&&performance.now()-window.__nativeAppLastSaveAttempt>1100&&document.getElementById("save-label").textContent==="Unsaved changes"&&!document.getElementById("typst-compile").textContent.includes("Compiling")'),'Dirty-buffer ordinary timers did not settle under denied writes.');await chmod(project,0o755);
  const dirtyBefore=await editor(),dirtySaves=await execute('return window.__nativeAppSaveAttempts');await openImport();await chooseFiles([join(incoming,'dirty-import.typ')]);await click('#file-import-submit');
  await until(()=>execute('return document.getElementById("file-import-status").textContent.startsWith("Imported 1 file")'),'Import alongside dirty buffer did not commit.');
  assert.deepEqual(await editor(),dirtyBefore);assert.equal(await execute('return window.__nativeAppSaveAttempts'),dirtySaves);await assertOriginal();await closeImport();
  await chmod(project,0o555);await click('.cm-content');native('xdotool',['key','--clearmodifiers','ctrl+z']);await until(()=>execute('return !document.querySelector(".cm-content").textContent.includes("Dirty native buffer survives import.")'),'Import destroyed the existing native Undo history.');
  native('xdotool',['key','--clearmodifiers','ctrl+shift+z']);await until(()=>execute('return document.querySelector(".cm-content").textContent.includes("Dirty native buffer survives import.")'),'Import destroyed the native Redo history.');await until(()=>execute('return window.__nativeAppSaveAttempts>arguments[0]&&performance.now()-window.__nativeAppLastSaveAttempt>1100&&document.getElementById("save-label").textContent==="Unsaved changes"&&!document.getElementById("typst-compile").textContent.includes("Compiling")',[dirtySaves]),'Post-Undo/Redo ordinary timers did not settle under denied writes.');await chmod(project,0o755);
  checks.push('Native import preserves the active dirty buffer and performs no source save; real keyboard Undo/Redo remains available afterward.');

  await mkdir(join(project,'stale-destination'));await openImport();await execute('const input=document.getElementById("file-import-parent");input.value="stale-destination";input.dispatchEvent(new Event("input",{bubbles:true}));');await chooseFiles([join(incoming,'stale-import.typ')]);
  await rename(join(project,'stale-destination'),join(project,'old-destination'));await mkdir(join(project,'stale-destination'));await click('#file-import-submit');
  await until(()=>execute('return document.getElementById("file-import-dialog").getAttribute("aria-busy")==="false"'),'Stale destination rejection did not settle.');
  assert.match(await execute('return document.getElementById("file-import-status").textContent'),/destination changed|folder again|project changed/i);await assert.rejects(stat(join(project,'stale-destination/stale-import.typ')),{code:'ENOENT'});await assert.rejects(stat(join(project,'old-destination/stale-import.typ')),{code:'ENOENT'});await assertOriginal();
  checks.push('Replacing the destination folder after the real native selection is staged rejects publication into either folder.');
  assert.deepEqual(await execute('return window.__nativeAppErrors'),[]);assert.deepEqual(await execute('return window.__nativeAppObservationErrors'),[]);assert.equal(await execute('return window.__nativeAppFallback'),false);
  evidence.result='passed';evidence.sourceSha256=sourceBefore;evidence.policySha256=policyBefore;evidence.mainDocument=mainBefore;
  console.log(`Native Import passed: ${checks.length} actual OS-picker/staging/receipt/preservation checks; evidence in ${artifacts}.`);

}catch(error){evidence.result='failed';evidence.error=error.message;if(nativeWindow)try{evidence.x11WindowState=windowState();}catch{}if(session){evidence.frontendErrors=await execute('return window.__nativeAppErrors||[]').catch(()=>[]);evidence.dom=await execute('return {importStatus:document.getElementById("file-import-status")?.textContent,importOpen:document.getElementById("file-import-dialog")?.open,importCalls:window.__nativeImportCalls,importReplies:window.__nativeImportReplies,ready:document.readyState,saveLabel:document.getElementById("save-label")?.textContent,status:document.getElementById("review-status")?.textContent,reviewOpen:document.querySelector(".review-workspace")?.dataset.reviewOpen,appEnabled:document.getElementById("connection-app-enabled")?.checked,observedCommands:window.__nativeAppObservedCommands?.slice(-12),observationErrors:window.__nativeAppObservationErrors};').catch(()=>null);await screenshot('native-app-failure.png').catch(()=>{});}throw error;}
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
