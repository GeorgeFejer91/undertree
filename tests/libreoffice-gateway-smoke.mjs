import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, parse } from 'node:path';
import { createZrokFixture } from './zrok-fixture.mjs';

const fixturePath = resolve(process.env.UNDERTREE_WRITER_FIXTURE || 'artifacts/libreoffice/gateway-private.json');
const writer = JSON.parse(await readFile(fixturePath, 'utf8'));
const stop = join(parse(fixturePath).dir, parse(fixturePath).name + '.stop');
assert.equal(new URL(writer.url).hostname, '127.0.0.1');
const root = await mkdtemp(join(tmpdir(), 'undertree-writer-gateway-'));
assert.equal(resolve(parse(root).dir), resolve(tmpdir()));
assert.ok(parse(root).base.startsWith('undertree-writer-gateway-'));
const token = randomBytes(32).toString('hex'), target = join(root, 'target');
let service, base, endpoint, startupError, sequence = 0, log = '';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function local(operation) {
  const response = await fetch(base + '/api/review', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(operation), signal: AbortSignal.timeout(45000),
  });
  const value = await response.json();
  assert.equal(value.ok, true, value.error?.message);
  return value.result;
}
async function rpc(method, params) {
  const response = await fetch(endpoint, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-06-18' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++sequence, method, params }), signal: AbortSignal.timeout(45000),
  });
  assert.equal(response.status, 200);
  const value = await response.json();
  assert.equal(value.error, undefined, 'Gateway JSON-RPC failed.');
  return value.result;
}
async function call(name, args, denied = false) {
  const result = await rpc('tools/call', { name, arguments: args });
  assert.equal(Boolean(result.isError), denied, denied ? 'Forbidden Writer action succeeded.' : 'Writer gateway call failed.');
  return denied ? result : JSON.parse(result.content[0].text);
}
try {
  const zrok = await createZrokFixture(root, target, 'review.example.org');
  service = spawn(resolve(process.env.UNDERTREE_REVIEW_BINARY || `target/debug/undertree-review${process.platform === 'win32' ? '.exe' : ''}`), ['serve'], {
    env: { ...process.env, ...zrok.environment, UNDERTREE_REVIEW_PORT: '0', UNDERTREE_REVIEW_STATE: join(root, 'state'), UNDERTREE_REVIEW_TOKEN: token, UNDERTREE_ZROK: zrok.executable },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  service.on('error', error => { startupError = error; });
  for (const stream of [service.stdout, service.stderr]) stream.on('data', bytes => { log = (log + bytes).slice(-16000); });
  const deadline = Date.now() + 30000;
  while (!base && Date.now() < deadline) {
    if (startupError) throw startupError;
    const port = log.match(/127\.0\.0\.1:(\d+)/)?.[1];
    if (port) base = `http://127.0.0.1:${port}`;
    else { assert.equal(service.exitCode, null, 'Rust service exited before readiness.'); await pause(50); }
  }
  assert.ok(base, 'Rust service readiness timed out.');
  await local({ action: 'tunnel', enabled: true, reservation: 'writer-gateway-test', public_url: 'https://review.example.org' });
  const hub = await local({ action: 'hub_enable', enabled: true });
  endpoint = (await readFile(target, 'utf8')) + new URL(hub.endpoint).pathname;
  await local({ action: 'hub_link', label: 'LibreOffice Writer test', url: writer.url });
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'Writer gateway qualification', version: '1' } });
  const tools = (await rpc('tools/list', {})).tools;
  const linked = tools.filter(tool => tool._meta?.['undertree/toolName']);
  assert.deepEqual(linked.map(tool => tool._meta['undertree/toolName']).sort(), ['highlight_text', 'list_manuscripts', 'read_manuscript', 'suggest_text']);
  const alias = name => linked.find(tool => tool._meta['undertree/toolName'] === name).name;
  const read = async id => call(alias('read_manuscript'), { requestId: id, arguments: { documentId: writer.documentId } });
  await call(alias('suggest_text'), { requestId: 'gateway-without-read', arguments: { documentId:writer.documentId, proposal:{ requestId: 'writer-no-context', revision: 'guessed', contextId: 'forged', from:0,to:23, quote: 'Direct gateway passage.', replacement: 'Must be refused without complete context.',rationale:'Test read prerequisite.' } } }, true);
  const before = await read('writer-read-before');
  assert.ok(before.content.includes('PRIVATE UNMARKED CONTEXT'), 'Complete document context must include unmarked text for reading.');
  assert.equal(before.context.complete, true);
  assert.equal(typeof before.contextId, 'string');
  const suggestion = before.markers.find(mark => mark.id === writer.suggestionMarker);
  const direct = before.markers.find(mark => mark.id === writer.directMarker);
  assert.equal(suggestion.mode, 'suggestion'); assert.equal(direct.mode, 'direct');
  const request = (snapshot, mark, replacement, requestId) => ({ documentId:writer.documentId, proposal:{ requestId, revision: snapshot.revision, contextId: snapshot.contextId, from:mark.from,to:mark.to, quote: mark.text, replacement, rationale:'Gateway qualification.' } });
  const forgedReceipt = request(before, direct, 'Must require a native read receipt.', 'writer-forged-receipt');
  forgedReceipt.proposal.contextId = 'forged';
  await call(alias('suggest_text'), { requestId: 'gateway-forged-receipt', arguments: forgedReceipt }, true);
  const pending = await call(alias('suggest_text'), { requestId: 'gateway-pending', arguments: request(before, suggestion, 'Suggested through the Rust gateway.', 'writer-pending') });
  assert.equal(pending.status, 'pending_local_approval'); assert.equal(pending.documentChanged, false);
  const afterPending = await read('writer-read-pending');
  assert.equal(afterPending.content, before.content, 'Suggestion changed Writer text.');
  assert.equal(afterPending.revision, before.revision, 'Suggestion changed Writer permissions or revision.');
  assert.deepEqual(afterPending.markers, before.markers);
  const directArgs = { requestId: 'gateway-direct', arguments: request(afterPending, direct, 'Applied through the Rust gateway.', 'writer-direct') };
  const applied = await call(alias('suggest_text'), directArgs);
  assert.equal(applied.status, 'applied'); assert.equal(applied.saved, false);
  // Reusing a gateway ID returns its cached response; a fresh gateway ID reaches
  // Writer's native receipt and must report that no second mutation occurred.
  assert.deepEqual(await call(alias('suggest_text'), directArgs), applied);
  const nativeReplay = await call(alias('suggest_text'), { ...directArgs, requestId: 'gateway-native-replay' });
  assert.equal(nativeReplay.status, 'applied');
  assert.equal(nativeReplay.replayed, true);
  assert.equal(nativeReplay.manuscriptChanged, false);
  assert.equal(nativeReplay.appliedDirectly, false);
  const after = await read('writer-read-after');
  assert.equal(after.markers.find(mark => mark.id === direct.id).text, '', 'Consumed or stale ranges must not disclose newly inserted text.');
  assert.equal(after.markers.find(mark => mark.id === direct.id).stale, true);
  assert.equal(after.markers.find(mark => mark.id === suggestion.id).text, suggestion.text);
  await call(alias('suggest_text'), { requestId: 'gateway-unmarked', arguments: { documentId:writer.documentId, proposal:{ requestId: 'writer-unmarked', revision: after.revision, contextId: after.contextId,from:after.content.indexOf('PRIVATE UNMARKED CONTEXT'),to:after.content.indexOf('PRIVATE UNMARKED CONTEXT')+'PRIVATE UNMARKED CONTEXT'.length, quote: 'PRIVATE UNMARKED CONTEXT', replacement: 'Forbidden',rationale:'Attempt outside highlights.' } } }, true);
  const afterDenied = await read('writer-read-denied');
  assert.equal(afterDenied.content, after.content);
  assert.equal(afterDenied.revision, after.revision);
  await writeFile(stop, 'stop');
  const closeDeadline = Date.now() + 15000;
  let fixtureClosed = false;
  while (Date.now() < closeDeadline) {
    try { await readFile(fixturePath); await pause(50); }
    catch (error) { if (error.code === 'ENOENT') { fixtureClosed = true; break; } throw error; }
  }
  assert.equal(fixtureClosed, true, 'Writer fixture did not acknowledge closure.');
  const receipt = JSON.parse(await readFile(join(parse(fixturePath).dir, parse(fixturePath).name + '.result.json'), 'utf8'));
  assert.deepEqual(receipt, { status: 'passed', privateTextUnchanged: true, suggestionTextUnchanged: true, pendingSuggestions: 1, directApplied: true });
  await call(alias('read_manuscript'), { requestId: 'writer-read-revoked', arguments: { documentId: writer.documentId } }, true);
  await local({ action: 'tunnel', enabled: false, reservation: '', public_url: '' });
  console.log('PASS: actual Writer/UNO through Rust MCP gateway: complete-context read requirement, unmarked context read-only, suggestion/no mutation, scoped direct edit, replay, and close revocation. zrok child is simulated; live ChatGPT/public route not tested.');
} finally {
  await writeFile(stop, 'stop');
  if (base && service?.exitCode === null) {
    try { await local({ action: 'tunnel', enabled: false, reservation: '', public_url: '' }); }
    catch { process.exitCode = 1; console.error('Gateway cleanup did not confirm tunnel shutdown.'); }
  }
  service?.kill('SIGINT');
  if (service && service.exitCode === null) await new Promise(resolve => { service.once('exit', resolve); setTimeout(resolve, 5000); });
  await rm(root, { recursive: true, force: true });
}
