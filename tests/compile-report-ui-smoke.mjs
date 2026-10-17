import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, copyFile, symlink, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { resolve, dirname, join, extname, relative } from 'node:path';
import { build } from 'vite';
import { chromium } from 'playwright-core';

// Exact renderer fragments, real CM/Pretext, explicitly synthetic reports/Review replies.
// This does not qualify main.js integration, native compilation, PDF parsing or source authority.
const prepareOnly = process.argv.includes('--prepare-only');
if (!prepareOnly) assert.equal(process.env.UNDERTREE_DIAGNOSTICS_PRESENTATION_LAUNCH, '1', 'Obtain the serialized browser lane before launching this gate.');
const source = resolve(process.env.UNDERTREE_DIAGNOSTICS_SOURCE || '.'), output = resolve(process.env.UNDERTREE_DIAGNOSTICS_EVIDENCE || `artifacts/compile-report-presentation-${Date.now()}`);
assert.ok(relative(source, output).startsWith('artifacts/'), 'Use a fresh ignored artifact directory, outside product outputs.');
const inputs = join(output, 'inputs'), dist = join(output, 'dist');
const files = ['src/manuscript.js', 'src/manuscript.css', 'manuscript.html', 'modules/frontend/compile-report.js', 'modules/frontend/review-session.js', 'modules/frontend/review-text-layout.js', 'modules/frontend/text-details.js'];
const hash = bytes => createHash('sha256').update(bytes).digest('hex'), hashes = {}, fragments = {}, checks = [], geometry = [], errors = [];
let inputFreeze = null;
const protectedInputs = Object.create(null);
if (Object.hasOwn(process.env, 'UNDERTREE_DIAGNOSTICS_INPUT_FREEZE')) {
  const name = process.env.UNDERTREE_DIAGNOSTICS_INPUT_FREEZE;
  assert.ok(name.trim(), 'Supply a nonempty explicit input-freeze path.');
  const path = resolve(name), raw = await readFile(path), freeze = JSON.parse(raw);
  assert.ok(freeze && typeof freeze === 'object' && !Array.isArray(freeze), 'Supply an explicit input-freeze object.');
  inputFreeze = { path, sha256: hash(raw) };
  for (const key of ['sources', 'preservedPreviousHistoryRootFiles']) if (Object.hasOwn(freeze, key)) {
    const entries = freeze[key];
    assert.ok(entries && typeof entries === 'object' && !Array.isArray(entries) && Object.keys(entries).length, 'Explicit input-freeze maps must be nonempty objects.');
    for (const [name, expected] of Object.entries(entries)) {
      assert.ok(!name.startsWith('/') && !name.includes('\\') && name.split('/').every(part => part && !['.', '..'].includes(part)) && typeof expected === 'string' && /^[a-f0-9]{64}$/.test(expected), 'Each explicit input-freeze entry needs a canonical relative source path and a 64-character hex digest.');
      if (Object.hasOwn(protectedInputs, name)) assert.equal(protectedInputs[name], expected, 'Conflicting explicit input-freeze guards.');
      protectedInputs[name] = expected;
    }
  }
  assert.ok(Object.keys(protectedInputs).length, 'Supply a nonempty recognized sources or preservedPreviousHistoryRootFiles map.');
}
async function guard() {
  if (inputFreeze) assert.equal(hash(await readFile(inputFreeze.path)), inputFreeze.sha256, 'The explicit input-freeze file changed.');
  for (const [name, expected] of Object.entries(protectedInputs)) assert.equal(hash(await readFile(join(source, name))), expected, `Frozen product/test input changed: ${name}`);
  for (const name of files) if (hashes[name]) { assert.equal(hash(await readFile(join(source, name))), hashes[name], `Selected source changed: ${name}`); assert.equal(hash(await readFile(join(inputs, name))), hashes[name], `Copied input changed: ${name}`); }
}
await guard(); await mkdir(dirname(output), { recursive: true }); await mkdir(output); await mkdir(inputs);
for (const name of files) { await mkdir(dirname(join(inputs, name)), { recursive: true }); await copyFile(join(source, name), join(inputs, name)); hashes[name] = hash(await readFile(join(inputs, name))); }
await symlink(join(source, 'node_modules'), join(inputs, 'node_modules'), 'dir');
const script = await readFile(join(inputs, 'src/manuscript.js'), 'utf8'), html = await readFile(join(inputs, 'manuscript.html'), 'utf8');
function fragment(name, text, from, to) {
  const start = text.indexOf(from), end = text.indexOf(to, start + from.length);
  assert.ok(start >= 0 && end > start, `Missing exact ${name} boundaries`);
  const value = text.slice(start, end); fragments[name] = { sha256: hash(value), startLine: text.slice(0, start).split('\n').length, bytes: Buffer.byteLength(value) }; return value;
}
const renderer = fragment('logRenderer', script, 'function retireCompileNavigation(', 'const controlEffects =');
const element = fragment('element', script, 'function element(', 'function status(');
const task = fragment('task', script, 'function task(', 'function closeDialogs(');
const action = fragment('actionButton', script, 'function actionButton(', 'function renderReview(');
const preview = fragment('previewDOM', html, '<div class="pane-heading preview-toolbar"', '      </section>\n    </section>\n    <footer class="review-status"');
await writeFile(join(inputs, 'diagnostics.html'), `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
#fixture-actions{display:flex;flex-wrap:wrap;gap:.4rem;padding:.4rem;background:var(--chrome);color:white;flex:none}.review-workspace{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}.manuscript-editor{grid-column:1}.manuscript-preview{grid-column:2}
</style></head><body><main id="review-app"><div id="fixture-actions"><button id="fixture-show-log" data-measure>Show compilation log</button><button id="fixture-hide-log" data-measure>Back to preview</button><span>Diagnostics presentation fixture</span></div><section class="review-workspace" data-mobile-view="preview"><section class="manuscript-editor"><div id="manuscript-source"></div></section><section class="manuscript-preview">${preview}</section></section></main><p id="review-status" hidden></p><script type="module" src="/fixture.js"></script></body></html>`);
await writeFile(join(inputs, 'fixture.js'), `import '/src/manuscript.css';
import { EditorView, basicSetup } from 'codemirror';
import { EditorState } from '@codemirror/state';
import { ReviewSession } from '/modules/frontend/review-session.js';
import { unwrapNativeCompile, navigateCompileDiagnostic } from '/modules/frontend/compile-report.js';
import { observeReviewText } from '/modules/frontend/review-text-layout.js';
const $=id=>document.getElementById(id), keyFor=(project,path)=>project+':'+path;
const id=n=>'00000000-0000-0000-0000-'+String(n).padStart(12,'0'), project=id(1), root={dev:'9007199254740993',ino:'18446744073709551615'};
const path=Array.from({length:6},(_,i)=>'long-localized-folder-'+i+'-'.repeat(70)).join('/')+'/chapter:7.typ', otherPath=path.replace('chapter:7.typ','other:8.typ');
const content='First.\\n💛e\\u0301\\t#missing\\n'+('Stable editor line.\\n').repeat(100), offset=content.indexOf('missing');
const sha=async text=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)))].map(byte=>byte.toString(16).padStart(2,'0')).join('');
const revision=await sha(content), mainRevision=await sha('saved main inputs');
const snapshot={documentId:'chapter-7',path,sourceEpoch:7,expectedRoot:root,sidecarRevision:null,content,review:{revision,markers:[],rules:[],suggestions:[]}};
const effects=[], reads=[], failures=[]; let hold=false,release,inFlight=0,navigationCompletions=0;
let active=new ReviewSession(snapshot,project,async()=>{throw Error('Presentation must never use the editor save queue.');}),sessions=new Map([[keyFor(project,path),active]]);
let view, currentCompileReport=null,currentCompileContext=null,localRequestsVersion=0,navigationIntent=0,showingLogs=false,compiling=false,windowClosing=false,pending=0;
const historyPanel={visible:false},pdfBytes=new Uint8Array([37,80,68,70]),publicationPath=()=> 'main.typ';
function status(message,error=false){$('review-status').textContent=message;failures.push({message,error});}
function controlContext(){return {pending};}
function showPane(name){effects.push(name);}
async function request(operation){
  if(operation.action!=='review')throw Error('Only a synthetic bound pure Review is available.');
  reads.push(structuredClone(operation));inFlight++;try{if(hold)await new Promise(resolve=>{release=resolve;});return structuredClone(snapshot);}finally{inFlight--;hold=false;}
}
${element}${task}${action}${renderer}
view=new EditorView({parent:$('manuscript-source'),state:EditorState.create({doc:content,extensions:[basicSetup,EditorState.lineSeparator.of('\\n'),EditorView.updateListener.of(update=>{
  if(update.docChanged){active.edit(update.state.doc.toString());if(currentCompileContext&&!currentCompileContext())retireCompileNavigation();}
})]})});
$('typst-compile').hidden=false;$('export-pdf').hidden=false;
let iframeLoads=0;$('manuscript-preview').addEventListener('load',()=>iframeLoads++);$('manuscript-preview').srcdoc='<p>Retained last-good preview</p>';
const canvas=document.createElement('canvas');canvas.width=120;canvas.height=80;canvas.getContext('2d').fillRect(0,0,120,80);$('typst-pages').append(canvas);
const retained={editor:view.dom,iframe:$('manuscript-preview'),iframeSource:$('manuscript-preview').srcdoc,canvas,bytes:pdfBytes};
const point={projectPath:path,sourceDigest:revision,line1:2,columnScalar0:5,byteOffset:new TextEncoder().encode(content.slice(0,offset)).length,utf16Offset:offset};
const untrusted='<img src=x onerror="window.__compilerExecuted=true"><script>window.__compilerExecuted=true<\\/script>';
const longMessage='Die Übersetzung ist fehlgeschlagen. 無効な名前。 تعذر العثور على الاسم. '+('very-long-unbroken-'+('x'.repeat(70))+' ').repeat(20)+untrusted;
function envelope(mode='normal'){
  const incomplete=mode==='incomplete',truncated=mode==='truncated',many=mode==='many',outcome=mode==='unknown';
  const rows=incomplete?[]:many?Array.from({length:128},(_,i)=>({severity:i%2?'warning':'error',message:i===0?longMessage:'Bounded compiler row '+i+' '+untrusted,locationCandidate:i===0?point:i===1?{...point,projectPath:otherPath}:null})):[{severity:'error',message:'Undefined name '+untrusted,locationCandidate:point},{severity:'warning',message:'Other-file location is guidance only.',locationCandidate:{...point,projectPath:otherPath}},{severity:'warning',message:'No location '+untrusted,locationCandidate:null}];
  const value={compileDiagnosticsVersion:1,status:outcome?'outcome_unknown':'failed',error:{code:outcome?'outcome_unknown':'typst',message:'Compilation failed; previous PDF retained.'},report:{captureComplete:!incomplete,truncated,text:incomplete?'Incomplete capture; raw output only.':truncated?'Truncated capture; locations unavailable.':untrusted+'\\n'+('Compiler raw output line.\\n').repeat(many?1500:2),rows,sourceCandidates:incomplete?[]:[{projectPath:path,sourceDigest:revision,sourceEpoch:7},{projectPath:otherPath,sourceDigest:revision,sourceEpoch:8}],provenance:{project,expectedRoot:root,path:'main.typ',sourceEpoch:2,sourceDigest:mainRevision,mainRevision,nativeBuildId:id(2),instanceId:id(3)}}};
  if(mode==='stale-success'){value.status='succeeded';delete value.error;value.preview={available:true,base64:'JVBERi0=',pdfHash:'a'.repeat(64),revision:mainRevision,sourceEpoch:2,expectedRoot:root,current:false,diagnostics:'',dependencyCount:2,dependencyCoverage:'project',externalDependencyCount:0};}
  return value;
}
function install(mode='normal',current=true){
  let compilation;try{compilation=unwrapNativeCompile(envelope(mode),{action:'compile',project,path:'main.typ',sourceEpoch:2,expectedRoot:root,revision:mainRevision}).compileReport;}catch(error){if(!error.compileReport)throw error;compilation=error.compileReport;}
  const session=active,version=active.version,message=mode==='stale-success'?'Compiled main.typ successfully.\\nSource changes are newer than this PDF, inputs could not be verified, or require conflict resolution.':mode==='unknown'?'Build outcome unknown.':'Build failed; last-good PDF retained.';
  setCompileLog(message,compilation,current&&mode!=='stale-success'?()=>active===session&&active.version===version&&!active.dirty:null);setCompileLogs(true);
  // Observe settlement by delegating the exact existing handler, including its intentionally silent stale-session catch.
  for(const button of $('compile-diagnostics').querySelectorAll('button'))if(button.textContent.startsWith('Inspect line ')){const handler=button.onclick;button.onclick=async event=>{try{return await handler(event);}finally{navigationCompletions++;}};}
  return compilation;
}
$('fixture-show-log').onclick=()=>setCompileLogs(true);$('fixture-hide-log').onclick=()=>setCompileLogs(false);
observeReviewText(document.body);
window.fixture={install,envelope,content,path,otherPath,root,revision,offset,untrusted,longMessage,reads,effects,failures,retained,view,
  get active(){return active;},get compilation(){return currentCompileReport;},get inFlight(){return inFlight;},get iframeLoads(){return iframeLoads;},get navigationCompletions(){return navigationCompletions;},
  hold(){hold=true;},release(){release();},retire:retireCompileNavigation,
  raw(text){setCompileLog(text);setCompileLogs(true);},
  sameNodes(){return retained.editor===view.dom&&retained.iframe===$('manuscript-preview')&&retained.iframeSource===retained.iframe.srcdoc&&retained.canvas===document.querySelector('#typst-pages canvas')&&retained.bytes===pdfBytes;},
  replaceSession(){const next=new ReviewSession(snapshot,project,async()=>{throw Error('Never save from a diagnostic.');});active=next;sessions.set(keyFor(project,path),next);},
  showEditor(){document.querySelector('.review-workspace').dataset.mobileView='editor';},
};
`);

let browser, server, page, state = 'prepared', failure;
async function frames() { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); }
async function bounds(label) {
  const result = await page.evaluate(() => {
    const rect=node=>{const r=node.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,bottom:r.bottom,right:r.right};};
    const log=document.getElementById('compile-log'),pane=log.parentElement,toolbar=pane.querySelector('.preview-toolbar');
    const visible=node=>node.getClientRects().length&&getComputedStyle(node).visibility!=='hidden';
    const controls=[...pane.querySelectorAll('.preview-toolbar button,.compile-diagnostic button,summary,.text-details-button')].filter(visible).map(node=>({text:node.textContent||node.getAttribute('aria-label'),rect:rect(node),inLog:!!node.closest('#compile-log'),scrollWidth:node.scrollWidth,clientWidth:node.clientWidth}));
    return {viewport:{width:innerWidth,height:innerHeight},pane:rect(pane),toolbar:rect(toolbar),log:rect(log),logClient:{width:log.clientWidth,height:log.clientHeight,scrollWidth:log.scrollWidth,scrollHeight:log.scrollHeight},lineHeight:parseFloat(getComputedStyle(log).lineHeight),padding:parseFloat(getComputedStyle(log).paddingTop)+parseFloat(getComputedStyle(log).paddingBottom),controls,pageWidth:document.documentElement.scrollWidth,pageHeight:document.documentElement.scrollHeight,fit:[...log.querySelectorAll('[data-text-fit]')].map(node=>node.dataset.textFit)};
  });geometry.push({label,...result});return result;
}
function readable(result, allocated=false) {
  assert.ok(result.pageWidth<=result.viewport.width+1&&result.pageHeight<=result.viewport.height+1,JSON.stringify(result));
  assert.ok(result.log.width>0&&result.logClient.height>=result.lineHeight+result.padding,JSON.stringify(result));
  assert.ok(result.log.y>=result.toolbar.bottom-1&&result.log.bottom<=result.pane.bottom+1,JSON.stringify(result));
  assert.ok(result.logClient.scrollWidth<=result.logClient.width+1,JSON.stringify(result));
  if(allocated)assert.ok(Math.abs(result.pane.width-246)<1&&Math.abs(result.pane.height-227)<1,JSON.stringify(result));
  for(const control of result.controls){assert.ok(control.rect.width>0&&control.rect.height>0&&control.scrollWidth<=control.clientWidth+1,JSON.stringify(control));if(!control.inLog)assert.ok(control.rect.x>=result.pane.x-1&&control.rect.right<=result.pane.right+1&&control.rect.y>=result.pane.y-1&&control.rect.bottom<=result.pane.bottom+1,JSON.stringify(control));}
  assert.ok(result.fit.some(value=>['fit','reflow','details'].includes(value)),JSON.stringify(result));
}
async function inventory(directory,prefix='') { const result={};for(const item of await readdir(directory,{withFileTypes:true})){const name=prefix+item.name;if(item.isDirectory())Object.assign(result,await inventory(join(directory,item.name),name+'/'));else result[name]=hash(await readFile(join(directory,item.name)));}return result; }
try {
  await build({configFile:false,root:inputs,cacheDir:join(output,'cache'),logLevel:'error',build:{outDir:dist,rollupOptions:{input:join(inputs,'diagnostics.html')}}});
  if(!prepareOnly){
    state='running';server=createServer(async(request,response)=>{const name=resolve(dist,'.'+new URL(request.url,'http://localhost').pathname);if(relative(dist,name).startsWith('..')){response.writeHead(404).end();return;}try{const content=await readFile(name);response.setHeader('Content-Type',({'.html':'text/html','.js':'text/javascript','.css':'text/css'})[extname(name)]||'application/octet-stream');response.end(content);}catch{response.writeHead(404).end();}});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));browser=await chromium.launch({executablePath:process.env.UNDERTREE_CHROME||'/usr/bin/google-chrome',headless:true,args:['--no-sandbox']});page=await browser.newPage({viewport:{width:1280,height:800}});page.on('pageerror',error=>errors.push(error.message));await page.goto(`http://127.0.0.1:${server.address().port}/diagnostics.html`);await page.waitForFunction(()=>!!window.fixture);await page.evaluate(()=>document.fonts.ready);
    await page.waitForFunction(()=>fixture.iframeLoads>0);const iframeLoads=await page.evaluate(()=>fixture.iframeLoads);
    await page.evaluate(()=>fixture.install());await frames();
    assert.equal(await page.locator('.compile-diagnostic').count(),3);assert.equal(await page.locator('.compile-diagnostic button').filter({hasText:/^Inspect line/}).count(),1);assert.match(await page.locator('.compile-diagnostic').nth(1).textContent(),/Open this file locally and recompile/);assert.equal(await page.locator('#compile-log script,#compile-log img').count(),0);assert.equal(await page.evaluate(()=>window.__compilerExecuted===undefined),true);assert.equal(await page.evaluate(()=>document.getElementById('compile-raw').textContent.includes(fixture.untrusted)),true);
    const first=await page.evaluate(()=>({content:fixture.view.state.doc.toString(),snapshot:fixture.active.snapshot,dirty:fixture.active.dirty,selection:fixture.view.state.selection.toJSON()}));
    await page.getByRole('button',{name:'Inspect line 2',exact:true}).click();await page.waitForFunction(()=>fixture.reads.length===1&&fixture.inFlight===0&&fixture.view.state.selection.main.head===fixture.offset);await frames();
    assert.equal(await page.evaluate(()=>fixture.view.state.selection.main.head===fixture.offset),true);assert.equal(await page.evaluate(()=>fixture.view.state.doc.toString()),first.content);assert.equal(await page.evaluate(()=>fixture.active.dirty),false);assert.equal(await page.evaluate(()=>fixture.reads.every(request=>request.action==='review'&&request.sourceEpoch===7&&request.expectedRoot.dev===fixture.root.dev&&request.expectedRoot.ino===fixture.root.ino&&request.path===fixture.path)),true);
    checks.push('Exact source log renderer uses literal text and other-file guidance; actual CM navigation selects only an exact active-clean source after one explicitly synthetic bound Review and real WebCrypto digests.');

    for(const newer of ['selection','typing','log-scroll','session']){
      await page.evaluate(mode=>{fixture.install(mode);fixture.hold();},newer==='log-scroll'?'many':'normal');await frames();const count=await page.evaluate(()=>fixture.reads.length),completionCount=await page.evaluate(()=>fixture.navigationCompletions);await page.getByRole('button',{name:'Inspect line 2',exact:true}).click();await page.waitForFunction(n=>fixture.inFlight===1&&fixture.reads.length===n+1,count);
      if(newer==='selection')await page.evaluate(()=>fixture.view.dispatch({selection:{anchor:1}}));
      else if(newer==='typing'){await page.locator('#manuscript-source .cm-line').first().click();await page.keyboard.press('x');}
      else if(newer==='log-scroll'){const previous=await page.locator('#compile-log').evaluate(node=>node.scrollTop);await page.locator('#compile-log').evaluate(node=>{node.scrollTop+=20;});assert.notEqual(await page.locator('#compile-log').evaluate(node=>node.scrollTop),previous,'The held-response control must observe an actual scroll change.');}
      else await page.evaluate(()=>fixture.replaceSession());
      const held=await page.evaluate(()=>({state:fixture.view.state.selection.toJSON(),text:fixture.view.state.doc.toString(),effects:fixture.effects.length}));await page.evaluate(()=>fixture.release());await page.waitForFunction(n=>fixture.inFlight===0&&fixture.navigationCompletions===n+1,completionCount);await frames();
      assert.deepEqual(await page.evaluate(()=>fixture.view.state.selection.toJSON()),held.state);assert.equal(await page.evaluate(()=>fixture.view.state.doc.toString()),held.text);assert.equal(await page.evaluate(()=>fixture.effects.length),held.effects);
      // Restore this synthetic presentation context only; this is not source adoption or a product resolver.
      await page.evaluate(()=>{if(fixture.view.state.doc.toString()!==fixture.content)fixture.view.dispatch({changes:{from:0,to:fixture.view.state.doc.length,insert:fixture.content}});fixture.active.content=fixture.content;fixture.active.savedVersion=fixture.active.version;document.getElementById('compile-log').scrollTop=0;});
    }
    checks.push('Held synthetic Review replies cannot override newer real CM selection/typing, log scroll or replaced session; no save queue or second observation is exposed.');

    for(const mode of ['incomplete','truncated','unknown']){
      await page.evaluate(mode=>fixture.install(mode),mode);await frames();
      assert.match(await page.locator('#compile-report-status').textContent(),mode==='unknown'?/outcome is unknown/:/locations are unavailable/);
      if(mode==='incomplete')assert.equal(await page.locator('.compile-diagnostic').count(),0);
      else if(mode==='truncated')assert.equal(await page.getByRole('button',{name:'Inspect line 2',exact:true}).isDisabled(),true);
      assert.equal(await page.evaluate(()=>fixture.sameNodes()),true);
    }
    await page.evaluate(()=>fixture.install('stale-success'));assert.equal(await page.getByRole('button',{name:'Inspect line 2',exact:true}).isDisabled(),true);assert.match(await page.locator('#compile-raw').textContent(),/Source changes are newer than this PDF, inputs could not be verified/);assert.equal(await page.evaluate(()=>fixture.sameNodes()),true);
    await page.evaluate(()=>fixture.install());await page.evaluate(()=>fixture.retire());assert.equal(await page.getByRole('button',{name:'Inspect line 2',exact:true}).isDisabled(),true);assert.match(await page.locator('#compile-report-status').textContent(),/context changed/);
    await page.evaluate(()=>fixture.raw('r'.repeat(140000)));assert.equal(await page.evaluate(()=>document.getElementById('compile-raw').textContent.endsWith('[Output truncated for display.]')),true);assert.ok(await page.locator('#compile-raw').evaluate(node=>new TextEncoder().encode(node.textContent).length)<=131110);
    checks.push('Incomplete capture is text-only; truncated and stale locations are disabled; uncertain status is honest, raw text is bounded, and last-good preview nodes/bytes stay retained.');

    await page.evaluate(()=>fixture.install('many'));assert.equal(await page.locator('.compile-diagnostic').count(),128);await frames();
    for(const [width,height,font,allocated]of[[1280,800,14,false],[320,720,14,false],[320,720,28,false],[1100,480,28,false],[1100,480,28,true],[1280,800,14,false]]){
      await page.setViewportSize({width,height});await page.evaluate(({font,allocated})=>{document.documentElement.style.fontSize=font+'px';const pane=document.querySelector('.manuscript-preview');pane.style.inlineSize=allocated?'246px':'';pane.style.blockSize=allocated?'227px':'';document.getElementById('compile-log').scrollTop=0;},{font,allocated});await frames();readable(await bounds(`${width}x${height}@${font}${allocated?'-allocated246x227':''}`),allocated);
      const button=page.getByRole('button',{name:/^Compiler diagnostic:/}).first();await button.waitFor();await button.click();const dialog=page.locator('.text-details-dialog[open]');await dialog.waitFor();assert.equal(await dialog.locator('.text-details-message').textContent(),await page.evaluate(()=>'Error: '+fixture.longMessage));assert.equal(await dialog.locator('script,img').count(),0);
      const dialogBounds=await dialog.evaluate(node=>{const r=node.getBoundingClientRect(),close=node.querySelector('button').getBoundingClientRect();return {top:r.top,bottom:r.bottom,right:r.right,width:r.width,clientWidth:node.clientWidth,scrollWidth:node.scrollWidth,closeHeight:close.height,viewport:{width:innerWidth,height:innerHeight}};});assert.ok(dialogBounds.top>=-1&&dialogBounds.bottom<=height+1&&dialogBounds.right<=width+1&&dialogBounds.closeHeight>0&&dialogBounds.scrollWidth<=dialogBounds.clientWidth+1,JSON.stringify(dialogBounds));
      await dialog.getByRole('button',{name:'Close',exact:true}).click();
      const location=page.getByRole('button',{name:/^Compiler location candidate:/}).first();await location.click();assert.equal(await page.locator('.text-details-dialog[open] .text-details-message').textContent(),await page.evaluate(()=>fixture.path+' · line 2, scalar column 5'));await page.locator('.text-details-dialog[open]').getByRole('button',{name:'Close',exact:true}).click();
      const last=page.locator('.compile-diagnostic').last();await last.scrollIntoViewIfNeeded();assert.equal(await last.isVisible(),true);await page.locator('.compile-raw-output > summary').scrollIntoViewIfNeeded();assert.equal(await page.locator('.compile-raw-output > summary').isVisible(),true);assert.equal(await page.evaluate(()=>fixture.sameNodes()),true);await page.screenshot({path:join(output,`diagnostics-${width}-${height}-${font}-${allocated}.png`)});
    }
    checks.push('128 bounded rows and long localized messages/paths stay reachable via real Pretext/full-value dialogs in246x227,320/200%,wide-short and regrowth; content scrolls while finite toolbar and page remain contained.');
    await page.locator('#fixture-hide-log').click();assert.equal(await page.locator('#typst-preview').isVisible(),true);assert.equal(await page.evaluate(()=>fixture.sameNodes()),true);assert.equal(await page.evaluate(()=>fixture.iframeLoads),iframeLoads,'Showing logs must not navigate the retained sandboxed iframe.');await page.evaluate(()=>fixture.showEditor());await page.locator('#manuscript-source .cm-line').first().click();const unchanged=await page.evaluate(()=>fixture.view.state.doc.toString());await page.keyboard.press('x');assert.notEqual(await page.evaluate(()=>fixture.view.state.doc.toString()),unchanged);await page.keyboard.press('Control+z');assert.equal(await page.evaluate(()=>fixture.view.state.doc.toString()),unchanged);
    assert.deepEqual(errors,[]);assert.equal(await page.evaluate(()=>window.__compilerExecuted===undefined),true);state='passed';
  }
}catch(error){state='failed';failure={name:error.name,message:error.message};if(page){await bounds('failure-before-cleanup').catch(()=>{});await page.screenshot({path:join(output,'failure.png')}).catch(()=>{});}throw error;
}finally{
  await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));await guard();
  await writeFile(join(output,'receipt.json'),JSON.stringify({state,proof:'Presentation only: exact source fragments/HTML, actual CodeMirror/Pretext, explicitly synthetic native-shaped envelopes and bound Review replies. No native/main compiler or actual PDF parse proof.',runnerSha256:hash(await readFile(new URL(import.meta.url))),inputFreeze,sources:hashes,protectedInputs,fragments,build:await inventory(dist),checks,geometry,errors,failure,cleanup:{browserCloseAwaited:!!browser,serverCloseAwaited:!!server},inputsUnchanged:true},null,2)+'\n');
}
