// Passive timing/visibility only around the original two frames and500ms cap.
export function observeNativeCountFrames() {
  return new Promise(resolve=>{
    let completedFrames=0,done=false;
    const observation={maxRows:4,rows:[],dropped:0};
    const sample=(phase,frameTime)=>{
      if(observation.rows.length>=observation.maxRows){observation.dropped++;return;}
      try {
        const now=performance.now(),visibility=document.visibilityState;
        observation.rows.push({phase,atMs:Number.isFinite(now)?now:null,frameTimestampMs:Number.isFinite(frameTime)?frameTime:null,
          documentHidden:document.hidden===true,visibility:['visible','hidden','prerender'].includes(visibility)?visibility:'unknown',documentFocused:document.hasFocus()===true});
      } catch(error) {observation.rows.push({phase,unavailable:true,errorName:String(error?.name||'Error').slice(0,80)});}
    };
    const finish=timedOut=>{if(done)return;done=true;clearTimeout(timer);sample('resolved');resolve({ack:{completedFrames,timedOut,requestedFrames:2,capMs:500},observation});};
    const timer=setTimeout(()=>{if(done)return;sample('timeout');finish(true);},500);
    sample('armed');
    requestAnimationFrame(timestamp=>{if(done)return;completedFrames++;sample('first-frame',timestamp);requestAnimationFrame(timestamp=>{if(done)return;completedFrames++;sample('second-frame',timestamp);finish(false);});});
  });
}
