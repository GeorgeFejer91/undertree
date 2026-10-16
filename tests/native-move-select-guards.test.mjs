import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { windowIds,popupProperties,windowGeometry,assertPopup,assertObservationalDispatch,popupDismissed,directSummaryClick,privateRootTree } from './native-move-select-guards.mjs';

test('private X11 IDs are normalized/deduplicated without retaining window names',()=>{
  assert.deepEqual(windowIds('  0x2a "private fixture"\n    0xF0 (has no name)\n  0x2a "again"\n'),['0x2a','0xf0']);
  assert.throws(()=>windowIds('x'.repeat(65537)));
  assert.throws(()=>windowIds(Array.from({length:129},(_,i)=>'  0x'+(i+1).toString(16)+' child').join('\n')));
});
test('popup property parsing handles absent properties without inventing ownership/type',()=>{
  const text='_NET_WM_PID(CARDINAL) = 42\n_NET_WM_WINDOW_TYPE(ATOM) = _NET_WM_WINDOW_TYPE_COMBO\nWM_TRANSIENT_FOR(WINDOW): window id # 0xA0\n';
  assert.deepEqual(popupProperties(text),{pid:42,type:'_NET_WM_WINDOW_TYPE_COMBO',transient:'0xa0'});
  assert.deepEqual(popupProperties('not found'),{pid:null,type:null,transient:null});
});
test('window geometry uses actual X11 map state and absolute coordinates',()=>{
  assert.deepEqual(windowGeometry('Absolute upper-left X: -10\nAbsolute upper-left Y: 25\nWidth: 300\nHeight: 44\nMap State: IsViewable\n'),{viewable:true,left:-10,top:25,width:300,height:44});
  assert.equal(windowGeometry('Map State: IsUnMapped').viewable,false);
  for(const text of ['','tool error','Map State: Unknown'])assert.throws(()=>windowGeometry(text));
});
test('current root inventory rejects malformed output or a missing known app before absence can prove dismissal',()=>{
  const valid='xwininfo: Window id: 0x1 (root)\n  Root window id: 0x1\n  0xa0 "owned app"\n  0x2 "popup"\n';
  assert.deepEqual(privateRootTree(valid,'160'),['0xa0','0x2']);
  for(const text of ['', 'tool failed', '  0xa0 "app"\n',valid.replace('0xa0','0xa1')])assert.throws(()=>privateRootTree(text,'160'));
});
test('popup evidence rejects ordinary app windows, foreign owners, and merely sent keys',()=>{
  const row={viewable:true,pid:42,type:'_NET_WM_WINDOW_TYPE_POPUP_MENU',left:0,top:50,width:240,height:100};
  assert.doesNotThrow(()=>assertPopup(row,42));
  for(const delta of [{pid:43},{type:'_NET_WM_WINDOW_TYPE_NORMAL'},{type:null},{viewable:false},{width:0},{left:NaN}])assert.throws(()=>assertPopup({...row,...delta},42));
});
test('option navigation allows observations and ephemeral publications only',()=>{
  assertObservationalDispatch([{name:'review_action',action:'project_tree'},{name:'editor_operation',action:'editor_update'},{name:'control_operation',action:'control_poll'}]);
  for(const row of [{name:'prepare_file_move'},{name:'file_move_operation',action:'move_status'},{name:'review_action',action:'save'},{name:'review_action',action:'open'},{name:'review_action',action:'compile'},{name:'review_action',action:'sync'},{name:'editor_operation',action:'editor_commit'},{name:'unknown',action:'read'}])assert.throws(()=>assertObservationalDispatch([row]));
});
test('popup dismissal requires tree absence or successful explicitly unmapped inspection',()=>{
  assert.equal(popupDismissed('0x2',[],()=>{throw Error('must not inspect an absent X11 ID');}),true);
  assert.equal(popupDismissed('0x2',['0x2'],()=>({viewable:false})),true);
  assert.equal(popupDismissed('0x2',['0x2'],()=>({viewable:true})),false);
  assert.equal(popupDismissed('0x2',['0x2'],()=>({})),false);
  assert.throws(()=>popupDismissed('0x2',['0x2'],()=>{throw Error('inspection timeout');}),/inspection timeout/);
});
test('direct summary click sends exactly one genuine WebDriver element click and never auto-opens',async()=>{
  for(const selector of ['#file-move-maintenance > summary','#file-move-request-detail > summary']) {
    const calls=[];await directSummaryClick(async(path,body)=>{calls.push({path,body});return path==='/element'?{'element-6066-11e4-a52e-4f735466cecf':'actual-summary'}:null;},selector);
    assert.deepEqual(calls,[{path:'/element',body:{using:'css selector',value:selector}},{path:'/element/actual-summary/click',body:{}}]);
  }
  await assert.rejects(directSummaryClick(async()=>({}),'.anything'));
});
test('actual bounded inspection function restricts tools/time/output/direct-child kill and preserves errors',async()=>{
  const source=await readFile(new URL('./native-move-select-inspection.mjs',import.meta.url),'utf8');
  const body=source.slice(source.indexOf('export function')).replace('export function','function');
  const calls=[],env={DISPLAY:':owned-private',XDG_CONFIG_HOME:'/owned-private/config'};
  const inspect=vm.runInNewContext('('+body+')',{assert,execFileSync:(...args)=>{calls.push(args);return ' owned output \n';}});
  assert.equal(inspect('/usr/bin/xwininfo',['-id',42],env),'owned output');
  assert.equal(calls.length,1);assert.equal(calls[0][0],'/usr/bin/xwininfo');assert.deepEqual(Array.from(calls[0][1]),['-id','42']);
  const options=calls[0][2];assert.equal(options.env,env);assert.equal(options.timeout,2000);assert.equal(options.maxBuffer,65536);assert.equal(options.killSignal,'SIGKILL');assert.equal(options.encoding,'utf8');assert.deepEqual(Array.from(options.stdio),['ignore','pipe','pipe']);
  assert.throws(()=>inspect('/bin/sh',[],env));assert.equal(calls.length,1);
  const error=Object.assign(Error('direct child timed out'),{code:'ETIMEDOUT',signal:'SIGKILL'});
  const failing=vm.runInNewContext('('+body+')',{assert,execFileSync:()=>{throw error;}});assert.throws(()=>failing('/usr/bin/xprop',[],env),value=>value===error);
});
