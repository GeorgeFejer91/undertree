import assert from 'node:assert/strict';

export function windowIds(tree) {
  assert.ok(Buffer.byteLength(tree)<=65536,'Private X11 tree remains bounded.');
  const ids=[...new Set([...tree.matchAll(/^\s*(0x[0-9a-f]+)\s/gim)].map(match=>match[1].toLowerCase()))];
  assert.ok(ids.length<=128,'Private X11 inventory remains finite.');
  return ids;
}
export function popupProperties(text) {
  assert.ok(Buffer.byteLength(text)<=16384,'Popup properties remain bounded.');
  return {pid:Number(text.match(/_NET_WM_PID\([^)]*\)\s*=\s*(\d+)/)?.[1])||null,
    type:text.match(/_NET_WM_WINDOW_TYPE\([^)]*\)\s*=\s*([^\n]+)/)?.[1].trim()||null,
    transient:text.match(/WM_TRANSIENT_FOR\([^)]*\): window id # (0x[0-9a-f]+)/i)?.[1].toLowerCase()||null};
}
export function windowGeometry(text) {
  assert.ok(Buffer.byteLength(text)<=16384,'Popup geometry remains bounded.');
  const state=text.match(/Map State:\s*(\S+)/)?.[1];
  assert.ok(['IsViewable','IsUnMapped','IsUnviewable'].includes(state),'Actual window inspection has a known X11 map state.');
  const read=name=>Number(text.match(new RegExp(name+':\\s*(-?\\d+)'))?.[1]);
  return {viewable:state==='IsViewable',left:read('Absolute upper-left X'),top:read('Absolute upper-left Y'),width:read('Width'),height:read('Height')};
}
export function assertPopup(row,appPid) {
  assert.equal(row.viewable,true,'An actual native popup X11 window is viewable.');
  assert.ok(row.pid&&row.pid===appPid,'The observed native popup belongs to the existing app process.');
  assert.match(row.type||'',/_NET_WM_WINDOW_TYPE_(?:COMBO|DROPDOWN_MENU|POPUP_MENU)(?:,|$)/,'Actual window properties identify a native selection popup.');
  assert.ok([row.left,row.top,row.width,row.height].every(Number.isFinite)&&row.width>0&&row.height>0,'The popup has actual positive native geometry.');
}
export function assertObservationalDispatch(rows) {
  assert.ok(Array.isArray(rows)&&rows.length<=512);
  const allowed={review_action:new Set(['capabilities','projects','project_tree','review','pdf','connection']),editor_operation:new Set(['editor_poll','editor_update']),control_operation:new Set(['control_poll'])};
  assert.deepEqual(rows.filter(row=>!allowed[row.name]?.has(row.action)),[],'Option navigation and path reach dispatch observations only; no native Move/Save/Open/compile/sync/grant producers.');
}
export function popupDismissed(id,currentIds,inspect) {
  if(!currentIds.includes(id))return true;
  return inspect(id).viewable===false;
}
export async function directSummaryClick(command,selector) {
  assert.ok(['#file-move-maintenance > summary','#file-move-request-detail > summary'].includes(selector));
  const element=await command('/element',{using:'css selector',value:selector});
  const id=element['element-6066-11e4-a52e-4f735466cecf'];assert.equal(typeof id,'string');assert.ok(id.length);
  return command('/element/'+id+'/click',{});
}
export function privateRootTree(text,nativeWindow) {
  assert.match(text,/^\s*xwininfo: Window id:\s*0x[0-9a-f]+/im,'The current inventory is a successful xwininfo tree.');
  assert.match(text,/^\s*Root window id:\s*0x[0-9a-f]+/im,'The current inventory identifies its root.');
  const ids=windowIds(text),app='0x'+BigInt(nativeWindow).toString(16);
  assert.ok(ids.includes(app),'The known existing native app remains present in the private root inventory.');
  return ids;
}
