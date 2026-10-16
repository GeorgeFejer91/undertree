// Passive DOM geometry; no source/editor mutation or fake Pretext measurement.
export function readNativeFindGeometry() {
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
    compactMenuPanel:{...measure(compactPanel),viewport:compactViewport,scrollTop:compactPanel.scrollTop,scrollLeft:compactPanel.scrollLeft}};
}
