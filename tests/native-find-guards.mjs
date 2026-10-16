import assert from 'node:assert/strict';

export const isProducer = row => (row.name === 'review_action' && ['save','compile'].includes(row.action)) || (row.name === 'editor_operation' && row.action === 'editor_commit');
export function assertObserved(probe) {
  assert.equal(probe.dropped,0,'The finite native IPC observation did not drop events.');
  assert.deepEqual(probe.errors,[],'All actual IPC bodies and response metadata were observable.');
}
export function assertPureQuery(probe, afterSequence) {
  assertObserved(probe);
  const allowed = {
    review_action:new Set(['capabilities','projects','project_tree','review','pdf','connection']),
    editor_operation:new Set(['editor_poll','editor_update']),
    control_operation:new Set(['control_poll']),
  };
  const starts=probe.events.filter(row=>row.kind==='start'&&row.sequence>afterSequence);
  assert.deepEqual(starts.filter(row=>!allowed[row.name]?.has(row.action)),[], 'Find dispatches only declared observations or ephemeral editor/control publications, never Open/Save/compile/policy/tree/grant effects.');
  return starts;
}
export function assertProducerQuiet(probe, quietMilliseconds=1100) {
  assertObserved(probe);
  assert.deepEqual(probe.pending.filter(isProducer),[],'No denied Save/compile remains outstanding.');
  assert.ok(probe.now-probe.lastProducerStart>quietMilliseconds,'No producer has just started.');
  assert.ok(probe.now-probe.lastSourceDomChange>quietMilliseconds,'The existing source DOM has settled before restoring permissions.');
}
export function assertSaveBoundary(probe, afterSequence, expectedPath) {
  assertObserved(probe);
  const clicks=probe.events.filter(row=>row.kind==='click'&&row.id==='manuscript-save'&&row.sequence>afterSequence);
  assert.equal(clicks.length,1,'Exactly one genuine Save click supplies the explicit boundary.');
  assert.equal(clicks[0].trusted,true,'The Save came from real native/WebDriver input.');
  const starts=probe.events.filter(row=>row.kind==='start'&&row.sequence>afterSequence&&isProducer(row)&&row.action!=='compile');
  assert.equal(starts.length,1,'No additional source-save producer starts in the explicit Save interval.');
  const successful=starts.filter(row=>probe.events.some(ack=>ack.kind==='ack'&&ack.request===row.request&&ack.ok));
  assert.equal(successful.length,1,'Exactly one successful source-save producer is observed in the boundary.');
  const start=successful[0],acks=probe.events.filter(row=>row.kind==='ack'&&row.request===start.request);
  assert.equal(acks.length,1,'The same started Save has one terminal acknowledgement.');
  const ack=acks[0];
  assert.equal(start.name,'review_action');assert.equal(start.action,'save');assert.equal(start.path,expectedPath);
  assert.ok(start.sequence>clicks[0].sequence&&start.at>=clicks[0].at,'Actual Save request START follows the real click; a later ACK alone cannot establish provenance.');
  assert.ok(ack.sequence>start.sequence&&ack.at>=start.at,'The same started request reaches a terminal acknowledgement.');
  return {click:clicks[0],start,ack};
}
export function matchOffsets(source,needle) {
  assert.ok(needle.length);const positions=[];
  for(let at=source.indexOf(needle);at>=0;at=source.indexOf(needle,at+needle.length))positions.push(at);
  return positions;
}
export function assertFreshRegistrationSetup(probe,{project,path,expectedRoot,revision}) {
  assertObserved(probe);
  const target=row=>row.project===project&&row.path===path;
  const opened=probe.events.find(row=>row.kind==='start'&&row.name==='review_action'&&row.action==='open'&&target(row));
  const openAck=opened&&probe.events.find(row=>row.kind==='ack'&&row.request===opened.request&&row.ok);
  assert.ok(openAck,'Actual explicit Open has a successful terminal response before pure Find.');
  assert.deepEqual(opened.expectedRoot,expectedRoot);assert.deepEqual(openAck.expectedRoot,expectedRoot);
  assert.equal(openAck.revision,revision,'Open ACK describes the exact saved fixture revision.');
  assert.ok(Number.isSafeInteger(openAck.sourceEpoch)&&openAck.sourceEpoch>=0,'Open reports the actual owned source epoch.');
  const attempts=probe.events.filter(row=>row.kind==='start'&&row.name==='editor_operation'&&row.action==='editor_register'&&target(row)&&row.sequence>opened.sequence);
  const accepted=attempts.map(start=>({start,ack:probe.events.find(row=>row.kind==='ack'&&row.request===start.request&&row.ok)})).filter(row=>row.ack);
  assert.equal(accepted.length,1,'One actual successful fresh-source registration supplies setup readiness.');
  const {start,ack}=accepted[0];
  assert.equal(start.generation,0);assert.equal(start.revision,revision);assert.equal(start.contentDigest,revision);
  assert.equal(start.dirty,false);assert.equal(start.composing,false);assert.equal(start.conflict,false);
  assert.deepEqual(start.expectedRoot,expectedRoot);assert.equal(start.sourceEpoch,openAck.sourceEpoch);
  assert.equal(ack.protocolVersion,1);assert.equal(ack.registrationIdentityPresent,true);
  assert.deepEqual(ack.expectedRoot,expectedRoot);assert.equal(ack.sourceEpoch,openAck.sourceEpoch);
  assert.ok(ack.sequence>start.sequence&&ack.at>=start.at,'The same registration START reaches its actual successful ACK.');
  assert.deepEqual(probe.pending.filter(row=>isProducer(row)||(row.name==='editor_operation'&&row.action==='editor_register')||(row.name==='review_action'&&row.action==='open')),[],'No registration/Open or source-producing setup request remains pending before pure Find.');
  return {opened:{start:opened,ack:openAck},registration:{start,ack},attempts};
}
