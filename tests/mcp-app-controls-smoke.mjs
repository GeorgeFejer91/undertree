import { consentToFixtureShare } from './context-fixture.mjs';
// Strengthened artifact-only runner; the canonical test and copied snapshots stay frozen.
// Real Rust MCP -> rendered workspace. The zrok process is simulated; no public route claim.
import assert from 'node:assert/strict';
import { createZrokFixture } from './zrok-fixture.mjs';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const root = await mkdtemp(join(tmpdir(), 'undertree-app-mcp-'));
const projectRoot = join(root, 'project'), stateRoot = join(root, 'state'), assets = join(root, 'assets');
const sourceFile = join(projectRoot, 'main.typ');
const original = 'Hello 🌳 from the saved manuscript.\n\n#pagebreak()\nSecond page.\n\n#pagebreak()\nThird page.\n';
const privateFile = join(projectRoot, 'private.typ'), privateOriginal = 'Unshared source.\n';
const chapterFile = join(projectRoot, 'chapter.typ'), chapterOriginal = 'Shared chapter only.\n';
const token = randomBytes(32).toString('hex'), binary = resolve(process.env.UNDERTREE_REVIEW_BINARY || 'target/debug/undertree-review');
const targetFile = join(root, 'target');
let service, browser, port, log = '';
async function until(check, message, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    if (service?.exitCode !== null) throw new Error(log);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(message);
}
try {
  await mkdir(projectRoot); await cp(resolve(process.env.UNDERTREE_REVIEW_ASSETS || 'dist'), assets, { recursive: true });
  await writeFile(sourceFile, original); await writeFile(privateFile, privateOriginal); await writeFile(chapterFile, chapterOriginal);
  const zrokFixture = await createZrokFixture(root, targetFile, 'app-control.example.org');
  service = spawn(binary, [], { env: { ...process.env, ...zrokFixture.environment, UNDERTREE_REVIEW_PORT: '0', UNDERTREE_REVIEW_STATE: stateRoot, UNDERTREE_REVIEW_ASSETS: assets, UNDERTREE_REVIEW_TOKEN: token, UNDERTREE_ZROK: zrokFixture.executable }, stdio: ['ignore', 'pipe', 'pipe'] });
  service.stdout.on('data', bytes => { log = (log + bytes).slice(-16_000); port = Number(log.match(/127\.0\.0\.1:(\d+)/)?.[1]); });
  service.stderr.on('data', bytes => { log = (log + bytes).slice(-16_000); });
  await until(() => !!port, 'The Rust authority did not start.');
  const base = `http://127.0.0.1:${port}`;
  async function local(operation) {
    operation = await consentToFixtureShare(operation, local);
    const body = await fetch(base + '/api/review', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(operation) }).then(response => response.json());
    assert.equal(body.ok, true, body.error?.message); return body.result;
  }
  async function observeLocalRead(action, project, path) {
    assert.ok(action === 'projects' || action === 'pdf', 'Readiness observes only Projects or Pdf; never replay a producer.');
    assert.ok(action === 'projects' ? project === undefined && path === undefined : typeof project === 'string' && typeof path === 'string', 'Use the exact read-only observation shape.');
    const operation = action === 'projects' ? { action: 'projects' } : { action: 'pdf', project, path };
    const response = await fetch(base + '/api/review', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(operation) });
    const body = await response.json();
    if (response.status === 400 && body?.ok === false && body.error?.code === 'busy' && body.error.message === 'A local document operation is running. Retry this action.') {
      console.log(JSON.stringify({ readinessBusy: action })); return null;
    }
    assert.equal(response.ok, true, body?.error?.message || `Read observation HTTP ${response.status}`);
    assert.equal(body?.ok, true, body?.error?.message);
    assert.ok(action === 'projects' ? Array.isArray(body.result) : typeof body.result?.available === 'boolean', 'The read observation result is malformed.');
    return body.result;
  }
  const project = await local({ action: 'add_project', root: projectRoot });
  browser = await chromium.launch({ executablePath: process.env.UNDERTREE_CHROME || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  let blockAutosave = false, holdNavigationSave = false, lastUiSnapshot;
  const writes = { save:0, editorCommit:0 };
  let navigationSaveResponse, releaseNavigationSave;
  const navigationSaveRelease = new Promise(resolve => { releaseNavigationSave = resolve; });
  await page.route('**/api/review', async route => {
    const operation = route.request().postDataJSON();
    if (operation?.action === 'save') writes.save++;
    if (holdNavigationSave && operation?.action === 'save' && operation.path === 'private.typ') {
      holdNavigationSave = false;
      const response = await route.fetch();
      navigationSaveResponse = await response.json();
      await navigationSaveRelease;
      return route.fulfill({response});
    }
    if (blockAutosave && operation?.action === 'save') {
      return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ ok: false, error: { code: 'busy', message: 'Local autosave paused in the MCP boundary fixture.' } }) });
    }
    return route.continue();
  });
  await page.route('**/api/editor', route => {
    if (route.request().postDataJSON()?.action === 'editor_commit') {
      writes.editorCommit++;
      if (blockAutosave) return route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({ok:false,error:{code:'busy',message:'Local editor commits paused in the MCP boundary fixture.'}})});
    }
    return route.continue();
  });
  page.on('request', request => {
    if (new URL(request.url()).pathname !== '/api/control' || request.method() !== 'POST') return;
    const operation = request.postDataJSON();
    if (operation.action === 'control_poll') lastUiSnapshot = operation.snapshot;
    if (operation.action === 'control_complete') console.log(JSON.stringify({uiReceipt:operation.requestId,outcome:operation.outcome}));
  });
  const sourceText = () => page.locator('.cm-content').evaluate(source => [...source.querySelectorAll('.cm-line')].map(line => line.textContent).join('\n'));
  async function waitForSource(path, expected) {
    await page.waitForFunction(({path,expected}) => {
      const title = document.querySelector('#manuscript-tabs [role="tab"][aria-selected="true"]')?.textContent;
      const source = document.querySelector('.cm-content');
      return (title === path || title === path + ' •') && source
        && [...source.querySelectorAll('.cm-line')].map(line => line.textContent).join('\n') === expected
        && [...document.querySelectorAll('#manuscript-files [data-path]')].some(file => file.dataset.path === path && file.getAttribute('aria-current') === 'true');
    }, {path,expected});
  }
  async function openLocal(path, expected) {
    await page.locator(`#manuscript-files [data-path="${path}"]`).click();
    await waitForSource(path, expected);
  }
  async function fileMenu(label) {
    const id = await page.locator('#workspace-menu > summary').isVisible() ? 'workspace-menu' : 'menu-file';
    await page.locator(`#${id} > summary`).click();
    const menu = page.locator(`#${id}`);
    await menu.getByRole('menuitem',{name:label,exact:true}).or(menu.getByRole('button',{name:label,exact:true})).click();
  }
  await page.goto(`${base}/manuscript.html#session=${token}`);
  await openLocal('private.typ', privateOriginal);
  const observedPrivate = await local({ action: 'open', project: project.id, path: 'private.typ' });
  const privateBinding = Object.freeze({ sourceEpoch: observedPrivate.sourceEpoch, expectedRoot: Object.freeze({ ...observedPrivate.expectedRoot }) });
  const privateSnapshot = await local({ action: 'open', project: project.id, path: 'private.typ', ...privateBinding });
  assert.deepEqual(privateSnapshot.expectedRoot, privateBinding.expectedRoot); assert.equal(privateSnapshot.sourceEpoch, privateBinding.sourceEpoch);
  await local({action:'palette',project:project.id,path:'private.typ',revision:privateSnapshot.review.revision,rules:privateSnapshot.review.rules});
  await openLocal('main.typ', original);
  const localSource = await local({ action: 'open', project: project.id, path: 'main.typ' });
  await local({ action: 'palette', project: project.id, path: 'main.typ', revision: localSource.review.revision, rules: localSource.review.rules });
  await local({ action: 'share', project: project.id, path: 'main.typ', enabled: true });
  await local({ action: 'tunnel', enabled: true, reservation: 'app-control-test', public_url: 'https://app-control.example.org' });
  await page.locator('#connection-open').click();
  await page.locator('#connection-tab-app').click();
  await until(async () => await page.locator('#connection-app-enabled').isEnabled(), 'The UI-only App grant is unavailable.');
  assert.equal(await page.locator('#connection-app-enabled').isChecked(), false);
  await page.locator('#connection-app-enabled').check();
  await until(async () => !!(await local({ action: 'connection' })).appControls?.enabled, 'App grant did not enable.');
  const connection = await local({ action: 'connection' });
  assert.notEqual(connection.appControls.endpoint, connection.endpoint);
  const route = await readFile(targetFile, 'utf8');
  let appEndpoint = route + new URL(connection.appControls.endpoint).pathname;
  const reviewEndpoint = route + new URL(connection.endpoint).pathname;
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-06-18' };
  async function rpc(endpoint, method, params = {}) {
    let response;
    for (let attempt = 0; attempt < 10; attempt++) {
      response = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
      if (response.status !== 429) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(response.status, 200, `${method} HTTP ${response.status}`);
    const value = await response.json(); assert.equal(value.error, undefined, JSON.stringify(value.error)); return value.result;
  }
  const initialize = endpoint => rpc(endpoint, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'UnderTree app controls fixture', version: '1' } });
  await initialize(reviewEndpoint); await initialize(appEndpoint);
  const reviewTools = (await rpc(reviewEndpoint, 'tools/list')).tools.map(tool => tool.name);
  assert.deepEqual(reviewTools, ['list_manuscripts', 'read_manuscript', 'suggest_text', 'highlight_text']);
  const appTools = (await rpc(appEndpoint, 'tools/list')).tools.map(tool => tool.name);
  for (const forbidden of ['suggest_text', 'save', 'save_editor', 'replace_source', 'edit_file', 'decide', 'accept', 'set_policy', 'sync', 'create', 'import_tex', 'review_action']) assert.equal(appTools.includes(forbidden), false, forbidden);
  const tool = (name, args = {}) => rpc(appEndpoint, 'tools/call', { name, arguments: args });
  const value = reply => { assert.equal(reply.isError, false, JSON.stringify(reply)); return reply.structuredContent.result; };
  const manuscripts = value(await tool('list_manuscripts'));
  assert.equal(manuscripts.length, 1); const documentId = manuscripts[0].documentId;
  const snapshot = value(await tool('read_manuscript', { documentId }));
  await until(async () => !(await tool('get_workspace')).isError, 'The app UI heartbeat did not attach after grant activation.');
  async function applied(name, args, requestId) {
    const queued = value(await tool(name, { ...args, requestId }));
    let receipt = queued;
    await until(async () => {
      receipt = value(await tool('get_control_result', { requestId }));
      if (['queued', 'dispatched'].includes(receipt.state)) await new Promise(resolve => setTimeout(resolve, 150));
      return !['queued', 'dispatched'].includes(receipt.state);
    }, `No acknowledged result for ${name}.`, name === 'compile_manuscript' ? 60_000 : 15_000);
    assert.equal(receipt.state, 'applied', JSON.stringify(receipt)); return receipt;
  }
  await page.keyboard.press('Escape');
  const policyBefore = await readFile(sourceFile + '.undertree-review.json');
  await openLocal('private.typ', privateOriginal);
  await until(async () => value(await tool('get_workspace')).workspace.activeDocumentId === null, 'The private active source was not hidden from the remote workspace.');
  await applied('open_manuscript', { documentId }, 'open-saved-source');
  await waitForSource('main.typ', original);
  await applied('set_editor_preferences', { fontSize: 16, wordWrap: false }, 'display-preferences');
  assert.equal(await page.locator('[data-command="word-wrap"]').first().getAttribute('aria-pressed'), 'false');
  const unwrapped = await page.locator('.cm-content').evaluate(source => ({font:parseFloat(getComputedStyle(source).fontSize),wrapping:source.classList.contains('cm-lineWrapping'),whiteSpace:getComputedStyle(source).whiteSpace}));
  assert.ok(Math.abs(unwrapped.font - 16) < .1, 'MCP changes the rendered editor font to 16px');
  assert.equal(unwrapped.wrapping, false); assert.equal(unwrapped.whiteSpace, 'pre');
  await applied('set_editor_preferences', { wordWrap:true }, 'restore-wrapping');
  assert.equal(await page.locator('.cm-content').evaluate(source => source.classList.contains('cm-lineWrapping') && getComputedStyle(source).whiteSpace === 'break-spaces'), true, 'MCP restores real CodeMirror wrapping');
  await applied('set_workspace_view', { reviewVisible:true,logsVisible:true,outlineVisible:false }, 'view-panels');
  assert.equal(await page.locator('.manuscript-review').isVisible(), true);
  assert.ok((await page.locator('.manuscript-review').boundingBox()).width > 0);
  assert.equal(await page.locator('#compile-log').isVisible(), true);
  assert.equal(await page.locator('#compile-log-toggle').getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('#manuscript-outline').isHidden(), true);
  await page.locator('.cm-content').focus();
  const quote = '🌳', from = original.indexOf(quote), to = from + quote.length;
  await applied('select_passage', { documentId,revision:snapshot.review.revision,from,to,quote }, 'select-saved-text');
  const selection = await page.locator('.cm-content').evaluate(source => {
    const selection = getSelection();
    if (!selection?.anchorNode || !selection.focusNode || !source.contains(selection.anchorNode) || !source.contains(selection.focusNode)) return null;
    const offset = (node, position) => {const range=document.createRange();range.selectNodeContents(source);range.setEnd(node,position);return range.toString().length;};
    return {quote:selection.toString(),from:offset(selection.anchorNode,selection.anchorOffset),to:offset(selection.focusNode,selection.focusOffset)};
  });
  assert.deepEqual(selection, {quote,from,to}, 'the real DOM selects the exact non-BMP UTF-16 source range');
  await applied('set_workspace_view', { logsVisible:false,previewVisible:true }, 'show-pdf-pane');
  assert.equal(await page.locator('#compile-log').isHidden(), true);
  await applied('compile_manuscript', { documentId, revision: snapshot.review.revision }, 'compile-saved-source');
  const pdf = await local({ action: 'pdf', project: project.id, path: 'main.typ' });
  assert.equal(pdf.available, true);
  assert.equal(Buffer.from(pdf.base64, 'base64').subarray(0, 5).toString(), '%PDF-');
  await page.locator('#typst-pages .pdf-page[data-page="1"] canvas').waitFor({state:'visible',timeout:20_000});
  assert.equal(await page.locator('#pdf-page-count').textContent(), 'of 3');
  assert.equal(await page.locator('#typst-preview-status').getAttribute('data-state'), 'current');
  assert.equal(await page.locator('#typst-pages canvas').first().evaluate(canvas => {
    if (!canvas.width || !canvas.height) return false;
    const pixels=canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data;
    for(let i=0;i<pixels.length;i+=4) if(pixels[i+3] && pixels[i]+pixels[i+1]+pixels[i+2] < 600) return true;
    return false;
  }), true, 'the PDF is actually painted, not just acknowledged or allocated');
  await until(async()=>value(await tool('get_workspace')).workspace.preview?.pages===3,'The real rendered PDF was not published to the native workspace.');
  await applied('set_preview_view', {page:2,zoomPercent:100}, 'pdf-page-two');
  await page.locator('#typst-pages .pdf-page[data-page="2"] canvas').waitFor({state:'visible'});
  const pageWidth = (await page.locator('#typst-pages .pdf-page[data-page="2"]').boundingBox()).width;
  await applied('set_preview_view', {page:2,zoomPercent:125}, 'pdf-zoom');
  assert.equal(await page.locator('#pdf-page-number').inputValue(), '2');
  assert.equal(await page.locator('#pdf-zoom-label').textContent(), '125%');
  assert.ok(Math.abs((await page.locator('#typst-pages .pdf-page[data-page="2"]').boundingBox()).width / pageWidth - 1.25) < .02, 'MCP zoom changes the rendered PDF page width');
  await applied('set_preview_view', {fitWidth:true}, 'pdf-fit-width');
  assert.equal(await page.locator('#pdf-fit-width').getAttribute('aria-pressed'), 'true');
  assert.ok(await page.locator('#typst-pages .pdf-page[data-page="2"]').evaluate(page => Math.abs(page.getBoundingClientRect().width - (document.getElementById('typst-preview').clientWidth - 32)) < 2), 'fit width uses the actual preview viewport');
  assert.deepEqual(await readFile(sourceFile + '.undertree-review.json'), policyBefore, 'remote compilation preserves review policy bytes');
  assert.equal(await sourceText(), original);
  assert.equal(await readFile(sourceFile, 'utf8'), original, 'non-content controls preserve saved source');
  const workspace = value(await tool('get_workspace'));
  assert.equal(JSON.stringify(workspace).includes('private.typ'), false);
  assert.equal(JSON.stringify(workspace).includes(privateSnapshot.documentId), false, 'an inactive unshared buffer identity stays private');
  assert.equal((await tool('open_manuscript', { documentId: privateSnapshot.documentId, requestId: 'open-unshared-source' })).isError, true);
  for (const name of ['save', 'save_editor', 'replace_source', 'accept', 'set_policy', 'sync', 'create', 'control_enable', 'control_compile', 'control_open']) assert.equal((await tool(name, { documentId, content: 'forbidden' })).isError, true, name);
  assert.equal((await tool('set_editor_preferences', { requestId: 'extra-source', fontSize: 14, content: 'forbidden' })).isError, true);
  assert.equal(await readFile(sourceFile, 'utf8'), original);
  assert.deepEqual(writes, {save:0,editorCommit:0}, 'clean remote controls invoke neither source-save route');

  // The displayed main PDF can belong to an unshared source even while the chapter is shared.
  await local({action:'share',project:project.id,path:'chapter.typ',enabled:true});
  await page.locator('#connection-open').click(); await page.locator('#connection-refresh').click();
  await until(async () => (await page.locator('#connection-share-summary').textContent()).startsWith('2 manuscripts'), 'The chapter share did not reach the real UI.');
  await page.keyboard.press('Escape');
  await openLocal('private.typ', privateOriginal);
  await fileMenu('Set as main document');
  await until(async () => (await observeLocalRead('projects'))?.find(value=>value.id===project.id).mainDocument === 'private.typ' && await page.locator('#typst-compile').isVisible() && await page.locator('#typst-compile').getAttribute('title') === 'Compile private.typ', 'The local main-document setting did not reach its visible Compile target.');
  assert.equal(await page.locator('#typst-compile').getAttribute('title'),'Compile private.typ','the actual Recompile target is the private main document');
  await page.locator('#typst-compile').click();
  await page.locator('#typst-pages canvas').first().waitFor({state:'visible',timeout:30_000});
  assert.equal(await page.locator('#pdf-page-count').textContent(), 'of 1');
  await until(async () => (await observeLocalRead('pdf',project.id,'private.typ'))?.available === true, 'The local private PDF did not compile.');
  await openLocal('chapter.typ', chapterOriginal);
  await page.locator('#typst-pages canvas').first().waitFor({state:'visible',timeout:20_000});
  assert.match(await page.locator('#typst-compile').getAttribute('title'), /private\.typ/);
  const chapterId = value(await tool('list_manuscripts')).find(value=>value.path==='chapter.typ').documentId;
  await until(async () => value(await tool('get_workspace')).workspace.activeDocumentId === chapterId, 'The shared chapter did not become active remotely.');
  const chapterWorkspace = value(await tool('get_workspace')).workspace;
  assert.equal(chapterWorkspace.preview, null, 'a shared chapter cannot expose its unshared main PDF');
  assert.equal(JSON.stringify(chapterWorkspace).includes(privateSnapshot.documentId), false);
  assert.equal((await tool('set_preview_view',{requestId:'private-main-preview',page:1})).isError,true, 'the private main PDF cannot be remotely controlled');
  await fileMenu('Clear main document');
  await until(async () => { const projects = await observeLocalRead('projects'); return projects && !projects.find(value=>value.id===project.id).mainDocument; }, 'The temporary local main-document setting did not clear.');
  await applied('open_manuscript',{documentId},'return-to-shared-main');
  await waitForSource('main.typ',original);

  // Hold a real poll before dispatch, revoke the native share, and prove re-sharing
  // cannot resurrect the old command or capability in the rendered workspace.
  await openLocal('private.typ',privateOriginal);
  let pollHeld=false, releasePoll;
  const pausedPoll=new Promise(resolve=>{releasePoll=resolve;});
  const holdPoll=async route=>{
    if(route.request().postDataJSON()?.action==='control_poll'){pollHeld=true;await pausedPoll;}
    return route.continue();
  };
  await page.route('**/api/control',holdPoll);
  await until(()=>pollHeld,'The real UI poll did not reach the dispatch gate.');
  assert.equal(value(await tool('open_manuscript',{documentId,requestId:'revoked-queued-open'})).state,'queued');
  const revokedEndpoint=appEndpoint;
  await local({action:'share',project:project.id,path:'main.typ',enabled:false});
  const reshared=await local({action:'share',project:project.id,path:'main.typ',enabled:true});
  assert.equal(reshared.documentId,documentId);
  assert.equal((await local({action:'connection'})).appControls.enabled,false);
  await page.locator('#connection-open').click();await page.locator('#connection-tab-app').click();
  await until(async()=>await page.locator('#connection-app-enabled').isEnabled() && !await page.locator('#connection-app-enabled').isChecked(),'Revocation did not reach the grant checkbox.');
  await page.locator('#connection-app-enabled').check();
  await until(async()=>!!(await local({action:'connection'})).appControls.enabled,'The new local grant did not enable.');
  const renewed=await local({action:'connection'});
  appEndpoint=route+new URL(renewed.appControls.endpoint).pathname;
  assert.notEqual(appEndpoint,revokedEndpoint);
  releasePoll();await page.unroute('**/api/control',holdPoll);
  await initialize(appEndpoint);
  await until(async()=>!(await tool('get_workspace')).isError,'The renewed UI grant did not attach.');
  assert.equal((await tool('get_control_result',{requestId:'revoked-queued-open'})).isError,true);
  assert.equal((await fetch(revokedEndpoint,{method:'POST',headers,body:JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/list'})})).status,401);
  await page.keyboard.press('Escape');
  await waitForSource('private.typ',privateOriginal);
  await new Promise(resolve => setTimeout(resolve, 250));
  await applied('open_manuscript',{documentId},'open-after-regrant');
  await waitForSource('main.typ',original);
  assert.deepEqual(writes,{save:0,editorCommit:0},'clean opening, private PDF checks and capability rotation do not save content');

  // This is a real local navigation/save race, not a synthetic session mutation.
  // The first local save writes successfully; newer typing stays dirty in its inactive tab.
  await openLocal('private.typ',privateOriginal);
  holdNavigationSave=true;
  // Activate the real tree command in the dirty-tab mutation microtask, before
  // the automatic Save/Compile timers can enqueue a different first flush.
  await page.evaluate(expected => {
    globalThis.__appNavigationSaveActivated = false;
    const observer = new MutationObserver(() => {
      const selected = document.querySelector('#manuscript-tabs [aria-selected="true"]');
      const content = [...document.querySelectorAll('.cm-content .cm-line')].map(line => line.textContent).join('\n');
      if (selected?.textContent !== 'private.typ •' || content !== expected) return;
      observer.disconnect();
      document.querySelector('#manuscript-files [data-path="main.typ"]').click();
      globalThis.__appNavigationSaveActivated = true;
    });
    observer.observe(document.getElementById('manuscript-tabs'), { childList:true, subtree:true, characterData:true });
  }, privateOriginal+'First saved local edit.');
  await page.locator('.cm-content').focus();await page.keyboard.press('Control+End');await page.keyboard.insertText('First saved local edit.');
  await until(()=>!!navigationSaveResponse,'The real navigation save did not reach the held-response gate.');
  assert.equal(await page.evaluate(() => globalThis.__appNavigationSaveActivated),true,'the actual tree command owns the first navigation Save');
  const firstSave=navigationSaveResponse;
  assert.equal(firstSave.ok,true,firstSave.error?.message);
  const privateSaved=privateOriginal+'First saved local edit.';
  assert.equal(firstSave.result.content,privateSaved);
  await waitForSource('private.typ',privateSaved);
  await page.locator('.cm-content').focus();await page.keyboard.press('Control+End');await page.keyboard.insertText(' Newer unsaved private text.');
  const privateDirty=privateSaved+' Newer unsaved private text.';
  assert.equal(await sourceText(),privateDirty);
  blockAutosave=true;releaseNavigationSave();
  await waitForSource('main.typ',original);
  await until(()=>lastUiSnapshot?.activeDocumentId===documentId && lastUiSnapshot.openDocuments.some(doc=>doc.documentId===privateSnapshot.documentId && doc.dirty),'The private buffer was not dirty and INACTIVE in the real UI publication.');
  assert.equal(await page.getByRole('tab',{name:'private.typ •',exact:true}).getAttribute('aria-selected'),'false');
  await new Promise(resolve=>setTimeout(resolve,1600));
  const attemptsBeforeRemote={...writes};
  const sourcesBeforeRemote=[await readFile(sourceFile),await readFile(privateFile)];
  const policiesBeforeRemote=[await readFile(sourceFile+'.undertree-review.json'),await readFile(privateFile+'.undertree-review.json')];
  assert.equal(sourcesBeforeRemote[0].toString(),original);
  assert.deepEqual(policiesBeforeRemote[0],policyBefore);
  assert.equal(sourcesBeforeRemote[1].toString(),privateSaved,'only the first explicitly local edit reached disk');
  for (const [name, args] of [
    ['open_manuscript', { documentId }],
    ['compile_manuscript', { documentId, revision: snapshot.review.revision }],
    ['set_window_state', { state: 'close' }],
  ]) {
    const reply = await tool(name, { ...args, requestId: `dirty-${name}` });
    if (reply.isError) {
      assert.match(reply.content.map(value=>value.text||'').join('\n'),/buffer|saved|composition|conflict/i,'the denial must identify the dirty-buffer boundary');
    } else {
      let receipt;
      await until(async () => { receipt = value(await tool('get_control_result', { requestId: `dirty-${name}` })); return !['queued', 'dispatched'].includes(receipt.state); }, 'Dirty control did not settle.');
      assert.equal(receipt.state, 'rejected');
      assert.ok(['busy','stale'].includes(receipt.code),'a dirty-buffer refusal is not an unsupported-effect fallback');
    }
    await waitForSource('main.typ',original);
    assert.deepEqual([await readFile(sourceFile),await readFile(privateFile)],sourcesBeforeRemote,`${name} preserves both manuscript sources`);
    assert.deepEqual([await readFile(sourceFile+'.undertree-review.json'),await readFile(privateFile+'.undertree-review.json')],policiesBeforeRemote,`${name} preserves both policy files`);
  }
  assert.deepEqual(writes,attemptsBeforeRemote,'remote navigation/build/close invokes neither Save nor editor_commit with a dirty INACTIVE buffer');
  assert.equal(lastUiSnapshot.activeDocumentId,documentId);
  assert.equal(lastUiSnapshot.openDocuments.find(doc=>doc.documentId===privateSnapshot.documentId).dirty,true);
  await openLocal('private.typ',privateDirty);
  assert.ok(await page.locator('#typst-pages canvas').count()>0,'the private active manuscript retains an actual local last-good PDF');
  await until(async()=>value(await tool('get_workspace')).workspace.activeDocumentId===null,'The dirty private active identity did not disappear from the remote projection.');
  const privateActive = value(await tool('get_workspace')).workspace;
  assert.equal(privateActive.activeDocumentId, null);
  assert.equal(privateActive.preview, null);
  assert.equal(JSON.stringify(privateActive).includes(privateSnapshot.documentId),false);
  await page.locator('#connection-open').click(); await page.locator('#connection-tab-app').click();
  await page.locator('#connection-app-enabled').uncheck();
  await until(async () => !(await local({ action: 'connection' })).appControls.enabled, 'App revocation failed.');
  assert.equal((await fetch(appEndpoint, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) })).status, 401);
  assert.deepEqual((await rpc(reviewEndpoint, 'tools/list')).tools.map(tool => tool.name), reviewTools);
  assert.deepEqual(writes,attemptsBeforeRemote,'independent App revocation also leaves both save routes untouched');
  assert.deepEqual([await readFile(sourceFile),await readFile(privateFile)],sourcesBeforeRemote);
  assert.deepEqual([await readFile(sourceFile+'.undertree-review.json'),await readFile(privateFile+'.undertree-review.json')],policiesBeforeRemote);
  assert.deepEqual(errors, []);
  console.log('Real Rust MCP App controls: clean private-to-shared Open; rendered UTF-16 selection/font/wrap/panes/PDF/page/zoom; private-main PDF projection; queued-command unshare/re-share revocation; dirty INACTIVE private-buffer barrier with unchanged source/policy bytes and zero remote Save/editor_commit attempts; independent Review/App revocation passed. zrok simulated; public ChatGPT and native window actions untested.');
} finally {
  await browser?.close();
  service?.kill('SIGINT');
  if (service && service.exitCode === null) await new Promise(resolve => { service.once('exit', resolve); setTimeout(resolve, 3000).unref(); });
  await rm(root, { recursive: true, force: true });
}
