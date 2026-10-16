// Qualification observation only; the real native fetch and existing context observer run unchanged.
export function installNativeFindObserver() {
  if(window.__nativeFindProbe)throw Error('Native Find observer already installed.');
  const original=window.fetch,events=[],pending=new Map(),errors=[];
  let sequence=0,request=0,dropped=0,lastProducerStart=performance.now(),lastSourceDomChange=performance.now();
  const record=row=>{if(events.length<4096)events.push({sequence:++sequence,at:performance.now(),...row});else dropped++;};
  const producer=row=>(row.name==='review_action'&&['save','compile'].includes(row.action))||(row.name==='editor_operation'&&row.action==='editor_commit');
  const fail=()=>{if(errors.length<8)errors.push('Unsupported native observation.');else dropped++;};
  const click=event=>{const node=event.target.closest?.('#manuscript-save,#typst-compile');if(node)record({kind:'click',id:node.id,trusted:event.isTrusted});};
  document.addEventListener('click',click,true);
  const changes=new MutationObserver(()=>{lastSourceDomChange=performance.now();});
  const watchSource=()=>{changes.disconnect();const content=document.querySelector('.cm-content');if(content)changes.observe(content,{childList:true,subtree:true,characterData:true});lastSourceDomChange=performance.now();};
  watchSource();
  const wrapped=function(input,init,...rest) {
    let row;
    try {
      const url=new URL(typeof input==='string'?input:input.url);
      if(url.protocol==='ipc:'||url.hostname==='ipc.localhost') {
        const body=JSON.parse(typeof init?.body==='string'?init.body:new TextDecoder().decode(init.body));
        const operation=body.operation||{};
        row={request:++request,name:decodeURIComponent(url.pathname.slice(1)),action:operation.action||null,project:operation.project||null,path:operation.path||null,sourceEpoch:operation.sourceEpoch??null,expectedRoot:operation.expectedRoot?{dev:operation.expectedRoot.dev,ino:operation.expectedRoot.ino}:null};
        if(row.name==='editor_operation'&&row.action==='editor_register')Object.assign(row,{generation:operation.generation??null,revision:operation.revision??null,contentDigest:operation.contentDigest??null,dirty:operation.dirty??null,composing:operation.composing??null,conflict:operation.conflict??null});
        record({kind:'start',...row});if(pending.size<64)pending.set(row.request,row);else {fail();dropped++;}
        if(producer(row))lastProducerStart=performance.now();
      }
    } catch {fail();}
    let response;
    try {response=Reflect.apply(original,this,[input,init,...rest]);}
    catch(error){if(row){record({kind:'ack',request:row.request,ok:false,rejected:true});pending.delete(row.request);}throw error;}
    if(row)Promise.resolve(response).then(async value=>{
      try {
        const header=value.headers.get('Tauri-Response');
        // Clone setup registration/Open and producer replies for metadata only; no source/PDF bytes or session IDs are retained.
        const registration=row.name==='editor_operation'&&row.action==='editor_register';
        const body=producer(row)||registration||(row.name==='review_action'&&row.action==='open')?await value.clone().json():null;
        const preview=body?.preview||body;
        const ok=value.ok&&header!=='error'&&body?.ok!==false&&!body?.code&&(!body?.compileDiagnosticsVersion||body.status==='succeeded');
        record({kind:'ack',request:row.request,ok,status:value.status,tauriResponse:header,
          code:typeof (body?.code||body?.error?.code)==='string'?(body.code||body.error.code):null,
          revision:body?.review?.revision||preview?.revision||null,
          available:typeof preview?.available==='boolean'?preview.available:null,
          current:typeof preview?.current==='boolean'?preview.current:null,
          replyPath:body?.path||body?.report?.provenance?.path||null,
          replyProject:body?.report?.provenance?.project||null,
          sourceEpoch:preview?.sourceEpoch??null,
          expectedRoot:preview?.expectedRoot?{dev:preview.expectedRoot.dev,ino:preview.expectedRoot.ino}:null,
          compileStatus:typeof body?.compileDiagnosticsVersion==='number'?body.status:null,
          ...(registration?{protocolVersion:body?.protocolVersion??null,registrationIdentityPresent:typeof body?.sessionId==='string'&&body.sessionId.length>0}:{})});
      } catch {fail();record({kind:'ack',request:row.request,ok:false,observationFailed:true});}
      finally {pending.delete(row.request);}
    },()=>{record({kind:'ack',request:row.request,ok:false,rejected:true});pending.delete(row.request);});
    return response;
  };
  window.fetch=wrapped;
  window.__nativeFindProbe={snapshot:()=>({events:events.map(row=>({...row})),pending:[...pending.values()].map(row=>({...row})),errors:[...errors],dropped,now:performance.now(),lastProducerStart,lastSourceDomChange,sequence}),watchSource,restore:()=>{changes.disconnect();document.removeEventListener('click',click,true);if(window.fetch===wrapped)window.fetch=original;else fail();}};
}
