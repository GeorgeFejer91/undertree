import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, copyFile, symlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { resolve, dirname, join, extname, relative } from 'node:path';
import { build } from 'vite';
import { chromium } from 'playwright-core';

// Presentation fixtures exercise real CM/Pretext/panel code, not native History authority.
const source = resolve(process.env.UNDERTREE_HISTORY_SOURCE || '.'), output = resolve(process.env.UNDERTREE_HISTORY_EVIDENCE || `artifacts/history-ui-presentation-${Date.now()}`);
const inputs = join(output, 'inputs'), dist = join(output, 'dist');
const files = ['src/history-panel.js', 'src/history-panel.css', 'src/manuscript.css', 'manuscript.html', 'modules/frontend/history-controller.js', 'modules/frontend/review-session.js', 'modules/frontend/review-text-layout.js', 'modules/frontend/text-details.js'];
const hash = bytes => createHash('sha256').update(bytes).digest('hex'), hashes = {}, checks = [], errors = [], geometry = [];
let browser, server, page;
async function bounds(label) {
  const result = await page.evaluate(() => {
    const rect=node=>{const r=node.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,bottom:r.bottom,right:r.right};};
    const panel=document.querySelector('#history-panel'), body=document.querySelector('#history-body'), back=document.querySelector('#history-back'), summary=panel.querySelector('.history-navigation > summary'), title=document.querySelector('#history-title');
    const scrollers=[...panel.querySelectorAll('.history-saved-text .cm-scroller')].filter(node=>node.closest('.history-version').getBoundingClientRect().height>0).map(node=>{
      const content=node.querySelector('.cm-content'),style=getComputedStyle(content),line=getComputedStyle(node.querySelector('.cm-line')||content);
      return {rect:rect(node),clientHeight:node.clientHeight,lineHeight:parseFloat(line.lineHeight),padding:parseFloat(style.paddingTop)+parseFloat(style.paddingBottom)};
    });
    return {viewport:{width:innerWidth,height:innerHeight},panel:rect(panel),body:rect(body),back:rect(back),navigation:rect(summary),title:{rect:rect(title),lineHeight:parseFloat(getComputedStyle(title).lineHeight)},scrollers,pageWidth:document.documentElement.scrollWidth,pageHeight:document.documentElement.scrollHeight,fit:[...panel.querySelectorAll('[data-text-fit]')].map(node=>node.dataset.textFit)};
  }); geometry.push({label,...result}); return result;
}
function readable(result) {
  assert.ok(result.scrollers.length>0,JSON.stringify(result));
  assert.ok(result.title.rect.height>0&&result.title.rect.height<=result.title.lineHeight+1,JSON.stringify(result));
  for(const scroller of result.scrollers)assert.ok(scroller.clientHeight+1>=scroller.lineHeight+scroller.padding,JSON.stringify(result));
  for(const control of [result.back,result.navigation])assert.ok(control.width>0&&control.height>0&&control.y>=result.panel.y-1&&control.bottom<=result.panel.bottom+1&&control.x>=result.panel.x-1&&control.right<=result.panel.right+1,JSON.stringify(result));
  assert.ok(result.pageWidth<=result.viewport.width+1&&result.pageHeight<=result.viewport.height+1,JSON.stringify(result));
  assert.ok(result.fit.some(value=>['fit','reflow','details'].includes(value)),JSON.stringify(result));
}
await mkdir(inputs, { recursive: true });
for (const name of files) { await mkdir(dirname(join(inputs, name)), { recursive: true }); await copyFile(join(source, name), join(inputs, name)); hashes[name] = hash(await readFile(join(inputs, name))); }
await symlink(join(source, 'node_modules'), join(inputs, 'node_modules'), 'dir');
const manuscript = await readFile(join(inputs, 'manuscript.html'), 'utf8');
const panel = manuscript.slice(manuscript.indexOf('<section id="history-panel"'), manuscript.indexOf('<div class="pane-heading preview-toolbar"'));
assert.ok(panel.endsWith('        '), 'use the actual bounded History DOM from the supplied source');
await writeFile(join(inputs, 'history.html'), `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
#fixture-actions{display:flex;gap:.4rem;padding:.4rem;background:var(--chrome);color:white;flex:none}.review-workspace{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}.manuscript-editor{grid-column:1}.manuscript-preview{grid-column:2}
</style></head><body><main id="review-app"><div id="fixture-actions"><button id="fixture-open">History</button><span>Presentation fixture · no native History</span></div><section class="review-workspace" data-mobile-view="preview"><section class="manuscript-editor"><div id="manuscript-source"></div></section><section class="manuscript-preview">${panel}<div class="pane-heading preview-toolbar">Retained preview</div><iframe id="manuscript-preview" title="Retained preview" srcdoc="<p>Last good HTML</p>"></iframe><div id="typst-preview" hidden><canvas width="200" height="100"></canvas></div></section></section></main><script type="module" src="/fixture.js"></script></body></html>`);
await writeFile(join(inputs, 'fixture.js'), `import '/src/manuscript.css';
import { HistoryPanel } from '/src/history-panel.js';
import { observeReviewText } from '/modules/frontend/review-text-layout.js';
import { EditorView, basicSetup } from 'codemirror';
import { EditorState } from '@codemirror/state';
const id=n=>'00000000-0000-0000-0000-'+String(n).padStart(12,'0'), root={dev:'9007199254740993',ino:'18446744073709551615'}, project=id(1), namespace=id(2), source=id(3);
const path=Array.from({length:5},(_,i)=>'long-folder-'+i+'-'.repeat(25)).join('/')+'/chapter.typ';
const encoder=new TextEncoder(), sha=async text=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(text))),b=>b.toString(16).padStart(2,'0')).join('');
// ASCII payloads make the exact2MiB logical boundary independent of Unicode slicing.
const bigA=('Earlier archive line.\\n').repeat(110000).slice(0,2097152), bigB=('Later archive line..\\n').repeat(110000).slice(0,2097152);
const texts=['Saved earlier source.\\n','Saved later source.\\n',bigA,bigB], versions=[];
for(let i=0;i<texts.length;i++) versions.push({versionId:id(i+4),namespaceId:namespace,sourceId:source,binding:{projectId:project,root,path,sourceEpoch:7},sha256:await sha(texts[i]),bytes:encoder.encode(texts[i]).length,sequence:String(i+4),capturedAtMs:null,recordedAtMs:null,clockAdjusted:false,afterRecovery:false,cause:'native_save',suggestionId:null});
const live=new EditorView({parent:document.querySelector('#manuscript-source'),state:EditorState.create({doc:('Live current draft line.\\n').repeat(100),extensions:[basicSetup,EditorView.updateListener.of(update=>{if(update.docChanged){current.session.generation++;current.session.content=update.state.doc.toString();}})]})});
const current={session:{content:live.state.doc.toString(),dirty:true,generation:1},viewToken:live,editor:live,projectId:project,root,path,sourceEpoch:7};
const calls=[], visibility=[], savedViews=[], retained={iframe:document.querySelector('iframe'),canvas:document.querySelector('canvas'),source:live.dom}; let hold=false, release, inFlight=0, intents=0;
const saved=versionId=>{const i=versions.findIndex(v=>v.versionId===versionId);return {version:versions[i],content:texts[i]};};
const answer=query=>query.action==='list'?{kind:'list',result:{generation:'9007199254740993',namespaceId:query.observedRoot||query.namespaceId?namespace:null,items:query.sourceId?versions.map(version=>({kind:'version',version})):query.observedRoot||query.namespaceId?[{kind:'source',namespaceId:namespace,sourceId:source,path,sourceEpoch:7}]:[{kind:'namespace',namespaceId:namespace,projectId:project,root}],cursor:null}}:query.action==='read'?{kind:'read',result:saved(query.versionId)}:{kind:'compare',result:{from:saved(query.fromVersionId),to:saved(query.toVersionId),fromChanged:{fromUtf16:0,toUtf16:saved(query.fromVersionId).content.length},toChanged:{fromUtf16:0,toUtf16:saved(query.toVersionId).content.length},method:'coarse_text_comparison'}};
const history=new HistoryPanel({root:document.querySelector('#history-panel'),context:()=>current,owner:async()=> 'fixture-owner',request:async query=>{calls.push(query);inFlight++;try{if(hold)await new Promise(resolve=>{release=resolve;});return answer(query);}finally{inFlight--;hold=false;}},intent:()=>{intents++;},visibility:value=>{visibility.push(value);document.querySelector('.manuscript-preview').classList.toggle('history-visible',value);},back:editor=>editor?.contentDOM.focus({preventScroll:true})});
document.querySelector('#fixture-open').onclick=()=>history.open(); observeReviewText(document.body);
window.fixture={history,live,current,calls,retained,versions,visibility,get inFlight(){return inFlight;},get intents(){return intents;},hold(){hold=true;},release(){release();},sameNodes(){return retained.iframe===document.querySelector('iframe')&&retained.canvas===document.querySelector('canvas')&&retained.source===live.dom;}};
`);

try {
  await build({ configFile: false, root: inputs, cacheDir: join(output, 'cache'), logLevel: 'error', build: { outDir: dist, rollupOptions: { input: join(inputs, 'history.html') } } });
  server = createServer(async (request, response) => {
    const name = resolve(dist, '.' + new URL(request.url, 'http://localhost').pathname);
    if (relative(dist, name).startsWith('..')) { response.writeHead(404).end(); return; }
    try { const content = await readFile(name); response.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' })[extname(name)] || 'application/octet-stream'); response.end(content); }
    catch { response.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  browser = await chromium.launch({ executablePath: process.env.UNDERTREE_CHROME || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
  page = await browser.newPage({ viewport: { width: 1280, height: 800 } }); page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/history.html`); await page.waitForFunction(() => !!window.fixture);
  const open = async () => { await page.locator('#fixture-open').click(); await page.locator('#history-list .history-row > button').first().waitFor(); await bounds('before-source-navigation'); };
  const browse = async () => { await open(); await page.locator('#history-list .history-row > button').first().click(); await page.locator('[data-version-id]').first().waitFor(); };
  await browse();
  const before = await page.evaluate(() => ({ text: fixture.live.state.doc.toString(), selection: fixture.live.state.selection.toJSON(), dom: fixture.sameNodes() }));
  await page.evaluate(() => fixture.hold()); await page.locator('[data-version-id] button').first().click(); await page.waitForFunction(() => fixture.inFlight === 1);
  await page.locator('#manuscript-source .cm-content').focus(); await page.keyboard.insertText('Newer typing ');
  await page.evaluate(() => { fixture.current.session.savedVersion=fixture.current.session.generation; fixture.release(); });
  await page.locator('#history-result .cm-editor').waitFor();
  assert.equal(await page.locator('#history-result .cm-content').getAttribute('contenteditable'), 'false');
  const liveBeforeReadonlyKey = await page.evaluate(() => fixture.live.state.doc.toString());
  await page.locator('#history-result .cm-line').first().click(); await page.keyboard.press('x');
  assert.equal(await page.evaluate(() => fixture.history.views[0].state.doc.toString()), 'Saved earlier source.\n');
  assert.equal(await page.evaluate(() => fixture.live.state.doc.toString()), liveBeforeReadonlyKey, 'typing in the saved readonly view must not change the live editor');
  assert.equal(await page.evaluate(() => fixture.live.state.doc.toString().startsWith('Newer typing ')), true);
  assert.equal(await page.locator('iframe').isVisible(), false); assert.equal(await page.evaluate(() => fixture.sameNodes()), true);
  await page.locator('#history-back').click(); assert.equal(await page.locator('#history-panel').isVisible(), false);
  assert.equal(await page.locator('iframe').isVisible(), true); assert.equal(await page.evaluate(() => fixture.sameNodes()), true);
  await page.keyboard.press('Control+z'); assert.equal(await page.evaluate(() => fixture.live.state.doc.toString()), before.text);
  await page.keyboard.press('Control+Shift+z'); assert.equal(await page.evaluate(() => fixture.live.state.doc.toString().startsWith('Newer typing ')), true);
  checks.push('real live CodeMirror remains mounted/writable with Undo/Redo during held saved read; saved text read-only and retained preview nodes survive Back');

  await browse(); await page.evaluate(() => fixture.hold()); await page.locator('[data-version-id] button').first().click(); await page.waitForFunction(() => fixture.inFlight === 1);
  await page.locator('#history-back').click(); await page.evaluate(() => fixture.release()); await page.waitForFunction(() => fixture.inFlight === 0);
  assert.equal(await page.locator('#history-panel').isVisible(), false); assert.equal(await page.locator('#history-result .cm-editor').count(), 0);
  await browse(); await page.evaluate(() => fixture.hold()); await page.locator('[data-version-id] button').first().click(); await page.waitForFunction(() => fixture.inFlight === 1);
  await page.evaluate(() => { fixture.current.session={...fixture.current.session};fixture.current.sourceEpoch=8;fixture.history.changed();fixture.release(); });
  await page.waitForFunction(() => fixture.inFlight === 0); assert.match(await page.locator('#history-status').textContent(), /identity changed/); assert.equal(await page.locator('#history-result .cm-editor').count(), 0);
  await page.locator('#history-back').click(); await page.evaluate(() => { fixture.current.sourceEpoch=7; });
  checks.push('genuine held fixture replies cannot repaint after Back or synthetic session/epoch replacement; no live native retirement claim');

  // Exact allocated native-sized pane, distinct from a viewport lacking native chrome.
  await page.setViewportSize({width:1100,height:480});
  await page.evaluate(()=>{document.documentElement.style.fontSize='28px';const pane=document.querySelector('.manuscript-preview');pane.style.blockSize='227px';const style=getComputedStyle(pane);pane.style.inlineSize=(246+parseFloat(style.borderInlineStartWidth)+parseFloat(style.borderInlineEndWidth))+'px';});
  await browse(); await page.locator('[data-version-id] button').first().click(); await page.locator('#history-result .cm-editor').waitFor();
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  const shortRead=await bounds('allocated246x227-single-read');assert.ok(Math.abs(shortRead.panel.height-227)<1&&Math.abs(shortRead.panel.width-246)<1);readable(shortRead);
  await page.locator('.history-navigation > summary').click();
  await page.getByRole('button',{name:/^History details:/}).click();await page.locator('.text-details-dialog[open]').waitFor();
  const details=await page.locator('.text-details-dialog[open] .text-details-message').textContent();assert.match(details,/long-folder-0/);assert.match(details,/Version 4/);assert.match(details,/Saved versions only/);
  await page.locator('.text-details-dialog[open] button').click();await page.locator('.history-navigation > summary').click();
  await page.screenshot({path:join(output,'allocated-single-read.png')});await page.locator('#history-back').click();
  await page.setViewportSize({width:1280,height:800});await page.evaluate(()=>{document.documentElement.style.fontSize='14px';const pane=document.querySelector('.manuscript-preview');pane.style.blockSize='';pane.style.inlineSize='';});
  checks.push('ordinary long-path navigation and one actual saved CM line plus padding fit246x227/28px; compact metadata opens a full readable details dialog');

  await browse(); await page.locator('[data-version-id] input').nth(2).check(); await page.locator('[data-version-id] input').nth(3).check();
  assert.equal(await page.locator('[data-version-id] input').first().isDisabled(), true); await page.locator('#history-compare').click(); await page.locator('#history-result .cm-editor').first().waitFor();
  const virtualization = await page.evaluate(() => ({ lengths:fixture.history.views.map(view=>view.state.doc.length), lines:document.querySelectorAll('#history-result .cm-line').length, views:fixture.history.views.length }));
  assert.deepEqual(virtualization.lengths, [2097152,2097152]); assert.equal(virtualization.views, 2); assert.ok(virtualization.lines < 600, JSON.stringify(virtualization));
  checks.push('actual two2MiB read-only CodeMirror payloads virtualize instead of expanding archive lines into DOM');

  for (const [width,height,font,paneWidth,paneHeight,editorFont=14] of [[1280,800,14],[320,720,14],[320,720,28],[1100,480,28],[1100,480,28,246,227],[1100,480,28,246,227,28],[901,700,14],[1280,800,14]]) {
    await page.setViewportSize({width,height}); await page.evaluate(({font,paneWidth,paneHeight,editorFont})=>{
      document.documentElement.style.fontSize=font+'px';document.querySelector('#review-app').style.setProperty('--source-font-size',(editorFont/14)+'rem');
      const pane=document.querySelector('.manuscript-preview'),style=getComputedStyle(pane);pane.style.inlineSize=paneWidth?(paneWidth+parseFloat(style.borderInlineStartWidth)+parseFloat(style.borderInlineEndWidth))+'px':'';pane.style.blockSize=paneHeight?paneHeight+'px':'';
    },{font,paneWidth,paneHeight,editorFont}); await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    if (width <= 900 || width === 1100) { await page.locator('.history-comparison-tabs button').last().click(); }
    const measured=await bounds(`compare-${width}-${height}-${font}-${paneWidth||'auto'}-font${editorFont}`);readable(measured);
    if(paneWidth){
      assert.ok(Math.abs(measured.panel.height-paneHeight)<1&&Math.abs(measured.panel.width-paneWidth)<1);
      await page.locator('.history-comparison-tabs button').first().click();await page.evaluate(()=>new Promise(requestAnimationFrame));readable(await bounds('allocated-earlier'));
      await page.locator('.history-navigation > summary').click();await page.getByRole('button',{name:/^History details:/}).click();
      const comparisonDetails=await page.locator('.text-details-dialog[open] .text-details-message').textContent();assert.match(comparisonDetails,/Earlier: Version 6/);assert.match(comparisonDetails,/Later: Version 7/);assert.match(comparisonDetails,/Coarse changed region highlighted/);
      await page.locator('.text-details-dialog[open] button').click();await page.locator('.history-navigation > summary').click();
    }
    assert.equal(await page.evaluate(()=>fixture.sameNodes()),true);
    await page.screenshot({path:join(output,`history-${width}-${height}-${font}-${paneWidth||'auto'}-font${editorFont}.png`)});
  }
  await page.locator('#history-back').focus(); await page.keyboard.press('Escape'); assert.equal(await page.locator('#history-panel').isVisible(), false);
  assert.ok(await page.evaluate(()=>fixture.calls.every(query=>['list','read','compare'].includes(query.action)))); assert.deepEqual(errors,[]);
  checks.push('320/200%, short native-sized container, breakpoint and regrowth keep readable bounded chrome/content with real Pretext and keyboard Back');
  for(const name of files)assert.equal(hash(await readFile(join(inputs,name))),hashes[name],name);
  console.log(JSON.stringify({checks,geometry,virtualization,proof:'rendered presentation with explicit synthetic catalog; no native History qualification'},null,2));
} catch(error) {
  if(page)await bounds('failure-before-cleanup').catch(()=>{});
  if(page)await page.screenshot({path:join(output,'failure.png')}).catch(()=>{});
  await writeFile(join(output,'failure.json'),JSON.stringify({message:error.message,checks,geometry,errors},null,2)); throw error;
} finally {
  await browser?.close(); if(server)await new Promise(resolve=>server.close(resolve));
  await writeFile(join(output,'receipt.json'),JSON.stringify({proof:'presentation-only; copied source, actual CM/Pretext, synthetic catalog replies; no native backend',runnerSha256:hash(await readFile(new URL(import.meta.url))),inputs:hashes,checks,geometry,errors},null,2));
}
