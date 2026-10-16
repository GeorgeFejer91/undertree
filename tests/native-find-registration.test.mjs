import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { assertFreshRegistrationSetup,assertPureQuery } from './native-find-guards.mjs';
import { installNativeFindObserver } from './native-find-observer.mjs';

const root={dev:'1',ino:'2'},revision='a'.repeat(64),target={project:'p',path:'owned.typ',expectedRoot:root,revision};
const open={kind:'start',sequence:1,at:1,request:1,name:'review_action',action:'open',project:'p',path:'owned.typ',expectedRoot:root};
const opened={kind:'ack',sequence:2,at:2,request:1,ok:true,expectedRoot:root,sourceEpoch:0,revision};
const register={kind:'start',sequence:3,at:3,request:2,name:'editor_operation',action:'editor_register',project:'p',path:'owned.typ',expectedRoot:root,sourceEpoch:0,generation:0,revision,contentDigest:revision,dirty:false,composing:false,conflict:false};
const accepted={kind:'ack',sequence:4,at:4,request:2,ok:true,protocolVersion:1,registrationIdentityPresent:true,expectedRoot:root,sourceEpoch:0};
const probe=(events,pending=[])=>({events,pending,errors:[],dropped:0,sequence:events.at(-1)?.sequence||0});

test('old immediate pure marker rejects late setup registration; new readiness waits for actual ACK and keeps the same pure allowlist',()=>{
  assert.throws(()=>assertPureQuery(probe([open,opened,register,accepted]),2));
  assert.throws(()=>assertFreshRegistrationSetup(probe([open,opened]),target));
  assert.throws(()=>assertFreshRegistrationSetup(probe([open,opened,register],[register]),target));
  const settled=probe([open,opened,register,accepted]);assert.equal(assertFreshRegistrationSetup(settled,target).registration.ack.sequence,4);
  assertPureQuery(settled,settled.sequence);
  assert.throws(()=>assertPureQuery(probe([...settled.events,{...register,sequence:5,request:3}]),settled.sequence),'Registration remains forbidden after the measured setup boundary.');
});
test('matching saved root/epoch/generation/digest and typed actual registration response are required',()=>{
  for(const delta of [{path:'other.typ'},{project:'other'},{expectedRoot:{dev:'9',ino:'9'}},{sourceEpoch:1},{generation:1},{dirty:true},{composing:true},{conflict:true},{revision:'b'.repeat(64)},{contentDigest:'b'.repeat(64)}])assert.throws(()=>assertFreshRegistrationSetup(probe([open,opened,{...register,...delta},accepted]),target));
  for(const delta of [{ok:false},{protocolVersion:2},{registrationIdentityPresent:false},{expectedRoot:{dev:'9',ino:'9'}},{sourceEpoch:1}])assert.throws(()=>assertFreshRegistrationSetup(probe([open,opened,register,{...accepted,...delta}]),target));
  assert.throws(()=>assertFreshRegistrationSetup(probe([open,{...opened,revision:'b'.repeat(64)},register,accepted]),target));
});
test('pending Open/register/source producer cannot enter pure interval; natural failed setup attempts remain explicit without replay',()=>{
  const settled=[open,opened,register,accepted];
  for(const row of [register,open,{name:'review_action',action:'save'},{name:'review_action',action:'compile'},{name:'editor_operation',action:'editor_commit'}])assert.throws(()=>assertFreshRegistrationSetup(probe(settled,[row]),target));
  const failed={...register,sequence:2.5,request:9};const rejected={kind:'ack',sequence:2.6,at:2.6,request:9,ok:false};
  assert.equal(assertFreshRegistrationSetup(probe([open,opened,failed,rejected,register,accepted]),target).attempts.length,2);
});
test('actual observer forwards the original registration unchanged and retains bounded typed metadata without session ID/content',async()=>{
  let forwarded,deliver;
  const body={protocolVersion:1,sessionId:'private-registration-session',sourceEpoch:0,expectedRoot:root};
  const original=function(...args){forwarded={receiver:this,args};return new Promise(resolve=>{deliver=resolve;});};
  const window={fetch:original},document={querySelector:()=>({}),addEventListener(){},removeEventListener(){}};
  let clock=0;vm.runInNewContext('('+installNativeFindObserver.toString()+')();',{window,document,MutationObserver:class {observe(){}disconnect(){}},performance:{now:()=>++clock},URL,TextDecoder,Promise});
  const operation={action:'editor_register',project:'p',path:'owned.typ',expectedRoot:root,sourceEpoch:0,generation:0,revision,contentDigest:revision,dirty:false,composing:false,conflict:false};
  const init={body:JSON.stringify({operation})},responsePromise=window.fetch('ipc://localhost/editor_operation',init);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(window.__nativeFindProbe.snapshot().pending.length,1);assert.equal(window.__nativeFindProbe.snapshot().events.some(row=>row.kind==='ack'),false,'No ACK is inferred from registration START.');
  deliver(new Response(JSON.stringify(body),{status:200,headers:{'Tauri-Response':'ok'}}));
  const response=await responsePromise;
  assert.deepEqual(await response.json(),body);assert.equal(forwarded.receiver,window);assert.equal(forwarded.args[1],init);
  await new Promise(resolve=>setImmediate(resolve));
  const observation=window.__nativeFindProbe.snapshot(),start=observation.events.find(row=>row.kind==='start'),ack=observation.events.find(row=>row.kind==='ack');
  assert.equal(start.action,'editor_register');assert.equal(start.generation,0);assert.equal(start.contentDigest,revision);assert.equal(start.dirty,false);
  assert.equal(ack.ok,true);assert.equal(ack.protocolVersion,1);assert.equal(ack.registrationIdentityPresent,true);assert.equal(ack.sourceEpoch,0);assert.equal(ack.expectedRoot.dev,'1');assert.equal(observation.pending.length,0);
  assert.equal(JSON.stringify(observation).includes(body.sessionId),false);assert.equal(Object.hasOwn(start,'content'),false);window.__nativeFindProbe.restore();assert.equal(window.fetch,original);
});
