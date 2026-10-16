import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod,readFile,readdir,lstat,stat,writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { installNativeFindObserver } from './native-find-observer.mjs';
import { readNativeFindGeometry } from './native-find-geometry.mjs';
import { assertObserved,assertPureQuery,assertProducerQuiet,assertSaveBoundary,matchOffsets,isProducer,assertFreshRegistrationSetup } from './native-find-guards.mjs';

export const findPath='z-native-find.typ';
export const findSource='= Native Find fixture\r\n\r\n😀 needle one.\r\nneedle two; needle three.\r\n';
const hash=value=>createHash('sha256').update(value).digest('hex');
export async function seedNativeFind(project) {
  await writeFile(join(project,findPath),findSource);
  await writeFile(join(project,findPath+'.undertree-review.json'),JSON.stringify({version:1,revision:hash(findSource),rules:[{id:'protect',label:'Keep unchanged',color:'#74b9a4',action:'protect',prompt:''}],markers:[],suggestions:[]})+'\n');
}

// Pinned read-only bootstrap, validated against the public EditorView lookup before public state reads.
const readView=`
  const content=document.querySelector('.cm-content'),view=content?.cmTile?.root?.view;
  if(!view||view.contentDOM!==content||view.constructor.findFromDOM(view.dom)!==view)throw Error('Pinned native EditorView lookup is unavailable.');
`;
const stateScript=readView+`
  const query=document.querySelector('.cm-search input[name=search]');
  const compile=document.getElementById('typst-compile');
  const selected=document.querySelector('#manuscript-tabs [aria-selected=true]');
  return {doc:view.state.doc.toString(),selection:view.state.selection.toJSON(),activePath:selected?.textContent.replace(/ •$/,''),project:document.getElementById('project-select').value,
    saved:document.getElementById('save-label').textContent,editorFocused:document.activeElement===content,queryFocused:document.activeElement===query,documentFocused:document.hasFocus(),query:query?.value,panel:!!query,
    compileTitle:compile.title,compileText:compile.textContent,compileVisible:!!compile.getClientRects().length&&!compile.hidden,
    currentPdf:document.getElementById('typst-preview-status').textContent.startsWith('Current PDF'),canvas:!!document.querySelector('#typst-pages canvas')?.width,
    tabs:[...document.querySelectorAll('#manuscript-tabs [role=tab]')].map(node=>({label:node.textContent,selected:node.getAttribute('aria-selected')}))};
`;
async function files(project) {
  const rows=[];let bytes=0;
  async function walk(parent,relative='') {
    for(const entry of await readdir(parent,{withFileTypes:true})) {
      const name=relative?relative+'/'+entry.name:entry.name,path=join(parent,entry.name),info=await lstat(path);
      if(info.isDirectory())await walk(path,name);
      else {
        assert.ok(info.isFile()&&!info.isSymbolicLink(),'Owned fixture has regular files only.');
        assert.ok(rows.length<128&&bytes+info.size<=8*1024*1024,'Finite native Find disk snapshot.');
        const value=await readFile(path);bytes+=value.length;rows.push({path:name,sha256:hash(value),mode:info.mode&0o777});
      }
    }
  }
  await walk(project);return rows.sort((a,b)=>a.path.localeCompare(b.path));
}
async function projectMetadata(state) {
  const value=JSON.parse(await readFile(join(state,'projects.json'),'utf8'));
  return value.projects.map(project=>Object.fromEntries(['id','root','name','mainDocument','repository','autoSync'].filter(key=>Object.hasOwn(project,key)).map(key=>[key,project[key]])));
}
function harness(context) {
  const {execute,click,native,nativeWindow,waitFor}=context;
  const snapshot=()=>execute(stateScript);
  const probe=()=>execute('return window.__nativeFindProbe.snapshot();');
  const key=value=>native('xdotool',['windowactivate','--sync',nativeWindow,'key','--clearmodifiers',value]);
  const type=value=>native('xdotool',['type','--clearmodifiers','--delay','4',value]);
  async function command(name) {
    const selector=await execute('return document.getElementById("menu-edit-toggle").getClientRects().length?"#menu-edit":"#workspace-menu";');
    await click(selector+' [data-command="'+name+'"]');
    const value=await snapshot();
    assert.equal(value.documentFocused,true,'Real native app keeps document focus.');
    assert.equal(name==='find'?value.queryFocused:value.editorFocused,true,'Actual production command leaves focus on its intended target.');
    return value;
  }
  async function query(value) {
    assert.equal((await snapshot()).queryFocused,true,'Query field is genuinely focused BEFORE typing.');
    key('ctrl+a');assert.equal((await snapshot()).queryFocused,true);type(value);
    await waitFor(async()=>{const state=await snapshot();return state.queryFocused&&state.query===value;},'Real native query keys did not reach the focused field.');
  }
  async function expectDoc(value,label) {
    await waitFor(async()=>{const current=await snapshot();return current.doc===value;},label);
    return snapshot();
  }
  async function expectMatch(from,to) {
    return waitFor(async()=>{const value=await snapshot(),range=value.selection.ranges[0];return value.queryFocused&&value.selection.ranges.length===1&&range.anchor===from&&range.head===to?value:null;},'Actual native search selection did not reach its expected UTF16 match.');
  }
  async function quiet() {
    await waitFor(async()=>{const value=await probe(),current=await snapshot();assertObserved(value);return !value.pending.some(isProducer)&&value.now-value.lastProducerStart>1100&&value.now-value.lastSourceDomChange>1100&&current.compileText==='Recompile';},'Actual denied Save/compile producers did not settle.');
    assertProducerQuiet(await probe());
  }
  return {snapshot,probe,key,type,command,query,expectDoc,expectMatch,quiet};
}

export async function qualifyNativeFindDirtyQuery(context) {
  const {execute,project,compilerCalls,evidence,checks}=context,h=harness(context);
  const before=await h.snapshot(),disk=await files(project),compiler=hash(await readFile(compilerCalls));
  assert.equal(before.activePath,'main.typ');assert.equal(before.saved,'Unsaved changes');
  assert.deepEqual(before.selection.ranges,[{anchor:before.doc.length,head:before.doc.length}]);
  const query='CLI barrier.',positions=matchOffsets(before.doc,query);assert.equal(positions.length,1);
  await execute('('+installNativeFindObserver.toString()+')();');
  let failure;
  try {
    const marker=(await h.probe()).sequence;
    await h.command('find');await h.query(query);
    for(const key of ['Return','F3','shift+F3']) {
      h.key(key);const value=await h.expectMatch(positions[0],positions[0]+query.length);
      assert.deepEqual(value.selection.ranges,[{anchor:positions[0],head:positions[0]+query.length}]);
      assert.equal(value.queryFocused,true);assert.equal(value.doc,before.doc);
    }
    h.key('Escape');let value=await h.snapshot();assert.equal(value.panel,false);assert.equal(value.editorFocused,true);
    await h.command('find');h.key('Escape');h.key('ctrl+End');
    value=await h.snapshot();assert.equal(value.editorFocused,true);assert.equal(value.doc,before.doc);assert.equal(value.saved,before.saved);assert.deepEqual(value.selection,before.selection);assert.deepEqual(value.tabs,before.tabs);
    assert.deepEqual(await files(project),disk);assert.equal(hash(await readFile(compilerCalls)),compiler);
    const observation=await h.probe();assertPureQuery(observation,marker);
    evidence.nativeFindDirtyQuery={result:'passed',queryFocusBeforeTyping:true,realKeys:['Return','F3','ShiftF3','Escape'],docSha256:hash(value.doc),dirtyPreserved:true,noSourcePolicyOrCompilerWrites:true,observation};
    checks.push('Actual menu Find keeps query focus; native typing/Enter/F3/Escape preserve the settled dirty main and disk without Open/Save/compile effects.');
  } catch(error) {failure=error;evidence.nativeFindDirtyQuery={result:'failed',message:error.message,observation:await h.probe().catch(()=>null)};}
  finally {await execute('window.__nativeFindProbe.restore();delete window.__nativeFindProbe;').catch(error=>{failure ||= error;evidence.nativeFindDirtyQuery.result='failed';evidence.nativeFindDirtyQuery.cleanupError=error.message;});}
  if(failure)throw failure;
}

export async function qualifyNativeFindReplace(context) {
  const {execute,command,click,waitFor,project,state,projectId,evidence,checks,screenshot}=context,h=harness(context);
  const mode=(await stat(project)).mode&0o777,rect=await command('/window/rect',undefined,'GET');
  const font=await execute('return document.documentElement.style.fontSize;');
  const disk=await files(project),metadata=await projectMetadata(state),main=await h.snapshot();
  const initialPolicy=JSON.parse(await readFile(join(project,findPath+'.undertree-review.json'),'utf8'));
  const root=await execute('return window.__nativeFixtureContext.root(arguments[0]);',[projectId]);
  const physical=await stat(project,{bigint:true});assert.deepEqual(root,{dev:String(physical.dev),ino:String(physical.ino)});
  assert.equal(main.activePath,'main.typ');assert.equal(main.saved,'Saved locally');
  const unrelated=rows=>rows.filter(row=>![findPath,findPath+'.undertree-review.json'].includes(row.path));
  let failure,denied=false,observation;
  evidence.nativeFindReplace={result:'running',geometry:[],sourceScroll:[],cleanupErrors:[]};const report=evidence.nativeFindReplace;
  await execute('('+installNativeFindObserver.toString()+')();');
  try {
    await click('.file-button[data-path="'+findPath+'"]');
    const setup=await waitFor(async()=>{
      const {current,probe}=await execute('return {current:(function(){'+stateScript+'})(),probe:window.__nativeFindProbe.snapshot()};');
      if(current.activePath!==findPath||current.project!==projectId||current.doc!==findSource||current.saved!=='Saved locally'||!current.compileVisible)return false;
      return {probe,receipt:assertFreshRegistrationSetup(probe,{project:projectId,path:findPath,expectedRoot:root,revision:hash(findSource)})};
    },'Explicit owned source Open and registration did not settle its exact saved CRLF/emoji document before pure Find.');
    await execute('window.__nativeFindProbe.watchSource();');
    const opened=setup.receipt.opened.start;
    assert.ok(opened);assert.deepEqual(opened.expectedRoot,root);
    report.setupRegistration=setup.receipt;
    const pure=setup.probe.sequence,positions=matchOffsets(findSource,'needle');assert.equal(positions.length,3);
    await h.command('find');await h.query('needle');
    for(const [key,index] of [['Return',0],['F3',1],['F3',2],['F3',0],['shift+F3',2]]) {
      h.key(key);const value=await h.expectMatch(positions[index],positions[index]+6);assert.deepEqual(value.selection.ranges,[{anchor:positions[index],head:positions[index]+6}]);assert.equal(value.queryFocused,true);assert.equal(value.doc,findSource);
    }
    h.key('Escape');assert.equal((await h.snapshot()).editorFocused,true);
    for(const name of ['undo','redo']) {await h.command(name);assert.equal((await h.snapshot()).doc,findSource);}
    await h.command('select-all');assert.deepEqual((await h.snapshot()).selection.ranges,[{anchor:0,head:findSource.length}]);h.key('ctrl+Home');
    assertPureQuery(await h.probe(),pure);
    await qualifyFindGeometry(context,h,report);
    assertPureQuery(await h.probe(),pure);
    h.key('ctrl+Home');await h.command('find');await h.query('needle');h.key('Return');
    await h.expectMatch(positions[0],positions[0]+6);
    await click('.cm-search input[name="replace"]');
    assert.equal(await execute('return document.activeElement===document.querySelector(".cm-search input[name=replace]");'),true,'Replace field genuinely focused BEFORE typing.');
    h.key('ctrl+a');h.type('stem');
    await waitFor(()=>execute('return document.activeElement===document.querySelector(".cm-search input[name=replace]")&&document.activeElement.value==="stem";'),'Real native replacement keys did not reach the actual field.');
    await chmod(project,mode&~0o222);denied=true;
    const editSequence=(await h.probe()).sequence;
    const first=findSource.replace('needle','stem'),all=findSource.replaceAll('needle','stem');
    await click('.cm-search button[name="replace"]');await h.expectDoc(first,'Actual Replace did not edit exactly the selected first match.');
    for(const [name,expected] of [['undo',findSource],['redo',first],['undo',findSource]]) {await h.command(name);await h.expectDoc(expected,'Real '+name+' did not preserve exact first-replacement history.');}
    await click('.cm-search button[name="replaceAll"]');await h.expectDoc(all,'Actual Replace-all did not edit exactly the three matches.');
    for(const [name,expected] of [['undo',findSource],['redo',all]]) {await h.command(name);await h.expectDoc(expected,'Real '+name+' did not preserve exact replace-all history.');}
    await h.quiet();
    assert.equal((await h.snapshot()).saved,'Unsaved changes');assert.deepEqual(await files(project),disk,'All attempted autosaves were genuinely denied before the explicit Save.');
    const deniedProbe=await h.probe();assert.ok(deniedProbe.events.some(row=>row.kind==='start'&&row.sequence>editSequence&&row.name==='review_action'&&row.action==='save'),'Real edits actually attempted ordinary autosave.');
    assert.ok(!deniedProbe.events.some(row=>row.kind==='ack'&&row.ok&&deniedProbe.events.some(start=>start.kind==='start'&&start.sequence>editSequence&&start.request===row.request&&isProducer(start)&&start.action!=='compile')),'Denied write interval has no successful save acknowledgement.');
    const saveSequence=deniedProbe.sequence;
    await chmod(project,mode);denied=false;
    await click('#manuscript-save');
    await waitFor(async()=>{const current=await h.snapshot(),probe=await h.probe();return current.saved==='Saved locally'&&current.doc===all&&!probe.pending.some(isProducer)&&(await readFile(join(project,findPath),'utf8'))===all;},'The one explicit native Save did not settle the final replacement bytes.');
    observation=await h.probe();report.saveBoundary=assertSaveBoundary(observation,saveSequence,findPath);
    assert.equal(report.saveBoundary.ack.revision,hash(all));
    const policy=JSON.parse(await readFile(join(project,findPath+'.undertree-review.json'),'utf8'));assert.equal(policy.revision,hash(all));assert.deepEqual(policy.rules,initialPolicy.rules);assert.deepEqual(policy.markers,initialPolicy.markers);assert.deepEqual(policy.suggestions,initialPolicy.suggestions);
    assert.deepEqual(unrelated(await files(project)),unrelated(disk));assert.deepEqual(await projectMetadata(state),metadata);
    // This explicit main navigation and cleanup build are separate from pure Find and Save intervals.
    h.key('Escape');await click('.file-button[data-path="main.typ"]');
    await waitFor(async()=>{const value=await h.snapshot();return value.activePath==='main.typ'&&value.project===projectId&&value.doc===main.doc&&value.saved==='Saved locally'&&value.compileVisible&&value.compileTitle==='Compile main.typ';},'Clean main and the actual effective-main Compile title did not become ready.');
    await execute('window.__nativeFindProbe.watchSource();');
    const mainOpen=(await h.probe()).events.filter(row=>row.kind==='start'&&row.name==='review_action'&&row.action==='open'&&row.path==='main.typ').at(-1);
    // Main may already be registered; an existing-tab navigation deliberately needs no new Open.
    if(mainOpen)assert.deepEqual(mainOpen.expectedRoot,root);
    const compileSequence=(await h.probe()).sequence;
    await click('#typst-compile');
    await waitFor(async()=>{
      const value=await h.snapshot(),probe=await h.probe(),click=probe.events.find(row=>row.kind==='click'&&row.id==='typst-compile'&&row.sequence>compileSequence);
      const completed=click&&probe.events.some(start=>start.kind==='start'&&start.name==='review_action'&&start.action==='compile'&&start.project===projectId&&start.path==='main.typ'&&start.sequence>click.sequence&&probe.events.some(ack=>ack.kind==='ack'&&ack.request===start.request&&ack.ok&&ack.available&&ack.current&&ack.compileStatus==='succeeded'&&ack.revision===hash(main.doc)));
      return completed&&value.activePath==='main.typ'&&value.saved==='Saved locally'&&value.compileText==='Recompile'&&value.currentPdf&&value.canvas&&!probe.pending.some(isProducer);
    },'The one declared effective-main cleanup Recompile did not publish its current PDF.',30_000);
    observation=await h.probe();assertObserved(observation);
    const compileClicks=observation.events.filter(row=>row.kind==='click'&&row.id==='typst-compile'&&row.sequence>compileSequence);assert.equal(compileClicks.length,1);
    const compileStarts=observation.events.filter(row=>row.kind==='start'&&row.name==='review_action'&&row.action==='compile'&&row.project===projectId&&row.path==='main.typ'&&row.sequence>compileClicks[0].sequence);
    assert.ok(compileStarts.some(start=>observation.events.some(ack=>ack.kind==='ack'&&ack.request===start.request&&ack.ok&&ack.available&&ack.current&&ack.compileStatus==='succeeded'&&ack.revision===hash(main.doc)&&ack.replyPath==='main.typ'&&ack.replyProject===projectId&&JSON.stringify(ack.expectedRoot)===JSON.stringify(root))),'Actual effective-main compile reaches its bound successful/current PDF response.');
    const pdfKey=hash(projectId+':main.typ'),pdfMetadata=JSON.parse(await readFile(join(state,'pdfs',pdfKey+'.json'),'utf8'));
    assert.equal(pdfMetadata.revision,hash(main.doc));assert.equal((await readFile(join(state,'pdfs',pdfMetadata.pdf))).subarray(0,5).toString(),'%PDF-');
    assert.deepEqual(unrelated(await files(project)),unrelated(disk));assert.deepEqual(await projectMetadata(state),metadata);
    const returned=await h.snapshot();
    assert.deepEqual(returned.tabs.filter(row=>row.label.replace(/ •$/,'')!==findPath),main.tabs,'Unrelated native tabs and dirty labels are preserved after explicit return.');
    assert.ok(returned.tabs.some(row=>row.label===findPath),'The owned replacement source remains saved in its inactive tab.');
    report.cleanupCompile={click:compileClicks[0],starts:compileStarts,pdfRevision:pdfMetadata.revision,target:'main.typ'};
    report.observation=observation;report.finalSourceSha256=hash(all);report.result='passed';
    checks.push('Actual native Replace/Replace-all and Undo/Redo preserve CRLF/emoji; denied autosaves remain distinct from one click-bound local Save, followed by explicit return-main and one separately declared effective-main cleanup Recompile.');
  } catch(error) {failure=error;report.result='failed';report.error=error.message;report.observation=await h.probe().catch(()=>null);await screenshot?.('native-find-failure.png').catch(()=>{});}
  finally {
    if(denied)await h.quiet().catch(error=>report.cleanupErrors.push('Denied producer settlement: '+error.message));
    for(const cleanup of [()=>chmod(project,mode),()=>execute('document.documentElement.style.fontSize=arguments[0];',[font]),()=>command('/window/rect',{x:rect.x,y:rect.y,width:rect.width,height:rect.height}),()=>execute('window.__nativeFindProbe.restore();delete window.__nativeFindProbe;')]) {
      try {await cleanup();}catch(error){report.cleanupErrors.push(error.message);}
    }
    try {
      assert.equal((await stat(project)).mode&0o777,mode);
      assert.equal(await execute('return document.documentElement.style.fontSize;'),font);
      assert.deepEqual(await command('/window/rect',undefined,'GET'),rect);
      report.modeFontAndFullWindowRectRestored=true;
    } catch(error) {report.cleanupErrors.push('Restore verification: '+error.message);}
    if(report.cleanupErrors.length){report.result='failed';failure ||= Error('Native Find cleanup failed: '+report.cleanupErrors.join('; '));}
  }
  if(failure)throw failure;
}

async function qualifyFindGeometry(context,h,report) {
  const {execute,command,click,waitFor,screenshot}=context;
  const font=await execute('return document.documentElement.style.fontSize;');
  const previous=await command('/window/rect',undefined,'GET');
  const settle=()=>execute('return document.fonts.ready.then(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true)))));');
  const inside=(box,bounds)=>box.left>=bounds.left-1&&box.right<=bounds.right+1&&box.top>=bounds.top-1&&box.bottom<=bounds.bottom+1;
  const measured=async label=>{
    await waitFor(()=>execute(`
      const visible=node=>node.getClientRects().length&&!node.closest('[hidden],[inert]')&&getComputedStyle(node).visibility==='visible';
      const tab=document.querySelector('#manuscript-tabs [aria-selected=true]')?.parentElement;
      const nodes=[...document.querySelectorAll('.cm-search button,.cm-search label,.mobile-views button'),...tab?.querySelectorAll('button')||[]].filter(visible);
      return nodes.length>0&&nodes.every(node=>node.dataset.textFit&&node.dataset.textFit!=='deferred');
    `),'Actual native Pretext controls did not settle.',5000);
    const value=await execute('return ('+readNativeFindGeometry.toString()+')();');
    // Preserve the real failure dimensions before checking any predicate.
    report.geometry.push({label,value});
    const bounds={left:0,top:0,right:value.viewport.width,bottom:value.viewport.height};
    assert.ok(value.document.width<=bounds.right+1&&value.document.height<=bounds.bottom+1,'Native Find has no document overflow.');
    assert.ok(value.frame.box.height>0&&inside(value.frame.box,bounds),'Actual custom native titlebar remains visible.');
    assert.ok(value.topbar.box.height>0&&inside(value.topbar.box,bounds),'The actual combined topbar allocation remains visible and bounded.');
    if(value.viewport.width>500) {
      assert.equal(value.chatgpt.visible,true);assert.equal(value.topbarActions.visible,true);
      assert.equal(value.chatgpt.accessibleName,'ChatGPT MCP setup');assert.equal(value.chatgpt.controls,'connection-dialog');assert.equal(value.chatgpt.hasPopup,'dialog');
      assert.ok(inside(value.chatgpt.box,value.topbarActions.box)&&inside(value.chatgpt.box,value.topbar.box)&&inside(value.chatgpt.box,bounds),'The real desktop ChatGPT icon stays in its actual action row.');
      assert.ok(Math.abs(value.chatgpt.box.width-2*value.rootFont)<1&&Math.abs(value.chatgpt.box.height-2*value.rootFont)<1&&value.chatgpt.box.width>=28&&value.chatgpt.box.height>=28,'The icon keeps its existing2rem type-relative hit box.');
      assert.ok(value.chatgpt.ink&&inside(value.chatgpt.ink,value.chatgpt.svg)&&inside(value.chatgpt.svg,value.chatgpt.box)&&value.chatgpt.ink.right>value.chatgpt.ink.left&&value.chatgpt.ink.bottom>value.chatgpt.ink.top,'Native ChatGPT SVG ink is positive and fully inside its button.');
      assert.ok(Math.abs((value.chatgpt.ink.left+value.chatgpt.ink.right-value.chatgpt.box.left-value.chatgpt.box.right)/2)<=1&&Math.abs((value.chatgpt.ink.top+value.chatgpt.ink.bottom-value.chatgpt.box.top-value.chatgpt.box.bottom)/2)<=1,'Native ChatGPT SVG ink remains centered.');
    } else {
      assert.equal(value.chatgpt.visible,false,'Exact9559 uses its established compact-menu route at narrow widths.');assert.equal(value.topbarActions.visible,false);
    }
    for(const node of [value.source,value.editor,value.scroller,value.panel])assert.ok(node&&node.box.width>0&&node.box.height>0&&inside(node.box,bounds),'Actual source/search allocation remains positive and visible.');
    assert.ok(inside(value.scroller.box,value.editor.box));
    assert.ok(value.scroller.clientHeight+1>=value.sourceLineHeight&&value.sourceLineHeight>0,'Native Find leaves a full unchanged source line.');
    assert.ok(Math.abs(value.editor.font-value.rootFont*12/14)<.1,'Native source font keeps its default user scale.');
    assert.ok(value.panel.scrollWidth<=value.panel.clientWidth+1&&value.panel.scrollHeight<=value.panel.clientHeight+2,'Finite search panel does not hide controls.');
    assert.equal(value.activeTabControls.length,2,'The active real tab and Close remain present; inactive tabs retain their intentional scroll inventory.');
    assert.equal(value.mobileControls.length,value.mobileVisible?4:0);
    for(const [nodes,parent] of [[value.activeTabControls,value.tabs],[value.mobileControls,value.mobile]])for(const node of nodes) {
      assert.ok(inside(node.box,parent.box)&&node.box.height>=32&&Math.abs(node.font-value.rootFont)<.1,'Actual active tab/mobile label keeps its full type and existing hit floor.');
      assert.ok(inside(node.glyph,node.box)&&node.glyph.width>0&&node.glyph.height>0,'Full active label glyphs remain visible.');
      assert.ok(node.scrollWidth<=node.clientWidth+1&&node.scrollHeight<=node.clientHeight+2);
      assert.ok(['fit','reflow'].includes(node.fit),'Actual native Pretext approves the full active label.');
    }
    for(const node of value.controls) {
      assert.ok(inside(node.box,value.panel.box)&&node.box.width>0&&node.box.height>0,'Every real search/replace control is reachable.');
      assert.ok(node.scrollWidth<=node.clientWidth+1&&node.scrollHeight<=node.clientHeight+2,'Full control labels do not overflow.');
      assert.ok(node.font+0.1>=value.editor.font*.7,'Search controls preserve the pinned default type scale.');
      if(['BUTTON','LABEL'].includes(node.tag))assert.ok(['fit','reflow'].includes(node.fit),'Actual search label passes real Pretext.');
    }
    return value;
  };
  let failure;
  try {
    for(const [width,height,rootFont] of [[1440,900,14],[320,480,28]]) {
      await command('/window/rect',{width,height});await execute('document.documentElement.style.fontSize=arguments[0];',[rootFont+'px']);await settle();
      await h.command('find');await h.query('needle');await measured(width+'x'+height+'/'+rootFont+'/opened');
      await click('.cm-content');assert.equal((await h.snapshot()).editorFocused,true);
      for(const [key,position] of [['ctrl+Home',0],['ctrl+End',findSource.length]]) {
        h.key(key);await settle();
        const cursor=await waitFor(()=>execute(readView+`
          const position=arguments[0],range=view.state.selection.main,coords=view.coordsAtPos(position),s=view.scrollDOM.getBoundingClientRect();
          if(range.from!==position||range.to!==position||!coords||coords.top<s.top-1||coords.bottom>s.bottom+1)return null;
          return {position,selection:{from:range.from,to:range.to},coords,scrollTop:view.scrollDOM.scrollTop,clientHeight:view.scrollDOM.clientHeight};
        `,[position]),'Actual source caret/scroll did not reach '+key);
        report.sourceScroll.push({width,height,rootFont,key,cursor});assert.equal((await h.snapshot()).doc,findSource);
        await measured(width+'x'+height+'/'+rootFont+'/'+key);
      }
      await h.command('find');assert.equal((await h.snapshot()).queryFocused,true);await measured(width+'x'+height+'/'+rootFont+'/refocus');
      if(width===320) {
        // One genuine summary click; the shared helper's child auto-open is inappropriate for a summary itself.
        const summary=await command('/element',{using:'css selector',value:'#workspace-menu > summary'});
        await command('/element/'+summary['element-6066-11e4-a52e-4f735466cecf']+'/click',{});
        const navigation=await execute(`
          const menu=document.getElementById('workspace-menu'),target=menu.querySelector('[data-command=chatgpt]');
          const items=[...menu.querySelector('.workspace-menu-panel').querySelectorAll('button')].filter(node=>!node.matches(':disabled,[aria-disabled="true"]')&&!node.closest('[hidden],[inert]')&&node.getClientRects().length>0&&getComputedStyle(node).visibility==='visible');
          return {open:menu.open,documentFocused:document.hasFocus(),summaryFocused:document.activeElement===menu.querySelector('summary'),targetIndex:items.indexOf(target),items:items.map(node=>({id:node.id||null,command:node.dataset.command||null}))};
        `);
        report.compactChatgptNavigation={...navigation,keys:[]};
        assert.equal(navigation.open,true);assert.equal(navigation.documentFocused,true);assert.equal(navigation.summaryFocused,true);
        assert.ok(navigation.items.length>0&&navigation.items.length<=64&&navigation.targetIndex>=0&&navigation.targetIndex<navigation.items.length,'The actual compact menu has a finite reachable ChatGPT target.');
        for(let index=0;index<=navigation.targetIndex;index++) {
          h.key('Down');
          await waitFor(()=>execute(`
            const menu=document.getElementById('workspace-menu');
            const items=[...menu.querySelector('.workspace-menu-panel').querySelectorAll('button')].filter(node=>!node.matches(':disabled,[aria-disabled="true"]')&&!node.closest('[hidden],[inert]')&&node.getClientRects().length>0&&getComputedStyle(node).visibility==='visible');
            return menu.open&&document.hasFocus()&&document.activeElement===items[arguments[0]];
          `,[index]),'Genuine compact-menu ArrowDown did not focus enabled item '+index);
          report.compactChatgptNavigation.keys.push({key:'ArrowDown',index,item:navigation.items[index],actualFocusVerified:true});
        }
        await waitFor(()=>execute('const node=document.querySelector("#workspace-menu [data-command=chatgpt]");return document.getElementById("workspace-menu").open&&node.dataset.textFit&&!["deferred","no-fit"].includes(node.dataset.textFit);'),'Actual narrow ChatGPT menu label did not receive fitted Pretext.',5000);
        const value=await measured('320x480/28/actual-compact-menu-open'),route=value.compactChatgpt;
        assert.equal(await execute('return document.hasFocus()&&document.activeElement===document.querySelector("#workspace-menu [data-command=chatgpt]");'),true,'The production menu handler genuinely focuses ChatGPT without activating it.');
        assert.equal(route.menuOpen,true);assert.equal(route.visible,true);assert.equal(route.disabled,false);assert.equal(route.role,'menuitem');assert.equal(route.text,'ChatGPT MCP setup');
        assert.ok(inside(route.box,{left:0,top:0,right:value.viewport.width,bottom:value.viewport.height})&&route.box.height>=32,'The actual compact ChatGPT route has a reachable existing hit area.');
        assert.ok(value.compactMenuPanel.box.width>0&&value.compactMenuPanel.box.height>0&&inside(value.compactMenuPanel.box,{left:0,top:0,right:value.viewport.width,bottom:value.viewport.height}),'The real compact-menu scroll panel has a positive allocation inside the window.');
        assert.ok(inside(route.box,value.compactMenuPanel.viewport)&&inside(route.glyph,value.compactMenuPanel.viewport),'The complete ChatGPT control and glyph are visible within the actual menu-panel scroll viewport.');
        assert.ok(route.font>=value.rootFont-.1&&inside(route.glyph,route.box)&&route.glyph.width>0&&route.glyph.height>0,'The complete compact ChatGPT label keeps readable user type and full glyphs.');
        assert.ok(route.scrollWidth<=route.clientWidth+1&&route.scrollHeight<=route.clientHeight+2&&['fit','reflow'].includes(route.fit));
        await screenshot?.('native-find-compact-chatgpt-route.png');
        h.key('Escape');assert.equal(await execute('return !document.getElementById("workspace-menu").open&&document.activeElement===document.querySelector("#workspace-menu > summary");'),true,'Genuine Escape closes the actual compact menu and restores its trigger.');
        await h.command('find');await h.query('needle');assert.equal((await h.snapshot()).doc,findSource);await measured('320x480/28/find-refocused-after-compact-menu');
      }
      await screenshot?.('native-find-'+width+'x'+height+'-'+rootFont+'.png');h.key('Escape');assert.equal((await h.snapshot()).editorFocused,true);
    }
  } catch(error) {failure=error;}
  finally {
    for(const restore of [()=>execute('document.documentElement.style.fontSize=arguments[0];',[font]),()=>command('/window/rect',{x:previous.x,y:previous.y,width:previous.width,height:previous.height})]) {
      try {await restore();}catch(error){failure ||= error;}
    }
  }
  if(failure)throw failure;
  await settle();await h.command('find');await measured('restored-full-window-regrowth');h.key('Escape');
  report.nativeHelperAttribution='Source CtrlHome/End reach is native; zero-helper source-edit instrumentation remains the separate static source05 proof because bundled native URLs do not retain the stack matcher.';
}
