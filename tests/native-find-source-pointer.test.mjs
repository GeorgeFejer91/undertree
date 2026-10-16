import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import test from 'node:test';
import vm from 'node:vm';

const source=readFileSync(new URL('native-find-contract.mjs',import.meta.url),'utf8');
const a=source.indexOf('function readNativeFindSourcePointer('),b=source.indexOf('\nasync function qualifyFindGeometry(',a);
assert.ok(a>=0&&b>a);
const helper=source.slice(a,b);
const box=(left,top,right,bottom)=>({left,top,right,bottom});
function fixture() {
  const node={connected:true,hidden:false,inert:false,display:{value:'block'},visibility:{value:'visible'},pointerEvents:{value:'auto'},box:box(98,273,317,547)};
  const geometry={documentFocused:true,viewportValid:true,target:node,scroller:{...node,box:box(2,273,317,315.171875)},
    viewport:box(0,0,320,480),layoutViewport:{width:320,height:480},scrollerClientViewport:box(2,273,317,315),
    lineViewportPoint:{x:207.5,y:296},lines:[{...node,box:box(98,277,317,353)}]};
  const hits=[],target={isConnected:true,contains:hit=>hit===target},document={querySelector:selector=>{assert.equal(selector,'.cm-content');return target;},elementFromPoint:(x,y)=>{hits.push({x,y});return target;}};
  const context=vm.createContext({document});
  const run=()=>vm.runInContext(helper+';readNativeFindSourcePointer;',context)(()=>geometry);
  return {geometry,hits,target,document,run};
}
test('Actual helper rounds once to the interior integer source point and tests that exact hit',()=>{
  const f=fixture(),v=f.run();assert.deepEqual(JSON.parse(JSON.stringify(v)),{x:207,y:296,documentFocused:true,integerHitInsideSource:true,viewport:f.geometry.viewport,clip:f.geometry.scrollerClientViewport});
  assert.deepEqual(f.hits,[{x:207,y:296}]);
});
test('Floating source hit cannot authorize a different integer hit covered by a label',()=>{
  const f=fixture();f.geometry.lineViewportHit={targetContains:true};f.document.elementFromPoint=()=>({});
  assert.throws(f.run,/covered or detached/);
});
test('Blurred document, detached, hidden, inert and disabled pointer target all refuse',()=>{
  for(const change of [g=>g.documentFocused=false,g=>g.target.connected=false,g=>g.target.hidden=true,g=>g.target.inert=true,g=>g.target.display.value='none',g=>g.target.visibility.value='hidden',g=>g.target.pointerEvents.value='none',g=>g.scroller.connected=false]){
    const f=fixture();change(f.geometry);assert.throws(f.run,/No focused visible/);assert.deepEqual(f.hits,[]);
  }
});
test('Missing, nonfinite, overflowing or unsafe action coordinates refuse without clamping',()=>{
  for(const point of [null,{x:NaN,y:296},{x:207,y:Infinity},{x:1e30,y:296}]){
    const f=fixture();f.geometry.lineViewportPoint=point;assert.throws(f.run);assert.deepEqual(f.hits,[]);
  }
});
test('The actual integer action must be strictly within visual and layout viewport, clip, target and line',()=>{
  for(const change of [g=>g.viewport.left=207,g=>g.layoutViewport.width=207,g=>g.scrollerClientViewport.bottom=296,g=>g.target.box.right=207,g=>g.lines[0].box.top=296,g=>g.scrollerClientViewport.right=Infinity,g=>g.viewportValid=false]){
    const f=fixture();change(f.geometry);assert.throws(f.run);assert.deepEqual(f.hits,[]);
  }
});
test('Fractional area with no admitted rounded interior point refuses instead of adjusting it',()=>{
  const f=fixture();f.geometry.lineViewportPoint={x:207.5,y:296};f.geometry.scrollerClientViewport.left=207.25;
  assert.throws(f.run,/outside/);assert.deepEqual(f.hits,[]);
});
test('No line or overlimit line inventory refuses',()=>{
  for(const lines of [[],Array.from({length:9},()=>fixture().geometry.lines[0])]){
    const f=fixture();f.geometry.lines=lines;assert.throws(f.run,/outside/);assert.deepEqual(f.hits,[]);
  }
});
test('Actual target relookup must still be connected and contain the hit',()=>{
  for(const disconnected of [true,false]){
    const f=fixture();if(disconnected)f.target.isConnected=false;else f.document.elementFromPoint=()=>null;
    assert.throws(f.run,/covered or detached/);
  }
});
test('Only declared target lookup and hit inspection occur; no focus, scroll or source reads',()=>{
  const f=fixture();for(const name of ['focus','scrollIntoView','click','dispatchEvent'])f.target[name]=()=>{throw Error('DOM producer forbidden');};
  for(const name of ['textContent','value','innerHTML'])Object.defineProperty(f.target,name,{get(){throw Error('source/value read forbidden');}});
  assert.equal(f.run().integerHitInsideSource,true);assert.equal(f.hits.length,1);
});
test('Whole candidate restores exact924 contract using only the declared wrapper replacement',()=>{
  const before=String.raw`async function clickNativeFindSource(context,report) {
  try {await context.click('.cm-content');}
  catch(error) {
    // One structural after-state and one early screenshot retain the ORIGINAL
    // failed viewport before the existing finally restores font/window size.
    try {report.clickFailure=await context.execute('return ('+readNativeFindClickTargetGeometry.toString()+')();');}
    catch(observationError){report.clickFailure={unavailable:true,errorName:String(observationError?.name||'Error').slice(0,80)};}
    try {await context.screenshot?.('native-find-click-failure.png');}
    catch(screenshotError){report.clickFailureScreenshot={unavailable:true,errorName:String(screenshotError?.name||'Error').slice(0,80)};}
    throw error;
  }
}
`;
  const start=source.indexOf('async function clickNativeFindSource('),end=source.indexOf('\nasync function qualifyFindGeometry(',start);
  assert.ok(start>=0&&end>start);const reversed=source.slice(0,start)+before+source.slice(end);
  assert.equal(createHash('sha256').update(reversed).digest('hex'),'1f1b727062165f0460cabf9158918308f604de6720ea33c47485350552190457');
  assert.equal((source.match(/await clickNativeFindSource\(context,report\);assert.equal\(\(await h.snapshot\(\)\).editorFocused,true\);/g)||[]).length,1);
  assert.equal((source.match(/context.command\('\/actions'/g)||[]).length,1);
});
