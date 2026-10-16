import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import {readNativeFindClickTargetGeometry} from './native-find-geometry.mjs';

const read=name=>readFileSync(new URL(name,import.meta.url),'utf8');
const source=read('native-find-contract.mjs');
const start=source.indexOf('async function clickNativeFindSource('),end=source.indexOf('\nasync function qualifyFindGeometry(',start);
assert.ok(start>=0&&end>start,'Exact wrapper delimiters must exist.');
const wrapper=source.slice(start,end);
const rect=(left,top,width,height)=>({left,top,right:left+width,bottom:top+height,width,height});

function fixture({targetBox=rect(10,273,290,274),viewport={offsetLeft:0,offsetTop:0,width:320,height:480},lineCount=7,parentCount=2,rectCount=1}={}) {
  const calls={queries:[],hits:[],mutations:0,lineNextReads:0};
  const nodes=[];
  const node=(className,box,tag='DIV')=>{
    const result={tagName:tag,hidden:false,inert:false,isConnected:true,parentElement:null,firstElementChild:null,nextElementSibling:null,
      clientWidth:box.width,clientHeight:box.height,clientLeft:0,clientTop:0,scrollWidth:box.width,scrollHeight:box.height,scrollLeft:0,scrollTop:0,
      getBoundingClientRect:()=>box,getClientRects:()=>[box],getAttribute:name=>name==='class'?className:name==='role'?'textbox':null,
      classList:{contains:value=>className.split(' ').includes(value)},contains:other=>other===result,
      style:{display:'block',visibility:'visible',pointerEvents:'auto',overflowX:'visible',overflowY:'visible'}};
    for(const name of ['textContent','value','innerHTML'])Object.defineProperty(result,name,{get(){throw Error('No content/value reads allowed.');}});
    for(const name of ['focus','scrollIntoView','click','setAttribute'])result[name]=()=>{calls.mutations++;throw Error('No DOM producer allowed.');};
    nodes.push(result);return result;
  };
  const content=node('cm-content',targetBox),scroller=node('cm-scroller',rect(2,273,315,42)),panel=node('cm-search',rect(2,316.171875,315,103.453125));
  scroller.scrollHeight=274;scroller.style.overflowY='auto';
  const lines=Array.from({length:lineCount},(_,index)=>node('cm-line',rect(10,273+index*38.4,290,38.4)));
  for(let index=0;index<lines.length;index++)Object.defineProperty(lines[index],'nextElementSibling',{get(){calls.lineNextReads++;return lines[index+1]||null;}});
  content.firstElementChild=lines[0]||null;content.contains=other=>other===content||lines.includes(other);
  const parents=Array.from({length:parentCount},(_,index)=>index===0?scroller:node('parent-'+index,rect(2,273,315,147)));
  for(let index=0;index<parents.length;index++)parents[index].parentElement=parents[index+1]||null;
  content.parentElement=parents[0]||null;content.getClientRects=()=>Array.from({length:rectCount},()=>targetBox);
  const document={activeElement:{},hasFocus:()=>true,querySelector:selector=>{calls.queries.push(selector);assert.ok(['.cm-content','.cm-scroller'].includes(selector));return selector==='.cm-content'?content:scroller;},elementFromPoint:(x,y)=>{calls.hits.push({x,y});return y>=273&&y<=315?lines[0]||content:panel;}};
  const context=vm.createContext({document,visualViewport:viewport,innerWidth:320,innerHeight:480,getComputedStyle:node=>node.style});
  const run=()=>vm.runInContext('('+readNativeFindClickTargetGeometry.toString()+')()',context);
  return {run,calls,content,scroller,panel,lines,nodes,context,document};
}

test('Actual reader records tall clipped IVCP outside target and a genuine visible source point',()=>{
  const f=fixture(),value=f.run();
  assert.equal(value.ivcp.y,376.5);assert.equal(value.ivcpHit.targetContains,false);
  assert.equal(value.ivcpHit.class.value,'cm-search');
  assert.equal(value.lineViewportPoint.y,292.2);assert.equal(value.lineViewportHit.targetContains,true);
  assert.equal(value.scroller.clientHeight,42);assert.equal(value.scroller.scrollHeight,274);
  assert.equal(f.calls.mutations,0);assert.deepEqual(f.calls.queries,['.cm-content','.cm-scroller']);assert.equal(f.calls.hits.length,2);
});
test('Actual reader preserves an already contained short content hit without mutation',()=>{
  const f=fixture({targetBox:rect(10,273,290,38.4)}),value=f.run();
  assert.equal(value.ivcpHit.targetContains,true);assert.equal(value.ivcp.y,292.2);assert.equal(f.calls.mutations,0);
});
test('Missing or nonfinite viewport refuses derived points and hit tests',()=>{
  for(const viewport of [{offsetLeft:0,offsetTop:0,width:0,height:480},{offsetLeft:0,offsetTop:0,width:NaN,height:480}]){
    const f=fixture({viewport}),value=f.run();assert.equal(value.viewportValid,false);assert.equal(value.ivcp,null);assert.equal(value.lineViewportPoint,null);assert.equal(f.calls.hits.length,0);
  }
});
test('Nonfinite target rect and entirely outside target refuse IVCP without clamping',()=>{
  for(const targetBox of [rect(10,NaN,290,274),rect(10,-800,290,274)]){
    const f=fixture({targetBox}),value=f.run();assert.equal(value.ivcp,null);assert.equal(value.ivcpHit,null);
  }
});
test('Finite operands whose derived center overflows refuse a nonfinite hit point',()=>{
  const f=fixture({targetBox:rect(1e308,273,1e307,274),viewport:{offsetLeft:1e308,offsetTop:0,width:1e307,height:480}}),value=f.run();
  assert.equal(value.viewportValid,true);assert.equal(value.ivcp,null);assert.equal(f.calls.hits.length,0);
});
test('Actual visual viewport offset and size bound the sampled IVCP',()=>{
  const f=fixture({viewport:{offsetLeft:20,offsetTop:280,width:100,height:30}}),value=f.run();
  assert.equal(value.ivcp.x,70);assert.equal(value.ivcp.y,295);assert.equal(value.layoutViewport.width,320);
});
test('Absent target is explicit and does not scan alternative source elements',()=>{
  const f=fixture();f.document.querySelector=selector=>selector==='.cm-content'?null:f.scroller;
  const value=f.run();assert.equal(value.target,null);assert.equal(value.clientRectCount,0);assert.equal(value.ivcp,null);assert.equal(value.lines.length,0);assert.equal(value.ancestors.length,0);assert.equal(f.calls.hits.length,0);
});
test('Client rects, direct line-node visits and ancestor visits have explicit finite caps',()=>{
  const f=fixture({lineCount:80,parentCount:80,rectCount:40}),value=f.run();
  assert.equal(value.clientRects.length,4);assert.equal(value.clientRectCount,40);assert.equal(value.clientRectsTruncated,true);
  assert.equal(value.lineNodesInspected,8);assert.equal(value.lines.length,8);assert.equal(value.lineNodesTruncated,true);assert.equal(f.calls.lineNextReads,8);
  assert.equal(value.ancestors.length,8);assert.equal(value.ancestorsTruncated,true);assert.equal(f.calls.hits.length,2);
});
test('Unexpected nonline direct nodes consume the same finite visit allowance',()=>{
  const f=fixture({lineCount:80});for(const line of f.lines)line.classList.contains=()=>false;
  const value=f.run();assert.equal(value.lineNodesInspected,8);assert.equal(value.lines.length,0);assert.equal(value.lineViewportPoint,null);assert.equal(f.calls.lineNextReads,8);
});
test('Structural labels are bounded with explicit truncation and no content/value reads',()=>{
  const f=fixture();f.content.getAttribute=()=> 'x'.repeat(10000);
  const value=f.run();assert.equal(value.target.class.value.length,160);assert.equal(value.target.class.truncated,true);assert.equal(value.target.role.value.length,160);
  assert.equal(f.calls.mutations,0);
});
test('Maximum sampled structural labels fit the declared64KiB metadata envelope',()=>{
  const f=fixture({lineCount:80,parentCount:80,rectCount:40});
  for(const node of f.nodes){
    node.tagName='x'.repeat(10000);node.getAttribute=()=> 'y'.repeat(10000);
    for(const name of ['display','visibility','pointerEvents','overflowX','overflowY'])node.style[name]='z'.repeat(10000);
  }
  const value=f.run();assert.ok(Buffer.byteLength(JSON.stringify(value))<=65536);assert.equal(f.calls.mutations,0);
});
test('Absent hit or blurred document is recorded without invented focus or target membership',()=>{
  const f=fixture();f.document.elementFromPoint=()=>null;f.document.hasFocus=()=>false;
  const value=f.run();assert.equal(value.ivcpHit.tag,null);assert.equal(value.ivcpHit.targetContains,false);assert.equal(value.documentFocused,false);assert.equal(value.targetFocused,false);
});

function actualWrapper() {
  const context=vm.createContext({readNativeFindClickTargetGeometry});
  return vm.runInContext(wrapper+';clickNativeFindSource;',context);
}
test('Actual wrapper retains one original click and adds zero requests/actions on success',async()=>{
  const calls=[],report={};await actualWrapper()({click:async selector=>calls.push(['click',selector]),execute:async()=>{throw Error('unexpected execute');},screenshot:async()=>{throw Error('unexpected screenshot');}},report);
  assert.deepEqual(calls,[['click','.cm-content']]);assert.deepEqual(report,{});
});
test('Actual wrapper records after-state then early screenshot and rethrows ORIGINAL object',async()=>{
  const calls=[],report={},original=Error('original native refusal'),after={ivcp:{x:10,y:20}};
  const promise=actualWrapper()({click:async selector=>{calls.push(['click',selector]);throw original;},execute:async script=>{calls.push(['execute']);assert.ok(script.startsWith('return (function readNativeFindClickTargetGeometry()'));return after;},screenshot:async name=>calls.push(['screenshot',name])},report);
  await assert.rejects(promise,error=>error===original);
  assert.deepEqual(calls,[['click','.cm-content'],['execute'],['screenshot','native-find-click-failure.png']]);assert.equal(report.clickFailure,after);
});
test('Observation/screenshot failures never replace original error or retry the click',async()=>{
  const original=Error('original'),report={};let clicks=0,reads=0,screenshots=0;
  const observer=Object.assign(Error('body/value must not be recorded'),{name:'x'.repeat(1000)});
  await assert.rejects(actualWrapper()({click:async()=>{clicks++;throw original;},execute:async()=>{reads++;throw observer;},screenshot:async()=>{screenshots++;throw observer;}},report),error=>error===original);
  assert.equal(clicks,1);assert.equal(reads,1);assert.equal(screenshots,1);assert.equal(report.clickFailure.unavailable,true);assert.equal(report.clickFailure.errorName.length,80);assert.equal(report.clickFailureScreenshot.errorName.length,80);assert.equal(JSON.stringify(report).includes(observer.message),false);
});
test('Full contract reverses exact dcd after only four declared diagnostic edits',()=>{
  const edits=[
    ["import { readNativeFindGeometry } from './native-find-geometry.mjs';","import { readNativeFindGeometry,readNativeFindClickTargetGeometry } from './native-find-geometry.mjs';"],
    ['async function qualifyFindGeometry(context,h,report) {',wrapper+'\nasync function qualifyFindGeometry(context,h,report) {'],
    ["const value=await execute('return ('+readNativeFindGeometry.toString()+')();');","const value=await execute('return ('+readNativeFindGeometry.toString()+')('+readNativeFindClickTargetGeometry.toString()+');');"],
    ["await click('.cm-content');assert.equal((await h.snapshot()).editorFocused,true);","await clickNativeFindSource(context,report);assert.equal((await h.snapshot()).editorFocused,true);"]
  ];
  let value=source;
  for(const [before,after] of [...edits].reverse()){assert.equal(value.split(after).length,2);value=value.replace(after,before);}
  assert.equal(createHash('sha256').update(value).digest('hex'),'14987c0135d00f60f97a1f4171cb1775d9870e448b015ceac67cc4b3aaea932a');
  for(const [before,after] of edits){assert.equal(value.split(before).length,2);value=value.replace(before,after);}
  assert.equal(value,source);
});
test('All original geometry reader bytes restore by removing only additive target metadata',()=>{
  const current=read('native-find-geometry.mjs'),marker='\n// Fixed structural samples only.';
  assert.equal(current.split(marker).length,2);
  const before=current.slice(0,current.indexOf(marker)).replace('readNativeFindGeometry(readClickTargetGeometry)','readNativeFindGeometry()').replace(',clickTarget:readClickTargetGeometry()','');
  assert.equal(createHash('sha256').update(before).digest('hex'),'5c47ab9942b5f55ec2598a671f27c269ae1443e7d8d886d8b88a406d858079cb');
});
