import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createZrokFixture } from './zrok-fixture.mjs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = await mkdtemp(join(tmpdir(), 'undertree-mcp-hub-'));
const token = randomBytes(32).toString('hex'), targetFile = join(root, 'target');
const peers = [], requests = [], errors = [];
let service, base, endpoint, startupError, releaseHeld, log = '', rpcId = 0;
const pause = duration => new Promise(resolve => setTimeout(resolve, duration));
const tools = [
  { name: 'read_state', description: 'Read this app state.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: 'set_state', description: 'Change this app state.', inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false }, annotations: { readOnlyHint: false, destructiveHint: false } },
];
async function peer(label, sse, instructions = `Use ${label}'s locally granted tools only.`) {
  const state = { label, value: 'initial', effects: 0, session: randomBytes(16).toString('hex'), sse, dropNext: false, calls: [], holdNext: null };
  const path = '/mcp/' + randomBytes(24).toString('hex');
  const server = createServer(async (request, response) => {
    try {
      if (request.url !== path) { response.writeHead(404); response.end(); return; }
      if (request.method !== 'POST') { response.writeHead(405); response.end(); return; }
      let source = '';
      for await (const chunk of request) { source += chunk; assert.ok(source.length <= 131072); }
      const message = JSON.parse(source);
      state.calls.push(message.method);
      if (sse && message.method !== 'initialize' && request.headers['mcp-session-id'] !== state.session) { response.writeHead(404); response.end(); return; }
      if (!Object.hasOwn(message, 'id')) { response.writeHead(202); response.end(); return; }
      let result;
      if (message.method === 'initialize') {
        result = { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: label, version: '1' }, instructions };
      } else if (message.method === 'tools/list') {
        result = sse && !message.params?.cursor ? { tools: tools.slice(0, 1), nextCursor: 'second' } : { tools: sse ? tools.slice(1) : tools };
      } else if (message.method === 'tools/call') {
        const { name, arguments: args } = message.params;
        requests.push({ label, name });
        if (name === 'set_state') { state.value = args.value; state.effects++; }
        else assert.equal(name, 'read_state');
        if (state.holdNext) { const held = state.holdNext; state.holdNext = null; held.entered(); await held.released; }
        if (state.dropNext) { state.dropNext = false; request.socket.destroy(); return; }
        result = { content: [{ type: 'text', text: JSON.stringify({ app: label, value: state.value, effects: state.effects }) }], isError: false };
      } else if (message.method === 'ping') result = {};
      else { response.writeHead(400); response.end(); return; }
      const headers = { 'Content-Type': sse ? 'text/event-stream' : 'application/json' };
      if (sse) headers['Mcp-Session-Id'] = state.session;
      response.writeHead(200, headers);
      const body = JSON.stringify({ jsonrpc: '2.0', id: message.id, result });
      response.end(sse ? `event: message\ndata: ${body}\n\n` : body);
    } catch (error) {
      errors.push(error.message);
      if (!response.headersSent) response.writeHead(500);
      response.end();
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const item = { ...state, server, url: `http://127.0.0.1:${server.address().port}${path}`, state };
  peers.push(item);
  return item;
}
async function local(operation, denied = false, headers = {}) {
  const response = await fetch(base + '/api/review', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...headers },
    body: JSON.stringify(operation), signal: AbortSignal.timeout(45_000),
  });
  const body = await response.json();
  assert.equal(body.ok, !denied, body.error?.message);
  return denied ? body.error : body.result;
}
async function rpc(method, params = {}) {
  const response = await fetch(endpoint, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-06-18' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }), signal: AbortSignal.timeout(45_000),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.error, undefined, JSON.stringify(body.error));
  return body.result;
}
async function call(name, args, denied = false) {
  const result = await rpc('tools/call', { name, arguments: args });
  assert.equal(Boolean(result.isError), denied, result.content?.[0]?.text);
  return result;
}
try {
  const zrok = await createZrokFixture(root, targetFile, 'review.example.org');
  service = spawn(resolve(process.env.UNDERTREE_REVIEW_BINARY || 'target/debug/undertree-review'), ['serve'], {
    env: { ...process.env, ...zrok.environment, UNDERTREE_REVIEW_PORT: '0', UNDERTREE_REVIEW_STATE: join(root, 'state'), UNDERTREE_REVIEW_TOKEN: token, UNDERTREE_ZROK: zrok.executable },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  service.on('error', error => { startupError = error; });
  for (const stream of [service.stdout, service.stderr]) stream.on('data', bytes => { log = (log + bytes).slice(-16000); });
  const deadline = Date.now() + 30000;
  while (!base && Date.now() < deadline) {
    if (startupError) throw startupError;
    const port = log.match(/127\.0\.0\.1:(\d+)/)?.[1];
    if (port) base = `http://127.0.0.1:${port}`;
    else { assert.equal(service.exitCode, null, log); await pause(50); }
  }
  assert.ok(base, log || 'The isolated Rust service did not start.');
  await local({ action: 'hub_enable', enabled: true }, true);
  await local({ action: 'hub_status' }, true, { 'X-UnderTree-Caller': 'local_cli' });
  await local({ action: 'tunnel', enabled: true, reservation: 'hub-fixture', public_url: 'https://review.example.org' });
  const enabled = await local({ action: 'hub_enable', enabled: true });
  assert.equal(enabled.enabled, true);
  const cliStatus = await local({ action: 'connection' }, false, { 'X-UnderTree-Caller': 'local_cli' });
  assert.equal(cliStatus.gateway.enabled, true);
  assert.equal(cliStatus.gateway.endpoint, undefined);
  assert.ok(!JSON.stringify(cliStatus).includes(new URL(enabled.endpoint).pathname));
  endpoint = (await readFile(targetFile, 'utf8')) + new URL(enabled.endpoint).pathname;
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'hub-smoke', version: '1' } });
  const first = await peer('JSON app', false), second = await peer('SSE app', true);
  await local({ action: 'hub_link', label: first.label, url: first.url });
  await local({ action: 'hub_link', label: second.label, url: second.url });
  await local({ action: 'hub_link', label: 'Unsafe scheme', url: 'http://example.org/mcp' }, true);
  const status = await local({ action: 'hub_status' });
  assert.equal(status.apps.filter(app => app.label === first.label || app.label === second.label).length, 2);
  assert.ok(!JSON.stringify(status).includes(first.url) && !JSON.stringify(status).includes(second.url));
  const connected = JSON.parse((await call('list_connected_apps', {})).content[0].text).apps;
  for (const app of [first, second]) {
    assert.equal(connected.find(item => item.label === app.label).instructions, `Use ${app.label}'s locally granted tools only.`);
  }
  assert.ok(!JSON.stringify(connected).includes(first.url) && !JSON.stringify(connected).includes(second.url));
  const catalogue = (await rpc('tools/list')).tools;
  assert.equal(new Set(catalogue.map(tool => tool.name)).size, catalogue.length);
  const alias = (label, toolName) => {
    const app = status.apps.find(app => app.label === label);
    const tool = catalogue.find(tool => tool._meta?.['undertree/appId'] === app.id && tool._meta?.['undertree/toolName'] === toolName);
    assert.ok(tool, `${label}: ${toolName} was not routed.`);
    assert.ok(tool.name.length <= 64);
    return tool.name;
  };
  const firstRead = alias(first.label, 'read_state'), secondRead = alias(second.label, 'read_state');
  assert.notEqual(firstRead, secondRead);
  assert.equal(JSON.parse((await call(firstRead, { requestId: 'read-a', arguments: {} })).content[0].text).app, first.label);
  assert.equal(JSON.parse((await call(secondRead, { requestId: 'read-b', arguments: {} })).content[0].text).app, second.label);
  assert.ok(second.state.calls.filter(method => method === 'tools/list').length >= 2);
  const firstWrite = alias(first.label, 'set_state');
  const request = { requestId: 'write-once', arguments: { value: 'changed only in app A' } };
  const written = await call(firstWrite, request);
  assert.deepEqual(await call(firstWrite, request), written);
  assert.equal(first.state.effects, 1);
  assert.equal(second.state.effects, 0);
  await call(firstWrite, { requestId: request.requestId, arguments: { value: 'different' } }, true);
  assert.equal(first.state.effects, 1);
  await call('hub_link', { label: 'Forbidden registration', url: first.url }, true);
  await call(firstWrite, { requestId: 'extra-url', arguments: {}, url: first.url }, true);
  assert.equal(first.state.effects, 1);
  first.state.dropNext = true;
  const uncertain = { requestId: 'unknown-write', arguments: { value: 'effect before lost reply' } };
  await call(firstWrite, uncertain, true);
  await call(firstWrite, uncertain, true);
  assert.equal(first.state.effects, 2);
  const oldCatalogue = JSON.stringify(await rpc('tools/list'));
  assert.ok(!oldCatalogue.includes(first.url) && !oldCatalogue.includes(second.url));
  let entered = false, pendingError;
  second.state.holdNext = { entered: () => { entered = true; }, released: new Promise(resolve => { releaseHeld = resolve; }) };
  const pending = fetch(endpoint, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-06-18' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name: secondRead, arguments: { requestId: 'held-before-unlink', arguments: {} } } }), signal: AbortSignal.timeout(45_000),
  }).catch(error => { pendingError = error; });
  const callDeadline = Date.now() + 20_000;
  while (!entered && !pendingError && Date.now() < callDeadline) await pause(50);
  assert.equal(entered, true, pendingError?.message || 'The healthy target did not receive the held call.');
  await local({ action: 'hub_unlink', id: status.apps.find(app => app.label === second.label).id });
  releaseHeld();
  assert.equal((await pending)?.status, 401, pendingError?.message);
  await call(secondRead, { requestId: 'after-revoke', arguments: {} }, true);
  for (const label of ['Large context A', 'Large context B']) {
    const app = await peer(label, false, '\u0001'.repeat(100_000));
    await local({ action: 'hub_link', label, url: app.url });
  }
  await assert.rejects(rpc('tools/call', { name: 'list_connected_apps', arguments: {} }), /App context exceeds the gateway response limit/);
  await local({ action: 'hub_enable', enabled: false });
  const revoked = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }), signal: AbortSignal.timeout(5000) });
  assert.equal(revoked.status, 401);
  assert.equal((await local({ action: 'hub_status' })).enabled, false);
  assert.deepEqual(errors, []);
  console.log('PASS: one real Rust gateway routes two independent JSON/stateful-SSE apps, paginated discovery, distinct aliases, per-app control, no replay after lost replies, local-only registration and revocation. zrok and remote apps simulated; live cross-PC ChatGPT routing not tested.');
} finally {
  releaseHeld?.();
  if (base && service?.exitCode === null) await local({ action: 'tunnel', enabled: false, reservation: '', public_url: '' }).catch(() => {});
  for (const item of peers) { item.server.closeAllConnections(); await new Promise(resolve => item.server.close(resolve)); }
  if (service?.pid && service.exitCode === null && service.signalCode === null) {
    const closed = new Promise(resolve => service.once('exit', resolve));
    service.kill('SIGTERM'); await Promise.race([closed, pause(2000)]);
    if (service.exitCode === null && service.signalCode === null) { service.kill('SIGKILL'); await closed; }
  }
  await rm(root, { recursive: true, force: true });
}
