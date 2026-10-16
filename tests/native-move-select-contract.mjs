// Source preparation only: real keys and passive native-window evidence in the existing disposable app.
import assert from 'node:assert/strict';
import { privateRootTree,popupProperties,windowGeometry,assertPopup,assertObservationalDispatch,popupDismissed,directSummaryClick } from './native-move-select-guards.mjs';

export function readMoveSelect() {
  const dialog=document.getElementById('file-move-dialog'),body=dialog.querySelector('.file-move-body'),select=document.getElementById('file-move-requests'),wrapper=select.parentElement;
  const rect=node=>{const box=node.getBoundingClientRect();return {left:box.left,right:box.right,top:box.top,bottom:box.bottom,width:box.width,height:box.height};};
  const style=getComputedStyle(wrapper),control=getComputedStyle(select);
  const value=id=>{const node=document.getElementById(id),range=document.createRange();range.selectNodeContents(node);return {id,text:node.textContent,box:rect(node),glyph:rect(range),font:parseFloat(getComputedStyle(node).fontSize),fit:node.dataset.textFit,clientWidth:node.clientWidth,scrollWidth:node.scrollWidth};};
  const status=document.getElementById('file-move-status'),slot=status.parentElement,details=slot?.classList.contains('text-details-slot')&&slot.classList.contains('text-details-active');
  const button=details&&slot.children.length===2&&slot.firstElementChild===status&&slot.lastElementChild.matches('.text-details-button')?slot.lastElementChild:null;
  const surface=details?button:status,surfaceStyle=surface?getComputedStyle(surface):null;
  return {viewport:{width:innerWidth,height:innerHeight},documentFocused:document.hasFocus(),activeId:document.activeElement?.id,dialogOpen:dialog.open,modal:dialog.matches(':modal'),dialog:rect(dialog),title:rect(dialog.querySelector('h2')),footer:rect(dialog.querySelector(':scope > .dialog-actions')),body:rect(body),bodyClientWidth:body.clientWidth,bodyScrollWidth:body.scrollWidth,bodyScrollTop:body.scrollTop,bodyScrollHeight:body.scrollHeight,bodyClientHeight:body.clientHeight,dialogClientHeight:dialog.clientHeight,dialogScrollHeight:dialog.scrollHeight,
    rootFont:parseFloat(getComputedStyle(document.documentElement).fontSize),select:rect(select),selected:select.value,index:select.selectedIndex,options:[...select.options].map(option=>({value:option.value,text:option.textContent})),appearance:control.appearance,
    associated:select.labels.length===1&&select.labels[0].control===select,wrapper:rect(wrapper),onlySelect:wrapper.children.length===1&&wrapper.firstElementChild===select,wrapperClass:wrapper.className,focusWithin:wrapper.matches(':focus-within'),outline:{style:style.outlineStyle,width:parseFloat(style.outlineWidth),offset:parseFloat(style.outlineOffset),color:style.outlineColor},contain:style.contain,overflowX:style.overflowX,overflowY:style.overflowY,
    detailOpen:document.getElementById('file-move-request-detail').open,draftHidden:document.getElementById('file-move-draft').hidden,
    from:value('file-move-from'),to:value('file-move-to'),identity:value('file-move-identity'),status:value('file-move-status'),commit:{hidden:document.getElementById('file-move-commit').hidden,disabled:document.getElementById('file-move-commit').disabled},
    statusSurface:{mode:details?'details':'source',sourceId:status.id,sourceRole:status.getAttribute('role'),sourceDisplay:getComputedStyle(status).display,title:status.dataset.textDetails,tag:surface?.tagName,id:surface?.id||'',focused:!!surface&&document.activeElement===surface,connected:!!surface?.isConnected,hidden:surface?.hidden??true,disabled:surface?.disabled??false,display:surfaceStyle?.display,visibility:surfaceStyle?.visibility,box:surface?rect(surface):null,label:surface?.textContent,accessibleName:surface?.getAttribute('aria-label'),hasPopup:surface?.getAttribute('aria-haspopup')}};
}

export function assertMoveStatusFocus(value) {
  const surface=value.statusSurface;
  assert.equal(value.documentFocused,true);
  assert.equal(surface.sourceId,'file-move-status');assert.equal(surface.focused,true,'Production focus follows the actual accessible status surface without synthetic fixture focus.');
  assert.equal(surface.connected,true);assert.equal(surface.hidden,false);assert.equal(surface.disabled,false);
  assert.notEqual(surface.display,'none');assert.equal(surface.visibility,'visible');
  assert.ok(surface.box&&['left','right','top','bottom','width','height'].every(name=>Number.isFinite(surface.box[name]))&&surface.box.width>0&&surface.box.height>0,'The focused status surface has a real positive finite box.');
  assert.ok(surface.box.left>=value.body.left-1&&surface.box.right<=value.body.right+1&&surface.box.top>=value.body.top-1&&surface.box.bottom<=value.body.bottom+1,'The actual focused status surface is exposed inside the Move body.');
  if(surface.mode==='details') {
    assert.equal(value.status.fit,'details');assert.equal(surface.sourceDisplay,'none');assert.equal(surface.tag,'BUTTON');assert.equal(surface.hasPopup,'dialog');
    assert.equal(surface.label,surface.sourceRole==='alert'?'Error details':surface.title);assert.equal(surface.accessibleName,`${surface.label}: ${value.status.text}`);
  } else {
    assert.equal(surface.mode,'source');assert.notEqual(value.status.fit,'details');assert.equal(surface.id,'file-move-status');assert.equal(value.activeId,'file-move-status');
  }
}

function assertShell(value) {
  assert.equal(value.dialogOpen,true);assert.equal(value.modal,true);
  assert.ok(value.dialog.left>=-1&&value.dialog.right<=value.viewport.width+1&&value.dialog.top>=-1&&value.dialog.bottom<=value.viewport.height+1,'The actual dialog remains inside the native viewport.');
  assert.ok(value.body.width>0&&value.body.height>0,'Move body remains positive during real focus/scroll.');
  assert.ok(value.title.bottom<=value.body.top+1&&value.body.bottom<=value.footer.top+1,'Title/body/Close remain in their original rows.');
  assert.ok(value.title.top>=value.dialog.top&&value.footer.bottom<=value.dialog.bottom,'Title and Close remain anchored inside the dialog.');
  assert.ok(value.dialogScrollHeight<=value.dialogClientHeight+1,'Only the intended body scrolls.');
  assert.ok(value.bodyScrollWidth<=value.bodyClientWidth+1,'Real option focus and scrolling introduce no horizontal body overflow.');
}

export async function qualifyNativeMoveSelect({execute,command,click,waitFor,native,nativeWindow,screenshot,inspectNative,evidence,checks}) {
  const read=()=>execute('return ('+readMoveSelect.toString()+')();');
  const key=value=>native('xdotool',['windowactivate','--sync',nativeWindow,'key','--clearmodifiers',value]);
  const record=async label=>{const value=await read();report.geometry.push({label,value});assertShell(value);return value;};
  const tree=()=>privateRootTree(inspectNative('/usr/bin/xwininfo',['-root','-tree']),nativeWindow);
  const properties=id=>popupProperties(inspectNative('/usr/bin/xprop',['-id',id,'_NET_WM_PID','_NET_WM_WINDOW_TYPE','WM_TRANSIENT_FOR']));
  const geometry=id=>windowGeometry(inspectNative('/usr/bin/xwininfo',['-id',id]));
  const report=evidence.nativeMoveSelect={result:'running',geometry:[],popup:{result:'not observed'},fullValueScope:'Actual full text, readable glyph bounds, and physical body reach only; no OS text-selection or clipboard claim.'};
  try {
    const app=properties(String(nativeWindow));assert.ok(app.pid,'The existing native window exposes its app PID.');
    const before=await read(),dispatchStart=await execute('return window.__nativeMoveUiDispatch.length;');
    const identity=before.identity.text,selected=before.selected,option=before.options.find(row=>row.value===selected);
    assertMoveStatusFocus(before);
    assert.equal(before.documentFocused,true);assert.equal(before.options.length,2);assert.match(selected,/^1:[0-9a-f-]{36}$/);
    assert.equal(option?.text,'z-ui-source.typ → moves/z-ui-moved.typ · prepared');assert.equal(option.text.length,49);
    assert.equal(before.detailOpen,false);assert.equal(before.draftHidden,true);
    key('shift+Tab');
    const focused=await waitFor(async()=>{const value=await read();return value.activeId==='file-move-requests'?value:false;},'Real Shift+Tab from production status did not reach the native request SELECT.');
    report.geometry.push({label:'real-shift-tab-focus',value:focused});assertShell(focused);
    assert.equal(focused.documentFocused,true);assert.equal(focused.associated,true);assert.equal(focused.onlySelect,true);assert.equal(focused.wrapperClass,'file-move-request-select');
    assert.equal(focused.focusWithin,true);assert.equal(focused.outline.style,'solid');assert.equal(focused.outline.width,2);assert.equal(focused.outline.offset,-2);assert.notEqual(focused.outline.color,'rgba(0, 0, 0, 0)');
    assert.equal(focused.appearance,'auto');assert.equal(focused.contain,'paint');assert.equal(focused.overflowX,'hidden');assert.equal(focused.overflowY,'hidden');
    assert.ok(focused.wrapper.left>=focused.body.left-1&&focused.wrapper.right<=focused.body.right+1&&focused.wrapper.top>=focused.body.top-1&&focused.wrapper.bottom<=focused.body.bottom+1,'Inset wrapper focus outline is inside the visible body.');
    await screenshot?.('native-move-request-select-focus.png');
    const beforeWindows=tree();report.popup.before=beforeWindows;
    const observePopup=async label=>{
      const popup=await waitFor(()=>{
        const after=tree(),added=after.filter(id=>!beforeWindows.includes(id));report.popup.latest={label,after,added};
        assert.ok(added.length<=8,'Finite request popup navigation adds at most eight private-display windows.');
        for(const id of added) {
          let value;
          try {value={id,...properties(id),...geometry(id)};}catch {continue;}
          report.popup.candidates ||= [];if(!report.popup.candidates.some(row=>row.id===id))report.popup.candidates.push(value);
          if(value.viewable&&value.pid===app.pid&&/_NET_WM_WINDOW_TYPE_(?:COMBO|DROPDOWN_MENU|POPUP_MENU)(?:,|$)/.test(value.type||''))return value;
        }
        return false;
      },'Native request popup was not observable as a new viewable same-app X11 popup; popup coverage remains unqualified.');
      assertPopup(popup,app.pid);(report.popup.observations ||= []).push({label,popup});return popup;
    };
    key('alt+Down');const popup=await observePopup('open-and-cancel');
    assertPopup(popup,app.pid);report.popup={...report.popup,result:'observed',popup};
    await screenshot?.('native-move-request-popup-webview.png');
    key('Escape');
    await waitFor(()=>popupDismissed(popup.id,tree(),geometry),'Escape did not dismiss the observed native popup.');
    let value=await record('popup-cancelled');assert.equal(value.selected,selected);assert.equal(value.activeId,'file-move-requests');assert.equal(value.identity.text,identity);
    key('alt+Down');const newSourcePopup=await observePopup('choose-new-source');key('Home');key('Return');
    value=await waitFor(async()=>{const value=await read();return value.selected===''&&!value.draftHidden?value:false;},'Real Home/Return did not select New source Move through the production callback.');
    report.geometry.push({label:'real-new-source-selection',value});assertShell(value);assert.equal(value.activeId,'file-move-requests');
    await waitFor(()=>popupDismissed(newSourcePopup.id,tree(),geometry),'Return did not close the observed New source Move popup.');
    key('alt+Down');const preparedPopup=await observePopup('return-to-prepared');key('End');key('Return');
    value=await waitFor(async()=>{const value=await read();return value.selected===selected&&value.draftHidden&&!value.commit.hidden&&!value.commit.disabled?value:false;},'Real End/Return did not restore the same retained prepared Move.');
    report.geometry.push({label:'real-retained-request-selection',value});assertShell(value);assert.equal(value.identity.text,identity);assert.equal(value.status.text,before.status.text);assert.deepEqual(value.options,before.options);
    await waitFor(()=>popupDismissed(preparedPopup.id,tree(),geometry),'Return did not close the observed retained-request popup.');
    for(const id of ['file-move-from','file-move-to']) {
      await click('#'+id);await reach(id,id==='file-move-from'?before.from.text:before.to.text);
    }
    await directSummaryClick(command,'#file-move-request-detail > summary');
    assert.equal((await read()).detailOpen,true);
    await click('#file-move-identity');await reach('file-move-identity',identity);
    await directSummaryClick(command,'#file-move-request-detail > summary');assert.equal((await read()).detailOpen,false);
    const dispatch=await execute('return window.__nativeMoveUiDispatch.slice(arguments[0]);',[dispatchStart]);assertObservationalDispatch(dispatch);report.dispatch=dispatch;
    value=await record('restored-prepared-state');assert.equal(value.selected,selected);assert.equal(value.identity.text,identity);assert.equal(value.from.text,before.from.text);assert.equal(value.to.text,before.to.text);assert.equal(value.status.text,before.status.text);assert.equal(value.draftHidden,true);assert.equal(value.commit.hidden,false);assert.equal(value.commit.disabled,false);
    report.result='passed';checks.push('Native request SELECT preserves appearance and inset focus ring, exposes an independently observed X11 popup, uses real option keys without producer effects, and keeps full From/To/identity values readable through existing body-scroll routes.');
  } catch(error) {report.result='failed';report.error=error.message;report.terminal=await read().catch(()=>null);await screenshot?.('native-move-request-select-failure.png').catch(()=>{});throw error;}

  async function reach(id,text) {
    for(const block of ['start','end']) {
      // Declared rendering setup only: scroll the existing body to each full-value edge; no text/focus/selection/controller mutation.
      await execute('document.getElementById(arguments[0]).scrollIntoView({block:arguments[1],inline:"nearest"});return new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))));',[id,block]);
      const value=await record(id+'/'+block),target=value[id==='file-move-from'?'from':id==='file-move-to'?'to':'identity'];
      assert.equal(target.text,text);assert.ok(target.text.length>0&&target.font>=value.rootFont-.5);assert.ok(['fit','reflow'].includes(target.fit));
      assert.ok(target.scrollWidth<=target.clientWidth+1&&target.glyph.left>=value.body.left-1&&target.glyph.right<=value.body.right+1,'The complete unchanged value wraps within the body width.');
      assert.ok(target.glyph.width>0&&target.glyph.height>0,'The full unchanged value has actual readable glyph geometry.');
      if(block==='start')assert.ok(target.glyph.top>=value.body.top-1&&target.glyph.top<value.body.bottom,'The full value beginning is physically reachable.');
      else assert.ok(target.glyph.bottom<=value.body.bottom+1&&target.glyph.bottom>value.body.top,'The full value end is physically reachable.');
    }
  }
}
