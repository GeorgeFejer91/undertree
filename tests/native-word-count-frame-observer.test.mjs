import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import test from 'node:test';
import vm from 'node:vm';
import {observeNativeCountFrames} from './native-word-count-frame-observer.mjs';

function fixture({hidden=false,focused=true,visibility='visible',metadataThrows=false,nonfinite=false}={}) {
  const frames=[],timers=[],cleared=[],requests=[];let clock=0;
  const document={get hidden(){if(metadataThrows)throw Object.assign(Error('private value must not appear'),{name:'x'.repeat(1000)});return hidden;},visibilityState:visibility,hasFocus:()=>focused};
  for(const name of ['querySelector','createRange','getBoundingClientRect','elementFromPoint','focus','scrollIntoView','dispatchEvent'])document[name]=()=>{throw Error('No DOM/geometry/producer access');};
  const context=vm.createContext({document,performance:{now:()=>nonfinite?Infinity:clock++},setTimeout:(callback,ms)=>{timers.push({callback,ms});requests.push('timer');return 7;},clearTimeout:id=>cleared.push(id),requestAnimationFrame:callback=>{frames.push(callback);requests.push('frame');}});
  const promise=vm.runInContext('('+observeNativeCountFrames.toString()+')()',context);
  return {promise,frames,timers,cleared,requests,frame:timestamp=>{const callback=frames.shift();assert.ok(callback);callback(timestamp);}};
}
const plain=value=>JSON.parse(JSON.stringify(value));
test('Actual observer retains exactly two sequential frames and the original one500ms timer',async()=>{
  const f=fixture();assert.deepEqual(f.requests,['timer','frame']);assert.equal(f.timers.length,1);assert.equal(f.timers[0].ms,500);
  f.frame(20);assert.equal(f.frames.length,1);f.frame(40);const v=plain(await f.promise);
  assert.deepEqual(v.ack,{completedFrames:2,timedOut:false,requestedFrames:2,capMs:500});assert.deepEqual(f.cleared,[7]);
  assert.deepEqual(v.observation.rows.map(row=>row.phase),['armed','first-frame','second-frame','resolved']);
  assert.equal(v.observation.dropped,0);assert.equal(v.observation.rows.length,4);
  assert.deepEqual(v.observation.rows.map(row=>row.atMs),[0,1,2,3]);assert.equal(v.observation.rows[1].frameTimestampMs,20);
});
test('The actual one-frame timeout remains a failing original ACK; no new frames or retry',async()=>{
  const f=fixture();f.frame(20);f.timers[0].callback();const v=plain(await f.promise);
  assert.deepEqual(v.ack,{completedFrames:1,timedOut:true,requestedFrames:2,capMs:500});assert.deepEqual(v.observation.rows.map(row=>row.phase),['armed','first-frame','timeout','resolved']);
  assert.equal(f.requests.filter(name=>name==='frame').length,2);f.frame(1000);assert.equal(v.ack.completedFrames,1);assert.equal(f.frames.length,0);
});
test('Missing first frame times out with zero completedFrames and no invented callback',async()=>{
  const f=fixture();f.timers[0].callback();const v=plain(await f.promise);assert.equal(v.ack.completedFrames,0);assert.equal(v.ack.timedOut,true);assert.equal(f.requests.filter(name=>name==='frame').length,1);
});
test('Hidden or blurred state is recorded without changing frame success or producing focus',async()=>{
  const f=fixture({hidden:true,focused:false,visibility:'hidden'});f.frame(20);f.frame(40);const v=plain(await f.promise);
  assert.equal(v.ack.timedOut,false);assert.ok(v.observation.rows.every(row=>row.documentHidden&&row.visibility==='hidden'&&!row.documentFocused));
});
test('Metadata getter failure is bounded and cannot replace the original ACK',async()=>{
  const f=fixture({metadataThrows:true});f.frame(20);f.frame(40);const v=plain(await f.promise);
  assert.equal(v.ack.completedFrames,2);assert.ok(v.observation.rows.every(row=>row.unavailable&&row.errorName.length===80));assert.equal(JSON.stringify(v).includes('private value'),false);
});
test('Nonfinite clock observations and unknown visibility are explicit; no timeout weakening',async()=>{
  const f=fixture({nonfinite:true,visibility:'not-a-known-state'});f.timers[0].callback();const v=plain(await f.promise);
  assert.equal(v.ack.timedOut,true);assert.ok(v.observation.rows.every(row=>row.atMs===null&&row.visibility==='unknown'));
});
test('Late timeout/frame callbacks cannot add rows after original completion',async()=>{
  const f=fixture();f.frame(20);f.frame(40);const value=await f.promise;const before=JSON.stringify(value);f.timers[0].callback();assert.equal(JSON.stringify(value),before);assert.equal(value.observation.dropped,0);
});
test('The bounded observer returns only fixed timing/boolean categories and small metadata',async()=>{
  const f=fixture();f.frame(20);f.frame(40);const value=plain(await f.promise);assert.ok(Buffer.byteLength(JSON.stringify(value))<2048);
  for(const row of value.observation.rows)assert.deepEqual(Object.keys(row).sort(),['phase','atMs','frameTimestampMs','documentHidden','visibility','documentFocused'].sort());
});
test('Original WC source restores exactly after only import and observation-wrapper delta',()=>{
  const source=readFileSync(new URL('native-word-count-smoke.mjs',import.meta.url),'utf8');
  const after="    const frameObservation = await execute('return ('+observeNativeCountFrames.toString()+')();');\n    const frameAck = frameObservation.ack;\n    (evidence.layoutFrameObservations ||= []).push({width,height,text,...frameObservation.observation});";
  const before="    const frameAck = await execute('return new Promise(resolve=>{let completedFrames=0,done=false;const finish=timedOut=>{if(done)return;done=true;clearTimeout(timer);resolve({completedFrames,timedOut,requestedFrames:2,capMs:500});};const timer=setTimeout(()=>finish(true),500);requestAnimationFrame(()=>{if(done)return;completedFrames++;requestAnimationFrame(()=>{if(done)return;completedFrames++;finish(false);});});});');";
  assert.equal(source.split(after).length,2);const reversed=source.replace(after,before).replace("\nimport { observeNativeCountFrames } from './native-word-count-frame-observer.mjs';",'');
  assert.equal(createHash('sha256').update(reversed).digest('hex'),'8dd3372246c6bdf27b67e4665564deacc10a7708f20d7424152fff852e10423d');
  assert.ok(source.includes("assert.deepEqual(frameAck,{completedFrames:2,timedOut:false,requestedFrames:2,capMs:500},'Native count resize/font setup needs two animation frames before measuring.');"));
});
