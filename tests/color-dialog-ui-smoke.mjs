import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {build} from 'vite';
import {chromium} from 'playwright-core';

const output=resolve('artifacts/marker-access/color-dialog-bounded');await mkdir(output,{recursive:true});
await writeFile(output+'/entry.js',`import {setupColorRules} from '${resolve('src/color-rules.js').replaceAll('\\','/')}';import {observeReviewText} from '${resolve('modules/frontend/review-text-layout.js').replaceAll('\\','/')}';import {setupDialogLayout} from '${resolve('modules/frontend/dialog-layout.js').replaceAll('\\','/')}';
window.saveCalls=0;window.reports=[];const session={project:'fixture',path:'main.typ',snapshot:{review:{rules:[]}}};const controller=setupColorRules({context:()=>({session,binding:{project:'fixture',path:'main.typ'},blocked:false,composing:false}),save:(_captured,rules)=>{window.saveCalls++;session.snapshot.review.rules=structuredClone(rules);},report:message=>window.reports.push(message)});window.fixtureSession=session;window.colorController=controller;controller.render();setupDialogLayout(document);observeReviewText(document.body);for(const close of document.querySelectorAll('[data-close]'))close.onclick=()=>close.closest('dialog').close();document.querySelector('[data-color-add]').click();`);
const result=await build({configFile:false,logLevel:'error',build:{write:false,lib:{entry:output+'/entry.js',formats:['es']},minify:false}});
const bundle=(Array.isArray(result)?result[0]:result).output.find(item=>item.type==='chunk').code;
const css=(await readFile('src/manuscript.css','utf8'))+'\n'+(await readFile('src/dialog-layout.css','utf8')),html=await readFile('manuscript.html','utf8'),dialog=['color-rule-dialog','highlight-color-dialog'].map(id=>html.match(new RegExp(`<dialog id="${id}"[\\s\\S]*?<\\/dialog>`))[0]).join('');
const markup=`<!doctype html><html lang="en"><head><meta charset="UTF-8"><style>${css}</style></head><body><div class="manuscript-toolbar"><div id="color-slots"></div></div><select id="highlight-rule" hidden></select>${dialog}<script type="module" src="/bundle.js"></script></body></html>`;
await writeFile(output+'/bundle.js',bundle);await writeFile(output+'/index.html',markup);
const server=createServer((request,response)=>{response.setHeader('Content-Type',request.url==='/bundle.js'?'text/javascript':'text/html');response.end(request.url==='/bundle.js'?bundle:markup);});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const observations=[],errors=[];let browser,page;
async function ready() {
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  await page.waitForFunction(()=>['fit','no-fit'].includes(document.getElementById('color-rule-dialog').dataset.popupFit));
  await page.waitForFunction(()=>[...document.querySelectorAll('#color-rule-dialog [data-measure]')].filter(node=>node.getClientRects().length).every(node=>node.dataset.textFit&&node.dataset.textFit!=='deferred'));
}
const state=()=>page.locator('.color-rule-body input,.color-rule-body textarea').evaluateAll(nodes=>nodes.map(node=>({id:node.id,name:node.name,value:node.value,checked:node.checked,disabled:node.disabled})));
async function measure(label) {
  await ready();
  const result=await page.evaluate(()=>{
    const dialog=document.getElementById('color-rule-dialog'),body=dialog.querySelector('.popup-body'),slot=dialog.querySelector('.popup-body'),rect=dialog.getBoundingClientRect();
    const regions=[dialog,document.getElementById('color-rule-form'),slot,body,...dialog.querySelectorAll('[data-measure],button')].filter(node=>node.getClientRects().length);
    const title=document.getElementById('color-rule-title').getBoundingClientRect(),footer=dialog.querySelector('.dialog-actions').getBoundingClientRect(),space=slot.getBoundingClientRect();
    body.scrollTop=100;slot.scrollTop=100;dialog.scrollTop=100;
    return {fit:dialog.dataset.popupFit,measurement:dialog.dataset.textFit,viewport:[innerWidth,innerHeight],rootText:getComputedStyle(document.documentElement).fontSize,
      rect:{x:rect.x,y:rect.y,right:rect.right,bottom:rect.bottom},body:{width:body.clientWidth,height:body.clientHeight,scrollWidth:body.scrollWidth,scrollHeight:body.scrollHeight,scrollTop:body.scrollTop},
      ordered:title.bottom<=space.top+1&&space.bottom<=footer.top+1,scrollTops:[body.scrollTop,slot.scrollTop,dialog.scrollTop],
      scrollAreas:[body,slot,dialog].filter(node=>['auto','scroll'].includes(getComputedStyle(node).overflowY)||['auto','scroll'].includes(getComputedStyle(node).overflowX)).map(node=>node.id||node.className),
      overflow:regions.filter(node=>node.scrollWidth>node.clientWidth+1||node.scrollHeight>node.clientHeight+2).map(node=>({id:node.id||node.className,width:node.clientWidth,scrollWidth:node.scrollWidth,height:node.clientHeight,scrollHeight:node.scrollHeight})),
      saveDisabled:document.getElementById('color-rule-save').disabled,cancelVisible:footer.top>=rect.top&&footer.bottom<=rect.bottom,
      labels:[...dialog.querySelectorAll('[data-measure]')].filter(node=>node.getClientRects().length).map(node=>({text:node.textContent,fit:node.dataset.textFit}))};
  });
  observations.push({label,...result});assert.deepEqual(result.scrollAreas,[],label);assert.deepEqual(result.scrollTops,[0,0,0],label);
  assert.deepEqual(result.overflow,[],`${label}: ${JSON.stringify(result)}`);assert.ok(result.ordered&&result.cancelVisible,label);
  assert.ok(result.rect.x>=0&&result.rect.y>=0&&result.rect.right<=result.viewport[0]+1&&result.rect.bottom<=result.viewport[1]+1,label);
  assert.equal(result.fit,'fit',`${label}: every visible page must fit`);
  for(const text of result.labels) assert.ok(['fit','reflow','unavailable'].includes(text.fit),JSON.stringify(text));
  return result;
}
async function reveal(selector) {
  const popup=page.locator('#color-rule-dialog');
  for(let step=0;step<30;step++) {
    if(await page.locator(selector).isVisible()) return;
    const next=popup.locator('.popup-pager button').last();
    if(await next.isDisabled()) {
      const previous=popup.locator('.popup-pager button').first();
      while(!await previous.isDisabled()) await previous.click();
    } else await next.click();
  }
  throw Error(`Unreachable color setting: ${selector}`);
}
async function checkPages(label) {
  const popup=page.locator('#color-rule-dialog'), previous=popup.locator('.popup-pager button').first(),next=popup.locator('.popup-pager button').last();
  if(!await previous.isVisible()) {await measure(label);return;}
  while(!await previous.isDisabled()) await previous.click();
  const seen=new Set();
  for(let step=0;step<30;step++) {
    await measure(`${label} page ${step+1}`);
    for(const id of await popup.locator('input:visible,textarea:visible').evaluateAll(nodes=>nodes.map(node=>node.id||node.name))) seen.add(id);
    if(await next.isDisabled()) break;
    await next.click();
  }
  for(const id of ['color-rule-label','color-rule-color','color-rule-action','color-rule-prompt','color-rule-access']) assert.ok(seen.has(id),`${label}: ${id} stays reachable`);
}
try {
  browser=await chromium.launch({executablePath:process.env.UNDERTREE_CHROME||(process.platform==='win32'?'C:/Program Files/Google/Chrome/Application/chrome.exe':'/usr/bin/google-chrome'),headless:true});
  page=await browser.newPage({viewport:{width:1440,height:900}});page.on('pageerror',error=>errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);await page.locator('#color-rule-dialog').waitFor();
  assert.equal((await measure('normal14px complete form')).fit,'fit');
  await page.screenshot({path:output+'/normal.png'});
  await reveal('#color-rule-label');await page.locator('#color-rule-label').fill('Editable Unicode é 🌳');await reveal('#color-rule-prompt');await page.locator('#color-rule-prompt').fill('Preserve the complete scientific argument. '.repeat(35));
  await reveal('#color-rule-shorten');await page.locator('#color-rule-shorten').check();await page.locator('#color-rule-detail').check();await reveal('#color-rule-permissions');await page.locator('input[name="color-rule-access"][value="direct"]').check();
  await page.locator('#color-rule-color').evaluate(node=>{node.value='#7655ad';node.dispatchEvent(new Event('input',{bubbles:true}));});
  await reveal('#color-rule-label');await page.locator('#color-rule-label').focus();await page.locator('#color-rule-label').evaluate(node=>node.setSelectionRange(2,7));
  const expected=await state();
  await page.setViewportSize({width:1300,height:1000});assert.equal((await measure('fit-to-fit caret retention')).fit,'fit');
  assert.deepEqual(await page.locator('#color-rule-label').evaluate(node=>({focused:node===document.activeElement,start:node.selectionStart,end:node.selectionEnd})),{focused:true,start:2,end:7});
  for(const [width,height,font] of [[1440,480,14],[901,480,28],[900,900,28],[320,900,28],[667,375,14],[320,720,14]]) {
    await page.setViewportSize({width,height});await page.evaluate(font=>document.documentElement.style.fontSize=font+'px',font);
    const measurement=await measure(`${width}x${height} / ${font}px`);
    assert.deepEqual(await state(),expected,'no-fit presentation preserves every input and access choice');
    await checkPages(`${width}x${height}/${font}px`);
  }
  await page.screenshot({path:output+'/compact-pages.png'});
  await page.setViewportSize({width:900,height:1800});assert.equal((await measure('adequate200% complete form')).fit,'fit');assert.deepEqual(await state(),expected);
  await page.locator('#color-rule-prompt').evaluate(node=>node.style.height='12rem');assert.equal((await measure('native textarea resize remains bounded')).fit,'fit');assert.deepEqual(await state(),expected);
  await reveal('#color-rule-label');await page.locator('#color-rule-label').focus();assert.deepEqual(await page.locator('#color-rule-label').evaluate(node=>[node.selectionStart,node.selectionEnd]),[2,7]);
  await page.screenshot({path:output+'/enlarged-fit.png'});
  await page.addStyleTag({content:'#color-rule-dialog [data-measure]{line-height:1.5!important;letter-spacing:.12em!important;word-spacing:.16em!important}#color-rule-dialog p{margin-bottom:2em!important}'});
  await page.setViewportSize({width:320,height:900});assert.equal((await measure('320px200%WCAGspacing')).fit,'fit');assert.deepEqual(await state(),expected);
  await page.evaluate(()=>document.querySelector('style:last-of-type')?.remove());await page.setViewportSize({width:1440,height:900});await page.evaluate(()=>document.documentElement.style.fontSize='14px');
  assert.equal((await measure('regrowth restores complete editor')).fit,'fit');assert.deepEqual(await state(),expected);
  await reveal('#color-rule-label');await page.locator('#color-rule-label').fill('é'.repeat(80));await page.locator('#color-rule-save').click();await page.locator('#color-rule-error').getByText('Name this color using at most 100 bytes.',{exact:true}).waitFor();
  assert.equal((await measure('readable validation error')).fit,'fit');assert.equal(await page.evaluate(()=>window.saveCalls),0);
  await page.locator('#color-rule-label').fill('A valid color');await page.locator('#color-rule-save').click();await page.locator('#color-rule-dialog').waitFor({state:'hidden'});assert.equal(await page.evaluate(()=>window.saveCalls),1);assert.deepEqual(errors,[]);
  await page.locator('[data-color-rule]').dblclick();await page.locator('#color-rule-dialog').waitFor();
  assert.equal(await page.evaluate(()=>window.saveCalls),1,'toolbar double-click opens settings without saving');
  await reveal('input[name="color-rule-action"][value="neutral"]');await page.locator('input[name="color-rule-action"][value="neutral"]').check();
  assert.deepEqual(await page.locator('#color-rule-instructions,#color-rule-permissions').evaluateAll(nodes=>nodes.map(node=>node.disabled)),[true,true]);
  assert.equal(await page.locator('#color-rule-prompt').isDisabled(),true);assert.equal(await page.locator('input[name="color-rule-access"][value="direct"]').isDisabled(),true);
  await page.locator('#color-rule-save').click();await page.locator('#color-rule-dialog').waitFor({state:'hidden'});
  const neutral=await page.evaluate(()=>window.fixtureSession.snapshot.review.rules[0]);
  assert.equal(neutral.action,'neutral');assert.equal(neutral.prompt,'');assert.equal(neutral.accessMode,'suggestions');
  await page.locator('[data-color-rule]').focus();await page.keyboard.press('F4');await page.locator('#color-rule-dialog').waitFor();
  assert.equal(await page.locator('input[name="color-rule-action"][value="neutral"]').isChecked(),true);
  await page.locator('#color-rule-dialog [data-close]').click();await page.locator('#color-rule-dialog').waitFor({state:'hidden'});
  await page.evaluate(()=>{const session=window.fixtureSession;session.snapshot.review.rules.push({id:'protected',label:'Protected citations',color:'#74b9a4',action:'protect',prompt:'',accessMode:'suggestions'});window.colorController.render();window.colorController.edit(session.snapshot.review.rules.map(rule=>rule.id),document.querySelector('[data-color-rule]'));});
  await page.locator('#highlight-color-dialog').waitFor();assert.equal(await page.locator('#highlight-color-choice option').count(),2);
  assert.equal(await page.evaluate(()=>window.saveCalls),2,'overlap choice grants no permission');
  await page.setViewportSize({width:320,height:900});await page.evaluate(()=>document.documentElement.style.fontSize='28px');
  await page.waitForFunction(()=>document.getElementById('highlight-color-dialog').dataset.popupFit==='fit');
  assert.deepEqual(await page.locator('#highlight-color-dialog').evaluate(dialog=>[dialog,...dialog.querySelectorAll('.popup-body,.dialog-actions')].filter(node=>node.scrollWidth>node.clientWidth+2||node.scrollHeight>node.clientHeight+2).map(node=>node.id||node.className)),[]);
  await page.screenshot({path:output+'/overlap-choice.png'});
  await page.locator('#highlight-color-choice').selectOption('protected');await page.locator('#highlight-color-form button[type="submit"]').click();await page.locator('#color-rule-dialog').waitFor();
  assert.equal(await page.locator('input[name="color-rule-action"][value="protect"]').isChecked(),true);
  await page.locator('#color-rule-dialog [data-close]').click();await page.locator('#color-rule-dialog').waitFor({state:'hidden'});
  await page.evaluate(()=>window.colorController.edit(window.fixtureSession.snapshot.review.rules.map(rule=>rule.id)));
  await page.locator('#highlight-color-dialog').waitFor();await page.evaluate(()=>window.fixtureSession.snapshot.review.rules[0].label='Locally changed');
  await page.locator('#highlight-color-form button[type="submit"]').click();
  const staleMessage='The manuscript or its colors changed. Close this dialog and choose the highlight again.';
  await page.waitForFunction(message=>document.getElementById('highlight-color-error').textContent===message,staleMessage);
  if(!await page.locator('#highlight-color-error').isVisible()) {
    await page.locator('#highlight-color-dialog').getByRole('button',{name:`Error details: ${staleMessage}`,exact:true}).click();
    assert.equal(await page.locator('.text-details-dialog[open] .text-details-message').textContent(),staleMessage);
    await page.locator('.text-details-dialog[open]').getByRole('button',{name:'Close',exact:true}).click();
  } else assert.equal(await page.locator('#highlight-color-error').textContent(),staleMessage);
  assert.equal(await page.locator('#color-rule-dialog').isVisible(),false);assert.equal(await page.evaluate(()=>window.saveCalls),2);
  await page.locator('#highlight-color-dialog [data-close]').click();assert.deepEqual(errors,[]);
  await writeFile(output+'/result.json',JSON.stringify({status:'PASS',sourceSha256:createHash('sha256').update(await readFile('src/color-rules.js')).digest('hex'),cssSha256:createHash('sha256').update(css).digest('hex'),dialogSha256:createHash('sha256').update(dialog).digest('hex'),runnerSha256:createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex'),observations,qualification:'Actual color controller, complete original controls, source HTML/CSS and pinned Pretext in isolated Chrome. No native policy changes or primary dist rebuild.'},null,2)+'\n');
  console.log('Color dialog: compact normal/enlarged pages, no internal panel scroll, reachable Cancel/Save, exact form/caret retention, resize/spacing/regrowth and readable validation passed.');
} finally {await browser?.close();await new Promise(resolve=>server.close(resolve));}
