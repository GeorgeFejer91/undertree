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
await writeFile(join(projectRoot, 'main.html'), original);
await writeFile(join(projectRoot, 'main.typ'), '#set page(paper: "a4")\n\n= Manuscript\n\nHello world. This is Typst, without TeX.\n');
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
  await page.getByRole('button',{name:'main.html',exact:true}).click();
  await page.locator('.cm-content').click();await page.keyboard.press('Control+Home');
  for(let i=0;i<3;i++) await page.keyboard.press('ArrowRight');
  for(let i=0;i<5;i++) await page.keyboard.press('Shift+ArrowRight');
  await page.getByRole('button',{name:'Highlight selection',exact:true}).click();
  await page.locator('#highlight-dialog-rule').selectOption('protect');
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
  await page.getByRole('button',{name:'Remove highlight',exact:true}).click();
  await page.locator('.review-card h3').getByText('Keep unchanged',{exact:true}).waitFor({state:'hidden'});
  const submitted=await mcp('suggest_text',{documentId:shared.documentId,proposal});assert.equal(submitted.isError,false);
  assert.equal(await readFile(join(projectRoot,'main.html'),'utf8'),original);
  await page.locator('.suggestion-card').waitFor({timeout:10000});
  await page.getByRole('button',{name:'Accept',exact:true}).click();
  await page.locator('.suggestion-card').waitFor({state:'hidden'});
  assert.equal(await readFile(join(projectRoot,'main.html'),'utf8'),original.replace('Hello','Greetings'));
  await mkdir(resolve('artifacts'),{recursive:true});await page.screenshot({path:resolve('artifacts/review-desktop.png'),fullPage:true});
  await page.getByRole('button',{name:'Color rules',exact:true}).click();
  await page.getByRole('button',{name:'Add color rule',exact:true}).click();
  const custom=page.locator('.palette-row').last();await custom.getByLabel('Rule name').fill('Keep meaning; make the introduction clearer and more concise');await custom.getByLabel('Fixed reviewer prompt').fill('Preserve every scientific claim; improve readability.');
  await page.getByRole('button',{name:'Save rules',exact:true}).click();
  await page.locator('.cm-content').click();await page.keyboard.press('Control+End');await page.keyboard.type('Editor history remains attached to this file.');
  await page.getByRole('button',{name:'Save',exact:true}).click();
  await page.getByRole('button',{name:'main.typ',exact:true}).click();
  await page.getByRole('tab',{name:'main.html',exact:true}).click();await page.locator('.cm-content').click();await page.keyboard.press('Control+z');
  assert.ok(!await page.locator('.cm-content').textContent().then(text=>text.includes('Editor history remains attached to this file.')),'undo survives file switches');
  await page.getByRole('button',{name:'Save',exact:true}).click();
  for(const width of [320,760,1100,1600]) {
    await page.setViewportSize({width,height:900});await page.waitForTimeout(100);
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`page reflow at ${width}`);
  }
  await page.setViewportSize({width:320,height:900});await page.getByRole('button',{name:'Review',exact:true}).click();
  await page.screenshot({path:resolve('artifacts/review-mobile.png'),fullPage:true});
  await page.evaluate(()=>{document.documentElement.style.fontSize='28px';});
  await page.waitForTimeout(100);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'200% text reflow');
  await page.evaluate(()=>{document.documentElement.style.fontSize='';});
  await page.setViewportSize({width:1600,height:1000});
  await page.getByRole('button',{name:'main.typ',exact:true}).click();
  await page.getByRole('button',{name:'Recompile',exact:true}).click();
  await page.locator('#typst-compile').click();
  for(let i=0;i<100;i++) {
    const count=(await readFile(compilerCalls,'utf8').catch(()=>'' )).trim().split('\n').filter(Boolean).length;
    if(count>=2 && await page.locator('#typst-compile').textContent()==='Recompile') break;
    await page.waitForTimeout(100);
  }
  assert.equal((await readFile(compilerCalls,'utf8')).trim().split('\n').length,2,'explicit compilations are both executed');
  await page.locator('#typst-pages canvas').waitFor({timeout:20000});
  assert.ok((await call({action:'pdf',project:project.id,path:'main.typ'})).available);
  await page.screenshot({path:resolve('artifacts/typst-desktop.png'),fullPage:true});
  await page.getByRole('button',{name:'import.tex',exact:true}).click();
  await page.getByRole('button',{name:'Import to Typst',exact:true}).click();
  await page.getByRole('tab',{name:'import.typ',exact:true}).waitFor();
  assert.ok((await readFile(join(projectRoot,'import.typ'),'utf8')).includes('#strong[important]'));
  assert.ok((await readFile(join(projectRoot,'import.tex'),'utf8')).includes('\\custom{kept}'));
  const checkpoint=await call({action:'open',project:project.id,path:'main.typ'});
  await call({action:'save',project:project.id,path:'main.typ',revision:checkpoint.review.revision,content:'#unknown-function()'});
  const invalid=await call({action:'open',project:project.id,path:'main.typ'});
  await call({action:'compile',project:project.id,path:'main.typ',revision:invalid.review.revision},true);
  const preserved=await call({action:'pdf',project:project.id,path:'main.typ'});assert.equal(preserved.available,true);assert.equal(preserved.current,false);
  await call({action:'tunnel',enabled:false,reservation:'',public_url:''});
  assert.notEqual((await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'})}).catch(()=>({status:0}))).status,200);
  assert.deepEqual(errors,[]);
  console.log('Native review, scoped MCP, protected highlights, acceptance, rules, narrow/200% reflow, real Typst PDF, queued explicit compilations, TeX import and failed-build preservation passed. zrok process simulated; public tunnel not tested.');
} finally {
  await browser?.close();child.kill('SIGINT');
  await new Promise(r=>{if(child.exitCode!==null) r();else {child.once('exit',r);setTimeout(r,3000).unref();}});
  await rm(root,{recursive:true,force:true});
}
