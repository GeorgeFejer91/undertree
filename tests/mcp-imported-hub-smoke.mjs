import assert from 'node:assert/strict';
import { createZrokFixture } from './zrok-fixture.mjs';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, toNamespacedPath } from 'node:path';

const binary = resolve(process.env.UNDERTREE_REVIEW_BINARY || 'target/debug/undertree-review');
const artifacts = resolve(process.env.UNDERTREE_IMPORTED_HUB_ARTIFACTS || 'artifacts/mcp-imported-hub');
const fixture = await mkdtemp(join(tmpdir(), 'undertree-imported-hub-'));
const token = randomBytes(32).toString('hex');
const reservation = 'existing-name', publicUrl = 'https://existing-name.shares.zrok.io';
const publicPathToken = 'existing_private_token', importedPath = `/t/${publicPathToken}/mcp`;
const publicEndpoint = publicUrl + importedPath;
const targetFile = join(fixture, 'target'), childHomeFile = join(fixture, 'child-home');
const peerPath = '/mcp/' + randomBytes(24).toString('hex');
const checks = [], peerState = { value: 'initial', effects: 0 };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const pause = duration => new Promise(resolve => setTimeout(resolve, duration));
const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-06-18' };
const initialize = { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'Imported gateway fixture', version: '1' } };
const evidence = { verifiedAt: new Date().toISOString(), binary, assertions: checks, limitations: 'Fake private import, fake zrok and loopback peer only. No real credentials, account transfer, public tunnel, ChatGPT, desktop or renderer acknowledgements.' };
let service, base, endpoint, startupError, ownerId, log = '', rpcId = 0;
function redact(value) {
  return String(value).replaceAll(token, '[redacted]').replaceAll(publicPathToken, '[fixture-token]');
}
async function http(path, operation = {}, denied = false) {
  const response = await fetch(base + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(path === '/api/control' ? { 'X-UnderTree-Editor': ownerId } : {}) },
    body: JSON.stringify(operation), signal: AbortSignal.timeout(45_000),
  });
  const body = await response.json();
  assert.equal(body.ok, !denied, redact(body.error?.message));
  return denied ? body.error : body.result;
}
const local = (operation, denied = false) => http('/api/review', operation, denied);
async function rpc(method, params = {}, target = endpoint) {
  const response = await fetch(target, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }), signal: AbortSignal.timeout(45_000) });
  assert.equal(response.status, 200, method + ' HTTP status');
  const body = await response.json(); assert.equal(body.error, undefined, redact(JSON.stringify(body.error)));
  return body.result;
}
const tool = (name, args = {}, target = endpoint) => rpc('tools/call', { name, arguments: args }, target);
const names = async () => (await rpc('tools/list')).tools.map(tool => tool.name);
const peer = createServer(async (request, response) => {
  try {
    if (request.url !== peerPath) { response.writeHead(404).end(); return; }
    if (request.method !== 'POST') { response.writeHead(405).end(); return; }
    let source = '';
    for await (const chunk of request) { source += chunk; assert.ok(source.length <= 131_072); }
    const message = JSON.parse(source);
    if (!Object.hasOwn(message, 'id')) { response.writeHead(202).end(); return; }
    let result;
    if (message.method === 'initialize') result = { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'Imported fixture peer', version: '1' } };
    else if (message.method === 'tools/list') result = { tools: [{ name: 'set_state', description: 'Change only this disposable peer state.', inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false }, annotations: { readOnlyHint: false, destructiveHint: false } }] };
    else if (message.method === 'tools/call') {
      assert.equal(message.params.name, 'set_state'); assert.equal(typeof message.params.arguments.value, 'string');
      peerState.value = message.params.arguments.value; peerState.effects++;
      result = { content: [{ type: 'text', text: JSON.stringify(peerState) }], structuredContent: { ...peerState }, isError: false };
    } else if (message.method === 'ping') result = {};
    else { response.writeHead(400).end(); return; }
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  } catch (error) {
    log = (log + '\nFixture peer: ' + error.message).slice(-16_000);
    if (!response.headersSent) response.writeHead(500);
    response.end();
  }
});
try {
  evidence.binarySha256 = hash(await readFile(binary));
  await mkdir(join(fixture, 'state'), { mode: 0o700 });
  const state = await realpath(join(fixture, 'state')), home = join(state, 'zrok-home-fixture');
  await mkdir(home, { mode: 0o700 }); await mkdir(join(home, '.zrok2'), { mode: 0o700 });
  await writeFile(join(home, '.zrok2', 'metadata.json'), 'fixture-activation', { mode: 0o600 });
  await writeFile(join(home, '.zrok2', 'environment.json'), JSON.stringify({ ziti_identity: 'fixture-enrollment' }), { mode: 0o600 });
  const profile = JSON.stringify({ version: 1, reservation, publicUrl, publicPathToken, zrokHome: home });
  const profilePath = join(state, 'secret-tunnel-connector.json');
  await writeFile(profilePath, profile, { mode: 0o600 });
  await writeFile(join(state, 'connection.json'), JSON.stringify({ reservation, publicUrl }), { mode: 0o600 });
  const zrokFixture = await createZrokFixture(fixture, targetFile, new URL(publicUrl).hostname);
  service = spawn(binary, ['serve'], {
    env: { ...process.env, ...zrokFixture.environment, UNDERTREE_REVIEW_PORT: '0', UNDERTREE_REVIEW_STATE: state, UNDERTREE_REVIEW_TOKEN: token, UNDERTREE_ZROK: zrokFixture.executable, XDG_DATA_HOME: join(fixture, 'data'), XDG_CONFIG_HOME: join(fixture, 'config'), XDG_CACHE_HOME: join(fixture, 'cache') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  service.on('error', error => { startupError = error; });
  for (const stream of [service.stdout, service.stderr]) stream.on('data', bytes => { log = (log + bytes).slice(-16_000); });
  const deadline = Date.now() + 30_000;
  while (!base && Date.now() < deadline) {
    if (startupError) throw startupError;
    const port = log.match(/127\.0\.0\.1:(\d+)/)?.[1];
    if (port) base = `http://127.0.0.1:${port}`;
    else { assert.equal(service.exitCode, null, redact(log)); await pause(50); }
  }
  assert.ok(base, redact(log) || 'The isolated Rust service did not start.');
  const started = await local({ action: 'tunnel', enabled: true, reservation, public_url: publicUrl });
  assert.equal(started.endpoint, publicEndpoint); assert.equal(started.textOnlyConnector, true);
  assert.equal(await readFile(childHomeFile, 'utf8'), toNamespacedPath(await realpath(home)));
  assert.equal(await readFile(join(fixture, 'child-activation'), 'utf8'), 'fixture-activation', 'The imported child reads the dedicated synthetic activation metadata.');
  const target = await readFile(targetFile, 'utf8'); endpoint = target + importedPath;
  await rpc('initialize', initialize);
  const reviewTools = ['list_manuscripts', 'read_manuscript', 'suggest_text'];
  assert.deepEqual(await names(), reviewTools);
  assert.equal((await tool('list_manuscripts')).isError, false);
  assert.equal((await local({ action: 'connection' })).config.publicUrl, publicUrl);
  ownerId = (await http('/api/editor/connect')).ownerId;
  await http('/api/control', { action: 'control_enable', enabled: true }, true);
  checks.push('A strict private fixture import preserves the exact connector URL, gives only Review tools initially, and launches the fake child with its private activation home.');
  const enabled = await local({ action: 'hub_enable', enabled: true });
  assert.equal(enabled.endpoint, publicEndpoint); assert.equal(enabled.enabled, true);
  await rpc('initialize', initialize);
  assert.deepEqual(await names(), [...reviewTools, 'list_connected_apps']);
  await new Promise((resolve, reject) => { peer.once('error', reject); peer.listen(0, '127.0.0.1', resolve); });
  const peerUrl = `http://127.0.0.1:${peer.address().port}${peerPath}`;
  await local({ action: 'hub_link', label: 'Imported fixture peer', url: peerUrl });
  const catalogue = (await rpc('tools/list')).tools;
  const alias = catalogue.find(tool => tool._meta?.['undertree/toolName'] === 'set_state')?.name;
  assert.ok(alias);
  const input = { requestId: 'imported-peer-once', arguments: { value: 'same imported MCP address' } };
  assert.equal((await tool(alias, input)).isError, false); assert.equal((await tool(alias, input)).isError, false);
  assert.equal(peerState.value, input.arguments.value); assert.equal(peerState.effects, 1);
  assert.equal((await local({ action: 'hub_status' })).endpoint, publicEndpoint);
  checks.push('Explicit gateway opt-in keeps the same URL and forwards one frozen peer alias exactly once without changing the connector identity.');
  const controls = await http('/api/control', { action: 'control_enable', enabled: true });
  const controlEndpoint = target + new URL(controls.endpoint).pathname;
  await rpc('initialize', initialize, controlEndpoint);
  assert.ok((await names()).includes('control_list_manuscripts'));
  assert.equal((await tool('control_list_manuscripts')).isError, false);
  const workspace = await tool('control_get_workspace'); assert.equal(workspace.isError, true);
  checks.push('A separately authenticated local browser-adapter owner can grant App controls only after gateway opt-in; absent renderer state is rejected rather than fabricated.');
  await local({ action: 'hub_enable', enabled: false });
  assert.deepEqual(await names(), reviewTools);
  assert.equal((await tool(alias, input)).isError, true); assert.equal(peerState.effects, 1);
  const disabled = await local({ action: 'connection' });
  assert.equal(disabled.endpoint, publicEndpoint); assert.equal(disabled.gateway.enabled, false); assert.equal(disabled.gateway.appCount, 0); assert.equal(disabled.appControls.enabled, false);
  const deniedControl = await fetch(controlEndpoint, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'initialize', params: initialize }), signal: AbortSignal.timeout(10_000) });
  assert.equal(deniedControl.status, 404);
  assert.equal(await readFile(profilePath, 'utf8'), profile);
  assert.equal(hash(await readFile(binary)), evidence.binarySha256, 'The CLI changed during qualification.');
  checks.push('Disabling the imported gateway restores Review-only tools at the identical URL, removes peer aliases and App grants, and preserves the private profile.');
  evidence.result = 'passed';
  console.log(`Imported MCP gateway passed: ${checks.length} real HTTP/Rust checks. Private import, zrok and peer are synthetic; no public or native UI claim.`);
} catch (error) {
  evidence.result = 'failed'; evidence.error = redact(error.message); throw Error(redact(error.message));
} finally {
  if (base && service?.exitCode === null) await local({ action: 'tunnel', enabled: false, reservation: '', public_url: '' }).catch(() => {});
  peer.closeAllConnections(); await new Promise(resolve => peer.close(resolve));
  if (service?.pid && service.exitCode === null && service.signalCode === null) {
    const closed = new Promise(resolve => service.once('exit', resolve));
    service.kill('SIGTERM'); await Promise.race([closed, pause(2000)]);
    if (service.exitCode === null && service.signalCode === null) { service.kill('SIGKILL'); await closed; }
  }
  evidence.log = redact(log); await mkdir(artifacts, { recursive: true });
  await writeFile(join(artifacts, 'imported-hub-evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
  await rm(fixture, { recursive: true, force: true });
}
