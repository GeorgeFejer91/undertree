// Passive DOM geometry; no source/editor mutation or fake Pretext measurement.
export function readNativeFindGeometry(readClickTargetGeometry) {
  const rect=node=>{const b=node.getBoundingClientRect();return {left:b.left,right:b.right,top:b.top,bottom:b.bottom,width:b.width,height:b.height};};
  const visible=node=>!!node?.getClientRects().length&&!node.closest('[hidden],[inert]')&&getComputedStyle(node).visibility==='visible';
  const measure=node=>{
    const style=getComputedStyle(node),range=document.createRange();range.selectNodeContents(node);
    return {id:node.id,tag:node.tagName,name:node.getAttribute('name'),type:node.getAttribute('type'),box:rect(node),glyph:rect(range),clientWidth:node.clientWidth,scrollWidth:node.scrollWidth,clientHeight:node.clientHeight,scrollHeight:node.scrollHeight,font:parseFloat(style.fontSize),lineHeight:parseFloat(style.lineHeight),minHeight:parseFloat(style.minHeight)||0,fit:node.dataset.textFit||null,paddingLeft:parseFloat(style.paddingLeft)||0,paddingRight:parseFloat(style.paddingRight)||0};
  };
  const editor=document.querySelector('.cm-editor'),panel=editor.querySelector('.cm-search'),scroller=editor.querySelector('.cm-scroller'),line=editor.querySelector('.cm-line');
  const tab=document.querySelector('#manuscript-tabs [aria-selected=true]')?.parentElement;
  const mobile=document.querySelector('.mobile-views');
  const topbar=document.querySelector('.review-topbar'),actions=document.querySelector('.topbar-actions'),chatgpt=document.getElementById('chatgpt-open'),path=chatgpt.querySelector('path'),svg=chatgpt.querySelector('svg');
  let inkBox=null;
  if(visible(chatgpt)) {
    const ink=path.getBBox(),matrix=path.getScreenCTM();
    if(matrix) {
      const corners=[[ink.x,ink.y],[ink.x+ink.width,ink.y],[ink.x,ink.y+ink.height],[ink.x+ink.width,ink.y+ink.height]].map(([x,y])=>{const point=svg.createSVGPoint();point.x=x;point.y=y;return point.matrixTransform(matrix);});
      inkBox={left:Math.min(...corners.map(p=>p.x)),right:Math.max(...corners.map(p=>p.x)),top:Math.min(...corners.map(p=>p.y)),bottom:Math.max(...corners.map(p=>p.y))};
    }
  }
  const compact=document.querySelector('#workspace-menu [data-command=chatgpt]');
  const compactPanel=document.querySelector('#workspace-menu .workspace-menu-panel'),compactBox=rect(compactPanel);
  const compactViewport={left:compactBox.left+compactPanel.clientLeft,right:compactBox.left+compactPanel.clientLeft+compactPanel.clientWidth,top:compactBox.top+compactPanel.clientTop,bottom:compactBox.top+compactPanel.clientTop+compactPanel.clientHeight};
  return {viewport:{width:innerWidth,height:innerHeight},rootFont:parseFloat(getComputedStyle(document.documentElement).fontSize),document:{width:document.documentElement.scrollWidth,height:document.documentElement.scrollHeight},frame:measure(document.getElementById('window-titlebar')),source:measure(document.getElementById('manuscript-source')),editor:measure(editor),scroller:measure(scroller),sourceLineHeight:parseFloat(getComputedStyle(line).lineHeight),panel:panel?measure(panel):null,
    controls:panel?[...panel.querySelectorAll('input,button,label')].filter(visible).map(measure):[],tabs:measure(document.getElementById('manuscript-tabs')),activeTabControls:tab?[...tab.querySelectorAll('button')].filter(visible).map(measure):[],mobileVisible:visible(mobile),mobile:measure(mobile),mobileControls:[...mobile.querySelectorAll('button')].filter(visible).map(measure),
    topbar:measure(topbar),topbarActions:{...measure(actions),visible:visible(actions)},chatgpt:{...measure(chatgpt),visible:visible(chatgpt),accessibleName:chatgpt.getAttribute('aria-label'),controls:chatgpt.getAttribute('aria-controls'),hasPopup:chatgpt.getAttribute('aria-haspopup'),svg:rect(svg),ink:inkBox},compactChatgpt:{...measure(compact),visible:visible(compact),text:compact.textContent,role:compact.getAttribute('role'),disabled:compact.disabled,menuOpen:document.getElementById('workspace-menu').open},
    compactMenuPanel:{...measure(compactPanel),viewport:compactViewport,scrollTop:compactPanel.scrollTop,scrollLeft:compactPanel.scrollLeft},clickTarget:readClickTargetGeometry()};
}

// Fixed structural samples only. No focus, scroll, source text or DOM mutation.
export function readNativeFindClickTargetGeometry() {
  const caps={rects:4,lineNodes:8,ancestors:8,labelChars:160};
  const label=value=>typeof value==='string'?{value:value.slice(0,caps.labelChars),truncated:value.length>caps.labelChars}:null;
  const box=value=>{
    if(!value)return null;
    const result={left:value.left,right:value.right,top:value.top,bottom:value.bottom,width:value.width,height:value.height};
    return Object.values(result).every(Number.isFinite)?result:null;
  };
  const intersect=(a,b)=>{
    if(!a||!b)return null;
    const left=Math.max(a.left,b.left),right=Math.min(a.right,b.right),top=Math.max(a.top,b.top),bottom=Math.min(a.bottom,b.bottom);
    return right>left&&bottom>top?{left,right,top,bottom,width:right-left,height:bottom-top}:null;
  };
  const center=rect=>{
    if(!rect)return null;
    const point={x:(rect.left+rect.right)/2,y:(rect.top+rect.bottom)/2};
    return Number.isFinite(point.x)&&Number.isFinite(point.y)?point:null;
  };
  const facts=node=>{
    if(!node)return null;
    const style=getComputedStyle(node);
    return {tag:label(node.tagName),role:label(node.getAttribute('role')),class:label(node.getAttribute('class')),box:box(node.getBoundingClientRect()),
      clientWidth:node.clientWidth,clientHeight:node.clientHeight,clientLeft:node.clientLeft,clientTop:node.clientTop,
      scrollWidth:node.scrollWidth,scrollHeight:node.scrollHeight,scrollLeft:node.scrollLeft,scrollTop:node.scrollTop,
      display:label(style.display),visibility:label(style.visibility),pointerEvents:label(style.pointerEvents),overflowX:label(style.overflowX),overflowY:label(style.overflowY),
      hidden:!!node.hidden,inert:!!node.inert,connected:node.isConnected===true};
  };
  const content=document.querySelector('.cm-content'),scroller=document.querySelector('.cm-scroller');
  const visual=globalThis.visualViewport;
  const viewport={left:visual?visual.offsetLeft:0,top:visual?visual.offsetTop:0,width:visual?visual.width:innerWidth,height:visual?visual.height:innerHeight};
  viewport.right=viewport.left+viewport.width;viewport.bottom=viewport.top+viewport.height;
  const viewportValid=Object.values(viewport).every(Number.isFinite)&&viewport.width>0&&viewport.height>0;
  const target=facts(content),scroll=facts(scroller),rects=[],lines=[],ancestors=[];
  let clientRectCount=0,lineNodesInspected=0,lineNodesTruncated=false,ancestorsTruncated=false;
  if(content) {
    const all=content.getClientRects();clientRectCount=all.length;
    for(let index=0;index<Math.min(all.length,caps.rects);index++)rects.push(box(all[index]));
    let line=content.firstElementChild;
    while(line&&lineNodesInspected<caps.lineNodes) {
      lineNodesInspected++;if(line.classList.contains('cm-line'))lines.push(facts(line));
      line=line.nextElementSibling;
    }
    lineNodesTruncated=!!line;
    let parent=content.parentElement;
    while(parent&&ancestors.length<caps.ancestors){ancestors.push(facts(parent));parent=parent.parentElement;}
    ancestorsTruncated=!!parent;
  }
  const ivcp=center(viewportValid?intersect(rects[0],viewport):null);
  const client=scroll?.box?{left:scroll.box.left+scroll.clientLeft,top:scroll.box.top+scroll.clientTop,
    right:scroll.box.left+scroll.clientLeft+scroll.clientWidth,bottom:scroll.box.top+scroll.clientTop+scroll.clientHeight}:null;
  let lineViewportPoint=null;
  for(const line of lines){lineViewportPoint=center(viewportValid?intersect(intersect(line.box,client),viewport):null);if(lineViewportPoint)break;}
  const hit=point=>{
    if(!point)return null;
    const node=document.elementFromPoint(point.x,point.y);
    return {point,tag:label(node?.tagName),role:label(node?.getAttribute('role')),class:label(node?.getAttribute('class')),targetContains:!!node&&!!content&&content.contains(node)};
  };
  return {caps,target,scroller:scroll,scrollerClientViewport:client,viewport,viewportValid,layoutViewport:{width:innerWidth,height:innerHeight},
    clientRects:rects,clientRectCount,clientRectsTruncated:clientRectCount>caps.rects,ivcp,ivcpHit:hit(ivcp),lineViewportPoint,lineViewportHit:hit(lineViewportPoint),
    lines,lineNodesInspected,lineNodesTruncated,ancestors,ancestorsTruncated,documentFocused:document.hasFocus(),targetFocused:document.activeElement===content};
}
