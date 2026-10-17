import { createTypstObserver } from './typst-observer-fixture.mjs';
import { markFixturePassage } from './context-fixture.mjs';
import { readFixtureContext } from './context-fixture.mjs';
import { confirmContextShareUi } from './context-fixture.mjs';
import { consentToFixtureShare } from './context-fixture.mjs';
import assert from 'node:assert/strict';
import { createZrokFixture } from './zrok-fixture.mjs';
import { mkdtemp, mkdir, writeFile, readFile, chmod, rm, cp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, dirname, basename } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { chromium } from 'playwright-core';

const root = await mkdtemp(join(tmpdir(), 'undertree-review-ui-'));
const selectedAssets = resolve(process.env.UNDERTREE_REVIEW_ASSETS || 'dist');
const frontendAssets = join(root, 'assets'); await cp(selectedAssets, frontendAssets, {recursive:true});
const selectedBinary = resolve(process.env.UNDERTREE_REVIEW_BINARY || 'target/debug/undertree-review');
const reviewBinary = join(root, `undertree-review${process.platform === 'win32' ? '.exe' : ''}`); await cp(selectedBinary, reviewBinary); await chmod(reviewBinary, 0o700);
async function snapshotHashes(directory, prefix = '') {
  const hashes = {};
  for (const entry of await readdir(directory, {withFileTypes:true})) {
    const path = join(directory, entry.name), key = join(prefix, entry.name);
    if (entry.isDirectory()) Object.assign(hashes, await snapshotHashes(path, key));
    else if (entry.isFile()) hashes[key] = createHash('sha256').update(await readFile(path)).digest('hex');
  }
  return hashes;
}
const snapshotReceipt = resolve(`artifacts/reverse-engineering/typst-overleaf-engine-parity/review-ui-snapshot-${basename(root)}.json`);
const snapshot = JSON.stringify({createdAt:new Date().toISOString(),selectedBinary,selectedAssets,runnerSha256:createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex'),binarySha256:createHash('sha256').update(await readFile(reviewBinary)).digest('hex'),frontend:await snapshotHashes(frontendAssets)},null,2)+'\n';
await mkdir(dirname(snapshotReceipt), {recursive:true}); await writeFile(snapshotReceipt, snapshot);
const snapshotSha256 = createHash('sha256').update(snapshot).digest('hex');
console.log(`Review UI snapshot: ${snapshotReceipt} (${snapshotSha256})`);
const projectRoot = join(root, 'project'); await mkdir(projectRoot);
const original = '<p>Hello world. This sentence has a clear meaning.</p>\n';
const crlfSource = '<p>First paragraph.\r\nSecond passage.</p>\r\n';
const chapterSource = '= Part\n\nA nested manuscript.\n';
const bibliographySource = '@book{undertree, title={An Offline Manuscript}, author={Example, Alice}, year={2026}}\n';
await writeFile(join(projectRoot, 'main.html'), original);
await writeFile(join(projectRoot, 'crlf.html'), crlfSource);
await writeFile(join(projectRoot, 'delayed.html'), '<p>A delayed file response must not replace the chosen manuscript.</p>\n');
await writeFile(join(projectRoot, 'autosave-a.html'), '<p>Autosave A.</p>\n');
await writeFile(join(projectRoot, 'autosave-b.html'), '<p>Autosave B.</p>\n');
await writeFile(join(projectRoot, 'composition.html'), '<p>A composed manuscript.</p>\n');
await writeFile(join(projectRoot, 'main.typ'), '#set page(paper: "a4")\n\n= Manuscript\n\nHello world. This is Typst, without TeX.\n' + Array.from({length:9}, (_, index) => `\n#pagebreak()\n= Page ${index + 2}\n\nA full-document preview reaches this page.\n`).join(''));
await mkdir(join(projectRoot, 'chapters')); await writeFile(join(projectRoot, 'chapters', 'part.typ'), chapterSource);
await writeFile(join(projectRoot, 'book.typ'), '#set text(font: ("UndertreeMissingParityFont", "Libertinus Serif"))\n= Whole project\n#include "chapters/part.typ"\nA reference @undertree.\n#bibliography("references.bib")\n');
await writeFile(join(projectRoot, 'references.bib'), bibliographySource);
await writeFile(join(projectRoot, 'import.tex'), '\\documentclass{article}\n\\begin{document}\n\\section{Results}An \\textbf{important} result.\\custom{kept}\n\\end{document}');
const targetFile = join(root,'zrok-target');
const zrokFixture = await createZrokFixture(root, targetFile, 'review.example.org');
const token = randomBytes(32).toString('hex');
const compilerCalls = join(root,'compiler-calls');
const compilerFixture = await createTypstObserver(root, compilerCalls);
const child = spawn(reviewBinary, [], { env: { ...process.env, ...zrokFixture.environment, ...compilerFixture.environment, UNDERTREE_REVIEW_PORT:'0', UNDERTREE_REVIEW_STATE:join(root,'state'), UNDERTREE_REVIEW_ASSETS:frontendAssets, UNDERTREE_REVIEW_TOKEN:token, UNDERTREE_ZROK: zrokFixture.executable, UNDERTREE_TYPST:compilerFixture.executable }, stdio:['ignore','pipe','pipe'] });
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
  await page.locator(`#${id}`).getByRole('menuitem',{name:label,exact:true}).or(page.locator(`#${id}`).getByRole('button',{name:label,exact:true})).click();
}
async function shareFixtureThroughUi(page,project,path,snapshot) {
  const matches=(response,action)=>response.url().endsWith('/api/review')&&response.request().method()==='POST'&&response.request().postDataJSON()?.action===action&&response.request().postDataJSON()?.project===project&&response.request().postDataJSON()?.path===path;
  const state=()=>page.evaluate(path=>({
    project:document.getElementById('project-select').value,
    tab:document.querySelector('#manuscript-tabs [aria-selected="true"]')?.textContent,
    content:document.querySelector('.cm-content')?.textContent,
    epoch:document.querySelector(`.file-button[data-path="${path}"]`)?.dataset.sourceEpoch,
    saved:document.getElementById('save-label').textContent,
    inputVersion:window.__fixtureShareCommand.inputVersion,
  }),path);
  const responses=[];let initial,firstPreview,firstOperation,expectedScope,guardProblem;
  const observe=response=>{if(matches(response,'share'))responses.push(response);};
  const guard=async route=>{
    const operation=route.request().postDataJSON();
    if(operation.action!=='share'||operation.enabled!==true)return route.continue();
    try {
      assert.deepEqual(await state(),initial,'A refused Share retry retains the exact clean editor and input version.');
      assert.equal(operation.project,project);assert.equal(operation.path,path);
      assert.equal(operation.sourceEpoch,snapshot.sourceEpoch);assert.deepEqual(operation.expectedRoot,snapshot.expectedRoot);
      assert.equal(operation.contextShared,true);assert.equal(operation.expectedContextScope,expectedScope);
      if(firstOperation)assert.deepEqual(operation,firstOperation,'A refused Share retry retains its complete native consent binding.');
      else firstOperation=operation;
    } catch(error){guardProblem=error;await route.abort();return;}
    return route.continue();
  };
  await page.evaluate(()=>{
    const control=document.getElementById('manuscript-share'),original=control.onchange;
    const command={control,original,commands:[],inputVersion:0};
    command.changed=()=>{command.inputVersion++;};
    document.addEventListener('beforeinput',command.changed,true);document.addEventListener('compositionstart',command.changed,true);
    control.onchange=function(event){const completion=original.call(this,event);command.commands.push(completion);return completion;};
    window.__fixtureShareCommand=command;
  });
  try {
    initial=await state();assert.equal(initial.project,project);assert.equal(initial.tab,path);assert.equal(initial.saved,'Saved locally');
    assert.equal(Number(initial.epoch),snapshot.sourceEpoch);assert.equal(snapshot.path,path);
    await page.route('**/api/review',guard);page.on('response',observe);
    for(let attempt=0;attempt<4;attempt++) {
      await waitForDocumentIdle(page);assert.deepEqual(await state(),initial);
      assert.equal(await page.locator('#manuscript-share').isChecked(),false);
      const before=responses.length,count=await page.evaluate(()=>window.__fixtureShareCommand.commands.length);
      const previewResponse=page.waitForResponse(async response=>matches(response,'context_preview')&&(await response.json()).ok===true);
      await page.locator('#manuscript-share').check();
      const preview=(await(await previewResponse).json()).result;
      assert.equal(preview.complete,true);assert.equal(preview.snapshot,'saved');
      assert.equal(preview.files.find(file=>file.path===path).sourceEpoch,snapshot.sourceEpoch);
      assert.equal(preview.files.find(file=>file.path===path).revision,snapshot.review.revision);
      if(firstPreview)assert.deepEqual(preview,firstPreview,'A refused Share retry retains the complete canonical scope, policy and source inventory.');
      else firstPreview=preview;
      expectedScope=preview.scopeId;
      await confirmContextShareUi(page,preview.files.map(file=>file.path));
      await page.evaluate(async count=>{
        const command=window.__fixtureShareCommand;
        if(command.commands.length!==count+1)throw Error('One Share consent must invoke exactly one actual onchange handler.');
        await command.commands.at(-1);
      },count);
      if(guardProblem)throw guardProblem;
      const receipts=await Promise.all(responses.slice(before).map(async response=>({operation:response.request().postDataJSON(),reply:await response.json()})));
      const grants=receipts.filter(receipt=>receipt.operation.enabled===true),revokes=receipts.filter(receipt=>receipt.operation.enabled===false);
      assert.equal(grants.length,1,'One actual Share command produces one grant attempt.');
      const {operation,reply}=grants[0];
      page.__fixtureHeldReceipts.push({action:'share_ui_command',attempt:attempt+1,receipts});
      assert.equal(operation.expectedContextScope,preview.scopeId);
      if(reply.ok) {
        assert.equal(revokes.length,0);assert.equal(reply.result.shared,true);
        assert.equal(reply.result.sourceEpoch,snapshot.sourceEpoch);assert.deepEqual(reply.result.expectedRoot,snapshot.expectedRoot);
        assert.equal(typeof reply.result.documentId,'string');assert.ok(reply.result.documentId);
        return reply.result;
      }
      assert.equal(reply.error?.code,'busy');assert.equal(reply.error.message,'A local document operation is running. Retry this action.');
      assert.equal(revokes.length,1,'A refused actual Share must finish its compensating revocation before another consent.');
      assert.equal(revokes[0].reply.ok,true);assert.equal(revokes[0].reply.result.shared,false);
      assert.ok(attempt<3,'Share fixture has at most four explicitly refused commands.');
    }
  } finally {
    page.off('response',observe);await page.unroute('**/api/review',guard);
    await page.evaluate(()=>{
      const command=window.__fixtureShareCommand;
      if(command){command.control.onchange=command.original;document.removeEventListener('beforeinput',command.changed,true);document.removeEventListener('compositionstart',command.changed,true);delete window.__fixtureShareCommand;}
    });
  }
}
async function setFixtureMain(page,clear=false) {
  const sourcePath=clear?'chapters/part.typ':'book.typ',targetPath=clear?'':'book.typ';
  const command=clear?'clear-main-document':'set-main-document',label=clear?'Clear main document':'Set as main document';
  const state=()=>page.evaluate(path=>({
    project:document.getElementById('project-select').value,
    tab:document.querySelector('#manuscript-tabs [aria-selected="true"]')?.textContent,
    content:document.querySelector('.cm-content')?.textContent,
    epoch:document.querySelector(`.file-button[data-path="${path}"]`)?.dataset.sourceEpoch,
    saved:document.getElementById('save-label').textContent,
  }),sourcePath);
  const initial=await state(),responses=[];let operation,guardProblem;
  assert.equal(initial.tab,sourcePath);assert.equal(initial.saved,'Saved locally');
  const guard=async route=>{
    const incoming=route.request().postDataJSON();
    if(incoming.action!=='set_main_document')return route.continue();
    try {
      assert.equal(incoming.project,initial.project);assert.equal(incoming.path,targetPath);
      if(!clear){assert.equal(incoming.sourceEpoch,Number(initial.epoch));assert.ok(incoming.expectedRoot);}
      if(operation)assert.deepEqual(incoming,operation,'A refused SetMain retry must retain the complete original native binding.');
      else operation=incoming;
    } catch(error){guardProblem=error;await route.abort();return;}
    return route.continue();
  };
  const observe=response=>{if(response.url().endsWith('/api/review')&&response.request().method()==='POST'&&response.request().postDataJSON()?.action==='set_main_document')responses.push(response);};
  await page.route('**/api/review',guard);page.on('response',observe);
  try {
    await page.evaluate(command=>{
      const handlers=[...document.querySelectorAll(`[data-command="${command}"]`)].map(button=>({button,original:button.onclick})),commands=[];
      for(const {button,original} of handlers)button.onclick=function(event){const completion=original.call(this,event);commands.push(completion);return completion;};
      window.__fixtureMainCommand={handlers,commands};
    },command);
    for(let attempt=0;attempt<4;attempt++) {
      await waitForDocumentIdle(page);assert.deepEqual(await state(),initial,'SetMain retry preserves the selected clean source and epoch.');
      const before=responses.length,count=await page.evaluate(()=>window.__fixtureMainCommand.commands.length);
      await menuAction(page,'file',label);
      await page.evaluate(async count=>{
        const command=window.__fixtureMainCommand;
        if(command.commands.length!==count+1)throw Error('The menu must invoke exactly one actual SetMain handler.');
        await command.commands.at(-1);
      },count);
      if(guardProblem)throw guardProblem;
      assert.equal(responses.length,before+1,'One actual SetMain command has one native receipt.');
      const reply=await responses.at(-1).json();
      if(reply.ok)return;
      assert.equal(reply.error?.code,'busy');assert.equal(reply.error.message,'A local document operation is running. Retry this action.');
      assert.ok(attempt<3,'SetMain fixture has at most four explicitly refused commands.');
    }
  } finally {
    page.off('response',observe);await page.unroute('**/api/review',guard);
    await page.evaluate(()=>{
      const command=window.__fixtureMainCommand;
      if(command){for(const {button,original} of command.handlers)button.onclick=original;delete window.__fixtureMainCommand;}
    });
  }
}
async function waitForSource(page, path) {
  const deadline = Date.now() + 30_000; let attempts = 0;
  while (Date.now() < deadline) {
    if (await page.evaluate(path => {
      const title = document.querySelector('#manuscript-tabs [role="tab"][aria-selected="true"]')?.textContent;
      return (title === path || title === `${path} •`) && !!document.querySelector('.cm-content');
    }, path)) return;
    const refused = page.__fixtureOpenReplies?.get(path);
    if (refused && !refused.body.ok) {
      assert.equal(refused.body.error?.code, 'busy');
      assert.equal(refused.body.error.message, 'A local document operation is running. Retry this action.');
      assert.ok(attempts++ < 4, 'A fixture Open has a bounded number of explicitly refused admission attempts.');
      await waitForDocumentIdle(page);
      if(page.__fixtureOpenReplies.get(path)!==refused)continue;
      assert.equal(await page.locator('#project-select').inputValue(),refused.operation.project,'A refused Open retry retains its original project.');
      const button = page.locator(`.file-button[data-path="${path}"]`);
      assert.equal(Number(await button.getAttribute('data-source-epoch')), refused.operation.sourceEpoch, 'A refused Open retry retains its original tree identity.');
      page.__fixtureOpenReplies.delete(path); await button.click();
    }
    await page.waitForTimeout(30);
  }
  assert.fail(`The genuine UI Open did not mount ${path}.`);
}

async function call(operation, expectError=false) {
  if (!expectError) operation = await consentToFixtureShare(operation, call);
  let value;
  for (let attempt = 0; ; attempt++) {
    const response=await fetch(base+'/api/review',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},body:JSON.stringify(operation)});
    value=await response.json();
    // Explicit fixture marks retain this exact quote/revision/root/epoch. The native
    // admission-busy response proves the operation has not been dispatched.
    const replayable = ['open','review','context_preview','pdf','connection','project_tree','projects','mark'].includes(operation.action);
    if (expectError || !replayable || attempt >= 3 || value.error?.code !== 'busy' || value.error.message !== 'A local document operation is running. Retry this action.') break;
    if (failurePage) await waitForDocumentIdle(failurePage);
    await new Promise(resolve => setTimeout(resolve, 40 * (attempt + 1)));
  }
  if(expectError) {assert.equal(value.ok,false);return value.error;}
  assert.equal(value.ok,true,value.error?.message);return value.result;
}
function waitForLateAutosaveReceipt(page, expectedOperation, firstNavigationSaveRequest) {
  let attempts=0;
  return page.waitForResponse(async response=>{
    if(!response.url().endsWith('/api/review')) return false;
    if(response.request()===firstNavigationSaveRequest) return false;
    const operation=response.request().postDataJSON();
    if(operation?.action!=='save'||operation.path!==expectedOperation.path||operation.project!==expectedOperation.project) return false;
    assert.deepEqual(operation,expectedOperation,'Every product retry retains the exact late autosave source, draft, revision, root and epoch.');
    const receipt=await response.json();attempts++;
    const intermediate=receipt.ok===false&&receipt.error?.code==='busy'&&receipt.error.message==='A local document operation is running. Retry this action.'&&attempts<6;
    page.__fixtureHeldReceipts.push({action:'late_autosave',operation,ok:receipt.ok,error:receipt.error,attempt:attempts,intermediate});
    return !intermediate;
  });
}
async function saveExactSource(page, project, path, expected) {
  const responses=[];
  const observe=response=>{
    if(!response.url().endsWith('/api/review')||response.request().method()!=='POST') return;
    const operation=response.request().postDataJSON();
    if(operation.action==='save'&&operation.project===project&&operation.path===path&&operation.content===expected) responses.push(response);
  };
  page.on('response',observe);
  try {
    // Native busy receipts can be intermediate attempts inside one UI Save.
    await page.evaluate(()=>{
      const button=document.getElementById('manuscript-save'), original=button.onclick;
      if(window.__fixtureSaveCommand) throw Error('A fixture Save command is already observed.');
      const commands=[];
      const wrapped=function(event){const completion=original.call(this,event);commands.push(completion);return completion;};
      button.onclick=wrapped;window.__fixtureSaveCommand={button,original,commands};
    });
    const draft = await page.locator('.cm-content').textContent();
    for (let attempt = 0; ; attempt++) {
      const before = responses.length;
      const commandBefore=await page.evaluate(()=>window.__fixtureSaveCommand.commands.length);
      await menuAction(page,'file','Save');
      await page.evaluate(async count=>{
        const command=window.__fixtureSaveCommand;
        if(command.commands.length!==count+1) throw Error('The menu must invoke exactly one real Save handler.');
        await command.commands.at(-1);
      },commandBefore);
      const reply=responses.length>before ? await responses.at(-1).json() : null;
      const refusal=reply&&!reply.ok ? reply.error : null;
      if (!refusal) {
        await page.waitForFunction(path=>document.getElementById('save-label').textContent==='Saved locally'&&document.querySelector('#manuscript-tabs [role="tab"][aria-selected="true"]')?.textContent===path,path);
        break;
      }
      assert.equal(refusal.code,'busy'); assert.equal(refusal.message,'A local document operation is running. Retry this action.');
      assert.ok(attempt < 3,'Save fixture has at most four explicitly refused admission attempts.');
      assert.equal(await page.locator('.cm-content').textContent(),draft,'A fixture Save retry cannot replace or alter the local draft.');
      await page.waitForTimeout(50 * (attempt + 1));
    }
    for(let i=0;page.__fixtureFiniteRequests?.size&&i<1000;i++) await page.waitForTimeout(20);
    assert.equal(page.__fixtureFiniteRequests?.size||0,0,'the saved source verification follows completion of outstanding UI document work');
    const saved=await call({action:'open',project,path});
    assert.equal(saved.content,expected,`native saved source for ${path} preserves the exact expected bytes`);
    let capturedSave;
    for(const response of responses) {
      const operation = response.request().postDataJSON();
      if (capturedSave) assert.deepEqual(operation,capturedSave,'Only the same source-bound Save may follow an explicit admission refusal.');
      else capturedSave = operation;
      const receipt=await response.json();
      if (!receipt.ok) { assert.equal(receipt.error?.code,'busy'); assert.equal(receipt.error.message,'A local document operation is running. Retry this action.'); continue; }
      assert.equal(receipt.result.content,expected,`save receipt contains the exact expected ${path} source`);
      assert.equal(receipt.result.review.revision,saved.review.revision,`save receipt and authoritative ${path} source share a revision`);
    }
    return saved;
  } finally {
    page.off('response',observe);
    await page.evaluate(()=>{
      const command=window.__fixtureSaveCommand;
      if(command){command.button.onclick=command.original;delete window.__fixtureSaveCommand;}
    });
  }
}
async function waitForEditorRevision(page, revision) {
  if(!page.__fixtureEditorSnapshots) return;
  const path=(await page.locator('#manuscript-tabs [aria-selected="true"]').textContent()).replace(/ •$/,'');
  for(let i=0;i<1000;i++) {
    const published=page.__fixtureEditorSnapshots.get(path);
    if(published?.revision===revision&&published.contentDigest===revision&&!published.dirty&&!published.composing&&!published.conflict) return;
    await page.waitForTimeout(20);
  }
  assert.fail('The exact saved editor snapshot was not acknowledged clean before reading remote manuscript context.');
}
async function waitForDocumentIdle(page, heldRequest) {
  const pending=()=>[...page.__fixtureFiniteRequests||[]].filter(request=>request!==heldRequest).length;
  for(let i=0;pending()&&i<1000;i++) await page.waitForTimeout(20);
  assert.equal(pending(),0,'the next positive local action follows completion of outstanding UI document work');
}
async function reloadExactBuffer(page) {
  const tab = await page.locator('#manuscript-tabs [aria-selected="true"]').textContent();
  const draft = await page.locator('.cm-content').textContent();
  let captured;
  for(let attempt=0;attempt<4;attempt++) {
    for(let i=0;page.__fixtureFiniteRequests?.size&&i<1000;i++) await page.waitForTimeout(20);
    assert.equal(await page.locator('#manuscript-tabs [aria-selected="true"]').textContent(),tab);
    assert.equal(await page.locator('.cm-content').textContent(),draft,'a refused reload preserves the exact recoverable buffer');
    const replied = page.waitForResponse(response=>response.url().endsWith('/api/review')&&response.request().postDataJSON()?.action==='open');
    await page.locator('#reload-buffer').click();
    const response=await replied, operation=response.request().postDataJSON(), receipt=await response.json();
    if(captured) assert.deepEqual(operation,captured,'only the identical source-bound reload follows an explicit admission refusal');
    else captured=operation;
    if(receipt.ok) return;
    assert.equal(receipt.error?.code,'busy');
    assert.equal(receipt.error.message,'A local document operation is running. Retry this action.');
  }
  assert.fail('The explicit source-bound reload remained refused after four admission attempts.');
}
let browser, failurePage, failureStage='main';
try {
  assert.equal((await fetch(base+'/api/review',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'projects'})})).status,401);
  const project=await call({action:'add_project',root:projectRoot});
  // Register fixture projects before live editor operations can hold document admission.
  const secondRoot=join(root,'other-project');await mkdir(secondRoot);await writeFile(join(secondRoot,'other.html'),'<p>Only B may own this new highlight.</p>\n');
  const secondProject=await call({action:'add_project',root:secondRoot});
  const preferenceRoot=join(root,'preferences-project');await mkdir(preferenceRoot);
  const preferenceSource='<p>'+ 'An editable sentence. '.repeat(25)+'</p>\n';await writeFile(join(preferenceRoot,'settings.html'),preferenceSource);
  const preferenceProject=await call({action:'add_project',root:preferenceRoot});
  const denied=await call({action:'open',project:project.id,path:'../main.html'},true);assert.equal(denied.code,'path');
  browser=await chromium.launch({executablePath:process.env.UNDERTREE_CHROME || '/usr/bin/google-chrome',headless:true,args:['--no-sandbox']});
  const context=await browser.newContext({viewport:{width:1600,height:1000}});
  const page=failurePage=await context.newPage();const errors=[];page.on('pageerror',error=>errors.push(error.message));
  const finiteRequests = new Set(), requestHistory = [], editorPaths = new Map(), editorSnapshots = new Map();
  page.__fixtureFiniteRequests = finiteRequests;
  page.__fixtureEditorSnapshots = editorSnapshots;
  page.__fixtureRequestHistory = requestHistory;
  page.__fixtureMutationHistory = [];
  page.__fixtureHeldReceipts = [];
  page.on('framenavigated',frame=>{if(frame===page.mainFrame()) finiteRequests.clear();});
  page.on('request', request => {
    if (!/\/api\/(review|editor)$/.test(request.url())) return;
    if (request.postDataJSON()?.action !== 'review_changes') finiteRequests.add(request);
  });
  page.on('requestfinished', request => finiteRequests.delete(request));
  page.on('requestfailed', request => finiteRequests.delete(request));
  page.on('response', async response => {
    if (!/\/api\/(review|editor)$/.test(response.url())) return;
    const operation=response.request().postDataJSON();
    if (operation?.action==='review_changes') return;
    const body=await response.json().catch(()=>null);
    if(body?.ok&&operation.action==='editor_register') editorPaths.set(body.result.sessionId,operation.path);
    if(body?.ok&&['editor_register','editor_update'].includes(operation.action)) {
      const path=operation.path||editorPaths.get(operation.sessionId);
      if(path) editorSnapshots.set(path,operation);
    }
    requestHistory.push({action:operation?.action,path:operation?.path,ok:body?.ok,error:body?.error});
    if(['save','compile','decide','palette','mark','reanchor','share','import_tex','set_main_document'].includes(operation?.action)) {
      page.__fixtureMutationHistory.push({action:operation.action,path:operation.path,ok:body?.ok,error:body?.error});
      if(page.__fixtureMutationHistory.length>500) page.__fixtureMutationHistory.shift();
    }
    if(requestHistory.length>40) requestHistory.shift();
  });
  page.__fixtureOpenReplies = new Map();
  page.on('request', request => {
    if (request.url().endsWith('/api/review') && request.postDataJSON()?.action === 'open') page.__fixtureOpenReplies.delete(request.postDataJSON().path);
  });
  page.on('response', async response => {
    if (!response.url().endsWith('/api/review') || response.request().postDataJSON()?.action !== 'open') return;
    const operation = response.request().postDataJSON(), body = await response.json().catch(() => null);
    if (body) page.__fixtureOpenReplies.set(operation.path, {operation, body});
  });
  await page.goto(base+`/manuscript.html#session=${token}`);
  await page.locator('#project-select').selectOption(project.id);
  assert.equal(await page.locator('#project-select').inputValue(),project.id,'the scenario starts in the intended registered project');
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
  await page.keyboard.insertText('A revised nested manuscript.');
  assert.ok((await page.locator('.cm-content').textContent()).includes('*A revised nested manuscript.*'),'typing replaces the selected bold text');
  await page.locator('#source-undo').click();assert.ok((await page.locator('.cm-content').textContent()).includes('*A nested manuscript.*'),'first Undo restores the bold selection before replacement typing');
  await page.locator('#source-undo').click();assert.ok(!(await page.locator('.cm-content').textContent()).includes('*A nested manuscript.*'),'toolbar formatting stays undoable');
  const beforeMathInsertion=await page.locator('.cm-content').textContent();
  await page.locator('.cm-content').click();await page.keyboard.press('Control+End');await menuAction(page,'insert','Inline math');
  await page.keyboard.insertText('z^2');assert.ok((await page.locator('.cm-content').textContent()).includes('$z^2$'),'Inline math selects an editable expression placeholder');
  await page.locator('#source-undo').click();assert.ok((await page.locator('.cm-content').textContent()).includes('$x^2$'),'Undo restores the math placeholder independently of typing');
  await page.locator('#source-undo').click();assert.equal(await page.locator('.cm-content').textContent(),beforeMathInsertion,'a second Undo removes only the inline math insertion');
  await page.locator('.cm-content').click();await page.keyboard.press('Control+Home');await page.keyboard.press('ArrowDown');await page.keyboard.press('ArrowDown');await page.keyboard.press('Home');await page.keyboard.press('Shift+End');
  await menuAction(page,'insert','Section heading');assert.ok((await page.locator('.cm-content').textContent()).includes('= A nested manuscript.'),'Insert heading applies to the current source line');
  await page.locator('#manuscript-outline').getByRole('button',{name:'A nested manuscript.',exact:true}).waitFor({timeout:10000});
  await page.locator('#manuscript-outline').getByRole('button',{name:'A nested manuscript.',exact:true}).click();
  assert.ok((await page.evaluate(()=>getSelection().toString())).includes('A nested manuscript.'),'outline navigation selects its source heading');
  await page.locator('#source-undo').click();
  await page.locator('#source-bullets').click();assert.ok((await page.locator('.cm-content').textContent()).includes('- A nested manuscript.'),'source list controls apply a Typst bullet');
  await page.locator('#source-undo').click();await menuAction(page,'insert','Numbered list');assert.ok((await page.locator('.cm-content').textContent()).includes('+ A nested manuscript.'),'Insert menu applies a Typst numbered list');
  await page.locator('#source-undo').click();await saveExactSource(page,project.id,'chapters/part.typ',chapterSource);
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
  assert.equal(await page.locator('#preview-collapse,#editor-collapse').count(),0,'content panes have no accidental collapse arrows');
  await page.locator('#rail-preview').click(); assert.equal(await page.locator('.manuscript-preview').isVisible(),true);
  await menuAction(page,'edit','Find and replace');
  assert.equal(await page.locator('.cm-search').isVisible(),true,'editor menu opens the real CodeMirror search');
  // This ordinary navigation follows the accepted chapter build and its metadata.
  await page.waitForFunction(()=>document.getElementById('typst-compile').textContent==='Recompile');
  await waitForDocumentIdle(page);
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
  await page.locator('#source-undo').click();await saveExactSource(page,project.id,'crlf.html',crlfSource);assert.equal(await readFile(join(projectRoot,'crlf.html'),'utf8'),crlfSource,'formatting undo roundtrips literal CRLF');
  await page.locator('.cm-content').click();await page.keyboard.press('Control+End');await page.keyboard.press('Enter');await page.locator('#source-undo').click();await saveExactSource(page,project.id,'crlf.html',crlfSource);
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
  const source=await call({action:'open',project:project.id,path:'main.html'});
  const shared=await shareFixtureThroughUi(page,project.id,'main.html',source);
  const tunnel=await call({action:'tunnel',enabled:true,reservation:'test-session',public_url:'https://review.example.org/'});
  const target=await readFile(targetFile,'utf8');const endpoint=target+new URL(tunnel.endpoint).pathname;
  const mcpHeaders = {'Content-Type':'application/json',Accept:'application/json, text/event-stream','MCP-Protocol-Version':'2025-06-18'};
  const initialized=await fetch(endpoint,{method:'POST',headers:mcpHeaders,body:JSON.stringify({jsonrpc:'2.0',id:0,method:'initialize',params:{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'UnderTree review test',version:'1'}}})});
  assert.equal((await initialized.json()).result.protocolVersion,'2025-06-18');
  async function mcp(name,args) {
    if (name === 'suggest_text' && !args.proposal.contextId) {
      await waitForEditorRevision(page,args.proposal.revision);
      const context = await readFixtureContext((method, params) => mcp(params.name, params.arguments), args.documentId);
      args = { ...args, proposal: { ...args.proposal, contextId: context.contextId } };
    }
    const body=JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}});
    for (let attempt = 0; ; attempt++) {
      const response=await fetch(endpoint,{method:'POST',headers:mcpHeaders,body});
      if(response.status===429&&['read_manuscript','list_manuscripts'].includes(name)) {
        await response.arrayBuffer();
        page.__fixtureMcpErrors ||= [];page.__fixtureMcpErrors.push({name,status:429});
        if(page.__fixtureMcpErrors.length>40)page.__fixtureMcpErrors.shift();
        if(attempt<3){await waitForDocumentIdle(page);await new Promise(resolve=>setTimeout(resolve,40*(attempt+1)));continue;}
      }
      assert.equal(response.status,200); const result = (await response.json()).result;
      if(result.isError===true) {
        page.__fixtureMcpErrors ||= [];
        page.__fixtureMcpErrors.push({name,requestId:args.proposal?.requestId,result});
        if(page.__fixtureMcpErrors.length>40)page.__fixtureMcpErrors.shift();
      }
      const busy = result.isError===true && result.content?.some(item => item.type==='text' && ['A local document operation is running. Retry this action.','A local editor operation is running. Retry this action.'].includes(item.text));
      if (!busy || attempt >= 3) return result;
      await waitForDocumentIdle(page);
      await new Promise(resolve => setTimeout(resolve, 40 * (attempt + 1)));
    }
  }
  const proposal={requestId:'review-1',revision:source.review.revision,from:3,to:8,quote:'Hello',replacement:'Greetings',rationale:'More precise opening.'};
  const blocked=await mcp('suggest_text',{documentId:shared.documentId,proposal});assert.equal(blocked.isError,true);
  assert.equal((await mcp('accept_suggestion',{})).isError,true);
  const markerBefore=source.review.markers[0];
  await page.locator('.cm-content').click(); await page.keyboard.press('Control+Home');
  for(let index=0;index<3;index++) await page.keyboard.press('ArrowRight');
  for(let index=0;index<5;index++) await page.keyboard.press('Shift+ArrowRight');
  await page.keyboard.insertText('Hi'); await saveExactSource(page,project.id,'main.html',original.replace('Hello','Hi'));
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
  await page.locator('.cm-content').click(); await page.keyboard.press('Control+a'); await page.keyboard.insertText(original); await saveExactSource(page,project.id,'main.html',original);

  await page.getByRole('button',{name:'Remove highlight',exact:true}).click();
  await page.locator('.review-card h3').getByText('Keep unchanged',{exact:true}).waitFor({state:'hidden'});
  await markFixturePassage(call, project.id, await call({action:'open',project:project.id,path:'main.html'}), 'Hello world. This sentence has a clear meaning.');
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
  if (await page.locator('#review-toggle').getAttribute('aria-pressed') !== 'true') await page.locator('#review-toggle').click();
  await page.locator('#review-new-cue').click();
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
  const htmlAcceptance=page.waitForResponse(response=>{
    if(!response.url().endsWith('/api/review')||response.request().method()!=='POST') return false;
    const operation=response.request().postDataJSON();return operation.action==='decide'&&operation.path==='main.html'&&operation.decision==='accepted';
  });
  await waitForDocumentIdle(page);
  await page.locator('.suggestion-card').first().getByRole('button',{name:'Accept',exact:true}).click();
  const htmlAccepted=await (await htmlAcceptance).json();assert.equal(htmlAccepted.ok,true,htmlAccepted.error?.message);
  assert.equal(htmlAccepted.result.content,original.replace('Hello','Greetings'),'native HTML acceptance stores the exact expected source');
  for(let index=0;index<100&&await page.locator('.suggestion-card').count()!==3;index++) await page.waitForTimeout(50);
  assert.equal(await page.locator('.suggestion-card').count(),3,'the accepted HTML suggestion leaves the pending list');
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
  await markFixturePassage(call, project.id, composingSource, 'composed');
  assert.equal((await mcp('suggest_text',{documentId:composingShare.documentId,proposal:{requestId:'composition-race',revision:composingSource.review.revision,from:composingFrom,to:composingFrom+'composed'.length,quote:'composed',replacement:'revised',rationale:'Qualify a composition beginning during acceptance.'}})).isError,false);
  await page.locator('#review-refresh').click();await page.locator('.suggestion-card').waitFor();
  let acceptanceHeld;let releaseAcceptance;
  const waitForAcceptance=new Promise(resolve=>{acceptanceHeld=resolve;});const pendingAcceptance=new Promise(resolve=>{releaseAcceptance=resolve;});
  const holdAcceptance=async route=>{
    const operation=route.request().postDataJSON();
    if(operation.action!=='decide'||operation.path!=='composition.html') return route.continue();
    const response=await route.fetch();finiteRequests.delete(route.request());acceptanceHeld();await pendingAcceptance;await route.fulfill({response});
  };
  await page.route('**/api/review',holdAcceptance);
  await waitForDocumentIdle(page);
  await page.locator('.suggestion-card').getByRole('button',{name:'Accept',exact:true}).click();await waitForAcceptance;
  await page.locator('.cm-content').focus();
  await page.locator('.cm-content').evaluate(source=>(source.editContext||source).dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true})));
  releaseAcceptance();await page.locator('#review-conflict').waitFor();
  assert.ok((await page.locator('.cm-content').textContent()).includes('A composed manuscript.'),'acceptance cannot overwrite a composition begun while its native request was pending');
  assert.equal(await readFile(join(projectRoot,'composition.html'),'utf8'),'<p>A revised manuscript.</p>\n','native acceptance stays authoritative while the live composing buffer remains recoverable');
  assert.equal(await page.locator('#manuscript-tabs [role="tab"][aria-selected="true"]').textContent(),'composition.html •','the composing buffer remains dirty against the accepted disk source');
  await page.locator('.cm-content').evaluate(source=>(source.editContext||source).dispatchEvent(new CompositionEvent('compositionend',{bubbles:true})));
  await page.unroute('**/api/review',holdAcceptance);
  await reloadExactBuffer(page);await page.waitForFunction(()=>document.getElementById('review-conflict').hidden);
  assert.ok((await page.locator('.cm-content').textContent()).includes('A revised manuscript.'),'explicit conflict recovery loads the accepted source after composition finishes');
  await page.getByRole('button',{name:'Close composition.html',exact:true}).click();
  await page.getByRole('tab',{name:'main.html',exact:true}).click();await waitForSource(page,'main.html');
  await mkdir(resolve('artifacts'),{recursive:true});await page.screenshot({path:resolve('artifacts/review-desktop.png'),fullPage:true});
  await menuAction(page,'format','Color rules');
  await page.getByRole('button',{name:'Add color rule',exact:true}).click();
  const custom=page.locator('.palette-row').last();await custom.getByLabel('Rule name').fill('Keep meaning; make the introduction clearer and more concise');await custom.getByLabel('Fixed reviewer prompt').fill('Preserve every scientific claim; improve readability.');
  await page.getByRole('button',{name:'Save rules',exact:true}).click();
  await page.locator('.cm-content').click();await page.keyboard.press('Control+End');await page.keyboard.type('Editor history remains attached to this file.');
  await saveExactSource(page,project.id,'main.html',original.replace('Hello','Greetings')+'Editor history remains attached to this file.');
  await page.getByRole('button',{name:'main.typ',exact:true}).click();
  await waitForSource(page,'main.typ');
  await page.getByRole('tab',{name:'main.html',exact:true}).click();await waitForSource(page,'main.html');await page.locator('.cm-content').click();await page.keyboard.press('Control+z');
  assert.ok(!await page.locator('.cm-content').textContent().then(text=>text.includes('Editor history remains attached to this file.')),'undo survives file switches');
  await saveExactSource(page,project.id,'main.html',original.replace('Hello','Greetings'));
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
  const searchBounds=await page.locator('#editor-search').evaluate(button=>{const r=button.getBoundingClientRect(),p=button.parentElement.getBoundingClientRect();return r.left>=p.left-1&&r.right<=p.right+1&&r.top>=p.top-1&&r.bottom<=p.bottom+1;});
  assert.ok(searchBounds,'enlarged source search action stays inside its toolbar');
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
  // Tab mounting precedes PDF/annotation reads. Start the queue scenario only
  // after that navigation has completed, so those reads cannot refuse admission.
  await page.waitForFunction(()=>document.querySelector('.file-button[data-path="main.typ"]')?.getAttribute('aria-current')==='true');
  for(let i=0;finiteRequests.size&&i<300;i++) await page.waitForTimeout(20);
  assert.equal(finiteRequests.size,0,'navigation and editor registrations finish before the explicit compilation scenario');
  const priorCompileCount=(await readFile(compilerCalls,'utf8').catch(()=>'' )).trim().split('\n').filter(Boolean).length;
  const firstExplicitCompile=page.waitForRequest(request=>request.url().endsWith('/api/review')&&request.postDataJSON()?.action==='compile');
  await page.getByRole('button',{name:'Recompile',exact:true}).click();
  await firstExplicitCompile;
  assert.equal(await page.locator('#typst-compile').textContent(),'Compiling…','the second explicit click is made while the first build is in flight');
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
      delayedCompile=false;await waitForDocumentIdle(page,route.request());const response=await route.fetch();finiteRequests.delete(route.request());
      const receipt=await response.json();page.__fixtureHeldReceipts.push({action:operation.action,path:operation.path,ok:receipt.ok,error:receipt.error});assert.equal(receipt.ok,true,`the held main build must succeed before its response is delayed: ${JSON.stringify(receipt.error)}`);
      firstCompileHeld();await pendingFirstCompile;return route.fulfill({response});
    }
    followupCompileHeld();await pendingFollowupCompile;await waitForDocumentIdle(page,route.request());return route.continue();
  };
  await page.route('**/api/review',holdCompileResponse);
  await page.locator('#typst-compile').click();await waitForFirstCompile;
  const mainBeforeHeldEdit=await call({action:'open',project:project.id,path:'main.typ'});
  const heldMainEdit='// Newer source saved while the compiled PDF response is pending.';
  await page.locator('.cm-content').click();await page.keyboard.press('Control+End');await page.keyboard.insertText(heldMainEdit);
  await saveExactSource(page,project.id,'main.typ',mainBeforeHeldEdit.content+heldMainEdit);
  assert.equal((await call({action:'open',project:project.id,path:'main.typ'})).content,mainBeforeHeldEdit.content+heldMainEdit,'the newer main input is authoritatively saved before the old PDF response is released');
  releaseFirstCompile();await waitForFollowupCompile;
  assert.equal(await page.locator('#typst-preview-status').getAttribute('data-state'),'stale','an older PDF response stays stale after newer source has been explicitly saved');
  assert.ok((await page.locator('#review-status').textContent()).includes('recompile or verify project inputs'),'the compilation receipt uses the same revision-aware current status');
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
  await page.waitForFunction(()=>{const page=document.querySelector('.pdf-page');return page&&Math.abs(page.getBoundingClientRect().width-(document.getElementById('typst-preview').clientWidth-32))<1;});
  const zoomBeforePageEdit=Number.parseInt(await page.locator('#pdf-zoom-label').textContent());
  await page.locator('#pdf-page-number').fill('10');
  await page.setViewportSize({width:1500,height:1000});
  await page.waitForFunction(previous=>Number.parseInt(document.getElementById('pdf-zoom-label').textContent)!==previous,zoomBeforePageEdit);
  assert.equal(await page.locator('#pdf-page-number').inputValue(),'10','a real asynchronous resize render preserves a focused page-number edit');
  await page.setViewportSize({width:1600,height:1000});
  await page.waitForFunction(previous=>Number.parseInt(document.getElementById('pdf-zoom-label').textContent)===previous,zoomBeforePageEdit);
  assert.equal(await page.locator('#pdf-page-number').inputValue(),'10','a second render also preserves the uncommitted page selection');
  await page.locator('#pdf-page-number').press('Enter');
  await page.locator('#pdf-page-number').blur();
  await page.locator('.pdf-page[data-page="10"] canvas').waitFor({timeout:10000}).catch(async error=>{
    throw new Error(`${error.message}\n${JSON.stringify(await page.evaluate(()=>({page:document.getElementById('pdf-page-number').value,total:document.getElementById('pdf-page-count').textContent,preview:document.getElementById('typst-preview-status').textContent,status:document.getElementById('review-status').textContent,canvases:[...document.querySelectorAll('.pdf-page canvas')].map(canvas=>canvas.parentElement.dataset.page),scrollTop:document.getElementById('typst-preview').scrollTop,previewHeight:document.getElementById('typst-preview').clientHeight})))}`);
  });
  assert.ok(await page.locator('#typst-pages canvas').count()<=128,'PDF page navigation keeps a bounded visible canvas window');
  await page.locator('#pdf-page-number').fill('2.5'); await page.locator('#pdf-page-number').press('Enter'); await page.locator('#pdf-page-number').blur();
  assert.equal(await page.locator('#pdf-page-number').inputValue(),'2','committed fractional page input normalizes to an integer');
  await page.locator('.pdf-page[data-page="2"] canvas').waitFor({timeout:10000});
  await page.locator('#pdf-next').click();
  await page.waitForFunction(()=>document.getElementById('pdf-page-number').value==='3',{},{timeout:10000});
  assert.equal(await page.locator('#pdf-page-number').inputValue(),'3','Next advances from the normalized integer page');
  await page.locator('.pdf-page[data-page="3"] canvas').waitFor({timeout:10000});
  await page.locator('#pdf-previous').click();
  await page.waitForFunction(()=>document.getElementById('pdf-page-number').value==='2',{},{timeout:10000});
  assert.equal(await page.locator('#pdf-page-number').inputValue(),'2','Previous returns to the normalized integer page');
  await page.locator('.pdf-page[data-page="2"] canvas').waitFor({timeout:10000});
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
  const typstBefore=await call({action:'open',project:project.id,path:'main.typ'});const typstFrom=typstBefore.content.indexOf('Hello');
  const typstShare=await shareFixtureThroughUi(page,project.id,'main.typ',typstBefore);
  await markFixturePassage(call, project.id, typstBefore, 'Hello');
  const typstSuggestion=await mcp('suggest_text',{documentId:typstShare.documentId,proposal:{requestId:'typst-auto-build',revision:typstBefore.review.revision,from:typstFrom,to:typstFrom+5,quote:'Hello',replacement:'Greetings',rationale:'A clearer opening.'}});
  assert.equal(typstSuggestion.isError,false,JSON.stringify(typstSuggestion));await page.locator('.suggestion-card').waitFor({timeout:10000});
  const acceptanceCompileCount=(await readFile(compilerCalls,'utf8')).trim().split('\n').length;
  const typstAcceptance=page.waitForResponse(response=>{
    if(!response.url().endsWith('/api/review')||response.request().method()!=='POST') return false;
    const operation=response.request().postDataJSON();
    return operation.action==='decide'&&operation.path==='main.typ'&&operation.decision==='accepted';
  });
  await waitForDocumentIdle(page);
  await page.locator('.suggestion-card').getByRole('button',{name:'Accept',exact:true}).click();
  const acceptedTypst=(await (await typstAcceptance).json());assert.equal(acceptedTypst.ok,true,acceptedTypst.error?.message);
  assert.equal(acceptedTypst.result.content,typstBefore.content.replace('Hello','Greetings'),'native acceptance receipt contains the exact accepted source');
  assert.notEqual(acceptedTypst.result.review.revision,typstBefore.review.revision,'native acceptance advances the source revision');
  await page.locator('.suggestion-card').waitFor({state:'hidden',timeout:10000});
  assert.ok(await page.locator('#typst-pages canvas').count()>0,'accepted Typst wording retains the last good preview');
  for(let index=0;index<120;index++) {const count=(await readFile(compilerCalls,'utf8')).trim().split('\n').length;if(count>acceptanceCompileCount&&await page.locator('#typst-preview-status').textContent().then(text=>text.startsWith('Current PDF'))) break;await page.waitForTimeout(100);}
  assert.ok((await readFile(compilerCalls,'utf8')).trim().split('\n').length>acceptanceCompileCount,'accepted Typst suggestions trigger a new automatic compilation');
  assert.ok((await page.locator('#typst-preview-status').textContent()).startsWith('Current PDF'),`automatic compile catches up to the accepted source: ${JSON.stringify(await page.evaluate(()=>({preview:document.getElementById('typst-preview-status').textContent,receipt:document.getElementById('review-status').textContent,log:document.getElementById('compile-log').textContent,conflict:!document.getElementById('review-conflict').hidden})))}`);
  const acceptedPdf=await call({action:'pdf',project:project.id,path:'main.typ'});
  assert.equal(acceptedPdf.current,true,'the accepted PDF has a current native publication receipt');
  assert.equal(acceptedPdf.revision,acceptedTypst.result.review.revision,'the PDF receipt matches the authoritative accepted source revision');
  assert.ok((await readFile(join(projectRoot,'main.typ'),'utf8')).includes('Greetings world'));
  await page.waitForFunction(()=>document.getElementById('typst-compile').textContent==='Recompile');
  await waitForDocumentIdle(page);
  await page.locator('.cm-content').click(); await page.keyboard.press('Control+End'); await page.keyboard.insertText('\nPDF cleanup draft.');
  await saveExactSource(page,project.id,'main.typ',acceptedTypst.result.content+'\nPDF cleanup draft.');
  await page.waitForFunction(()=>document.getElementById('typst-compile').textContent==='Recompile');
  for(let i=0;finiteRequests.size&&i<300;i++) await page.waitForTimeout(20);
  assert.equal(finiteRequests.size,0,'the accepted build finishes before the old-worker termination fixture is installed');

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
  await saveExactSource(page,project.id,'main.typ',acceptedTypst.result.content);
  await page.getByRole('tab',{name:'crlf.html',exact:true}).click();
  await waitForSource(page,'crlf.html');
  assert.ok((await page.locator('.cm-content').textContent()).includes('CRLF isolated draft.'),'the newer file retains its independent edit history');
  await page.locator('#source-undo').click();
  assert.ok(!(await page.locator('.cm-content').textContent()).includes('CRLF isolated draft.'),'Undo removes the newer file’s independent draft in its live editor');
  await saveExactSource(page,project.id,'crlf.html',crlfSource);
  assert.equal(await readFile(join(projectRoot,'crlf.html'),'utf8'),crlfSource,'undo after delayed PDF cleanup preserves the other file’s exact bytes');
  let releaseOpen; let openHeld;
  const waitForOpen = new Promise(resolve => { openHeld = resolve; });
  const pendingOpen = new Promise(resolve => { releaseOpen = resolve; });
  const holdOpen = async route => {
    const operation = route.request().postDataJSON();
    if (operation.action !== 'open' || operation.path !== 'delayed.html') return route.continue();
    const response = await route.fetch(); finiteRequests.delete(route.request()); openHeld(); await pendingOpen; await route.fulfill({response});
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
  let releaseSave;let saveHeld;let holdFirstSave=true;let firstNavigationSaveOperation;let firstNavigationSaveRequest;let expectedLateNavigationSave;
  const waitForSave=new Promise(resolve=>{saveHeld=resolve;});const pendingSave=new Promise(resolve=>{releaseSave=resolve;});
  const holdNavigationSave=async route=>{
    const operation=route.request().postDataJSON();
    if(expectedLateNavigationSave&&operation.action==='save'&&operation.path==='autosave-a.html') assert.deepEqual(operation,expectedLateNavigationSave,'A product late autosave retry retains its full original body before native dispatch.');
    if(operation.action!=='save'||operation.path!=='autosave-a.html'||!holdFirstSave) return route.continue();
    firstNavigationSaveOperation=operation;
    firstNavigationSaveRequest=route.request();
    holdFirstSave=false;await waitForDocumentIdle(page,route.request());const response=await route.fetch();finiteRequests.delete(route.request());
    const receipt=await response.json();page.__fixtureHeldReceipts.push({action:operation.action,path:operation.path,ok:receipt.ok,error:receipt.error});
    saveHeld(receipt);await pendingSave;await route.fulfill({response});
  };
  await page.route('**/api/review',holdNavigationSave);
  await page.locator('.cm-content').click();await page.keyboard.press('Control+End');await page.keyboard.insertText(' First A draft.');
  await page.getByRole('tab',{name:'autosave-b.html',exact:true}).click();
  const heldNavigationSave=await waitForSave;
  if(!heldNavigationSave.ok) releaseSave();
  assert.equal(heldNavigationSave.ok,true,`the first native navigation Save must commit before late typing is introduced: ${JSON.stringify(heldNavigationSave.error)}`);
  await page.locator('.cm-content').click();await page.keyboard.press('Control+End');await page.keyboard.insertText(' Late A draft.');
  expectedLateNavigationSave={...firstNavigationSaveOperation,revision:heldNavigationSave.result.review.revision,content:'<p>Autosave A.</p>\n First A draft. Late A draft.'};
  const savedLateDraft=waitForLateAutosaveReceipt(page,expectedLateNavigationSave,firstNavigationSaveRequest);
  releaseSave();await waitForSource(page,'autosave-b.html');
  await page.locator('.cm-content').click();await page.keyboard.press('Control+End');await page.keyboard.insertText(' New B draft.');
  const lateDraftReceipt=await (await savedLateDraft).json();assert.equal(lateDraftReceipt.ok,true,lateDraftReceipt.error?.message);
  assert.equal(lateDraftReceipt.result.content,'<p>Autosave A.</p>\n First A draft. Late A draft.','the native autosave receipt includes both versions of the first file’s draft');
  await waitForDocumentIdle(page);
  assert.equal((await call({action:'open',project:project.id,path:'autosave-a.html'})).review.revision,lateDraftReceipt.result.review.revision,'the autosave receipt matches the saved first-file revision');
  assert.ok((await readFile(join(projectRoot,'autosave-a.html'),'utf8')).includes('Late A draft.'),'newer typing during a navigation save still autosaves after switching and editing another file');
  await saveExactSource(page,project.id,'autosave-b.html','<p>Autosave B.</p>\n New B draft.');
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
  await waitForDocumentIdle(page);
  await menuAction(page,'file','Import to Typst');
  await page.getByRole('tab',{name:'import.typ',exact:true}).waitFor();
  assert.ok((await readFile(join(projectRoot,'import.typ'),'utf8')).includes('#strong[important]'));
  assert.ok((await readFile(join(projectRoot,'import.tex'),'utf8')).includes('\\custom{kept}'));
  await page.getByRole('button',{name:'book.typ',exact:true}).click();await waitForSource(page,'book.typ');
  await waitForDocumentIdle(page);
  await setFixtureMain(page);
  await page.waitForFunction(()=>document.getElementById('review-status').textContent==='Main document: book.typ');
  assert.equal((await call({action:'projects'})).find(item=>item.id===project.id).mainDocument,'book.typ','main document is stored by the native authority');
  await page.setViewportSize({width:320,height:900});await page.evaluate(()=>{document.documentElement.style.fontSize='28px';});
  await page.locator('#workspace-menu summary').click();
  await page.waitForFunction(()=>[...document.querySelectorAll('#workspace-menu [data-command$="main-document"]')].every(button=>['fit','reflow'].includes(button.dataset.textFit)));
  assert.equal(await page.locator('#workspace-menu [data-command="clear-main-document"]').evaluate(button=>button.scrollWidth<=button.clientWidth+1&&button.scrollHeight<=button.clientHeight+2),true,'main document controls remain measured and readable at 320px with enlarged text');
  await page.keyboard.press('Escape');await page.evaluate(()=>{document.documentElement.style.fontSize='';});await page.setViewportSize({width:1600,height:1000});
  await page.reload();
  await page.locator('#project-select').selectOption(project.id);
  assert.equal(await page.locator('#project-select').inputValue(),project.id,'the reloaded bibliography scenario selects its original project explicitly');
  await page.getByRole('button',{name:'references.bib',exact:true}).click();await waitForSource(page,'references.bib');
  assert.equal(await page.locator('#typst-compile').isVisible(),true,'a configured main remains compilable while a bibliography is selected');
  assert.equal(await page.locator('#typst-compile').getAttribute('title'),'Compile book.typ');
  await page.locator('.cm-content').click();await page.keyboard.press('Control+End');await page.keyboard.insertText('\n% An edited bibliography remains selected.\n');
  const bibliographyBuffer=await page.locator('.cm-content').textContent();
  await page.keyboard.press('F5');
  await page.waitForFunction(()=>document.getElementById('typst-preview-status').dataset.state==='current',{},{timeout:15000});
  const completedBibliographyLog=await page.waitForFunction(()=>{
    const log=document.getElementById('compile-log').textContent;
    return document.getElementById('typst-compile').textContent==='Recompile'&&document.getElementById('typst-preview-status').dataset.state==='current'&&log.includes('Compiled book.typ successfully.') ? log : null;
  },{},{timeout:15000});
  const bibliographyLog=await completedBibliographyLog.jsonValue();
  assert.equal(await page.locator('#manuscript-tabs [role="tab"][aria-selected="true"]').textContent(),'references.bib','compiling the main preserves the selected dependency');
  assert.equal(await page.locator('.cm-content').textContent(),bibliographyBuffer,'compilation preserves bibliography editor content');
  assert.ok((await readFile(join(projectRoot,'references.bib'),'utf8')).includes('An edited bibliography'),'F5 saves the dependency before compiling');
  assert.ok(bibliographyLog.includes('book.typ'),'build log identifies the actual compiled main');
  assert.ok(bibliographyLog.includes('unknown font family'),'successful compiler warnings remain available');
  assert.ok((await call({action:'pdf',project:project.id,path:'book.typ'})).diagnostics.includes('unknown font family'),'warnings persist with the last successful PDF');
  const mainDownload=page.waitForEvent('download');await page.locator('#export-pdf').click();
  assert.equal((await mainDownload).suggestedFilename(),'book.pdf','export uses the main document filename while a bibliography is selected');
  await page.locator('#source-undo').click();
  assert.ok(!(await page.locator('.cm-content').textContent()).includes('An edited bibliography'),'compiling leaves the dependency undo history intact');
  await saveExactSource(page,project.id,'references.bib',bibliographySource);
  let firstBookCompile=true,bookCompileHeld,releaseBookCompile,bookFollowupHeld,releaseBookFollowup;
  const bookHeld=new Promise(resolve=>{bookCompileHeld=resolve;}),bookPending=new Promise(resolve=>{releaseBookCompile=resolve;});
  const bookFollowup=new Promise(resolve=>{bookFollowupHeld=resolve;}),bookNextPending=new Promise(resolve=>{releaseBookFollowup=resolve;});
  const holdBookCompile=async route=>{
    const operation=route.request().postDataJSON();
    if(operation.action!=='compile'||operation.path!=='book.typ') return route.continue();
    if(firstBookCompile) {
      firstBookCompile=false;await waitForDocumentIdle(page,route.request());const response=await route.fetch();finiteRequests.delete(route.request());
      const receipt=await response.json();page.__fixtureHeldReceipts.push({action:operation.action,path:operation.path,ok:receipt.ok,error:receipt.error});assert.equal(receipt.ok,true,`the held included-main build must succeed before its response is delayed: ${JSON.stringify(receipt.error)}`);
      bookCompileHeld();await bookPending;return route.fulfill({response});
    }
    bookFollowupHeld();await bookNextPending;await waitForDocumentIdle(page,route.request());return route.continue();
  };
  await page.route('**/api/review',holdBookCompile);await page.locator('#typst-compile').click();await bookHeld;
  await page.getByRole('button',{name:'part.typ',exact:true}).click();await waitForSource(page,'chapters/part.typ');
  const includedChapterEdit='An included chapter edit.';
  await page.locator('.cm-content').click();await page.keyboard.press('Control+End');await page.keyboard.insertText(includedChapterEdit);
  const chapterBuffer=await page.locator('.cm-content').textContent();
  await saveExactSource(page,project.id,'chapters/part.typ',chapterSource+includedChapterEdit);
  assert.equal((await call({action:'open',project:project.id,path:'chapters/part.typ'})).content,chapterSource+includedChapterEdit,'the included dependency is authoritatively saved before the old main PDF response is released');
  releaseBookCompile();await bookFollowup;
  assert.equal(await page.locator('#typst-preview-status').getAttribute('data-state'),'stale','a newly opened dependency edited and saved after build start invalidates the pending main response');
  releaseBookFollowup();await page.waitForFunction(()=>document.getElementById('typst-preview-status').dataset.state==='current',{},{timeout:15000});
  await page.unroute('**/api/review',holdBookCompile);
  assert.equal(await page.locator('.cm-content').textContent(),chapterBuffer,'building the main keeps the chapter buffer and caret owner');
  assert.ok((await readFile(join(projectRoot,'chapters','part.typ'),'utf8')).includes('An included chapter edit.'));
  await page.waitForFunction(()=>document.getElementById('typst-compile').textContent==='Recompile');
  await waitForDocumentIdle(page);
  const chapterSnapshot=await call({action:'open',project:project.id,path:'chapters/part.typ'});
  const chapterShare=await call({action:'share',project:project.id,path:'chapters/part.typ',enabled:true});
  const chapterQuote='A nested manuscript.',chapterFrom=chapterSnapshot.content.indexOf(chapterQuote);
  await markFixturePassage(call, project.id, chapterSnapshot, chapterQuote);
  assert.equal((await mcp('suggest_text',{documentId:chapterShare.documentId,proposal:{requestId:'chapter-after-switch',revision:chapterSnapshot.review.revision,from:chapterFrom,to:chapterFrom+chapterQuote.length,quote:chapterQuote,replacement:'An improved chapter manuscript.',rationale:'Qualify a delayed included-file acceptance.'}})).isError,false);
  await menuAction(page,'view','Show manuscript review');
  await page.locator('.suggestion-card').getByRole('button',{name:'Accept',exact:true}).waitFor({timeout:10000});
  let chapterDecisionHeld,releaseChapterDecision,chapterDecisionReply;
  const chapterDecision=new Promise(resolve=>{chapterDecisionHeld=resolve;}),chapterDecisionPending=new Promise(resolve=>{releaseChapterDecision=resolve;});
  const holdChapterDecision=async route=>{
    const operation=route.request().postDataJSON();
    if(operation.action!=='decide'||operation.path!=='chapters/part.typ') return route.continue();
    const response=await route.fetch();finiteRequests.delete(route.request());chapterDecisionReply=await response.json();chapterDecisionHeld();await chapterDecisionPending;return route.fulfill({response});
  };
  await page.route('**/api/review',holdChapterDecision);await waitForDocumentIdle(page);await page.locator('.suggestion-card').getByRole('button',{name:'Accept',exact:true}).click();await chapterDecision;
  if(!chapterDecisionReply.ok) releaseChapterDecision();
  assert.equal(chapterDecisionReply.ok,true,`the native chapter acceptance must commit before the response is held: ${JSON.stringify(chapterDecisionReply.error)}`);
  assert.equal(chapterDecisionReply.result.content,chapterSnapshot.content.replace(chapterQuote,'An improved chapter manuscript\\.'),'native acceptance returns the exact source with safely escaped Typst punctuation');
  await page.getByRole('button',{name:'references.bib',exact:true}).click();await waitForSource(page,'references.bib');
  const bibliographyDuringDecision=await page.locator('.cm-content').textContent();
  const chapterRebuild=page.waitForRequest(request=>{
    if(!request.url().endsWith('/api/review')||request.method()!=='POST') return false;
    const operation=request.postDataJSON();return operation.action==='compile'&&operation.project===project.id&&operation.path==='book.typ';
  });
  releaseChapterDecision();
  const chapterRebuildResponse=await (await chapterRebuild).response();assert.ok(chapterRebuildResponse,'chapter acceptance produces a native main-document compile response');
  const chapterRebuildReceipt=await chapterRebuildResponse.json();assert.equal(chapterRebuildReceipt.ok,true,chapterRebuildReceipt.error?.message);
  assert.equal(chapterRebuildReceipt.result.current,true,'the follow-up main build validates the accepted chapter inputs');
  await page.waitForFunction(()=>document.getElementById('typst-preview-status').dataset.state==='current',{},{timeout:15000});
  await page.waitForFunction(()=>document.getElementById('typst-compile').textContent==='Recompile');
  await waitForDocumentIdle(page);
  assert.equal((await call({action:'pdf',project:project.id,path:'book.typ'})).current,true,'the cached main PDF verifies the accepted chapter dependency');
  assert.equal((await call({action:'open',project:project.id,path:'chapters/part.typ'})).review.revision,chapterDecisionReply.result.review.revision,'the accepted chapter revision remains authoritative after the follow-up main build');
  assert.equal(await page.locator('.cm-content').textContent(),bibliographyDuringDecision,'a delayed chapter acceptance keeps the newly selected bibliography buffer');
  assert.equal(await readFile(join(projectRoot,'chapters','part.typ'),'utf8'),chapterSnapshot.content.replace(chapterQuote,'An improved chapter manuscript\\.'),'acceptance stores escaped Typst prose in the included source');
  await page.unroute('**/api/review',holdChapterDecision);
  const bibliographyOnDisk=await readFile(join(projectRoot,'references.bib'),'utf8');
  await writeFile(join(projectRoot,'references.bib'),bibliographyOnDisk+'\n% External bibliography edit.\n');
  await page.locator('#review-conflict').waitFor({state:'visible',timeout:10000});
  assert.equal(await page.locator('#typst-preview-status').getAttribute('data-state'),'stale','an observed external dependency conflict invalidates the visible main PDF');
  assert.equal(await page.locator('.cm-content').textContent(),bibliographyDuringDecision,'refresh conflict retains the existing dependency editor');
  await page.locator('#reload-buffer').click();
  await page.waitForFunction(()=>document.querySelector('.cm-content')?.textContent.includes('External bibliography edit.'));
  await page.locator('#typst-compile').click();await page.waitForFunction(()=>document.getElementById('typst-preview-status').dataset.state==='current',{},{timeout:15000});
  await page.waitForFunction(()=>document.getElementById('typst-compile').textContent==='Recompile');
  await waitForDocumentIdle(page);
  await page.getByRole('button',{name:'part.typ',exact:true}).click();await waitForSource(page,'chapters/part.typ');
  const goodMain=await call({action:'pdf',project:project.id,path:'book.typ'});assert.equal(goodMain.current,true);
  await page.locator('.cm-content').click();await page.keyboard.press('Control+End');await page.keyboard.insertText('\n#unknown-chapter-function()\n');
  const failedChapter=await page.locator('.cm-content').textContent();
  await page.locator('#typst-compile').click();await page.waitForFunction(()=>document.getElementById('typst-preview-status').dataset.state==='error',{},{timeout:15000});
  assert.equal(await page.locator('.cm-content').textContent(),failedChapter,'a main build failure preserves the included chapter editor');
  assert.ok(await page.locator('#typst-pages canvas').count()>0,'a failed included chapter keeps the main last-good preview');
  const failedMain=await call({action:'pdf',project:project.id,path:'book.typ'});assert.equal(failedMain.base64,goodMain.base64);assert.equal(failedMain.current,false,'an unchanged main is stale after an included file changes');
  await page.locator('#source-undo').click();
  assert.ok(!(await page.locator('.cm-content').textContent()).includes('#unknown-chapter-function()'),'Undo removes the invalid included source from its live editor');
  await saveExactSource(page,project.id,'chapters/part.typ',chapterDecisionReply.result.content);
  await waitForDocumentIdle(page);
  await setFixtureMain(page,true);
  await page.waitForFunction(()=>document.getElementById('typst-compile').title==='Compile chapters/part.typ');
  assert.equal((await call({action:'projects'})).find(item=>item.id===project.id).mainDocument,'','clearing main restores selected-source compilation');
  await page.getByRole('button',{name:'references.bib',exact:true}).click();await waitForSource(page,'references.bib');
  assert.equal(await page.locator('#typst-compile').isVisible(),false,'a bibliography has no compile action without a configured main');
  await page.getByRole('button',{name:'main.typ',exact:true}).click();await waitForSource(page,'main.typ');
  const mainBeforeExternalChange=await page.locator('.cm-content').textContent();
  const checkpoint=await call({action:'open',project:project.id,path:'main.typ'});
  await call({action:'save',project:project.id,path:'main.typ',revision:checkpoint.review.revision,content:'#unknown-function()'});
  const invalid=await call({action:'open',project:project.id,path:'main.typ'});
  await call({action:'compile',project:project.id,path:'main.typ',revision:invalid.review.revision},true);
  const preserved=await call({action:'pdf',project:project.id,path:'main.typ'});assert.equal(preserved.available,true);assert.equal(preserved.current,false);
  await menuAction(page,'view','Show manuscript review');
  await page.locator('#review-conflict').waitFor({state:'visible',timeout:10000});
  assert.equal(await page.locator('.cm-content').textContent(),mainBeforeExternalChange,'the external failing source must not silently replace the open buffer');
  await page.locator('#reload-buffer').click();
  await page.waitForFunction(()=>document.querySelector('.cm-content')?.textContent==='#unknown-function()'&&document.getElementById('review-conflict').hidden&&document.getElementById('save-label').textContent==='Saved locally');
  await page.locator('#typst-pages canvas').first().waitFor({timeout:10000});
  await page.waitForFunction(()=>document.getElementById('typst-preview-status').dataset.state==='stale',{},{timeout:10000});
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
  for (const fixture of [project,secondProject]) await call({action:'bind_github',project:fixture.id,repository:'qualification/undertree-fixture',auto_sync:true});
  const syncProjects=[];let metadataAction;let releaseMetadata;let metadataHeld;
  const routeMetadata=async route=>{
    const operation=route.request().postDataJSON();
    if(operation.action==='sync') {
      syncProjects.push(operation.project);
      return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({ok:false,error:{code:'git',message:'Qualification records the sync target without contacting a remote.'}})});
    }
    if(operation.action===metadataAction) {
      const response=await route.fetch();finiteRequests.delete(route.request());metadataHeld();await releaseMetadata.promise;return route.fulfill({response});
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
  const beforeDelayedProjectMark=await call({action:'open',project:project.id,path:'main.html'});
  assert.ok(beforeDelayedProjectMark.review.rules.some(rule=>rule.label==='Rule belongs to the original project'));
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
  assert.deepEqual((await call({action:'open',project:project.id,path:'main.html'})).review.markers,beforeDelayedProjectMark.review.markers,'the delayed highlight does not leak into or change the newer project');
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
    const response=await route.fetch();finiteRequests.delete(route.request());reloadHeld();await new Promise(resolve=>{releaseReload=resolve;});await route.fulfill({response});
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
  const preferenceContext=await browser.newContext({viewport:{width:1600,height:1000}});const preferencePage=failurePage=await preferenceContext.newPage();failureStage='preferences';
  preferencePage.on('pageerror',error=>errors.push(error.message));
  await preferencePage.goto(base+`/manuscript.html#session=${token}`);
  await preferencePage.locator('#project-select').selectOption(preferenceProject.id);await preferencePage.getByRole('button',{name:'settings.html',exact:true}).click();await waitForSource(preferencePage,'settings.html');
  await preferencePage.locator('.cm-content').click();await preferencePage.keyboard.press('Control+End');await preferencePage.keyboard.insertText(' Preserve editor history.');
  await menuAction(preferencePage,'view','Larger editor text');await menuAction(preferencePage,'view','Larger editor text');await menuAction(preferencePage,'view','Word wrap');
  await menuAction(preferencePage,'edit','Undo');
  assert.ok(!(await preferencePage.locator('.cm-content').textContent()).includes('Preserve editor history.'),'changing editor presentation preserves the undoable source edit');
  await saveExactSource(preferencePage,preferenceProject.id,'settings.html',preferenceSource);
  assert.equal(await readFile(join(preferenceRoot,'settings.html'),'utf8'),preferenceSource,'changing text size and wrap preserves editor undo history');
  await preferencePage.locator('#files-splitter').focus();for(let index=0;index<20;index++) await preferencePage.keyboard.press('ArrowRight');
  await preferencePage.locator('#preview-splitter').focus();await preferencePage.keyboard.press('ArrowRight');await preferencePage.keyboard.press('ArrowRight');
  await preferencePage.locator('#outline-toggle').click();await preferencePage.locator('#review-toggle').click();
  await preferencePage.locator('#files-collapse').click();
  await preferencePage.evaluate(()=>{const key='undertree.workspace-preferences';const saved=JSON.parse(localStorage.getItem(key));saved.previewCollapsed=true;localStorage.setItem(key,JSON.stringify(saved));});
  const preferred=await preferencePage.evaluate(()=>JSON.parse(localStorage.getItem('undertree.workspace-preferences')));
  assert.equal(preferred.editorFontSize,14);assert.equal(preferred.wordWrap,false);assert.equal(preferred.filesCollapsed,true);assert.equal(preferred.previewCollapsed,true);assert.equal(preferred.reviewOpen,true);assert.equal(preferred.outlineCollapsed,true);assert.ok(Math.abs(preferred.editorFraction-.6)<1e-9);
  await preferencePage.reload();await preferencePage.locator('#project-select').selectOption(preferenceProject.id);
  assert.deepEqual(await preferencePage.locator('.review-workspace').evaluate(node=>[node.dataset.filesCollapsed,node.dataset.previewCollapsed,node.dataset.reviewOpen]),['true','false','true'],'reloading restores the split while preserving file and review visibility');
  assert.equal(await preferencePage.locator('#outline-toggle').getAttribute('aria-expanded'),'false');
  assert.equal(await preferencePage.locator('#preview-splitter').getAttribute('aria-valuenow'),'60');
  await menuAction(preferencePage,'view','Show file panel');await preferencePage.getByRole('button',{name:'settings.html',exact:true}).click();await waitForSource(preferencePage,'settings.html');
  assert.equal(await preferencePage.locator('.cm-content').evaluate(node=>getComputedStyle(node).fontSize),'14px','explicit source text size restores without altering the default type token');
  assert.equal(await preferencePage.locator('.cm-content').evaluate(node=>node.classList.contains('cm-lineWrapping')),false,'wrap stays disabled after reopening a source');
  await preferencePage.setViewportSize({width:1000,height:800});await preferencePage.waitForTimeout(100);
  assert.ok((await preferencePage.locator('.manuscript-files').boundingBox()).width<preferred.filesWidth,'a narrow desktop clamps the visible file panel');
  await preferencePage.setViewportSize({width:1600,height:1000});await preferencePage.waitForTimeout(100);
  assert.ok(Math.abs((await preferencePage.locator('.manuscript-files').boundingBox()).width-preferred.filesWidth)<=1,'file panel regrows to the user preference after expansion');
  await preferencePage.setViewportSize({width:320,height:900});await preferencePage.evaluate(()=>{document.documentElement.style.fontSize='28px';});
  await preferencePage.getByRole('button',{name:'Editor',exact:true}).click();await assertChrome(preferencePage,'restored workspace at 320px and 200% text');
  assert.equal(await preferencePage.locator('.cm-content').evaluate(node=>getComputedStyle(node).fontSize),'28px','a restored editor preference respects user text enlargement');
  await menuAction(preferencePage,'view','Reset workspace');await assertChrome(preferencePage,'reset workspace at 320px and 200% text');
  await preferencePage.evaluate(()=>{document.documentElement.style.fontSize='';});await preferencePage.setViewportSize({width:1600,height:1000});
  assert.equal(await preferencePage.locator('.cm-content').evaluate(node=>getComputedStyle(node).fontSize),'12px','Reset workspace restores the pinned default source typography');
  assert.equal(await preferencePage.locator('.cm-content').evaluate(node=>node.classList.contains('cm-lineWrapping')),true);
  assert.ok(Math.abs((await preferencePage.locator('.manuscript-files').boundingBox()).width-232.95)<=1,'Reset workspace restores the proportional reference sidebar');
  await preferenceContext.close();failurePage=page;failureStage='main';
  const blockedStorageContext=await browser.newContext({viewport:{width:1600,height:1000}});
  await blockedStorageContext.addInitScript(()=>Object.defineProperty(window,'localStorage',{get(){throw new DOMException('Storage unavailable','SecurityError');}}));
  const blockedStoragePage=failurePage=await blockedStorageContext.newPage();failureStage='blocked-storage';blockedStoragePage.on('pageerror',error=>errors.push(error.message));
  await blockedStoragePage.goto(base+`/manuscript.html#session=${token}`);await blockedStoragePage.locator('#project-select').selectOption(preferenceProject.id);await blockedStoragePage.getByRole('button',{name:'settings.html',exact:true}).click();await waitForSource(blockedStoragePage,'settings.html');
  await menuAction(blockedStoragePage,'view','Larger editor text');
  assert.equal(await blockedStoragePage.locator('.cm-content').evaluate(node=>getComputedStyle(node).fontSize),'13px','settings remain usable when browser storage is unavailable');
  await blockedStorageContext.close();failurePage=page;failureStage='main';
  assert.deepEqual(errors,[]);
  console.log('Real Rust review/MCP, local reanchor/protection, pending/new cues, source-linked card collision/navigation/scroll, accepted Typst automatic PDF, six menus/centered title/source formatting/undo/outline, exact CRLF source markers and byte roundtrip, width×height/200%/text-spacing chrome, one 32px desktop preview toolbar/enlarged reflow/actual source+PDF downloads, all 10 PDF pages with bounded canvases, explicit builds, delayed real PDF Worker termination/open responses with independent file undo, delayed palette/highlight project ownership and recorded autosync targets, TeX import, delayed save/reload/IME acceptance safety, revision-aware delayed PDF status, persisted pane/text settings with undo, reload, clamp/regrowth, 320px/200% and denied storage, and visible failure/last-good PDF checks passed. zrok process and final autosync response simulated; public tunnel, live GitHub push and full rendered Overleaf parity not tested.');
} catch (error) {
  await (async () => {
    const output=resolve('artifacts/review-ui-failure');await mkdir(output,{recursive:true});
    const observed=await failurePage?.evaluate(()=>({
      tab:document.querySelector('#manuscript-tabs [aria-selected="true"]')?.textContent,
      status:document.querySelector('.review-status')?.textContent,
      saved:document.getElementById('save-label')?.textContent,
      conflictHidden:document.getElementById('review-conflict')?.hidden,
      conflictVisible:Boolean(document.getElementById('review-conflict')?.getClientRects().length),
      source:document.querySelector('.cm-content')?.textContent,
    })).catch(()=>null);
    const {source,...ui}=observed||{};
    await writeFile(join(output,`${basename(root)}.json`),JSON.stringify({
      snapshotReceipt,snapshotSha256,pageStage:failureStage,error:{name:error.name,message:error.message},ui,
      requestHistory:failurePage?.__fixtureRequestHistory,
      mutationHistory:failurePage?.__fixtureMutationHistory,
      nativeHeldReceipts:failurePage?.__fixtureHeldReceipts,
      mcpErrors:failurePage?.__fixtureMcpErrors,
      pendingRequests:[...failurePage?.__fixtureFiniteRequests||[]].map(request=>({action:request.postDataJSON()?.action,path:request.postDataJSON()?.path})),
      sourceSha256:typeof source==='string'?createHash('sha256').update(source).digest('hex'):null,
    },null,2)+'\n');
    await failurePage?.screenshot({path:join(output,`${basename(root)}.png`)});
  })().catch(()=>{});
  throw error;
} finally {
  await browser?.close();
  if (child.exitCode === null) await call({action:'tunnel',enabled:false,reservation:'',public_url:''}).catch(()=>{});
  if (child.exitCode === null) {
    if (process.platform === 'win32') spawnSync('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true});
    else child.kill('SIGINT');
  }
  await new Promise(r=>{if(child.exitCode!==null) r();else {child.once('exit',r);setTimeout(r,3000).unref();}});
  assert.ok(resolve(root).startsWith(join(resolve(tmpdir()),'undertree-review-ui-')));
  await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});
}
const resultReceipt = snapshotReceipt.replace(/\.json$/, '-result.json');
await writeFile(resultReceipt, JSON.stringify({completedAt:new Date().toISOString(),command:'npm run test:review-ui',exitCode:0,status:'VERIFIED',snapshotReceipt,snapshotSha256,scope:'Real Rust authority and Typst CLI with immutable copied frontend and executable; zrok and final autosync simulated. Full Overleaf parity, live ChatGPT/public tunnel, live GitHub push and native shell are not qualified by this gate.'},null,2)+'\n');
console.log(`Review UI result: ${resultReceipt}`);
