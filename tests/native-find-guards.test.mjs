import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { assertPureQuery,assertProducerQuiet,assertSaveBoundary,matchOffsets } from './native-find-guards.mjs';
import { installNativeFindObserver } from './native-find-observer.mjs';
const probe=events=>({events,pending:[],errors:[],dropped:0,now:3000,lastProducerStart:0,lastSourceDomChange:0});
const start=(sequence,action='save')=>({kind:'start',request:1,sequence,at:sequence,name:'review_action',action,path:'owned.typ'});
const click={kind:'click',id:'manuscript-save',sequence:10,at:10,trusted:true};
const ack={kind:'ack',request:1,sequence:30,at:30,ok:true};
test('only read observations and ephemeral publications qualify a pure Find interval',()=>{
  assert.equal(assertPureQuery(probe([{kind:'start',sequence:1,name:'editor_operation',action:'editor_update'},{kind:'start',sequence:2,name:'control_operation',action:'control_poll'}]),0).length,2);
  for(const action of ['open','save','compile','share','palette','sync','create_directory','unknown'])assert.throws(()=>assertPureQuery(probe([start(1,action)]),0));
});
test('Save boundary checks actual START, not a successful ACK arriving after click',()=>{
  assert.equal(assertSaveBoundary(probe([click,start(20),ack]),0,'owned.typ').start.sequence,20);
  assert.throws(()=>assertSaveBoundary(probe([start(5),click,ack]),0,'owned.typ'));
});
test('missing acknowledgement, wrong source, extra successful producer and fake click fail closed',()=>{
  assert.throws(()=>assertSaveBoundary(probe([click,start(20)]),0,'owned.typ'));
  assert.throws(()=>assertSaveBoundary(probe([click,start(20),ack]),0,'other.typ'));
  assert.throws(()=>assertSaveBoundary(probe([{...click,trusted:false},start(20),ack]),0,'owned.typ'));
  assert.throws(()=>assertSaveBoundary(probe([click,start(20),ack,{...start(40),request:2},{...ack,request:2,sequence:50,at:50}]),0,'owned.typ'));
});
test('pending denied Save/compile and recent source changes prevent restoring write permissions',()=>{
  assertProducerQuiet(probe([]));
  for(const action of ['save','compile'])assert.throws(()=>assertProducerQuiet({...probe([]),pending:[start(1,action)]}));
  assert.throws(()=>assertProducerQuiet({...probe([]),lastSourceDomChange:2500}));
  assert.throws(()=>assertProducerQuiet({...probe([]),lastProducerStart:2500}));
});
test('dropped or undecodable observation cannot establish absence of writes',()=>{
  assert.throws(()=>assertPureQuery({...probe([]),dropped:1},0));
  assert.throws(()=>assertProducerQuiet({...probe([]),errors:['Unsupported native observation.']}));
});
test('raw UTF16 match offsets retain emoji and CRLF',()=>{
  assert.deepEqual(matchOffsets('😀\r\nneedle\r\nneedle needle','needle'),[4,12,19]);
});
async function observedResponse(body) {
  let clock=0,forwarded;
  const original=function(...args){forwarded={receiver:this,args};return Promise.resolve(new Response(JSON.stringify(body),{status:200,headers:{'Tauri-Response':'ok'}}));};
  const window={fetch:original},content={},document={querySelector:()=>content,addEventListener(){},removeEventListener(){}};
  const context={window,document,MutationObserver:class {observe(){}disconnect(){}},performance:{now:()=>++clock},URL,TextDecoder,Promise};
  vm.runInNewContext('('+installNativeFindObserver.toString()+')();',context);
  const init={body:JSON.stringify({operation:{action:'compile',project:'p',path:'main.typ'}})};
  const response=await window.fetch('ipc://localhost/review_action',init);
  assert.equal((await response.json()).status,body.status,'Original untouched response is still delivered.');
  await new Promise(resolve=>setImmediate(resolve));
  return {snapshot:window.__nativeFindProbe.snapshot(),forwarded,window,init};
}
test('actual observer preserves the original fetch and reads only bounded compile metadata from the typed envelope',async()=>{
  const value=await observedResponse({compileDiagnosticsVersion:1,status:'succeeded',preview:{available:true,current:true,revision:'a'.repeat(64),expectedRoot:{dev:'1',ino:'2'}},report:{provenance:{project:'p',path:'main.typ'}}});
  assert.equal(value.forwarded.receiver,value.window);assert.equal(value.forwarded.args[1],value.init);
  const terminal=value.snapshot.events.find(row=>row.kind==='ack');assert.equal(terminal.ok,true);assert.equal(terminal.available,true);assert.equal(terminal.compileStatus,'succeeded');assert.equal(terminal.replyPath,'main.typ');assert.equal(terminal.revision,'a'.repeat(64));
});
test('actual observer does not mislabel a successful IPC transport as successful compile outcome',async()=>{
  for(const status of ['failed','outcome_unknown']) {
    const value=await observedResponse({compileDiagnosticsVersion:1,status,error:{code:status}});
    assert.equal(value.snapshot.events.find(row=>row.kind==='ack').ok,false);
  }
});
