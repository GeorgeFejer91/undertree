import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';

const root = await mkdtemp(join(tmpdir(), 'undertree-review-ui-'));
const projectRoot = join(root, 'project'); await mkdir(projectRoot);
const original = '<p>Hello world. This sentence has a clear meaning.</p>\n';
const crlfSource = '<p>First paragraph.\r\nSecond passage.</p>\r\n';
await writeFile(join(projectRoot, 'main.html'), original);
await writeFile(join(projectRoot, 'crlf.html'), crlfSource);
await writeFile(join(projectRoot, 'delayed.html'), '<p>A delayed file response must not replace the chosen manuscript.</p>\n');
await writeFile(join(projectRoot, 'autosave-a.html'), '<p>Autosave A.</p>\n');
await writeFile(join(projectRoot, 'autosave-b.html'), '<p>Autosave B.</p>\n');
await writeFile(join(projectRoot, 'composition.html'), '<p>A composed manuscript.</p>\n');
await writeFile(join(projectRoot, 'main.typ'), '#set page(paper: "a4")\n\n= Manuscript\n\nHello world. This is Typst, without TeX.\n' + Array.from({length:9}, (_, index) => `\n#pagebreak()\n= Page ${index + 2}\n\nA full-document preview reaches this page.\n`).join(''));
await mkdir(join(projectRoot, 'chapters')); await writeFile(join(projectRoot, 'chapters', 'part.typ'), '= Part\n\nA nested manuscript.\n');
await writeFile(join(projectRoot, 'import.tex'), '\\documentclass{article}\n\\begin{document}\n\\section{Results}An \\textbf{important} result.\\custom{kept}\n\\end{document}');
const zrok = join(root,'zrok2'); const targetFile = join(root,'zrok-target');
await writeFile(zrok, `#!/bin/sh\nprintf '%s' "$3" > '${targetFile}'\nexec sleep 120\n`); await chmod(zrok,0o700);
const token = randomBytes(32).toString('hex');
const compilerCalls = join(root,'compiler-calls');
const compiler = join(root,'typst');
const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`;
await writeFile(compiler,`#!/bin/sh\nprintf '1\\n' >> ${shellQuote(compilerCalls)}\nsleep 0.3\nexec ${shellQuote(process.env.UNDERTREE_TYPST || 'typst')} "$@"\n`);await chmod(compiler,0o700);
const child = spawn(resolve('target/debug/undertree-review'), [], { env: { ...process.env, UNDERTREE_REVIEW_PORT:'0', UNDERTREE_REVIEW_STATE:join(root,'state'), UNDERTREE_REVIEW_TOKEN:token, UNDERTREE_ZROK:zrok, UNDERTREE_TYPST:compiler }, stdio:['ignore','pipe','pipe'] });
let serverLog=''; let port;
child.stdout.on('data', b=>{serverLog+=b;port=Number(serverLog.match(/127\.0\.0\.1:(\d+)/)?.[1]);});
child.stderr.on('data', b=>{serverLog+=b;});
for(let i=0;i<100&&!port;i++) { if(child.exitCode!==null) throw new Error(serverLog); await new Promise(r=>setTimeout(r,100)); }
assert.ok(port, 'native service startup');
const base = `http://127.0.0.1:${port}`;
async function assertChrome(page, label) {
  const violations = await page.evaluate(() => [...document.querySelectorAll('.review-topbar,.pane-heading,.manuscript-toolbar,.pdf-toolbar,.mobile-views,.review-status')].flatMap(region => {
    if (!region.getClientRects().length) return [];
    const bounds = region.getBoundingClientRect();
    if (bounds.width === 0 || bounds.height === 0) return [];
    const errors = [];
    if (region.scrollWidth > region.clientWidth + 1 || region.scrollHeight > region.clientHeight + 1) errors.push(region.className + ': internal overflow');
    if (bounds.left < -1 || bounds.right > innerWidth + 1 || bounds.top < -1 || bounds.bottom > innerHeight + 1) errors.push(region.className + ': outside viewport');
    return errors;
  }));
  assert.deepEqual(violations, [], label);
}
async function menuAction(page, menu, label) {
  const id=await page.locator('#workspace-menu summary').isVisible()?'workspace-menu':`menu-${menu}`;
  await page.locator(`#${id} summary`).click();
  await page.locator(`#${id}`).getByRole('button',{name:label,exact:true}).click();
}
async function waitForSource(page, path) {
  await page.waitForFunction(path => {
    const title = document.querySelector('#manuscript-tabs [role="tab"][aria-selected="true"]')?.textContent;
    return (title === path || title === `${path} •`) && document.querySelector('.cm-content');
  }, path);
}

async function call(operation, expectError=false) {
  const response=await fetch(base+'/api/review',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},body:JSON.stringify(operation)});
  const value=await response.json();
  if(expectError) {assert.equal(value.ok,false);return value.error;}
  assert.equal(value.ok,true,value.error?.message);return value.result;
}
let browser;
try {
  assert.equal((await fetch(base+'/api/review',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'projects'})})).status,401);
  const project=await call({action:'add_project',root:projectRoot});
  const denied=await call({action:'open',project:project.id,path:'../main.html'},true);assert.equal(denied.code,'path');
  browser=await chromium.launch({executablePath:process.env.UNDERTREE_CHROME || '/usr/bin/google-chrome',headless:true,args:['--no-sandbox']});
  const context=await browser.newContext({viewport:{width:1600,height:1000}});
  const page=await context.newPage();const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(base+`/manuscript.html#session=${token}`);
  assert.equal(await page.locator('#window-titlebar').isVisible(), false, 'native controls stay hidden in browser mode');
  assert.equal(await page.locator('#review-app').evaluate(root => root.classList.contains('native-window')), false, 'browser keeps its own window frame');
  await page.getByLabel('Folder chapters', {exact:true}).click();
  await page.getByRole('button',{name:'part.typ',exact:true}).click();
  await waitForSource(page,'chapters/part.typ');
  assert.deepEqual(await page.locator('.workspace-menus summary').allTextContents(),['File','Edit','Insert','View','Format','Help'],'desktop keeps the six familiar menus');
  const geometry=await page.evaluate(()=>{
    const rect=selector=>document.querySelector(selector).getBoundingClientRect(),header=rect('.review-topbar'),project=rect('#project-select');
    const source=getComputedStyle(document.querySelector('.cm-content')),gutter=getComputedStyle(document.querySelector('.cm-gutters'));
    return {header:header.height,projectCenter:project.left+project.width/2,headerCenter:header.left+header.width/2,projectAlignment:getComputedStyle(document.querySelector('#project-select')).textAlignLast,toolbar:rect('.manuscript-toolbar').height,toolbarColor:getComputedStyle(document.querySelector('.manuscript-toolbar')).backgroundColor,tabs:rect('#manuscript-tabs').height,sidebar:rect('.manuscript-files').width,tree:rect('#manuscript-files').height,outline:rect('#outline-panel').height,sourceFont:source.fontSize,sourceLine:source.lineHeight,gutterWidth:rect('.cm-gutters').width,gutterColor:gutter.color,gutterBackground:gutter.backgroundColor,gutterLine:gutter.lineHeight};
  });
  assert.equal(geometry.header,40);assert.ok(Math.abs(geometry.projectCenter-geometry.headerCenter)<1,'project title selector is centered');
  assert.equal(geometry.projectAlignment,'center','the visible selected project value is centered inside its native select');
  assert.equal(geometry.toolbar,32);assert.equal(geometry.toolbarColor,'rgb(27, 34, 44)');assert.ok(Math.abs(geometry.tabs-36)<.1);assert.ok(Math.abs(geometry.sidebar-232.95)<.1);
  assert.equal(geometry.sourceFont,'12px');assert.equal(geometry.sourceLine,'19.2px','source uses the pinned baseline typography');
  assert.ok(Math.abs(geometry.gutterWidth-48)<.1);assert.equal(geometry.gutterBackground,'rgb(240, 240, 240)');assert.equal(geometry.gutterColor,'rgb(51, 51, 51)');assert.equal(geometry.gutterLine,'19.2px');
  assert.ok(Math.abs(geometry.tree-geometry.outline)<=3.1,'Files and Outline share their available content area equally');
  await page.setViewportSize({width:1100,height:800});await page.waitForTimeout(100);
  assert.ok(Math.abs((await page.locator('.manuscript-files').boundingBox()).width-157.95)<.1,'the untouched sidebar follows the reference proportional width');
  assert.equal(await page.locator('#files-splitter').getAttribute('aria-valuenow'),'158');
  await page.setViewportSize({width:1600,height:1000});await page.waitForTimeout(100);
  assert.ok(Math.abs((await page.locator('.manuscript-files').boundingBox()).width-232.95)<.1,'the untouched sidebar regrows after a narrower window');
  const iconErrors=await page.locator('svg[aria-hidden="true"]').evaluateAll(icons=>icons.filter(icon=>icon.getClientRects().length).flatMap(icon=>{
    const painted=icon.getBBox(),box=icon.viewBox.baseVal,rect=icon.getBoundingClientRect();
    return Math.abs((painted.x+painted.width/2-box.x-box.width/2)*rect.width/box.width)>1 || Math.abs((painted.y+painted.height/2-box.y-box.height/2)*rect.height/box.height)>1 || icon.getAttribute('focusable')!=='false' ? [icon.parentElement.id] : [];
  }));assert.deepEqual(iconErrors,[],'original SVG geometry centers painted icons in their focusable button slots');
  assert.equal(await page.locator('#manuscript-files').isVisible(),true);assert.equal(await page.locator('#manuscript-outline').isVisible(),true,'outline appears beneath the file tree');
  await page.locator('#outline-toggle').click();assert.equal(await page.locator('#manuscript-outline').isVisible(),false);
  await menuAction(page,'view','Show file outline');assert.equal(await page.locator('#manuscript-outline').isVisible(),true,'View menu reopens the outline');
  await page.locator('.cm-content').click();await page.keyboard.press('Control+Home');await page.keyboard.press('ArrowDown');await page.keyboard.press('ArrowDown');await page.keyboard.press('Home');await page.keyboard.press('Shift+End');
  await page.locator('#source-bold').click();assert.ok((await page.locator('.cm-content').textContent()).includes('*A nested manuscript.*'),'Typst Bold operates on the selected source');
  await page.locator('#source-undo').click();assert.ok(!(await page.locator('.cm-content').textContent()).includes('*A nested manuscript.*'),'toolbar formatting stays undoable');
  await menuAction(page,'insert','Section heading');assert.ok((await page.locator('.cm-content').textContent()).includes('= A nested manuscript.'),'Insert heading applies to the current source line');
  await page.locator('#manuscript-outline').getByRole('button',{name:'A nested manuscript.',exact:true}).waitFor({timeout:10000});
  await page.locator('#manuscript-outline').getByRole('button',{name:'A nested manuscript.',exact:true}).click();
  assert.ok((await page.evaluate(()=>getSelection().toString())).includes('A nested manuscript.'),'outline navigation selects its source heading');
  await page.locator('#source-undo').click();
  await page.locator('#source-bullets').click();assert.ok((await page.locator('.cm-content').textContent()).includes('- A nested manuscript.'),'source list controls apply a Typst bullet');
  await page.locator('#source-undo').click();await menuAction(page,'insert','Numbered list');assert.ok((await page.locator('.cm-content').textContent()).includes('+ A nested manuscript.'),'Insert menu applies a Typst numbered list');
  await page.locator('#source-undo').click();await menuAction(page,'file','Save');
  await page.locator('#menu-file-toggle').focus();await page.keyboard.press('ArrowRight');assert.equal(await page.locator('#menu-edit-toggle').evaluate(node=>node===document.activeElement),true,'keyboard follows the menu hierarchy');
  await page.keyboard.press('ArrowDown');assert.equal(await page.locator('#menu-edit').getAttribute('open'),'','ArrowDown opens real Edit actions');await page.keyboard.press('Escape');assert.equal(await page.locator('#menu-edit').getAttribute('open'),null);
  await menuAction(page,'help','UnderTree help');assert.equal(await page.locator('#help-dialog').isVisible(),true);await page.locator('#help-dialog [data-close]').click();
  assert.equal(await page.locator('.file-folder').first().evaluate(folder => folder.open),true,'selected file ancestor remains expanded');
  await page.locator('#files-splitter').focus(); await page.keyboard.press('ArrowRight');
  assert.equal(await page.locator('#files-splitter').getAttribute('aria-valuenow'),'253','file panel is keyboard resizable');
  await page.setViewportSize({width:1100,height:800});await page.waitForTimeout(100);
  assert.ok(Math.abs((await page.locator('.manuscript-files').boundingBox()).width-252.95)<.1,'a user resize remains an explicit width when the window changes');
  await page.locator('#files-splitter').focus();await page.keyboard.press('Home');
  assert.ok(Math.abs((await page.locator('.manuscript-files').boundingBox()).width-157.95)<.1,'Home restores the responsive default');
  await page.setViewportSize({width:1600,height:1000});await page.waitForTimeout(100);
  await page.locator('#files-collapse').click(); assert.equal(await page.locator('.manuscript-files').isVisible(),false);
  await page.locator('#rail-files').click(); assert.equal(await page.locator('.manuscript-files').isVisible(),true);
  await page.locator('#preview-collapse').click(); assert.equal(await page.locator('.manuscript-preview').isVisible(),false);
  await page.locator('#rail-preview').click(); assert.equal(await page.locator('.manuscript-preview').isVisible(),true);
  await menuAction(page,'edit','Find and replace');
  assert.equal(await page.locator('.cm-search').isVisible(),true,'editor menu opens the real CodeMirror search');
  await page.getByRole('button',{name:'crlf.html',exact:true}).click();
  await waitForSource(page,'crlf.html');
  await page.locator('.cm-preserved-cr').first().waitFor({state:'attached'});
  assert.equal(await page.locator('.cm-specialChar[aria-label="Control character carriage return"]').count(),0,'preserved CRLF does not paint control-character warnings');
  const crlfWidgets=await page.locator('.cm-preserved-cr').evaluateAll(nodes=>nodes.map(node=>({width:node.getBoundingClientRect().width,hidden:node.getAttribute('aria-hidden')})));
  assert.deepEqual(crlfWidgets,[{width:0,hidden:'true'},{width:0,hidden:'true'}]);
  assert.equal(await page.locator('.cm-line').count(),3,'CRLF source renders one visual source line per LF');
  await page.locator('.cm-content').click();await page.keyboard.press('Control+Home');await page.keyboard.press('ArrowDown');await page.keyboard.press('Home');
  for(let index=0;index<'Second passage.'.length;index++) await page.keyboard.press('Shift+ArrowRight');
  await menuAction(page,'format','Highlight selection');assert.equal(await page.locator('#highlight-quote').textContent(),'Second passage.');
  await page.getByRole('button',{name:'Add highlight',exact:true}).click();await page.getByRole('button',{name:'Remove highlight',exact:true}).waitFor();
  const crlfMarked=await call({action:'open',project:project.id,path:'crlf.html'});
  assert.equal(crlfMarked.review.markers[0].anchor.from,crlfSource.indexOf('Second passage.'));
  assert.equal(crlfMarked.review.markers[0].anchor.quote,'Second passage.');assert.equal(crlfMarked.content,crlfSource,'clean metadata operations preserve CRLF source bytes');
  await page.getByRole('button',{name:'Remove highlight',exact:true}).click();
  await page.locator('#source-italic').click();assert.ok((await page.locator('.cm-content').textContent()).includes('<em>Second passage.</em>'),'HTML source formatting uses HTML wrappers');
  await page.locator('#source-undo').click();await menuAction(page,'file','Save');assert.equal(await readFile(join(projectRoot,'crlf.html'),'utf8'),crlfSource,'formatting undo roundtrips literal CRLF');
  await page.locator('.cm-content').click();await page.keyboard.press('Control+End');await page.keyboard.press('Enter');await page.locator('#source-undo').click();await menuAction(page,'file','Save');
  assert.equal(await readFile(join(projectRoot,'crlf.html'),'utf8'),crlfSource,'native newline input and undo preserve untouched CRLF');
  await page.getByRole('button',{name:'main.html',exact:true}).click();
  await waitForSource(page,'main.html');
  await page.locator('.cm-content').click();await page.keyboard.press('Control+Home');
  for(let i=0;i<3;i++) await page.keyboard.press('ArrowRight');
  for(let i=0;i<5;i++) await page.keyboard.press('Shift+ArrowRight');
  await menuAction(page,'format','Highlight selection');
  await page.locator('#highlight-dialog-rule').selectOption('protect');
  await page.locator('#highlight-prompt').fill('Preserve the approved opening.');
  await page.getByRole('button',{name:'Add highlight',exact:true}).click();
  await page.locator('.review-card h3').getByText('Keep unchanged',{exact:true}).waitFor();
  await page.locator('#manuscript-share').check();
  const shared=await call({action:'share',project:project.id,path:'main.html',enabled:true});
  const tunnel=await call({action:'tunnel',enabled:true,reservation:'test-session',public_url:'https://review.example.org/'});
  const target=await readFile(targetFile,'utf8');const endpoint=target+new URL(tunnel.endpoint).pathname;
  const mcpHeaders = {'Content-Type':'application/json',Accept:'application/json, text/event-stream','MCP-Protocol-Version':'2025-06-18'};
  const initialized=await fetch(endpoint,{method:'POST',headers:mcpHeaders,body:JSON.stringify({jsonrpc:'2.0',id:0,method:'initialize',params:{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'UnderTree review test',version:'1'}}})});
  assert.equal((await initialized.json()).result.protocolVersion,'2025-06-18');
  async function mcp(name,args) {
    const response=await fetch(endpoint,{method:'POST',headers:mcpHeaders,body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})});
    assert.equal(response.status,200);return (await response.json()).result;
  }
  const source=await call({action:'open',project:project.id,path:'main.html'});
  const proposal={requestId:'review-1',revision:source.review.revision,from:3,to:8,quote:'Hello',replacement:'Greetings',rationale:'More precise opening.'};
  const blocked=await mcp('suggest_text',{documentId:shared.documentId,proposal});assert.equal(blocked.isError,true);
  assert.equal((await mcp('accept_suggestion',{})).isError,true);
  const markerBefore=source.review.markers[0];
  await page.locator('.cm-content').click(); await page.keyboard.press('Control+Home');
  for(let index=0;index<3;index++) await page.keyboard.press('ArrowRight');
  for(let index=0;index<5;index++) await page.keyboard.press('Shift+ArrowRight');
  await page.keyboard.insertText('Hi'); await menuAction(page,'file','Save');
  await page.getByRole('button',{name:'Reanchor from selection',exact:true}).waitFor();
  await page.locator('.cm-content').click(); await page.keyboard.press('Control+Home');
  for(let index=0;index<3;index++) await page.keyboard.press('ArrowRight');
  for(let index=0;index<2;index++) await page.keyboard.press('Shift+ArrowRight');
  await page.setViewportSize({width:320,height:900}); await page.evaluate(()=>{document.documentElement.style.fontSize='28px';});
  await page.getByRole('button',{name:'Review',exact:true}).click(); await assertChrome(page,'stale protection at narrow enlarged text');
  await page.getByRole('button',{name:'Reanchor from selection',exact:true}).click();
  assert.equal(await page.locator('#reanchor-new').textContent(),'Hi');
  await page.getByRole('button',{name:'Reanchor highlight',exact:true}).click();
  await page.locator('#reanchor-dialog').waitFor({state:'hidden'});
  await page.evaluate(()=>{document.documentElement.style.fontSize='';});await page.setViewportSize({width:1600,height:1000});
  const anchored=await call({action:'open',project:project.id,path:'main.html'});
  const markerAfter=anchored.review.markers[0];
  assert.equal(markerAfter.id,markerBefore.id); assert.equal(markerAfter.rule,markerBefore.rule); assert.equal(markerAfter.prompt,markerBefore.prompt);
  assert.equal(markerAfter.anchor.quote,'Hi'); assert.equal(markerAfter.anchor.stale,false);
  assert.equal(await readFile(join(projectRoot,'main.html'),'utf8'),original.replace('Hello','Hi'),'reanchor only changes metadata');
  assert.equal((await mcp('reanchor',{})).isError,true,'remote agents cannot move protection');
  const protectedAgain=await mcp('suggest_text',{documentId:shared.documentId,proposal:{...proposal,requestId:'reanchored-protection',revision:anchored.review.revision,to:5,quote:'Hi'}});
  assert.equal(protectedAgain.isError,true,'reanchored protection is enforced');
  await page.locator('.cm-content').click(); await page.keyboard.press('Control+a'); await page.keyboard.insertText(original); await menuAction(page,'file','Save');

  await page.getByRole('button',{name:'Remove highlight',exact:true}).click();
  await page.locator('.review-card h3').getByText('Keep unchanged',{exact:true}).waitFor({state:'hidden'});
  await page.locator('#review-toggle').click();
  await page.locator('.cm-content').click(); await page.keyboard.press('Control+Home');
  for(let index=0;index<4;index++) await page.keyboard.press('ArrowRight');
  const sourceCursor=await page.evaluate(()=>{const selection=getSelection(),range=document.createRange();range.selectNodeContents(document.querySelector('.cm-content'));range.setEnd(selection.focusNode,selection.focusOffset);return range.toString().length;});
  const submitted=await mcp('suggest_text',{documentId:shared.documentId,proposal});assert.equal(submitted.isError,false);
  for(const [requestId,quote,replacement] of [['review-two','world','planet'],['review-three','This sentence','The sentence']]) {
    const from=original.indexOf(quote); const response=await mcp('suggest_text',{documentId:shared.documentId,proposal:{...proposal,requestId,from,to:from+quote.length,quote,replacement}}); assert.equal(response.isError,false);
  }
  await page.waitForFunction(()=>document.getElementById('review-toggle-count').textContent==='3',{},{timeout:10000});
  assert.equal(await page.locator('#review-toggle-count').getAttribute('class'),'review-count has-new');
  assert.equal(await page.evaluate(()=>{const selection=getSelection(),range=document.createRange();range.selectNodeContents(document.querySelector('.cm-content'));range.setEnd(selection.focusNode,selection.focusOffset);return range.toString().length;}),sourceCursor,'incoming suggestions preserve the source caret');
  await page.locator('#review-toggle').click(); await page.locator('#review-new-cue').click();
  await page.waitForTimeout(150);
  const cardBounds=await page.locator('.suggestion-card').evaluateAll(cards=>cards.map(card=>{const rect=card.getBoundingClientRect();return {top:rect.top,bottom:rect.bottom,from:Number(card.dataset.sourcePosition)};}));
  for(let index=1;index<cardBounds.length;index++) {assert.ok(cardBounds[index].from>=cardBounds[index-1].from);assert.ok(cardBounds[index].top>=cardBounds[index-1].bottom+7,'source-linked cards avoid collisions');}
  await page.locator('.suggestion-card').last().getByRole('button',{name:'Locate',exact:true}).click();
  assert.equal(await page.evaluate(()=>getSelection().toString()),'This sentence','review Locate selects the exact source passage');
  await page.waitForTimeout(150);
  const linkedBounds=await page.evaluate(()=>{const range=getSelection().getRangeAt(0).getBoundingClientRect(),card=document.querySelector('.suggestion-card[data-selected="true"]').getBoundingClientRect(),list=document.getElementById('review-list').getBoundingClientRect();return {source:range.top,card:card.top,target:Math.max(list.top,Math.min(list.bottom-Math.min(card.height,list.height),range.top))};});
  assert.ok(Math.abs(linkedBounds.target-linkedBounds.card)<=4,`focused review card aligns with the selected source line: ${JSON.stringify(linkedBounds)}`);
  await page.locator('#review-list').evaluate(list=>{list.scrollTop=80;});
  const reviewScroll=await page.locator('#review-list').evaluate(list=>list.scrollTop);
  const extraFrom=original.indexOf('clear meaning');
  const extra=await mcp('suggest_text',{documentId:shared.documentId,proposal:{...proposal,requestId:'review-four',from:extraFrom,to:extraFrom+'clear meaning'.length,quote:'clear meaning',replacement:'clear point'}});assert.equal(extra.isError,false);
  await page.waitForFunction(()=>document.querySelectorAll('.suggestion-card').length===4,{},{timeout:10000});await page.waitForTimeout(150);
  assert.equal(await page.locator('#review-list').evaluate(list=>list.scrollTop),reviewScroll,'background suggestions preserve review reading position');
  await page.screenshot({path:resolve('artifacts/review-source-linked.png'),fullPage:true});
  await page.setViewportSize({width:320,height:900});await page.evaluate(()=>{document.documentElement.style.fontSize='28px';});
  await page.getByRole('button',{name:'Review',exact:true}).click();await page.waitForTimeout(150);await assertChrome(page,'pending review chrome at narrow enlarged text');
  const cardOverflow=await page.locator('.suggestion-card').evaluateAll(cards=>cards.flatMap(card=>{const bounds=card.getBoundingClientRect();return [...card.querySelectorAll('button')].filter(button=>{const r=button.getBoundingClientRect();return r.left<bounds.left-1||r.right>bounds.right+1||r.top<bounds.top-1||r.bottom>bounds.bottom+1;}).map(button=>button.textContent);}));
  assert.deepEqual(cardOverflow,[],'every pending-card action fits at 320px and 200% text');
  assert.ok(await page.locator('#review-list').evaluate(list=>list.scrollHeight>list.clientHeight),'long review remains scrollable at enlarged text');
  await page.screenshot({path:resolve('artifacts/review-pending-enlarged.png'),fullPage:true});
  await page.evaluate(()=>{document.documentElement.style.fontSize='';});await page.setViewportSize({width:1600,height:1000});
  assert.equal(await readFile(join(projectRoot,'main.html'),'utf8'),original);
  await page.locator('.suggestion-card').first().waitFor({timeout:10000});
  await page.locator('.suggestion-card').first().getByRole('button',{name:'Accept',exact:true}).click();
  for(let index=0;index<100&&await page.locator('.suggestion-card').count()!==3;index++) await page.waitForTimeout(50);
  await page.locator('.cm-content').evaluate(editor=>editor.focus());
  const acceptedText=await page.locator('.cm-content').textContent();await menuAction(page,'edit','Undo');
  assert.ok((await page.locator('.cm-content').textContent()).includes('Hello world'),'accepted wording is undoable');
  await menuAction(page,'edit','Redo');assert.equal(await page.locator('.cm-content').textContent(),acceptedText,'redo restores accepted wording');

  while(await page.locator('.suggestion-card').count()) {
    const count=await page.locator('.suggestion-card').count();await page.locator('.suggestion-card').first().getByRole('button',{name:'Reject',exact:true}).click();
    for(let index=0;index<100&&await page.locator('.suggestion-card').count()===count;index++) await page.waitForTimeout(50);
  }
  assert.equal(await readFile(join(projectRoot,'main.html'),'utf8'),original.replace('Hello','Greetings'));
  await page.getByRole('button',{name:'composition.html',exact:true}).click();await waitForSource(page,'composition.html');
  const composingSource=await call({action:'open',project:project.id,path:'composition.html'});
  const composingShare=await call({action:'share',project:project.id,path:'composition.html',enabled:true});
  const composingFrom=composingSource.content.indexOf('composed');
  assert.equal((await mcp('suggest_text',{documentId:composingShare.documentId,proposal:{requestId:'composition-race',revision:composingSource.review.revision,from:composingFrom,to:composingFrom+'composed'.length,quote:'composed',replacement:'revised',rationale:'Qualify a composition beginning during acceptance.'}})).isError,false);
  await page.locator('#review-refresh').click();await page.locator('.suggestion-card').waitFor();
  let acceptanceHeld;let releaseAcceptance;
  const waitForAcceptance=new Promise(resolve=>{acceptanceHeld=resolve;});const pendingAcceptance=new Promise(resolve=>{releaseAcceptance=resolve;});
  const holdAcceptance=async route=>{
    const operation=route.request().postDataJSON();
    if(operation.action!=='decide'||operation.path!=='composition.html') return route.continue();
    const response=await route.fetch();acceptanceHeld();await pendingAcceptance;await route.fulfill({response});
  };
  await page.route('**/api/review',holdAcceptance);
  await page.locator('.suggestion-card').getByRole('button',{name:'Accept',exact:true}).click();await waitForAcceptance;
  await page.locator('.cm-content').focus();
  await page.locator('.cm-content').evaluate(source=>(source.editContext||source).dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true})));
  releaseAcceptance();await page.locator('#review-conflict').waitFor();
  assert.ok((await page.locator('.cm-content').textContent()).includes('A composed manuscript.'),'acceptance cannot overwrite a composition begun while its native request was pending');
  assert.equal(await readFile(join(projectRoot,'composition.html'),'utf8'),'<p>A revised manuscript.</p>\n','native acceptance stays authoritative while the live composing buffer remains recoverable');
  assert.equal(await page.locator('#manuscript-tabs [role="tab"][aria-selected="true"]').textContent(),'composition.html •','the composing buffer remains dirty against the accepted disk source');
  await page.locator('.cm-content').evaluate(source=>(source.editContext||source).dispatchEvent(new CompositionEvent('compositionend',{bubbles:true})));
  await page.unroute('**/api/review',holdAcceptance);
  await page.locator('#reload-buffer').click();await page.waitForFunction(()=>document.getElementById('review-conflict').hidden);
  assert.ok((await page.locator('.cm-content').textContent()).includes('A revised manuscript.'),'explicit conflict recovery loads the accepted source after composition finishes');
  await page.getByRole('button',{name:'Close composition.html',exact:true}).click();
  await page.getByRole('tab',{name:'main.html',exact:true}).click();await waitForSource(page,'main.html');
  await mkdir(resolve('artifacts'),{recursive:true});await page.screenshot({path:resolve('artifacts/review-desktop.png'),fullPage:true});
  await menuAction(page,'format','Color rules');
  await page.getByRole('button',{name:'Add color rule',exact:true}).click();
  const custom=page.locator('.palette-row').last();await custom.getByLabel('Rule name').fill('Keep meaning; make the introduction clearer and more concise');await custom.getByLabel('Fixed reviewer prompt').fill('Preserve every scientific claim; improve readability.');
  await page.getByRole('button',{name:'Save rules',exact:true}).click();
  await page.locator('.cm-content').click();await page.keyboard.press('Control+End');await page.keyboard.type('Editor history remains attached to this file.');
  await menuAction(page,'file','Save');
  await page.getByRole('button',{name:'main.typ',exact:true}).click();
  await waitForSource(page,'main.typ');
  await page.getByRole('tab',{name:'main.html',exact:true}).click();await waitForSource(page,'main.html');await page.locator('.cm-content').click();await page.keyboard.press('Control+z');
  assert.ok(!await page.locator('.cm-content').textContent().then(text=>text.includes('Editor history remains attached to this file.')),'undo survives file switches');
  await menuAction(page,'file','Save');
  for(const width of [320,760,1100,1600]) {
    await page.setViewportSize({width,height:900});await page.waitForTimeout(100);
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`page reflow at ${width}`);
  }
  for (const [width,height] of [[1600,480],[900,480],[320,600],[1600,1000]]) {
    await page.setViewportSize({width,height}); await page.waitForTimeout(100);
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1 && document.documentElement.scrollHeight<=innerHeight+1),`bounded window at ${width} x ${height}`);
    await assertChrome(page, `finite chrome at ${width} x ${height}`);
  }
  await page.setViewportSize({width:320,height:900});await page.getByRole('button',{name:'Review',exact:true}).click();
  await page.screenshot({path:resolve('artifacts/review-mobile.png'),fullPage:true});
  await page.evaluate(()=>{document.documentElement.style.fontSize='28px';});
  await page.waitForTimeout(100);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'200% text reflow');
  await assertChrome(page, 'finite chrome with 200% text');
  await page.getByRole('button',{name:'Editor',exact:true}).click();
  await assertChrome(page, 'Editor chrome with 200% text');
  assert.ok(await page.locator('#manuscript-source').evaluate(source=>source.clientHeight>=120),'enlarged Editor retains usable document space');
  await page.evaluate(()=>{document.getElementById('review-app').classList.add('native-window');document.getElementById('window-titlebar').hidden=false;});
  await page.waitForTimeout(100); await assertChrome(page, 'native shell geometry in Editor at 200% text');
  assert.ok(await page.locator('#manuscript-source').evaluate(source=>source.clientHeight>=120),'enlarged native shell retains usable document space');
  const collapseBounds=await page.locator('#editor-collapse').evaluate(button=>{const r=button.getBoundingClientRect(),p=button.parentElement.getBoundingClientRect();return r.left>=p.left-1&&r.right<=p.right+1&&r.top>=p.top-1&&r.bottom<=p.bottom+1;});
  assert.ok(collapseBounds,'enlarged editor collapse action stays inside its toolbar');
  await page.screenshot({path:resolve('artifacts/review-editor-enlarged.png'),fullPage:true});
  await page.evaluate(()=>{document.getElementById('review-app').classList.remove('native-window');document.getElementById('window-titlebar').hidden=true;});
  await page.getByRole('button',{name:'Review',exact:true}).click();
  await page.evaluate(()=>{document.documentElement.style.fontSize='';});
  await page.addStyleTag({content:'button,summary,p,label {line-height:1.5!important;letter-spacing:.12em!important;word-spacing:.16em!important} p {margin-bottom:2em!important}'});
  await page.waitForTimeout(100); await assertChrome(page, 'finite chrome with user text-spacing overrides');
  await page.evaluate(()=>{document.querySelector('style:last-of-type')?.remove();});
  await page.setViewportSize({width:1600,height:1000});
  await page.getByRole('button',{name:'main.typ',exact:true}).click();
  await waitForSource(page,'main.typ');
  const priorCompileCount=(await readFile(compilerCalls,'utf8').catch(()=>'' )).trim().split('\n').filter(Boolean).length;
  await page.getByRole('button',{name:'Recompile',exact:true}).click();
  await page.locator('#typst-compile').click();
  for(let i=0;i<100;i++) {
    const count=(await readFile(compilerCalls,'utf8').catch(()=>'' )).trim().split('\n').filter(Boolean).length;
    if(count>=priorCompileCount+2 && await page.locator('#typst-compile').textContent()==='Recompile') break;
    await page.waitForTimeout(100);
  }
  assert.equal((await readFile(compilerCalls,'utf8')).trim().split('\n').length,priorCompileCount+2,'explicit compilations are both executed');
  let firstCompileHeld;let releaseFirstCompile;let followupCompileHeld;let releaseFollowupCompile;let delayedCompile=true;
  const waitForFirstCompile=new Promise(resolve=>{firstCompileHeld=resolve;});const pendingFirstCompile=new Promise(resolve=>{releaseFirstCompile=resolve;});
  const waitForFollowupCompile=new Promise(resolve=>{followupCompileHeld=resolve;});const pendingFollowupCompile=new Promise(resolve=>{releaseFollowupCompile=resolve;});
  const holdCompileResponse=async route=>{
    const operation=route.request().postDataJSON();
    if(operation.action!=='compile'||operation.path!=='main.typ') return route.continue();
    if(delayedCompile) {
      delayedCompile=false;const response=await route.fetch();firstCompileHeld();await pendingFirstCompile;return route.fulfill({response});
    }
    followupCompileHeld();await pendingFollowupCompile;return route.continue();
  };
  await page.route('**/api/review',holdCompileResponse);
  await page.locator('#typst-compile').click();await waitForFirstCompile;
  await page.locator('.cm-content').click();await page.keyboard.press('Control+End');await page.keyboard.insertText('\n// Newer source saved while the compiled PDF response is pending.\n');
  await page.waitForFunction(()=>document.getElementById('save-label').textContent==='Saved locally');
  releaseFirstCompile();await waitForFollowupCompile;
  assert.equal(await page.locator('#typst-preview-status').getAttribute('data-state'),'stale','an older PDF response stays stale after newer source has already autosaved');
  assert.ok((await page.locator('#review-status').textContent()).includes('newer source still needs compilation'),'the compilation receipt uses the same revision-aware current status');
  releaseFollowupCompile();await page.waitForFunction(()=>document.getElementById('typst-preview-status').dataset.state==='current',{},{timeout:10000});
  await page.unroute('**/api/review',holdCompileResponse);
  await page.locator('#typst-pages canvas').first().waitFor({timeout:20000});
  assert.equal(await page.locator('#pdf-page-count').textContent(),'of 10');
  await page.locator('#review-close').click();
  for (const width of [1600,1100]) {
    await page.setViewportSize({width,height:1000}); await page.waitForTimeout(100);
    const toolbar = await page.locator('.preview-toolbar').evaluate(node => {
      const bounds=node.getBoundingClientRect();
      return {height:bounds.height,controlRows:[...node.querySelectorAll('button,input')].filter(control=>control.getClientRects().length).map(control=>control.getBoundingClientRect().top+control.getBoundingClientRect().height/2),nested:node.contains(document.getElementById('pdf-toolbar'))};
    });
    assert.equal(toolbar.height,32,`${width}px baseline uses one compact 32px preview toolbar`);
    assert.ok(toolbar.nested,'navigation shares the compilation toolbar');
    assert.ok(Math.max(...toolbar.controlRows)-Math.min(...toolbar.controlRows)<=1,'all desktop preview controls share one row');
    assert.equal(await page.locator('#typst-preview-status').getAttribute('data-state'),'current');
    assert.equal(await page.locator('#typst-preview-status').evaluate(node=>node.classList.contains('sr-only')),true,'current PDF status remains accessible without consuming a row');
    await assertChrome(page,`${width}px merged preview chrome`);
  }
  await page.setViewportSize({width:320,height:900}); await page.evaluate(()=>{document.documentElement.style.fontSize='28px';});
  await page.getByRole('button',{name:'Preview',exact:true}).click(); await page.waitForTimeout(100);
  await assertChrome(page,'320px enlarged PDF controls reflow with readable fields');
  assert.equal(await page.locator('#pdf-page-number').evaluate(node=>getComputedStyle(node).fontSize),'28px','editable page field preserves enlarged text');
  assert.ok(await page.locator('#typst-preview').evaluate(node=>node.clientHeight>=120),'enlarged controls retain usable PDF space');
  assert.ok(['fit','reflow'].includes(await page.locator('#typst-compile').getAttribute('data-text-fit')),'real Pretext checks the readable compile label and permits its rendered reflow');
  await page.screenshot({path:resolve('artifacts/preview-toolbar-enlarged.png'),fullPage:true});
  await page.evaluate(()=>{document.documentElement.style.fontSize='';}); await page.setViewportSize({width:1600,height:1000});
  await page.locator('#review-toggle').click();
  await page.locator('#pdf-page-number').fill('10'); await page.locator('#pdf-page-number').press('Enter');
  await page.locator('#pdf-page-number').blur();
  await page.locator('.pdf-page[data-page="10"] canvas').waitFor({timeout:10000});
  assert.ok(await page.locator('#typst-pages canvas').count()<=128,'PDF page navigation keeps a bounded visible canvas window');
  await page.locator('#pdf-page-number').fill('1'); await page.locator('#pdf-page-number').press('Enter'); await page.locator('#pdf-page-number').blur();
  for (let step=0; step<30 && Number.parseInt(await page.locator('#pdf-zoom-label').textContent())>10; step++) {
    await page.locator('#pdf-zoom-out').click(); await page.waitForTimeout(100);
  }
  await page.waitForFunction(()=>document.getElementById('pdf-zoom-label').textContent==='10%');
  await page.waitForFunction(()=>{
    const pane=document.getElementById('typst-preview'),bounds=pane.getBoundingClientRect(),pages=[...document.querySelectorAll('.pdf-page')];
    return pages.filter(page=>{const box=page.getBoundingClientRect();return box.bottom>bounds.top&&box.top<bounds.bottom;}).every(page=>page.querySelector('canvas')?.height>0) && pages.length>3;
  },{},{timeout:10000});
  const lowZoom=await page.evaluate(()=>{
    const pane=document.getElementById('typst-preview'),bounds=pane.getBoundingClientRect(),slots=[...document.querySelectorAll('.pdf-page')],canvases=[...document.querySelectorAll('#typst-pages canvas')];
    return {visible:slots.filter(slot=>{const box=slot.getBoundingClientRect();return box.bottom>bounds.top&&box.top<bounds.bottom;}).map(slot=>({page:slot.dataset.page,painted:Boolean(slot.querySelector('canvas')?.height)})),canvases:canvases.length,pixels:canvases.reduce((sum,canvas)=>sum+canvas.width*canvas.height,0)};
  });
  assert.ok(lowZoom.visible.length>3 && lowZoom.visible.every(slot=>slot.painted),'10% paints all viewport-visible PDF slots');
  assert.ok(lowZoom.canvases<=128 && lowZoom.pixels<=9_000_000,'visible pages share strict canvas-count and total-pixel budgets');
  await page.locator('#pdf-fit-width').click(); await page.waitForTimeout(150);
  await page.locator('#pdf-page-number').fill('10'); await page.locator('#pdf-page-number').press('Enter'); await page.locator('#pdf-page-number').blur();
  await page.locator('.pdf-page[data-page="10"] canvas').waitFor({timeout:10000});
  const fittedPageWidth=(await page.locator('.pdf-page[data-page="10"]').boundingBox()).width;
  const fittedLabel=Number.parseInt(await page.locator('#pdf-zoom-label').textContent());
  await page.locator('#pdf-zoom-in').click();
  await page.waitForFunction(previous=>Number.parseInt(document.getElementById('pdf-zoom-label').textContent)>previous,fittedLabel);
  assert.ok(Math.abs((await page.locator('.pdf-page[data-page="10"]').boundingBox()).width/fittedPageWidth-1.25)<.01,'Zoom in scales the real PDF page by the reference factor');
  assert.ok(Math.abs(Number.parseInt(await page.locator('#pdf-zoom-label').textContent())-fittedLabel*1.25)<=1,'the visible normalized zoom percentage follows the reference factor');
  await page.locator('#pdf-zoom-out').click();
  await page.waitForFunction(previous=>Number.parseInt(document.getElementById('pdf-zoom-label').textContent)===previous,fittedLabel);
  assert.ok(Math.abs((await page.locator('.pdf-page[data-page="10"]').boundingBox()).width-fittedPageWidth)<1,'Zoom out scales the real PDF page by the inverse reference factor');
  await page.locator('#pdf-fit-width').click(); await page.waitForTimeout(150);
  assert.ok(Math.abs((await page.locator('.pdf-page[data-page="10"]').boundingBox()).width-fittedPageWidth)<1,'normalized percentages preserve the physical fitted PDF size');
  await page.locator('#compile-log-toggle').click(); assert.equal(await page.locator('#compile-log').isVisible(),true);
  assert.ok((await page.locator('#compile-log').textContent()).includes('successfully'));
  await page.locator('#compile-log-toggle').click();
  const sourceDownload=page.waitForEvent('download');
  await menuAction(page,'file','Download source');
  const downloadedSource=await sourceDownload;
  assert.equal(downloadedSource.suggestedFilename(),'main.typ','source export remains available through the project menu');
  assert.equal(await readFile(await downloadedSource.path(),'utf8'),await readFile(join(projectRoot,'main.typ'),'utf8'),'source download preserves the complete text');
  const pdfDownload=page.waitForEvent('download');await page.getByRole('button',{name:'Export PDF',exact:true}).click();
  const downloadedPdf=await pdfDownload;assert.equal(downloadedPdf.suggestedFilename(),'main.pdf');
  assert.equal((await readFile(await downloadedPdf.path())).subarray(0,5).toString(),'%PDF-','icon download exports the actual cached PDF');
  assert.ok((await call({action:'pdf',project:project.id,path:'main.typ'})).available);
  await page.screenshot({path:resolve('artifacts/typst-desktop.png'),fullPage:true});
  await page.locator('#manuscript-share').check();
  const typstShare=await call({action:'share',project:project.id,path:'main.typ',enabled:true});
  const typstBefore=await call({action:'open',project:project.id,path:'main.typ'});const typstFrom=typstBefore.content.indexOf('Hello');
  const typstSuggestion=await mcp('suggest_text',{documentId:typstShare.documentId,proposal:{requestId:'typst-auto-build',revision:typstBefore.review.revision,from:typstFrom,to:typstFrom+5,quote:'Hello',replacement:'Greetings',rationale:'A clearer opening.'}});
  assert.equal(typstSuggestion.isError,false);await page.locator('.suggestion-card').waitFor({timeout:10000});
  await page.locator('.suggestion-card').getByRole('button',{name:'Accept',exact:true}).click();
  assert.ok(await page.locator('#typst-pages canvas').count()>0,'accepted Typst wording retains the last good preview');
  for(let index=0;index<120;index++) {const count=(await readFile(compilerCalls,'utf8')).trim().split('\n').length;if(count>=priorCompileCount+3&&await page.locator('#typst-preview-status').textContent().then(text=>text.startsWith('Current PDF'))) break;await page.waitForTimeout(100);}
  assert.ok((await readFile(compilerCalls,'utf8')).trim().split('\n').length>=priorCompileCount+3,'accepted Typst suggestions trigger automatic compilation');
  assert.ok((await page.locator('#typst-preview-status').textContent()).startsWith('Current PDF'),'automatic compile catches up to the accepted source');
  assert.ok((await readFile(join(projectRoot,'main.typ'),'utf8')).includes('Greetings world'));

  await page.evaluate(() => {
    const postMessage = Worker.prototype.postMessage;
    window.heldPdfTermination = [];
    Worker.prototype.postMessage = function (...args) {
      if (args[0]?.action === 'Terminate') window.heldPdfTermination.push(() => postMessage.apply(this, args));
      else postMessage.apply(this, args);
    };
    window.releasePdfTermination = () => {
      Worker.prototype.postMessage = postMessage;
      for (const send of window.heldPdfTermination.splice(0)) send();
    };
  });
  await page.locator('.cm-content').click(); await page.keyboard.press('Control+End'); await page.keyboard.insertText('\nPDF cleanup draft.');
  await page.getByRole('button',{name:'main.html',exact:true}).click();
  await page.waitForFunction(() => window.heldPdfTermination.length > 0);
  await page.getByRole('button',{name:'crlf.html',exact:true}).click();
  await page.waitForFunction(() => document.querySelector('#manuscript-tabs [role="tab"][aria-selected="true"]')?.textContent === 'crlf.html');
  await page.locator('.cm-content').click(); await page.keyboard.press('Control+End'); await page.keyboard.insertText('CRLF isolated draft.');
  await page.evaluate(() => window.releasePdfTermination()); await page.waitForTimeout(150);
  assert.ok((await page.locator('.cm-content').textContent()).includes('CRLF isolated draft.'),'a delayed old PDF worker shutdown cannot replace the newer file');
  assert.ok((await page.locator('#manuscript-tabs [role="tab"][aria-selected="true"]').textContent()).startsWith('crlf.html'));
  await page.getByRole('tab',{name:'main.typ',exact:true}).click();
  await waitForSource(page,'main.typ');
  assert.ok((await page.locator('.cm-content').textContent()).includes('PDF cleanup draft.'),'the detached PDF file keeps its own draft');
  await page.locator('#source-undo').click();
  assert.ok(!(await page.locator('.cm-content').textContent()).includes('PDF cleanup draft.'),'undo remains attached to the detached PDF file');
  assert.ok((await page.locator('.cm-content').textContent()).includes('Greetings world'),'undo does not remove the previous authoritative acceptance');
  await menuAction(page,'file','Save');
  await page.getByRole('tab',{name:'crlf.html',exact:true}).click();
  await waitForSource(page,'crlf.html');
  assert.ok((await page.locator('.cm-content').textContent()).includes('CRLF isolated draft.'),'the newer file retains its independent edit history');
  await page.locator('#source-undo').click(); await menuAction(page,'file','Save');
  assert.equal(await readFile(join(projectRoot,'crlf.html'),'utf8'),crlfSource,'undo after delayed PDF cleanup preserves the other file’s exact bytes');
  let releaseOpen; let openHeld;
  const waitForOpen = new Promise(resolve => { openHeld = resolve; });
  const pendingOpen = new Promise(resolve => { releaseOpen = resolve; });
  const holdOpen = async route => {
    const operation = route.request().postDataJSON();
    if (operation.action !== 'open' || operation.path !== 'delayed.html') return route.continue();
    const response = await route.fetch(); openHeld(); await pendingOpen; await route.fulfill({response});
  };
  await page.route('**/api/review', holdOpen);
  await page.getByRole('button',{name:'delayed.html',exact:true}).click(); await waitForOpen;
  await page.getByRole('button',{name:'main.html',exact:true}).click();
  await waitForSource(page,'main.html');
  releaseOpen(); await page.waitForTimeout(150); await page.unroute('**/api/review', holdOpen);
  assert.equal(await page.locator('#manuscript-tabs [role="tab"][aria-selected="true"]').textContent(),'main.html','a delayed real open response cannot override the latest chosen file');
  assert.equal(await page.getByRole('tab',{name:'delayed.html',exact:true}).count(),0,'an obsolete open response does not create a stray editor session');

  await page.getByRole('button',{name:'autosave-b.html',exact:true}).click();await waitForSource(page,'autosave-b.html');
  await page.getByRole('button',{name:'autosave-a.html',exact:true}).click();await waitForSource(page,'autosave-a.html');
  let releaseSave;let saveHeld;let holdFirstSave=true;
  const waitForSave=new Promise(resolve=>{saveHeld=resolve;});const pendingSave=new Promise(resolve=>{releaseSave=resolve;});
  const holdNavigationSave=async route=>{
    const operation=route.request().postDataJSON();
    if(operation.action!=='save'||operation.path!=='autosave-a.html'||!holdFirstSave) return route.continue();
    holdFirstSave=false;const response=await route.fetch();saveHeld();await pendingSave;await route.fulfill({response});
  };
  await page.route('**/api/review',holdNavigationSave);
  await page.locator('.cm-content').click();await page.keyboard.press('Control+End');await page.keyboard.insertText(' First A draft.');
  await page.getByRole('tab',{name:'autosave-b.html',exact:true}).click();await waitForSave;
  await page.locator('.cm-content').click();await page.keyboard.press('Control+End');await page.keyboard.insertText(' Late A draft.');
  const savedLateDraft=page.waitForResponse(response=>{
    if(!response.url().endsWith('/api/review')) return false;
    const operation=response.request().postDataJSON();return operation?.action==='save'&&operation.path==='autosave-a.html'&&operation.content.includes('Late A draft.');
  });
  releaseSave();await waitForSource(page,'autosave-b.html');
  await page.locator('.cm-content').click();await page.keyboard.press('Control+End');await page.keyboard.insertText(' New B draft.');
  await savedLateDraft;
  assert.ok((await readFile(join(projectRoot,'autosave-a.html'),'utf8')).includes('Late A draft.'),'newer typing during a navigation save still autosaves after switching and editing another file');
  await menuAction(page,'file','Save');
  assert.ok((await readFile(join(projectRoot,'autosave-b.html'),'utf8')).includes('New B draft.'),'each file keeps its own autosave timer');
  await page.unroute('**/api/review',holdNavigationSave);
  await page.getByRole('tab',{name:'main.html',exact:true}).click();await waitForSource(page,'main.html');

  const compositionText=await page.locator('.cm-content').textContent();
  await page.locator('.cm-content').evaluate(source => (source.editContext || source).dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true})));
  await page.getByRole('button',{name:'crlf.html',exact:true}).click();
  await page.waitForFunction(()=>document.getElementById('review-status').textContent.includes('Finish the current text composition'));
  assert.equal(await page.locator('#manuscript-tabs [role="tab"][aria-selected="true"]').textContent(),'main.html','navigation retains an active IME composition');
  assert.equal(await page.locator('.cm-content').textContent(),compositionText,'a composition veto preserves the source');
  await page.getByRole('button',{name:'Close main.html',exact:true}).click();await page.waitForTimeout(100);
  assert.equal(await page.getByRole('tab',{name:'main.html',exact:true}).count(),1,'a composition veto leaves the active session registered');
  await page.locator('.cm-content').evaluate(source => (source.editContext || source).dispatchEvent(new CompositionEvent('compositionend',{bubbles:true})));

  await page.getByRole('button',{name:'import.tex',exact:true}).click();
  await waitForSource(page,'import.tex');
  await menuAction(page,'file','Import to Typst');
  await page.getByRole('tab',{name:'import.typ',exact:true}).waitFor();
  assert.ok((await readFile(join(projectRoot,'import.typ'),'utf8')).includes('#strong[important]'));
  assert.ok((await readFile(join(projectRoot,'import.tex'),'utf8')).includes('\\custom{kept}'));
  const checkpoint=await call({action:'open',project:project.id,path:'main.typ'});
  await call({action:'save',project:project.id,path:'main.typ',revision:checkpoint.review.revision,content:'#unknown-function()'});
  const invalid=await call({action:'open',project:project.id,path:'main.typ'});
  await call({action:'compile',project:project.id,path:'main.typ',revision:invalid.review.revision},true);
  const preserved=await call({action:'pdf',project:project.id,path:'main.typ'});assert.equal(preserved.available,true);assert.equal(preserved.current,false);
  await page.getByRole('button',{name:'Close main.typ',exact:true}).click();
  await page.getByRole('tab',{name:'main.typ',exact:true}).waitFor({state:'detached'});
  await page.getByRole('button',{name:'main.typ',exact:true}).click();await waitForSource(page,'main.typ');await page.locator('#typst-pages canvas').first().waitFor({timeout:10000});
  await page.waitForFunction(()=>document.getElementById('typst-preview-status').dataset.state==='stale',{},{timeout:10000});
  assert.equal(await page.locator('#typst-preview-status').getAttribute('data-state'),'stale','stale cached PDF status is visible without a permanent toolbar row');
  assert.equal(await page.locator('#typst-preview-status').evaluate(node=>node.classList.contains('sr-only')),false);
  await page.locator('#typst-compile').click();await page.waitForFunction(()=>document.getElementById('typst-preview-status').dataset.state==='error',{},{timeout:10000});
  assert.ok(await page.locator('#typst-pages canvas').count()>0,'failed recompilation retains the cached canvases');
  await page.locator('#compile-log-toggle').click();assert.ok((await page.locator('#compile-log').textContent()).includes('unknown-function'),'full failure diagnostics remain available from the toolbar');
  await page.locator('#compile-log-toggle').click();await assertChrome(page,'preview failure status and controls preserve finite chrome');
  await call({action:'tunnel',enabled:false,reservation:'',public_url:''});
  assert.notEqual((await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'})}).catch(()=>({status:0}))).status,200);
  const secondRoot=join(root,'other-project');await mkdir(secondRoot);await writeFile(join(secondRoot,'other.html'),'<p>Only B may own this new highlight.</p>\n');
  const secondProject=await call({action:'add_project',root:secondRoot});
  for (const fixture of [project,secondProject]) await call({action:'bind_github',project:fixture.id,repository:'qualification/undertree-fixture',auto_sync:true});
  const syncProjects=[];let metadataAction;let releaseMetadata;let metadataHeld;
  const routeMetadata=async route=>{
    const operation=route.request().postDataJSON();
    if(operation.action==='sync') {
      syncProjects.push(operation.project);
      return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({ok:false,error:{code:'git',message:'Qualification records the sync target without contacting a remote.'}})});
    }
    if(operation.action===metadataAction) {
      const response=await route.fetch();metadataHeld();await releaseMetadata.promise;return route.fulfill({response});
    }
    return route.continue();
  };
  const holdMetadata=action=>{
    metadataAction=action;let release;const promise=new Promise(resolve=>{release=resolve;});releaseMetadata={promise,release};
    return new Promise(resolve=>{metadataHeld=resolve;});
  };
  await page.route('**/api/review',routeMetadata);await page.reload();
  await page.locator('#project-select').selectOption(project.id);await page.getByRole('button',{name:'main.html',exact:true}).click();await waitForSource(page,'main.html');
  await menuAction(page,'format','Color rules');await page.getByRole('button',{name:'Add color rule',exact:true}).click();
  await page.locator('.palette-row').last().getByLabel('Rule name').fill('Rule belongs to the original project');
  const paletteHeld=holdMetadata('palette');await page.getByRole('button',{name:'Save rules',exact:true}).click();await paletteHeld;
  await page.locator('#palette-dialog').getByRole('button',{name:'Cancel',exact:true}).click();
  await page.locator('#project-select').selectOption(secondProject.id);await page.getByRole('button',{name:'other.html',exact:true}).click();await waitForSource(page,'other.html');
  metadataAction=null;releaseMetadata.release();
  await page.waitForFunction(()=>document.getElementById('review-status').textContent.startsWith('Automatic GitHub sync paused:'),{},{timeout:10000});
  assert.deepEqual(syncProjects,[project.id],'a delayed palette response schedules autosync for its original project');
  assert.equal(await page.locator('#manuscript-tabs [role="tab"][aria-selected="true"]').textContent(),'other.html','the palette response leaves the newer editor intact');
  assert.ok((await call({action:'open',project:project.id,path:'main.html'})).review.rules.some(rule=>rule.label==='Rule belongs to the original project'));
  assert.ok(!(await call({action:'open',project:secondProject.id,path:'other.html'})).review.rules.some(rule=>rule.label==='Rule belongs to the original project'));
  await page.locator('.cm-content').click();await page.keyboard.press('Control+Home');
  for(let index=0;index<3;index++) await page.keyboard.press('ArrowRight');for(let index=0;index<6;index++) await page.keyboard.press('Shift+ArrowRight');
  await menuAction(page,'format','Highlight selection');assert.equal(await page.locator('#highlight-quote').textContent(),'Only B');
  const markHeld=holdMetadata('mark');await page.getByRole('button',{name:'Add highlight',exact:true}).click();await markHeld;
  await page.locator('#highlight-dialog').getByRole('button',{name:'Cancel',exact:true}).click();
  await page.locator('#project-select').selectOption(project.id);await page.getByRole('button',{name:'main.html',exact:true}).click();await waitForSource(page,'main.html');
  metadataAction=null;releaseMetadata.release();
  for(let index=0;index<120&&syncProjects.length<2;index++) await page.waitForTimeout(100);
  assert.deepEqual(syncProjects,[project.id,secondProject.id],'a delayed highlight response schedules autosync for its original project');
  assert.equal(await page.locator('#manuscript-tabs [role="tab"][aria-selected="true"]').textContent(),'main.html','the highlight response leaves the newer editor intact');
  assert.equal((await call({action:'open',project:secondProject.id,path:'other.html'})).review.markers[0].anchor.quote,'Only B');
  assert.equal((await call({action:'open',project:project.id,path:'main.html'})).review.markers.length,0,'the delayed highlight does not leak into the newer project');
  await page.unroute('**/api/review',routeMetadata);
  await writeFile(join(projectRoot,'main.html'),'<p>An external author changed the disk source.</p>\n');
  await page.locator('.cm-content').click();await page.keyboard.press('Control+End');await page.keyboard.insertText('\nKeep my newer draft.');
  await page.locator('#project-select').selectOption(secondProject.id);
  await page.waitForFunction(project=>document.getElementById('project-select').value===project&&!document.getElementById('review-conflict').hidden,project.id);
  assert.ok((await page.locator('.cm-content').textContent()).includes('Keep my newer draft.'),'a failed project-switch save retains the edited source');
  assert.equal(await page.locator('#manuscript-tabs [role="tab"][aria-selected="true"]').textContent(),'main.html •','a failed project-switch save retains the active editor session');
  assert.equal(await readFile(join(projectRoot,'main.html'),'utf8'),'<p>An external author changed the disk source.</p>\n','a failed project-switch save preserves the external disk change');
  if(!await page.locator('#review-conflict').isVisible()) await page.locator('#review-toggle').click();
  let releaseReload;let reloadHeld;
  const holdReload=async route=>{
    const operation=route.request().postDataJSON();
    if(operation.action!=='open'||operation.path!=='main.html') return route.continue();
    const response=await route.fetch();reloadHeld();await new Promise(resolve=>{releaseReload=resolve;});await route.fulfill({response});
  };
  await page.route('**/api/review',holdReload);
  const waitForReload=new Promise(resolve=>{reloadHeld=resolve;});
  await page.locator('#reload-buffer').click();await waitForReload;
  await page.locator('.cm-content').click();await page.keyboard.press('Control+End');await page.keyboard.insertText(' Typed while loading disk.');
  releaseReload();
  await page.waitForFunction(()=>document.getElementById('review-status').textContent.includes('Your buffer changed while the disk version was loading'));
  assert.ok((await page.locator('.cm-content').textContent()).includes('Typed while loading disk.'),'conflict reload retains typing added while its disk request was pending');
  assert.equal(await page.locator('#review-conflict').isVisible(),true,'a cancelled reload retains the original conflict and recovery actions');
  const waitForComposingReload=new Promise(resolve=>{reloadHeld=resolve;});
  await page.locator('#reload-buffer').click();await waitForComposingReload;
  await page.locator('.cm-content').evaluate(source=>(source.editContext||source).dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true})));
  releaseReload();await page.waitForFunction(()=>document.getElementById('review-status').textContent.includes('Finish the current text composition'));
  assert.ok((await page.locator('.cm-content').textContent()).includes('Typed while loading disk.'),'an IME composition begun during reload also preserves the buffer');
  await page.locator('.cm-content').evaluate(source=>(source.editContext||source).dispatchEvent(new CompositionEvent('compositionend',{bubbles:true})));
  await page.unroute('**/api/review',holdReload);
  await page.locator('#reload-buffer').click();await waitForSource(page,'main.html');
  await page.waitForFunction(()=>document.getElementById('review-conflict').hidden);
  assert.equal((await page.locator('.cm-content').textContent()).trim(),'<p>An external author changed the disk source.</p>','an unchanged explicit retry loads the selected disk version');
  assert.equal(await readFile(join(projectRoot,'main.html'),'utf8'),'<p>An external author changed the disk source.</p>\n','recovery never overwrites the external source');
  assert.deepEqual(errors,[]);
  console.log('Real Rust review/MCP, local reanchor/protection, pending/new cues, source-linked card collision/navigation/scroll, accepted Typst automatic PDF, six menus/centered title/source formatting/undo/outline, exact CRLF source markers and byte roundtrip, width×height/200%/text-spacing chrome, one 32px desktop preview toolbar/enlarged reflow/actual source+PDF downloads, all 10 PDF pages with bounded canvases, explicit builds, delayed real PDF Worker termination/open responses with independent file undo, delayed palette/highlight project ownership and recorded autosync targets, TeX import and visible failure/last-good PDF checks passed. zrok process and final autosync response simulated; public tunnel, live GitHub push and full rendered Overleaf parity not tested.');
} finally {
  await browser?.close();child.kill('SIGINT');
  await new Promise(r=>{if(child.exitCode!==null) r();else {child.once('exit',r);setTimeout(r,3000).unref();}});
  await rm(root,{recursive:true,force:true});
}
