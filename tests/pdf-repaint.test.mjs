import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { assertSourceBinding, captureSourceBinding, sourceBindingCurrent, sourceRootsEqual, sourceEpoch, sourceRoot } from '../modules/frontend/review-session.js';

const source = await readFile(new URL('../src/manuscript.js', import.meta.url), 'utf8');
const busy = {code:'busy',message:'A local document operation is running. Retry this action.'};
const refresh = source.match(/async function refreshPdfAnnotations\(\) \{[\s\S]*?\n\}/)?.[0];
assert.ok(refresh);

test('a successful color policy commit is not reported as failed when its optional PDF repaint read fails', async () => {
  const configuration = source.match(/const colorRules = setupColorRules\((\{[\s\S]*?\n\})\);/)?.[1];
  assert.ok(configuration);
  const operations = [], messages = [], rules = [{id:'edit'}];
  const session = {project:'project',path:'main.typ',sourceEpoch:0,snapshot:{path:'main.typ',sourceEpoch:0,review:{rules:[]}},
    async mutate(action, payload, guard) { guard(); operations.push({action,payload}); this.snapshot.review.rules = payload.rules; }};
  const environment = {active:session,view:{},windowClosing:false,assertSourceBinding,sourceBindingCurrent,
    refreshPdfAnnotations:async () => {throw busy;},status:(...args)=>messages.push(args),renderReview(){},decorations(){},queueSync(){}};
  const config = runInNewContext(`(${configuration})`, environment);
  await config.save({session,binding:captureSourceBinding(session),original:'[]',rules:[]},rules);
  await Promise.resolve();
  assert.equal(operations.length,1); assert.equal(operations[0].action,'palette');
  assert.deepEqual(session.snapshot.review.rules,rules);
  assert.ok(messages.some(([message])=>message.startsWith('Color rule saved. PDF highlights could not refresh:')));
});

test('PDF repaint retries only refused reads and cannot attach its response to a changed root or epoch', async () => {
  for (const change of [null,'root','epoch']) {
    let calls = 0, paints = 0;
    const environment = {displayedColorPdf:()=>true,pdfViewer:{identity:'pdf'},pdfGeneration:1,pdfProject:'project',pdfPath:'main.typ',
      pdfRoot:{expectedRoot:{dev:'1',ino:'2'}},pdfSourceEpoch:2,pdfAnnotationRequest:0,pdfAnnotations:[],sourceRootsEqual,setTimeout,
      colorPdfHighlights(){paints++;},request:async operation=>{
        calls++; assert.equal(operation.action,'pdf_annotations'); assert.equal(operation.sourceEpoch,2);
        if (calls===1) {
          if(change==='root') environment.pdfRoot={expectedRoot:{dev:'1',ino:'3'}};
          if(change==='epoch') environment.pdfSourceEpoch=3;
          throw busy;
        }
        return {annotations:[{id:'mark'}]};
      }};
    await runInNewContext(`${refresh}\nrefreshPdfAnnotations`,environment)();
    assert.equal(calls,change?1:2); assert.equal(paints,change?0:1);
    assert.equal(environment.pdfAnnotations.length,change?0:1);
  }
});

test('a completed PDF display drains its annotation read before the next queued build can start', async () => {
  const show = source.match(/async function showPdf\(result,[\s\S]*?\n\}/)?.[0];
  assert.ok(show);
  let releaseRead, readStarted, completed = false;
  const started = new Promise(resolve => { readStarted = resolve; });
  const pendingRead = new Promise(resolve => { releaseRead = resolve; });
  const session = {project:'project',path:'main.typ',sourceEpoch:0,snapshot:{path:'main.typ',sourceEpoch:0}};
  const controls = new Map();
  const pdf = {numPages:1}, loading = {promise:Promise.resolve(pdf)};
  const environment = {active:session,sessions:new Map([['project/main.typ',session]]),
    publicationPath:()=>session.path,keyFor:(project,path)=>`${project}/${path}`,observedSourceTarget:()=>session,
    captureSourceBinding,assertSourceBinding,sourceEpoch,sourceRoot,sourceRootsEqual,sourceBindingCurrent,
    pdfGeneration:0,pdfWorker:'worker',Uint8Array,atob,showingLogs:false,pdfLoadingTask:null,
    pdfjsFixture:{GlobalWorkerOptions:{},getDocument:()=>loading},
    pdfViewer:{clear(){},async setDocument(){}},publicationCurrent:()=>true,colorPdfHighlights(){},
    refreshPdfAnnotations:()=>{readStarted();return pendingRead;},pdfStatus(){},status(){},
    $:id=>{if(!controls.has(id)) controls.set(id,{});return controls.get(id);}};
  const display = runInNewContext(`${show.replace("await import('pdfjs-dist')",'pdfjsFixture')}\nshowPdf`,environment);
  const finished = display({available:true,sourceEpoch:0,base64:'AA==',pdfHash:'pdf'},session).then(()=>{completed=true;});
  await started; await Promise.resolve(); await Promise.resolve();
  assert.equal(controls.get('export-pdf').hidden,false,'the PDF remains available while metadata finishes');
  assert.equal(completed,false,'queue release must wait for the document-bound annotation read');
  releaseRead(); await finished; assert.equal(completed,true);
});
