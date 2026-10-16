import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const source=await readFile(new URL('./review-ui-smoke.mjs',import.meta.url),'utf8');
const helper=source.slice(source.indexOf('async function observeSource('),source.indexOf('async function saveExactSource('));
assert.ok(helper.startsWith('async function observeSource('));
function model(reply, timeout) {
  let clock=0;
  const calls=[],delays=[];
  const signalFactory={timeout:milliseconds=>{
    assert.equal(milliseconds,15000);
    return timeout?.() || new AbortController().signal;
  }};
  const observe=new Function('assert','fetch','base','token','performance','AbortSignal','setTimeout',`${helper};return observeSource;`)(
    assert,async(url,options)=>{
      calls.push({url,...options,operation:JSON.parse(options.body)});
      return reply(calls.length,options.signal,value=>{clock=value;});
    },'http://fixture','fixture-token',{now:()=>clock},signalFactory,(callback,milliseconds)=>{
      delays.push(milliseconds);clock+=milliseconds;queueMicrotask(callback);
    });
  return {observe,calls,delays};
}
const envelope=(value,status=value.ok?200:400)=>({status,json:async()=>value});
const busy=()=>envelope({ok:false,error:{code:'busy',message:'A local document operation is running. Retry this action.'}});
const saved={content:'exact\r\n😀',review:{revision:'fixture-revision'}};

test('post-Save inspection observes typed busy then the exact source without replaying Save',async()=>{
  const m=model(attempt=>attempt<3?busy():envelope({ok:true,result:saved}));
  assert.equal(await m.observe('project-id','chapters/part.typ'),saved);
  assert.equal(m.calls.length,3);assert.deepEqual(m.delays,[50,50]);
  for(const call of m.calls) {
    assert.deepEqual(call.operation,{action:'open',project:'project-id',path:'chapters/part.typ'});
    assert.equal(call.url,'http://fixture/api/review');assert.equal(call.method,'POST');
    assert.equal(call.headers.Authorization,'Bearer fixture-token');
    assert.equal(call.signal,m.calls[0].signal,'one signal bounds the whole observation');
  }
});
test('a successful first observation adds no wait',async()=>{
  const m=model(()=>envelope({ok:true,result:saved}));
  assert.equal(await m.observe('p','main.typ'),saved);assert.equal(m.calls.length,1);assert.deepEqual(m.delays,[]);
});
for(const [label,reply] of [
  ['non-busy refusal',()=>envelope({ok:false,error:{code:'stale_session',message:'stale identity'}})],
  ['later saved-History busy',()=>envelope({ok:false,error:{code:'busy',message:'An original saved-History operation is unresolved. Inspect that operation before changing this source.'}})],
  ['other or unknown busy',()=>envelope({ok:false,error:{code:'busy',message:'Another operation is busy.'}})],
  ['authentication failure',()=>envelope({ok:false,error:{code:'busy',message:'unauthorized'}},401)],
  ['malformed envelope',()=>envelope({error:{code:'busy'}})],
  ['invalid JSON',()=>({status:400,json:async()=>{throw new SyntaxError('invalid JSON');}})],
  ['network failure',()=>{throw new Error('network failed');}],
]) test(`${label} is terminal without a second observation`,async()=>{
  const m=model(reply);await assert.rejects(m.observe('p','main.typ'));assert.equal(m.calls.length,1);assert.deepEqual(m.delays,[]);
});
test('continuous busy exhausts one absolute 15s budget',async()=>{
  const m=model(busy);await assert.rejects(m.observe('p','main.typ'),/source observation remained busy for 15s/);
  assert.equal(m.calls.length,300);assert.equal(m.delays.reduce((sum,delay)=>sum+delay,0),15000);
});
test('a late successful body cannot satisfy an expired observation',async()=>{
  const m=model((attempt,signal,setClock)=>({status:200,json:async()=>{setClock(15001);return {ok:true,result:saved};}}));
  await assert.rejects(m.observe('p','main.typ'),/source observation exceeded its 15s deadline/);assert.equal(m.calls.length,1);
});
test('the same abort signal covers a held response body',async()=>{
  const controller=new AbortController();
  const m=model((attempt,signal)=>({status:200,json:()=>new Promise((resolve,reject)=>{
    signal.addEventListener('abort',()=>reject(signal.reason),{once:true});
    queueMicrotask(()=>controller.abort(new Error('observation deadline')));
  })}),()=>controller.signal);
  await assert.rejects(m.observe('p','main.typ'),/observation deadline/);assert.equal(m.calls.length,1);assert.deepEqual(m.delays,[]);
});
test('Save remains a single action followed by the exact content and receipt assertions',()=>{
  const body=source.slice(source.indexOf('async function saveExactSource('),source.indexOf('let browser, failurePage'));
  assert.equal(body.split("await menuAction(page,'file','Save')").length-1,1);
  assert.ok(body.includes('const saved=await observeSource(project,path)'));
  assert.ok(body.includes('assert.equal(saved.content,expected'));
  assert.ok(body.includes('assert.equal(receipt.result.content,expected'));
  assert.ok(body.includes('assert.equal(receipt.result.review.revision,saved.review.revision'));
  assert.ok(body.includes("finally { page.off('response',observe); }"));
});

test('fixed Open observation has only its three known callers and preserves Reanchor/navigation/external mutation boundaries',()=>{
  assert.ok(helper.startsWith('async function observeSource(project, path)'));
  assert.equal((source.match(/\bobserveSource\(/g)||[]).length,4,'one declaration and exactly three direct callers');
  assert.deepEqual([...source.matchAll(/await observeSource\(([^)]*)\)/g)].map(match=>match[1]),['project,path',"project.id,'main.html'","project.id,'main.typ'"]);
  assert.ok(source.includes("  await page.getByRole('button',{name:'Reanchor highlight',exact:true}).click();\n  await page.locator('#reanchor-dialog').waitFor({state:'hidden'});\n  await page.evaluate(()=>{document.documentElement.style.fontSize='';});await page.setViewportSize({width:1600,height:1000});\n  const anchored=await observeSource(project.id,'main.html');\n  const markerAfter=anchored.review.markers[0];\n  assert.equal(markerAfter.id,markerBefore.id); assert.equal(markerAfter.rule,markerBefore.rule); assert.equal(markerAfter.prompt,markerBefore.prompt);\n  assert.equal(markerAfter.anchor.quote,'Hi'); assert.equal(markerAfter.anchor.stale,false);\n  assert.equal(await readFile(join(projectRoot,'main.html'),'utf8'),original.replace('Hello','Hi'),'reanchor only changes metadata');"),'one actual Reanchor and all exact marker/content assertions remain');
  assert.ok(source.includes(`  await page.getByRole('button',{name:'main.typ',exact:true}).click();await waitForSource(page,'main.typ');
  const mainBeforeExternalChange=await page.locator('.cm-content').textContent();
  const checkpoint=await observeSource(project.id,'main.typ');
  await call({action:'save',project:project.id,path:'main.typ',revision:checkpoint.review.revision,content:'#unknown-function()'});
  const invalid=await call({action:'open',project:project.id,path:'main.typ'});
  await call({action:'compile',project:project.id,path:'main.typ',revision:invalid.review.revision},true);`),'real navigation/capture stays before the one observation; the later Save/Open/Compile remain exact and singular');
});
