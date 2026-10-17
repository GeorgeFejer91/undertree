import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';

const source=await readFile(new URL('./review-ui-smoke.mjs',import.meta.url),'utf8');
const start=source.indexOf('async function saveExactSource('),end=source.indexOf('async function waitForEditorRevision(',start);
assert.ok(start>=0&&end>start);
const code=source.slice(start,end)+'\nsaveExactSource;';
const busy={code:'busy',message:'A local document operation is running. Retry this action.'};

function fixture(terminalError=null) {
  const listeners=new Map(),window={},event={type:'click'},operation={action:'save',project:'project',path:'main.typ',content:'Exact draft',revision:'before',sourceEpoch:3,expectedRoot:{dev:'1',ino:'2'}};
  const saved={content:operation.content,review:{revision:'after'}};
  let label='Unsaved changes',clicks=0,inProgress=0,overlappingClicks=0,intermediateBusy=0;
  const response=body=>({url:()=>'/api/review',request:()=>({method:()=>'POST',postDataJSON:()=>operation}),json:async()=>body});
  const emit=body=>listeners.get('response')?.(response(body));
  const button={onclick:function(received){
    assert.equal(this,button);assert.equal(received,event);clicks++;
    if(inProgress)overlappingClicks++;
    inProgress++;intermediateBusy++;emit({ok:false,error:terminalError||busy});
    return new Promise(resolve=>setTimeout(()=>{
      if(!terminalError){label='Saved locally';emit({ok:true,result:saved});}
      inProgress--;resolve();
    },15));
  }};
  const original=button.onclick;
  const document={getElementById:id=>id==='manuscript-save'?button:{get textContent(){return label;}},querySelector:()=>({textContent:operation.path})};
  const page={
    on:(name,listener)=>listeners.set(name,listener),off:name=>listeners.delete(name),
    evaluate:async(fn,arg)=>fn(arg),
    locator:selector=>({textContent:async()=>selector==='.cm-content'?operation.content:label}),
    waitForFunction:async(fn,arg)=>assert.equal(fn(arg),true),
    waitForTimeout:async()=>new Promise(resolve=>setImmediate(resolve)),
  };
  const save=runInNewContext(code,{assert,window,document,menuAction:async()=>{button.onclick.call(button,event);},call:async()=>saved});
  return {save,page,window,button,original,stats:()=>({clicks,overlappingClicks,intermediateBusy,inProgress})};
}

test('real Save fixture awaits one actual command through its intermediate native refusal',async()=>{
  const f=fixture();
  await f.save(f.page,'project','main.typ','Exact draft');
  assert.deepEqual(f.stats(),{clicks:1,overlappingClicks:0,intermediateBusy:1,inProgress:0});
  assert.equal(f.button.onclick,f.original);assert.equal(f.window.__fixtureSaveCommand,undefined);
});

test('real Save fixture keeps four explicit command limit and restores its handler',async()=>{
  const f=fixture(busy);
  await assert.rejects(f.save(f.page,'project','main.typ','Exact draft'),/at most four/);
  assert.equal(f.stats().clicks,4);assert.equal(f.stats().overlappingClicks,0);
  assert.equal(f.button.onclick,f.original);assert.equal(f.window.__fixtureSaveCommand,undefined);
});

for(const error of [{code:'outcome_unknown',message:busy.message},{code:'busy',message:'Different operation is busy.'}]) {
  test(`real Save fixture never retries terminal ${error.code}: ${error.message}`,async()=>{
    const f=fixture(error);
    await assert.rejects(f.save(f.page,'project','main.typ','Exact draft'));
    assert.equal(f.stats().clicks,1);assert.equal(f.button.onclick,f.original);
    assert.equal(f.window.__fixtureSaveCommand,undefined);
  });
}
