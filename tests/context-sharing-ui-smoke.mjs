import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {build} from 'vite';
import {chromium} from 'playwright-core';

// Bundle only the real consent owner and shared text measurement, away from dist.
const output=resolve('artifacts/marker-access/context-pagination');await mkdir(output,{recursive:true});
const entry=`import {setupContextSharing} from '${resolve('src/context-sharing.js').replaceAll('\\','/')}';
import {observeReviewText} from '${resolve('modules/frontend/review-text-layout.js').replaceAll('\\','/')}';
window.calls=[];window.guardError='';const controller=setupContextSharing({request:async operation=>{window.calls.push(operation);if(operation.action!=='context_preview')throw Error('Unexpected mutation');return window.scope;}});
observeReviewText(document.body);document.getElementById('context-share-cancel').onclick=()=>document.getElementById('context-share-dialog').close();
window.start=scope=>{window.scope=scope;window.result=undefined;window.guardError='';void controller.confirm({binding:{path:scope.main},assertCurrent(){if(window.guardError)throw Error(window.guardError);}}).then(result=>{window.result=result;window.exactReceipt=result===scope;});};`;
await writeFile(output+'/entry.js',entry);
const results=await build({configFile:false,logLevel:'error',build:{write:false,lib:{entry:output+'/entry.js',formats:['es']},minify:false}});
const bundle=(Array.isArray(results)?results[0]:results).output.find(item=>item.type==='chunk').code;
const html=await readFile('manuscript.html','utf8'),css=await readFile('src/manuscript.css','utf8');
const dialog=html.match(/<dialog id="context-share-dialog"[\s\S]*?<\/dialog>/)[0];
const pageHtml=`<!doctype html><html lang="en"><head><meta charset="UTF-8"><style>${css}</style></head><body>${dialog}<script type="module" src="/bundle.js"></script></body></html>`;
await writeFile(output+'/bundle.js',bundle);await writeFile(output+'/index.html',pageHtml);
const server=createServer((request,response)=>{response.setHeader('Content-Type',request.url==='/bundle.js'?'text/javascript':'text/html');response.end(request.url==='/bundle.js'?bundle:pageHtml);});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const scope={scopeId:'b'.repeat(64),main:'main.typ',snapshot:'saved',complete:true,files:Array.from({length:512},(_,index)=>({path:index===0?'main.typ':`chapters/${index}/`+'measured-é-日本語-👨‍👩‍👧‍👦/'.repeat(32)+'chapter.typ',revision:'a'.repeat(64),sourceEpoch:index}))};
scope.files[1].path='chapters/'+'long-unbroken-path-'.repeat(230).slice(0,4081)+'😀.typ';assert.equal(scope.files[1].path.length,4096);
const observations=[],errors=[];let browser,page;
async function ready() {
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  await page.waitForFunction(()=>['fit','no-fit'].includes(document.getElementById('context-share-dialog').dataset.contextFit));
}
async function bounds(label) {
  await ready();
  const result=await page.evaluate(()=>{
    const dialog=document.getElementById('context-share-dialog'),rect=dialog.getBoundingClientRect();
    const regions=[dialog,document.getElementById('context-share-form'),document.querySelector('.context-share-body'),document.getElementById('context-share-content'),...dialog.querySelectorAll('button,select,[data-measure],#context-share-content > :not([hidden])')].filter(node=>node.getClientRects().length);
    const heading=document.getElementById('context-share-title').getBoundingClientRect(),body=document.querySelector('.context-share-body').getBoundingClientRect(),footer=dialog.querySelector('.dialog-actions').getBoundingClientRect();
    return {fit:dialog.dataset.contextFit,measurement:dialog.dataset.contextMeasurement,viewport:[innerWidth,innerHeight],rect:{x:rect.x,y:rect.y,right:rect.right,bottom:rect.bottom},
      ordered:heading.bottom<=body.top+1&&body.bottom<=footer.top+1,contentHeight:document.getElementById('context-share-content').clientHeight,groupGap:getComputedStyle(document.getElementById('context-share-form')).rowGap,
      overflow:regions.filter(node=>node.scrollWidth>node.clientWidth+1||node.scrollHeight>node.clientHeight+2).map(node=>({id:node.id||node.className,width:node.clientWidth,scrollWidth:node.scrollWidth,height:node.clientHeight,scrollHeight:node.scrollHeight})),
      scrollAreas:regions.filter(node=>['auto','scroll'].includes(getComputedStyle(node).overflowY)||['auto','scroll'].includes(getComputedStyle(node).overflowX)).map(node=>node.id),
      labels:[...dialog.querySelectorAll('[data-measure]')].filter(node=>node.getClientRects().length).map(node=>({text:node.textContent,fit:node.dataset.textFit})),
      cancelVisible:document.getElementById('context-share-cancel').getBoundingClientRect().bottom<=rect.bottom,
      shareDisabled:document.getElementById('context-share-submit').disabled};
  });
  observations.push({label,...result});
  assert.deepEqual(result.overflow,[],`${label}: ${JSON.stringify(result)}`);assert.deepEqual(result.scrollAreas,[],label);
  assert.ok(result.rect.x>=0&&result.rect.y>=0&&result.rect.right<=result.viewport[0]+1&&result.rect.bottom<=result.viewport[1]+1,label);
  assert.equal(result.cancelVisible,true,label);
  assert.equal(result.ordered,true,label);
  if(result.fit==='no-fit') assert.equal(result.shareDisabled,true,label);
  for(const text of result.labels) assert.ok(['fit','reflow','unavailable'].includes(text.fit),JSON.stringify(text));
  return result;
}
async function recoverSection(index) {
  await page.locator('#context-share-location').selectOption(String(index));await ready();
  let recovered='',chunks=0;
  while(true) {
    const part=await page.evaluate(()=>{const content=document.querySelector('#context-share-content > :not([hidden])');const node=content.tagName==='UL'?content.firstElementChild:content;return {text:node.textContent,start:Number(node.dataset.start),end:Number(node.dataset.end),section:Number(document.getElementById('context-share-location').value)};});
    assert.equal(part.section,index);assert.equal(part.start,recovered.length);assert.ok(part.end>part.start);recovered+=part.text;chunks++;
    const expected=index===0?null:index===1?null:scope.files[index-2].path;
    if(expected&&recovered===expected) break;
    const hasMore=await page.evaluate(()=>{const node=document.querySelector('#context-share-content > :not([hidden])');const text=node.tagName==='UL'?node.firstElementChild:node;return Number(text.dataset.end);});
    if(!expected) return {recovered,chunks,hasMore};
    assert.ok(chunks<1000);await page.locator('#context-share-next').click();await ready();
  }
  return {recovered,chunks};
}
try {
  browser=await chromium.launch({executablePath:process.env.UNDERTREE_CHROME||(process.platform==='win32'?'C:/Program Files/Google/Chrome/Application/chrome.exe':'/usr/bin/google-chrome'),headless:true});
  page=await browser.newPage({viewport:{width:1440,height:900}});page.on('pageerror',error=>errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);await page.waitForFunction(()=>typeof window.start==='function');
  await page.evaluate(scope=>window.start(scope),scope);await page.locator('#context-share-dialog').waitFor();
  assert.equal(await page.locator('#context-share-cancel').evaluate(node=>node===document.activeElement),true,'Cancel receives initial focus');
  await bounds('512-file scope, desktop');
  await page.locator('#context-share-next').focus();await page.keyboard.press('Space');await ready();
  assert.equal(await page.locator('#context-share-location').inputValue(),'1','keyboard Next reads the saved snapshot after the instructions');
  await page.locator('#context-share-back').focus();await page.keyboard.press('Space');await ready();
  assert.equal(await page.locator('#context-share-location').inputValue(),'0','keyboard Back returns to the previous section');
  assert.deepEqual(await page.locator('#context-share-location option[data-path]').evaluateAll(options=>options.map(option=>option.dataset.path)),scope.files.map(file=>file.path));
  const maximum=await recoverSection(3);assert.equal(maximum.recovered,scope.files[1].path);
  for(let index=0;index<scope.files.length;index++) assert.equal((await recoverSection(index+2)).recovered,scope.files[index].path);
  const matrix=[[320,900,14],[1440,375,14],[320,600,28],[667,375,28],[320,375,28],[1440,900,14]];
  for(const [width,height,font] of matrix) {
    await page.setViewportSize({width,height});await page.evaluate(font=>document.documentElement.style.fontSize=font+'px',font);
    const result=await bounds(`${width}x${height}, ${font}px`);
    if(result.fit==='fit') assert.equal((await recoverSection(513)).recovered,scope.files.at(-1).path);
    else assert.equal(await page.locator('#context-share-resize').isVisible(),true);
  }
  await page.setViewportSize({width:320,height:600});await page.evaluate(()=>document.documentElement.style.fontSize='28px');
  await page.addStyleTag({content:'button,select,h2,#context-share-content {line-height:1.5!important;letter-spacing:.12em!important;word-spacing:.16em!important}'});
  const spaced=await bounds('320px / 200% text / WCAG spacing');
  if(spaced.fit==='fit') assert.equal((await recoverSection(513)).recovered,scope.files.at(-1).path);
  await page.screenshot({path:output+'/spacing.png'});
  await page.setViewportSize({width:320,height:240});
  const small=await bounds('too-small 320x240 / 200% text / spacing');
  assert.equal(small.fit,'no-fit');assert.equal(small.shareDisabled,true);
  assert.equal(await page.locator('#context-share-resize').isVisible(),true);
  assert.equal(await page.getByRole('dialog',{name:'Share manuscript context',exact:true}).count(),1,'compact no-fit text retains the complete accessible dialog name');
  await page.screenshot({path:output+'/no-fit.png'});
  await page.setViewportSize({width:1440,height:900});await page.evaluate(()=>document.documentElement.style.fontSize='14px');await bounds('regrowth after no-fit');
  await page.locator('#context-share-cancel').click();await page.waitForFunction(()=>window.result===null);
  assert.deepEqual(await page.evaluate(()=>window.calls.map(op=>op.action)),['context_preview'],'pagination and cancellation never save, share or mutate');
  await page.evaluate(()=>document.querySelector('style:last-of-type')?.remove());
  await page.setViewportSize({width:1440,height:900});await page.evaluate(()=>document.documentElement.style.fontSize='14px');
  await page.evaluate(scope=>window.start(scope),scope);await ready();
  await page.evaluate(()=>{window.savedSegmenter=Intl.Segmenter;Intl.Segmenter=undefined;document.documentElement.style.fontSize='15px';});
  assert.equal((await bounds('text paging capability unavailable')).fit,'no-fit');
  await page.evaluate(()=>{Intl.Segmenter=window.savedSegmenter;document.documentElement.style.fontSize='14px';});await ready();
  assert.equal((await bounds('text paging capability restored')).fit,'fit');
  await page.locator('#context-share-submit').click();await page.waitForFunction(()=>window.exactReceipt===true);
  assert.deepEqual(await page.evaluate(()=>window.result),scope,'approval returns the exact complete scope, without requiring all pages to be visited');
  await page.evaluate(scope=>window.start(scope),scope);await ready();
  const guardError='The saved context changed. '+'Keep the draft and review the concrete scope again. '.repeat(30);
  await page.evaluate(error=>window.guardError=error,guardError);await page.locator('#context-share-submit').click();await ready();
  assert.equal(await page.locator('#context-share-submit').isDisabled(),true);
  let recoveredError='';
  while(recoveredError.length<guardError.length) {recoveredError+=await page.locator('#context-share-error').textContent();if(recoveredError.length<guardError.length){await page.locator('#context-share-next').click();await ready();}}
  assert.equal(recoveredError,guardError);await bounds('complete paginated consent error');
  await page.locator('#context-share-cancel').click();assert.deepEqual(errors,[]);
  const receipt={result:'passed',sourceSha256:createHash('sha256').update(await readFile('src/context-sharing.js')).digest('hex'),cssSha256:createHash('sha256').update(css).digest('hex'),dialogSha256:createHash('sha256').update(dialog).digest('hex'),runnerSha256:createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex'),bundleSha256:createHash('sha256').update(bundle).digest('hex'),scopeFiles:512,maximumPathLength:scope.files[1].path.length,maximumPathPages:maximum.chunks,observations,qualification:'Actual consent HTML/CSS/controller and pinned Pretext in Chrome. Scope fixture only; native context authority is qualified separately. Primary dist was not rebuilt.'};
  await writeFile(output+'/result.json',JSON.stringify(receipt,null,2)+'\n');console.log('Context consent: complete 512-file inventory, maximum/Unicode path paging, cancellation, exact scope receipt, dirty guard errors, resize/text-spacing/no-scroll geometry passed.');
} finally {await browser?.close();await new Promise(resolve=>server.close(resolve));}
