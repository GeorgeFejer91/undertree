// Real packaged Tauri -> native IPC -> Rust MCP -> renderer -> native window controls.
// Requires Linux WebKitGTK/WebDriver, Xvfb, xfwm4, xdotool and wmctrl. zrok alone is simulated.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';

assert.equal(process.platform, 'linux');
assert.notEqual(process.getuid(), 0, 'The failed-autosave proof requires a regular user.');
const binary = resolve(process.env.UNDERTREE_DESKTOP || 'target/debug/undertree-desktop');
const artifacts = resolve(process.env.UNDERTREE_NATIVE_APP_ARTIFACTS || 'artifacts/native-publishing');
let downloadProbe=process.env.UNDERTREE_NATIVE_DOWNLOAD_DIR_PROBE?resolve(process.env.UNDERTREE_NATIVE_DOWNLOAD_DIR_PROBE):null;
const readOverlap=process.env.UNDERTREE_NATIVE_APP_READ_OVERLAP==='1';
const fixture = await mkdtemp(join(tmpdir(), 'undertree-native-app-'));
const project = join(fixture, 'project'), data = join(fixture, 'data');
const state = join(data, 'io.github.georgefejer91.UnderTree', 'review');
const sourceName=`qa-native-export-${Date.now()}-${process.pid}.typ`;
const downloads=join(fixture,'downloads'),config=join(fixture,'config');
const source = join(project, sourceName), policy = source + '.undertree-review.json';
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
const review=operation=>execute('return window.__TAURI_INTERNALS__.invoke("review_action",{operation:arguments[0]});',[operation]);
const windowState=()=>native('xprop',['-id',nativeWindow,'WM_STATE']);
async function screenshot(name){const encoded=await command('/screenshot',undefined,'GET');await writeFile(join(artifacts,name),Buffer.from(encoded,'base64'));}
try{
  await stat(binary);await mkdir(project);await mkdir(state,{recursive:true});await mkdir(artifacts,{recursive:true});
  let original='= Native publishing\r\n\r\nThe saved manuscript stays unchanged. Café UTF-8.\r\n';await writeFile(source,original);
  await writeFile(join(state,'projects.json'),JSON.stringify({projects:[{id:'native-app',name:'Native App controls',root:project,repository:'',autoSync:false,pending:[],pendingRevisions:{}}]}));
  await writeFile(zrok,`#!/bin/sh\nprintf '%s' "$3" > ${quote(targetFile)}\nexec sleep 180\n`);await chmod(zrok,0o700);
  await mkdir(config);await mkdir(downloads);await writeFile(join(config,'user-dirs.dirs'),`XDG_DOWNLOAD_DIR="${downloads}"\n`);
  let probeLibrary;
  if(!downloadProbe){
    const target=resolve(process.env.CARGO_TARGET_DIR||'target');
    for(const profile of ['debug','release']){
      const directory=join(target,profile,'deps');
      const names=await readdir(directory).catch(error=>{if(error.code==='ENOENT')return[];throw error;});
      const candidates=await Promise.all(names.filter(name=>/^libdirs-[a-f0-9]+\.rlib$/.test(name)).map(async name=>({path:join(directory,name),modified:(await stat(join(directory,name))).mtimeMs})));
      candidates.sort((a,b)=>b.modified-a.modified);if(candidates.length){probeLibrary=candidates[0].path;break;}
    }
    assert.ok(probeLibrary,'Build the native Tauri binary before this gate, or set UNDERTREE_NATIVE_DOWNLOAD_DIR_PROBE to its qualified dirs resolver.');
    const sourceProbe=join(fixture,'download-dir.rs');downloadProbe=join(fixture,'download-dir-probe');
    await writeFile(sourceProbe,'fn main(){let expected=std::path::PathBuf::from(std::env::var_os("UNDERTREE_QA_DOWNLOADS").unwrap());let actual=dirs::download_dir().expect("private download directory must resolve");assert_eq!(actual,expected);println!("{}",actual.display());}\n');
    const compiled=spawnSync('rustc',['--edition=2021','--crate-name','undertree_download_dir_probe',sourceProbe,'--extern',`dirs=${probeLibrary}`,'-L',`dependency=${join(probeLibrary,'..')}`,'-o',downloadProbe],{cwd:fixture,encoding:'utf8',timeout:30000});
    assert.equal(compiled.status,0,compiled.stderr);
  }
  const preflight=spawnSync(downloadProbe,[],{env:{...process.env,XDG_CONFIG_HOME:config,UNDERTREE_QA_DOWNLOADS:downloads},cwd:fixture,encoding:'utf8',timeout:5000});
  assert.equal(preflight.status,0,preflight.stderr);assert.equal(preflight.stdout.trim(),downloads);assert.deepEqual(await readdir(downloads),[]);
  evidence.downloadIsolation={preflight:true,HOMEChanged:false,privateCwd:true,probeSha256:hash(await readFile(downloadProbe)),librarySha256:probeLibrary?hash(await readFile(probeLibrary)):undefined};
  const xvfb=child(process.env.UNDERTREE_XVFB||'Xvfb',['-displayfd','1','-screen','0','1600x1000x24','-nolisten','tcp','-noreset']);let display='';xvfb.stdout.on('data',bytes=>{display+=bytes;});
  await until(()=>display.trim()&&xvfb.exitCode===null,'Private Xvfb did not start.');
  displayEnv={DISPLAY:`:${display.trim()}`,XDG_DATA_HOME:data,XDG_CONFIG_HOME:config,XDG_CACHE_HOME:join(fixture,'cache'),SESSION_MANAGER:'',UNDERTREE_ZROK:zrok};
  const wm=child(process.env.UNDERTREE_XFWM||'xfwm4',['--replace'],displayEnv);await until(()=>wm.exitCode===null&&native('xprop',['-root','_NET_SUPPORTING_WM_CHECK']).includes('window id'),'Private window manager did not start.');
  const port=await freePort(),nativePort=await freePort();driverUrl=`http://127.0.0.1:${port}`;
  const driver=child(process.env.UNDERTREE_TAURI_DRIVER||'tauri-driver',['--port',String(port),'--native-port',String(nativePort),'--native-host','127.0.0.1'],displayEnv);driver.stdout.on('data',bytes=>{log=(log+bytes).slice(-32_000);});
  await until(async()=>driver.exitCode===null&&await request('/status',undefined,'GET'),'Native WebDriver did not start.');
  const opened=await request('/session',{capabilities:{alwaysMatch:{'tauri:options':{application:binary}}}});session=opened.sessionId;evidence.webDriverCapabilities=opened.capabilities;
  await until(()=>execute('return !!document.querySelector(arguments[0])',[`.file-button[data-path="${sourceName}"]`]),'Native inventory did not render.');
  nativeWindow=native('xdotool',['search','--onlyvisible','--name','^UnderTree$']).split('\n')[0];nativePid=Number(native('xdotool',['getwindowpid',nativeWindow]));
  assert.equal(await execute(`
    window.__nativeAppErrors=[];window.__nativePublishingCompiles=[];
    window.__nativePublishingSaves=[];window.__nativePublishingClicks=[];window.__nativePublishingTimers=[];window.__nativePublishingPending=new Map();window.__nativePublishingInFlight=0;window.__nativePubPhase='setup';
    const originalSetTimeout=window.setTimeout,originalClearTimeout=window.clearTimeout;
    window.setTimeout=(callback,milliseconds,...args)=>{
      if(typeof callback==='function'&&[450,700].includes(milliseconds)){
        const meta={delay:milliseconds,scheduled:performance.now(),phase:window.__nativePubPhase};let id;
        id=Reflect.apply(originalSetTimeout,window,[(...callbackArgs)=>{window.__nativePublishingPending.delete(id);window.__nativePublishingTimers.push({...meta,fired:performance.now()});return Reflect.apply(callback,window,callbackArgs);},milliseconds,...args]);
        window.__nativePublishingPending.set(id,meta);return id;
      }
      return Reflect.apply(originalSetTimeout,window,[callback,milliseconds,...args]);
    };
    window.clearTimeout=id=>{window.__nativePublishingPending.delete(id);return Reflect.apply(originalClearTimeout,window,[id]);};
    addEventListener('click',event=>{const control=event.target.closest?.('button,summary');if(control)window.__nativePublishingClicks.push({at:performance.now(),id:control.id,command:control.dataset.command,phase:window.__nativePubPhase});},true);

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
      if(observedName==='review_action'&&observedPayload?.operation?.action==='save'){
        const trace={at:performance.now(),phase:window.__nativePubPhase,length:observedPayload.operation.content?.length,stack:new Error().stack,pending:[...window.__nativePublishingPending.values()]};window.__nativePublishingSaves.push(trace);window.__nativePublishingInFlight++;
        response.then(reply=>{trace.finished=performance.now();trace.ok=reply.headers.get('Tauri-Response')==='ok';window.__nativePublishingInFlight--;},()=>{window.__nativePublishingInFlight--;});
      }

      if(observedName==="review_action"&&observedPayload?.operation?.action==="compile"){const trace={started:performance.now()};window.__nativePublishingCompiles.push(trace);response.then(reply=>{trace.finished=performance.now();trace.ok=reply.headers.get("Tauri-Response")==="ok";}).catch(()=>{});}
      if(observedName==='review_action'&&observedPayload?.operation?.action==='review'&&window.__probeHoldReview)return response.then(async value=>{window.__probeReviewHeld=true;await new Promise(resolve=>window.__probeReleaseReview=resolve);return value;});
      if(observedName==='plugin:window|unminimize'&&window.__nativeAppReadOverlapEnabled)return response.then(async value=>{window.__probeHoldReview=true;document.getElementById('review-refresh').click();const deadline=performance.now()+5000;while(!window.__probeReviewHeld){if(performance.now()>deadline)throw Error('The real safe Review read did not reach its held response.');await new Promise(resolve=>setTimeout(resolve,10));}return value;});
      return response;
    };
    console.warn=(...args)=>{if(args.some(value=>String(value).includes('IPC custom protocol failed')))window.__nativeAppFallback=true;return Reflect.apply(originalWarn,console,args);};
    window.fetch=observed;
    return window.fetch===observed;
  `),true,'Passive IPC observation is installed without replacing native dispatch.');
  await execute('window.__nativeAppReadOverlapEnabled=arguments[0];',[readOverlap]);
  await click(`.file-button[data-path="${sourceName}"]`);await until(()=>execute('return document.querySelector(".cm-content")?.textContent.includes("The saved manuscript stays unchanged.")'),'Manuscript did not open.');
  await chmod(project,0o555);await click('.cm-content');native('xdotool',['windowactivate','--sync',nativeWindow,'key','--clearmodifiers','ctrl+End']);native('xdotool',['type','--clearmodifiers','--delay','3','Saved by uppercase Control+S.']);
  await until(()=>execute('return window.__nativePublishingPending.size===0&&window.__nativePublishingInFlight===0&&window.__nativeAppSaveAttempts>0&&performance.now()-window.__nativeAppLastSaveAttempt>1100&&document.getElementById("save-label").textContent==="Unsaved changes"&&!document.getElementById("typst-compile").textContent.includes("Compiling")'),'Ordinary save/compile timers did not settle under denied writes.');
  assert.equal(await readFile(source,'utf8'),original);await chmod(project,0o755);const keyboardBefore=await execute('return window.__nativeAppSaveAttempts');
  const expectedKeyboard=original+'Saved by uppercase Control+S.';native('xdotool',['key','--clearmodifiers','ctrl+shift+s']);
  await until(async()=>await readFile(source,'utf8')===expectedKeyboard&&await execute('return document.getElementById("save-label").textContent==="Saved locally"'),'Actual uppercase Control+S did not save the dirty native buffer.');
  assert.equal(await execute('return window.__nativeAppSaveAttempts'),keyboardBefore+1);original=expectedKeyboard;
  checks.push('Actual Ctrl+Shift+S produces the uppercase shortcut and saves once after ordinary timers quiesce, with exact CRLF/UTF-8 bytes.');
  await click('#menu-format-toggle');await click('#palette-open');await click('#palette-form button[type="submit"]');
  await until(()=>stat(policy),'The native policy setup did not persist its default color rules.');
  await until(()=>execute('return !document.getElementById("palette-dialog").open'),'The native policy save did not finish.');
  await until(()=>execute('return !document.getElementById("typst-compile").disabled'),'The native compile control did not become ready.');
  await click('#typst-compile');await until(()=>execute('return document.getElementById("typst-preview-status").textContent.startsWith("Current PDF")&&document.getElementById("typst-compile").textContent==="Recompile"&&!!document.querySelector("#typst-preview canvas")'),'Real native Typst PDF did not finish rendering.',30000);
  const pdf=value=>Buffer.from(value.base64,'base64');
  const firstPreview=await review({action:'pdf',project:'native-app',path:sourceName});const savedPdf=pdf(firstPreview);evidence.firstPreview={readAt:await execute('return performance.now()'),revision:firstPreview.revision,current:firstPreview.current,sha256:hash(savedPdf)};assert.ok(savedPdf.subarray(0,5).equals(Buffer.from('%PDF-')));
  await click('#menu-file-toggle');await until(()=>execute('const node=document.getElementById("export-manuscript"),box=node.getBoundingClientRect();return document.getElementById("menu-file").open&&!node.disabled&&box.width>0&&box.height>0&&getComputedStyle(node).visibility!=="hidden";'),'The visible native source download action did not finish opening.');await execute('return new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));');await click('#export-manuscript');
  const sourceDownload=join(downloads,sourceName);await until(async()=>{try{return (await readFile(sourceDownload)).equals(Buffer.from(original));}catch{return false;}},'Native source anchor.download did not produce exact source bytes in the isolated directory.');
  const pdfName=sourceName.replace(/\.typ$/,'.pdf');await click('#export-pdf');
  const pdfDownload=join(downloads,pdfName);await until(async()=>{try{return (await readFile(pdfDownload)).equals(savedPdf);}catch{return false;}},'Native PDF anchor.download did not produce the exact rendered PDF bytes in the isolated directory.');
  await copyFile(sourceDownload,join(artifacts,'downloaded-source.typ'));await copyFile(pdfDownload,join(artifacts,'downloaded-preview.pdf'));
  checks.push('Real native Blob downloads write exact UTF-8/CRLF source and rendered PDF bytes only into the preflight-verified private directory.');
  await click('#review-toggle');await click('#manuscript-share');await until(async()=>(await review({action:'open',project:'native-app',path:sourceName})).shared===true,'Actual native UI did not share the manuscript.');
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
  const savesBefore=await execute('return window.__nativeAppSaveAttempts');
  const beforePermission=(await tool('list_manuscripts')).structuredContent.result;const shared=beforePermission.find(item=>item.path===sourceName);assert.ok(shared);assert.equal(shared.savedPdf,undefined);
  const disabled=await tool('get_pdf_download',{documentId:shared.documentId,revision:hash(original),artifactId:hash(savedPdf)});assert.equal(disabled.isError,true);
  await click('#connection-open');await click('#connection-tab-app');
  let connectionStatus=(await review({action:'connection'})).appControls;assert.equal(connectionStatus.pdfExport.enabled,false);assert.deepEqual(connectionStatus.pdfExport.projects,[]);
  await click('#connection-pdf-export > summary');
  const rootSelector='#connection-pdf-export-projects input[value="native-app"]';assert.equal(await execute('return document.querySelector(arguments[0]).checked',[rootSelector]),false);
  assert.equal(await execute('return document.querySelector(".pdf-export-root").textContent'),project);
  await click(rootSelector);await click('#connection-pdf-export-apply');
  await until(async()=>{connectionStatus=(await review({action:'connection'})).appControls;return connectionStatus.pdfExport.enabled;},'Actual native PDF consent did not apply.');assert.deepEqual(connectionStatus.pdfExport.projects,['native-app']);
  const listed=(await tool('list_manuscripts')).structuredContent.result;const document=listed.find(item=>item.documentId===shared.documentId);assert.equal(document.savedPdf.available,true);
  const identity={documentId:shared.documentId,revision:document.savedPdf.revision,artifactId:document.savedPdf.artifactId};const ticket=value(await tool('get_pdf_download',identity));
  secrets.push(ticket.downloadUrl,new URL(ticket.downloadUrl).pathname,new URL(ticket.downloadUrl).pathname.split('/')[3]);
  const ticketEndpoint=target+new URL(ticket.downloadUrl).pathname;const downloaded=await fetch(ticketEndpoint,{signal:AbortSignal.timeout(10000)});assert.equal(downloaded.status,200);assert.equal(downloaded.headers.get('content-type'),'application/pdf');assert.equal(downloaded.headers.get('cache-control'),'no-store');
  const remotePdf=Buffer.from(await downloaded.arrayBuffer());const latestPreview=await review({action:'pdf',project:'native-app',path:sourceName});const latestPdf=pdf(latestPreview);evidence.pdfComparison={localInitialSha256:hash(savedPdf),remoteSha256:hash(remotePdf),nativeCurrentSha256:hash(latestPdf),initialRevision:firstPreview.revision,listedRevision:identity.revision,listedArtifactId:identity.artifactId,ticketSha256:ticket.sha256,ticketBytes:ticket.bytes,currentRevision:latestPreview.revision,current:latestPreview.current,compiles:await execute('return window.__nativePublishingCompiles')};await writeFile(join(artifacts,'mcp-export-attempt.pdf'),remotePdf);await writeFile(join(artifacts,'native-current.pdf'),latestPdf);assert.ok(remotePdf.equals(savedPdf));assert.equal(hash(remotePdf),ticket.sha256);assert.equal(remotePdf.length,ticket.bytes);await writeFile(join(artifacts,'mcp-export.pdf'),remotePdf);
  assert.equal(await execute('return window.__nativeAppSaveAttempts'),savesBefore);assert.equal(hash(await readFile(source)),sourceBefore);assert.equal(hash(await readFile(policy)),policyBefore);
  checks.push('Actual native root consent is independently off by default; selecting its displayed root authorizes only the exact existing saved PDF through real MCP and bounded download bytes, without a source save.');
  await click('#connection-pdf-export-disable');await until(async()=>!(await review({action:'connection'})).appControls.pdfExport.enabled,'Native PDF permission revocation did not apply.');
  const revoked=await fetch(ticketEndpoint,{signal:AbortSignal.timeout(5000)});assert.equal(revoked.status,404);assert.equal((await tool('get_pdf_download',identity)).isError,true);assert.equal((await review({action:'connection'})).appControls.enabled,true);
  assert.equal(await execute('return window.__nativeAppSaveAttempts'),savesBefore);assert.equal(hash(await readFile(source)),sourceBefore);assert.equal(hash(await readFile(policy)),policyBefore);
  checks.push('Actual native PDF-permission revocation invalidates the prior download ticket and prevents a fresh one while App controls remain enabled.');
  await command('/window/rect',{width:320,height:900,x:0,y:0});await execute('document.documentElement.style.fontSize="28px";');
  await until(()=>execute('return ["fit","reflow"].includes(document.getElementById("connection-pdf-export-summary").dataset.textFit)'),'Native PDF consent text did not finish Pretext measurement.');
  const geometry=await execute('const root=document.querySelector(".pdf-export-root");return {width:innerWidth,height:innerHeight,text:getComputedStyle(document.documentElement).fontSize,root:root.textContent,rootWidth:root.clientWidth,rootScroll:root.scrollWidth,pageOverflow:document.documentElement.scrollWidth>innerWidth+1||document.documentElement.scrollHeight>innerHeight+1};');
  assert.equal(geometry.root,project);assert.ok(geometry.rootScroll<=geometry.rootWidth+1);assert.equal(geometry.pageOverflow,false);evidence.consentGeometry=geometry;
  await command('/window/rect',{width:1600,height:1000,x:0,y:0});await execute('document.documentElement.style.fontSize="";');await until(()=>execute('return innerWidth>=1500&&parseFloat(getComputedStyle(document.documentElement).fontSize)<20'),'The native viewport/font did not restore before typing.');await execute('return new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));');
  await click('#connection-dialog [data-close]');const beforeDirtyTyping=await execute('return window.__nativeAppSaveAttempts');await chmod(project,0o555);await click('.cm-content');native('xdotool',['windowactivate','--sync',nativeWindow,'key','--clearmodifiers','ctrl+End']);native('xdotool',['type','--clearmodifiers','--delay','3','Unsaved buffer export stays local.']);
  await until(()=>execute('return document.querySelector(".cm-content").textContent.includes("Unsaved buffer export stays local.")'),'The actual native typing did not produce the complete dirty-buffer fixture.');
  await until(()=>execute('return window.__nativePublishingPending.size===0&&window.__nativePublishingInFlight===0&&window.__nativeAppSaveAttempts>arguments[0]&&document.getElementById("save-label").textContent==="Unsaved changes"&&performance.now()-window.__nativeAppLastSaveAttempt>1100&&!document.getElementById("typst-compile").textContent.includes("Compiling")',[beforeDirtyTyping]),'Dirty source export fixture did not become quiescent under denied writes.');await chmod(project,0o755);
  await execute('window.__nativePubPhase="dirty-export";');
  const dirtySaves=await execute('return window.__nativeAppSaveAttempts'),existing=new Set(await readdir(downloads));await click('#menu-file-toggle');await until(()=>execute('const node=document.getElementById("export-manuscript"),box=node.getBoundingClientRect();return document.getElementById("menu-file").open&&!node.disabled&&box.width>0&&box.height>0&&getComputedStyle(node).visibility!=="hidden";'),'The visible native source download action did not finish opening.');await execute('return new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));');await click('#export-manuscript');
  const dirtyFile=await until(async()=>{const files=(await readdir(downloads)).filter(name=>!existing.has(name));return files.find(name=>name.endsWith('.typ'));},'Unsaved native buffer download did not appear in its isolated destination.');
  await until(async()=>(await readFile(join(downloads,dirtyFile))).equals(Buffer.from(original+'Unsaved buffer export stays local.')),'Unsaved native buffer download did not retain exact current buffer bytes.');
  assert.equal(await execute('return window.__nativeAppSaveAttempts'),dirtySaves);assert.equal(await execute('return document.getElementById("save-label").textContent'),'Unsaved changes');assert.equal(hash(await readFile(source)),sourceBefore);assert.equal(hash(await readFile(policy)),policyBefore);await copyFile(join(downloads,dirtyFile),join(artifacts,'downloaded-unsaved-source.typ'));
  checks.push('Local source export includes the exact dirty buffer without saving it to writable project disk or altering its policy.');
  assert.deepEqual(await execute('return window.__nativeAppErrors'),[]);assert.deepEqual(await execute('return window.__nativeAppObservationErrors'),[]);assert.equal(await execute('return window.__nativeAppFallback'),false);
  evidence.result='passed';evidence.sourceSha256=sourceBefore;evidence.pdfSha256=hash(savedPdf);evidence.policySha256=policyBefore;evidence.nativeDownloads=(await readdir(downloads)).sort();evidence.remoteDownload={bytes:ticket.bytes,sha256:ticket.sha256,revokedStatus:revoked.status};
  console.log(`Native publishing passed: ${checks.length} real keyboard/download/consent checks; evidence in ${artifacts}.`);
}catch(error){evidence.result='failed';evidence.error=error.message;if(nativeWindow)try{evidence.x11WindowState=windowState();}catch{}if(session){evidence.frontendErrors=await execute('return window.__nativeAppErrors||[]').catch(()=>[]);evidence.dom=await execute('return {width:innerWidth,editorText:document.querySelector(".cm-content")?.textContent,menuOpen:document.getElementById("menu-file")?.open,exportButton:(()=>{const node=document.getElementById("export-manuscript");return node?{disabled:node.disabled,display:getComputedStyle(node).display,box:node.getBoundingClientRect().toJSON()}:null;})(),ready:document.readyState,saveLabel:document.getElementById("save-label")?.textContent,status:document.getElementById("review-status")?.textContent,reviewOpen:document.querySelector(".review-workspace")?.dataset.reviewOpen,appEnabled:document.getElementById("connection-app-enabled")?.checked,observedCommands:window.__nativeAppObservedCommands?.slice(-12),observationErrors:window.__nativeAppObservationErrors};').catch(()=>null);await screenshot('native-app-failure.png').catch(()=>{});}throw error;}
finally{
  if(session)evidence.scheduling=await execute('return {saves:window.__nativePublishingSaves,compiles:window.__nativePublishingCompiles,clicks:window.__nativePublishingClicks,timers:window.__nativePublishingTimers,pending:[...window.__nativePublishingPending.values()]};').catch(()=>null);
  await chmod(project,0o755).catch(()=>{});
  if(session)await review({action:'tunnel',enabled:false,reservation:'',public_url:''}).catch(()=>{});
  // Kill only this disposable application's PID; cleanup must not turn the deliberate dirty buffer into a local Close/save action.
  if(nativePid)try{process.kill(nativePid,'SIGTERM');}catch{}
  if(session)await command('',undefined,'DELETE').catch(()=>{});
  for(const processChild of [...processes].reverse())if(processChild.pid)try{process.kill(-processChild.pid,'SIGTERM');}catch{}
  await delay(200);for(const processChild of processes)if(processChild.exitCode===null&&processChild.pid)try{process.kill(-processChild.pid,'SIGKILL');}catch{}
  for(const secret of secrets.filter(Boolean))log=log.replaceAll(secret,'[redacted]');evidence.log=log;await mkdir(artifacts,{recursive:true});await writeFile(join(artifacts,'native-app-evidence.json'),JSON.stringify(evidence,null,2)+'\n');await rm(fixture,{recursive:true,force:true});
}
