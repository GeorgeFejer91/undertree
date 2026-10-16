import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('./review-ui-smoke.mjs',import.meta.url),'utf8');
const start=source.indexOf('function observeHighlightRequests('),end=source.indexOf('async function observeSource(',start);
assert.ok(start>0&&end>start);const helper=source.slice(start,end);
const plain=v=>JSON.parse(JSON.stringify(v));
function requestFixture(){
  const handlers=new Map();let now=0;
  const page={on(event,fn){assert.equal(handlers.has(event),false);handlers.set(event,fn);},off(event,fn){assert.equal(handlers.get(event),fn);handlers.delete(event);}};
  const context=vm.createContext({performance:{now:()=>now++}});
  vm.runInContext(helper+'globalThis.observe=observeHighlightRequests;',context);
  const observed=context.observe(page,'http://127.0.0.1:34567/api/review');
  const request=(action='mark',url='http://127.0.0.1:34567/api/review',method='POST')=>({url:()=>url,method:()=>method,postDataJSON:()=>({action,content:'never retain source',quote:'never retain quote',prompt:'never retain prompt'}),headers(){throw Error('headers forbidden');},failure(){throw Error('failure text forbidden');}});
  const emit=(event,value)=>handlers.get(event)?.(value);
  return {observed,request,emit,handlers};
}
test('actual request helper observes only fixed local endpoint and categories',()=>{
 const f=requestFixture();for(const action of ['mark','save','review'])f.emit('request',f.request(action));
 for(const action of ['open','compile','sync','projects',null])f.emit('request',f.request(action));
 f.emit('request',f.request('mark','http://external.invalid/api/review'));
 f.emit('request',f.request('mark','http://127.0.0.1:34567/api/review?other'));
 f.emit('request',f.request('mark',undefined,'GET'));
 assert.deepEqual(plain(f.observed.snapshot().rows.map(r=>r.action)),['mark','save','review']);assert.equal(f.observed.snapshot().matchedStarts,3);
});
test('actual start/status/finished record omits source values, headers and body',()=>{
 const f=requestFixture(),r=f.request();f.emit('request',r);f.emit('response',{request:()=>r,status:()=>400,json(){throw Error('body forbidden');}});f.emit('requestfinished',r);
 const row=plain(f.observed.snapshot().rows[0]);assert.deepEqual(Object.keys(row),['sequence','action','startedMs','httpStatus','terminal','endedMs']);assert.equal(row.httpStatus,400);assert.equal(row.terminal,'requestfinished');assert.ok(row.endedMs>row.startedMs);assert.equal(JSON.stringify(row).includes('never retain'),false);
});
test('requestfailed is terminal without reading sensitive error text',()=>{
 const f=requestFixture(),r=f.request('save');f.emit('request',r);f.emit('requestfailed',r);assert.equal(f.observed.snapshot().rows[0].terminal,'requestfailed');assert.equal(f.observed.snapshot().rows[0].httpStatus,null);
});
test('unknown responses and repeated terminal events cannot invent or overwrite an outcome',()=>{
 const f=requestFixture(),r=f.request();f.emit('response',{request:()=>r,status:()=>200});f.emit('requestfinished',r);assert.equal(f.observed.snapshot().rows.length,0);f.emit('request',r);f.emit('requestfailed',r);const before=plain(f.observed.snapshot());f.emit('requestfinished',r);f.emit('response',{request:()=>r,status:()=>200});assert.deepEqual(plain(f.observed.snapshot()),before);
});
test('invalid status and malformed request JSON remain unavailable without throwing',()=>{
 const f=requestFixture(),r=f.request();f.emit('request',{url:r.url,method:r.method,postDataJSON(){throw Error('malformed');}});f.emit('request',r);for(const status of [NaN,99,600,'200'])f.emit('response',{request:()=>r,status:()=>status});assert.equal(f.observed.snapshot().rows[0].httpStatus,null);assert.equal(f.observed.snapshot().rows.length,1);
});
test('at most64 retained request rows have explicit dropped and matched counts',()=>{
 const f=requestFixture();for(let i=0;i<70;i++)f.emit('request',f.request());const v=f.observed.snapshot();assert.equal(v.rows.length,64);assert.equal(v.dropped,6);assert.equal(v.matchedStarts,70);
});
test('stop removes all four exact event listeners and is idempotent',()=>{
 const f=requestFixture();assert.equal(f.handlers.size,4);f.observed.stop();f.observed.stop();assert.equal(f.handlers.size,0);assert.equal(f.observed.snapshot().stopped,true);f.emit('request',f.request());assert.equal(f.observed.snapshot().rows.length,0);
});
test('snapshots do not expose mutable retained request rows',()=>{
 const f=requestFixture();f.emit('request',f.request());f.observed.snapshot().rows[0].action='corrupted';assert.equal(f.observed.snapshot().rows[0].action,'mark');
});
const domStart=source.indexOf('    // Passive first-highlight diagnostic;'),domEnd=source.indexOf('    // End passive first-highlight diagnostic.',domStart);
assert.ok(domStart>0&&domEnd>domStart);const domBody=source.slice(domStart,domEnd);
function domFixture(){
 const handlers=new Map();let clock=0,removed=0;const calls={mutations:0,values:0};
 const forbidden=()=>{calls.mutations++;throw Error('producer forbidden');};
 const rect=()=>({x:1,y:2,width:100,height:30});
 const submit={tagName:'BUTTON',id:'',disabled:false,getBoundingClientRect:rect};
 const form={tagName:'FORM',id:'highlight-form',isConnected:true,getBoundingClientRect:rect,
  querySelector:s=>{assert.equal(s,'button[type="submit"]');return submit;},matches:s=>{assert.equal(s,':invalid');return false;},
  addEventListener(type,fn,options){assert.deepEqual(plain(options),{capture:true,passive:true});handlers.set(type,fn);},
  removeEventListener(type,fn,capture){assert.equal(capture,true);assert.equal(handlers.get(type),fn);handlers.delete(type);removed++;},
  checkValidity:forbidden,requestSubmit:forbidden,submit:forbidden};
 const dialog={tagName:'DIALOG',id:'highlight-dialog',open:true,getBoundingClientRect:rect,matches:s=>{assert.equal(s,':modal');return true;}};
 const document={getElementById:id=>id==='highlight-form'?form:dialog,hasFocus:()=>true,activeElement:submit};
 for(const node of [form,dialog,submit]){Object.defineProperty(node,'textContent',{get(){calls.values++;throw Error('content forbidden');}});Object.defineProperty(node,'value',{get(){calls.values++;throw Error('value forbidden');}});node.focus=forbidden;node.click=forbidden;node.dispatchEvent=forbidden;}
 const window={};vm.runInNewContext(domBody,{document,window,performance:{now:()=>clock++}});
 const emit=(type,target=submit)=>handlers.get(type)?.({type,target,isTrusted:true,defaultPrevented:false});
 return {window,emit,handlers,form,dialog,submit,calls,get removed(){return removed;}};
}
test('actual passive form listener records click/submit and detaches at first submit',()=>{
 const f=domFixture();f.emit('click');f.emit('submit',f.form);assert.equal(f.handlers.size,0);const v=plain(f.window.__undertreeReviewHighlightSubmit01());assert.deepEqual(v.rows.map(r=>r.kind),['click','submit']);assert.equal(v.rows[0].trusted,true);assert.equal(v.detached,true);assert.equal(f.removed,3);assert.deepEqual(f.calls,{mutations:0,values:0});
});
test('native invalid event is observed without checkValidity or fabricated submit',()=>{
 const f=domFixture();f.emit('invalid',{tagName:'TEXTAREA',id:'highlight-prompt',validity:{valid:false}});const v=f.window.__undertreeReviewHighlightSubmit01();assert.equal(v.rows[0].validity,false);assert.equal(v.rows[0].kind,'invalid');assert.equal(v.rows.length,1);assert.deepEqual(f.calls,{mutations:0,values:0});
});
test('form row cap and explicit drop count are bounded',()=>{
 const f=domFixture();for(let i=0;i<70;i++)f.emit('click');const v=f.window.__undertreeReviewHighlightSubmit01();assert.equal(v.rows.length,64);assert.equal(v.dropped,6);assert.equal(f.handlers.size,0);
});
test('fixed structural terminal fields omit quote, prompt, arbitrary IDs and full DOM',()=>{
 const f=domFixture();f.submit.id='secret arbitrary';f.emit('click',f.submit);const v=plain(f.window.__undertreeReviewHighlightSubmit01());assert.equal(v.rows[0].id,'');assert.equal(v.activeId,'');assert.equal(v.activeTag,'BUTTON');assert.deepEqual(v.submitRect,{x:1,y:2,width:100,height:30});assert.equal(JSON.stringify(v).includes('secret'),false);assert.deepEqual(f.calls,{mutations:0,values:0});
});
const clickStart=source.indexOf('  try {\n  await page.getByRole(\'button\',{name:\'Add highlight\',exact:true}).click();');
const clickEnd=source.indexOf('  const crlfMarked=',clickStart);assert.ok(clickStart>0&&clickEnd>clickStart);const actualClick=source.slice(clickStart,clickEnd);
async function runActualClick(error,stage){
 const names=[],calls=[];let stops=0;const context=vm.createContext({page:{getByRole(role,options){assert.equal(role,'button');assert.equal(options.exact,true);names.push(options.name);return {click:async()=>{calls.push('click');if(stage==='click')throw error;},waitFor:async(...args)=>{assert.equal(args.length,0);calls.push('wait');if(stage==='wait')throw error;}};}},highlightRequestObservation:{stop(){stops++;}}});
 const work=vm.runInContext('(async()=>{'+actualClick+'})()',context);if(error)await assert.rejects(work,e=>e===error);else await work;return {names,calls,stops};
}
test('actual original click/wait each execute once with no changed wait arguments',async()=>{assert.deepEqual(await runActualClick(),{names:['Add highlight','Remove highlight'],calls:['click','wait'],stops:1});});
test('original click error is rethrown unchanged and listener cleanup runs once',async()=>{const e=new Error('original click');assert.deepEqual(await runActualClick(e,'click'),{names:['Add highlight'],calls:['click'],stops:1});});
test('original30s wait error is rethrown unchanged with no replay',async()=>{const e=new Error('original wait');assert.deepEqual(await runActualClick(e,'wait'),{names:['Add highlight','Remove highlight'],calls:['click','wait'],stops:1});});
