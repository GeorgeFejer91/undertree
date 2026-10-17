import { confirmNativeContextShare } from './context-fixture.mjs';
import assert from 'node:assert/strict';
import { createZrokFixture } from './zrok-fixture.mjs';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createServer as httpServer } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createServer as netServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { nativeFixtureContextScript } from './native-fixture-context.mjs';

assert.equal(process.platform, 'linux');
assert.notEqual(process.getuid(), 0);
const binary = resolve(process.env.UNDERTREE_DESKTOP || 'target/debug/undertree-desktop');
const artifacts = resolve(process.env.UNDERTREE_NATIVE_HUB_ARTIFACTS || 'artifacts/native-mcp-hub');
const uiDist = resolve(process.env.UNDERTREE_UI_DIST || 'dist');
const fixture = await mkdtemp(join(tmpdir(), 'undertree-native-hub-'));
const project = join(fixture, 'project'), data = join(fixture, 'data');
const state = join(data, 'io.github.georgefejer91.UnderTree', 'review');
const projectId = '11111111-1111-4111-8111-111111111111';
const source = join(project, 'main.typ'), policy = source + '.undertree-review.json';
const targetFile = join(fixture, 'target');
const processes = [], checks = [], secrets = [];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const pause = duration => new Promise(resolve => setTimeout(resolve, duration));
const peerPath = '/mcp/' + randomBytes(24).toString('hex');
const peerState = { value: 'initial', effects: 0 };
let session, driverUrl, displayEnv, nativeWindow, nativePid, peerUrl, log = '', rpcId = 0;
const evidence = {
  verifiedAt: new Date().toISOString(), application: binary, assertions: checks,
  qualification: 'Actual Tauri native IPC, gateway opt-in and app registration UI, Rust MCP forwarding, renderer acknowledgement and X11 window effects.',
  limitations: 'Disposable loopback peer and simulated zrok; no public ChatGPT, real zrok account, cross-PC reachability, installation, signing or other platform.',
};
function redact(value) {
  let result = String(value);
  for (const secret of secrets.filter(Boolean)) result = result.replaceAll(secret, '[redacted]');
  return result;
}
function child(command, args, env = {}) {
  const processChild = spawn(command, args, { env: { ...process.env, ...env }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  processes.push(processChild);
  processChild.on('error', error => { log = (log + '\n' + error.message).slice(-32_000); });
  processChild.stderr.on('data', bytes => { log = (log + bytes).slice(-32_000); });
  return processChild;
}
async function until(check, message, timeout = 45_000) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try { const result = await check(); if (result) return result; } catch (error) { lastError = error; }
    await pause(75);
  }
  throw Error(redact(`${message}${lastError ? ': ' + lastError.message : ''}`));
}
async function freePort() {
  const server = netServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
function native(command, args) {
  const result = spawnSync(command, args, { env: { ...process.env, ...displayEnv }, encoding: 'utf8', timeout: 10_000 });
  assert.equal(result.status, 0, redact(`${command}: ${result.stderr}`));
  return result.stdout.trim();
}
async function request(path, body, method = 'POST') {
  const response = await fetch(driverUrl + path, {
    method, headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(45_000),
  });
  const result = await response.json();
  if (result.value?.error) throw Error(redact(`${result.value.error}: ${result.value.message}`));
  assert.ok(response.ok);
  return result.value;
}
const command = (path, body, method) => request(`/session/${session}${path}`, body, method);
const execute = (script, args = []) => command('/execute/sync', { script, args });
const find = async selector => (await command('/element', { using: 'css selector', value: selector }))['element-6066-11e4-a52e-4f735466cecf'];
const click = async selector => command(`/element/${await find(selector)}/click`, {});
const review = operation => execute('return window.__TAURI_INTERNALS__.invoke("review_action",{ownerId:window.__nativeFixtureContext.owner(),operation:arguments[0]});', [operation]);
async function screenshot(name) {
  const encoded = await command('/screenshot', undefined, 'GET');
  await writeFile(join(artifacts, name), Buffer.from(encoded, 'base64'));
}
const peer = httpServer(async (request, response) => {
  try {
    if (request.url !== peerPath) { response.writeHead(404).end(); return; }
    if (request.method !== 'POST') { response.writeHead(405).end(); return; }
    let source = '';
    for await (const chunk of request) { source += chunk; assert.ok(source.length <= 131_072); }
    const message = JSON.parse(source);
    if (!Object.hasOwn(message, 'id')) { response.writeHead(202).end(); return; }
    let result;
    if (message.method === 'initialize') result = { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'Native fixture app', version: '1' } };
    else if (message.method === 'tools/list') result = { tools: [{ name: 'set_state', description: 'Set this isolated fixture app state.', inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false }, annotations: { readOnlyHint: false, destructiveHint: false } }] };
    else if (message.method === 'tools/call') {
      assert.equal(message.params.name, 'set_state');
      assert.equal(typeof message.params.arguments.value, 'string');
      peerState.value = message.params.arguments.value; peerState.effects++;
      result = { content: [{ type: 'text', text: JSON.stringify(peerState) }], isError: false };
    } else if (message.method === 'ping') result = {};
    else { response.writeHead(400).end(); return; }
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  } catch (error) {
    log = (log + '\nFixture peer: ' + error.message).slice(-32_000);
    if (!response.headersSent) response.writeHead(500);
    response.end();
  }
});
try {
  evidence.binarySha256 = hash(await readFile(binary));
  const bundleFiles = ['manuscript.html', ...(await readdir(join(uiDist, 'assets'))).map(name => 'assets/' + name)];
  evidence.uiBundle = await Promise.all(bundleFiles.sort().map(async path => ({ path, sha256: hash(await readFile(join(uiDist, path))) })));
  await mkdir(project); await mkdir(state, { recursive: true }); await mkdir(artifacts, { recursive: true });
  const original = '= Native gateway\n\nThe manuscript stays unchanged.\n';
  await writeFile(source, original);
  await writeFile(join(state, 'projects.json'), JSON.stringify({ projects: [{ id: projectId, name: 'Native gateway', root: project, repository: '', autoSync: false, pending: [], pendingRevisions: {} }] }));
  const zrokFixture = await createZrokFixture(fixture, targetFile, 'native-hub.example.invalid');
  await new Promise((resolve, reject) => { peer.once('error', reject); peer.listen(0, '127.0.0.1', resolve); });
  peerUrl = `http://127.0.0.1:${peer.address().port}${peerPath}`; secrets.push(peerUrl, peerPath);
  const xvfb = child(process.env.UNDERTREE_XVFB || 'Xvfb', ['-displayfd', '1', '-screen', '0', '1600x1000x24', '-nolisten', 'tcp']);
  let display = ''; xvfb.stdout.on('data', bytes => { display += bytes; });
  await until(() => display.trim() && xvfb.exitCode === null, 'Private Xvfb did not start.');
  displayEnv = { ...zrokFixture.environment, DISPLAY: `:${display.trim()}`, XDG_DATA_HOME: data, XDG_CONFIG_HOME: join(fixture, 'config'), XDG_CACHE_HOME: join(fixture, 'cache'), SESSION_MANAGER: '', UNDERTREE_ZROK: zrokFixture.executable };
  const wm = child(process.env.UNDERTREE_XFWM || 'xfwm4', ['--replace'], displayEnv);
  await until(() => wm.exitCode === null && native('xprop', ['-root', '_NET_SUPPORTING_WM_CHECK']).includes('window id'), 'Private window manager did not start.');
  const port = await freePort(), nativePort = await freePort(); driverUrl = `http://127.0.0.1:${port}`;
  const driver = child(process.env.UNDERTREE_TAURI_DRIVER || 'tauri-driver', ['--port', String(port), '--native-port', String(nativePort), '--native-host', '127.0.0.1'], displayEnv);
  driver.stdout.on('data', bytes => { log = (log + bytes).slice(-32_000); });
  await until(async () => driver.exitCode === null && await request('/status', undefined, 'GET'), 'Native WebDriver did not start.');
  const opened = await request('/session', { capabilities: { alwaysMatch: { 'tauri:options': { application: binary } } } });
  session = opened.sessionId; evidence.webDriverCapabilities = opened.capabilities;
  await until(() => execute('return !!document.querySelector(".file-button[data-path=\\"main.typ\\"]")'), 'Native project inventory did not render.');
  nativeWindow = native('xdotool', ['search', '--onlyvisible', '--name', '^UnderTree$']).split('\n')[0];
  nativePid = Number(native('xdotool', ['getwindowpid', nativeWindow]));
  await execute(nativeFixtureContextScript);
  await execute(`
    window.__nativeHubErrors=[];window.__nativeHubObservationErrors=[];window.__nativeHubSaveAttempts=0;window.__nativeHubCommands=[];window.__nativeHubLinks=[];window.__nativeHubFallback=false;
    addEventListener('error',event=>window.__nativeHubErrors.push(event.message));
    addEventListener('unhandledrejection',event=>window.__nativeHubErrors.push(event.reason?.message||String(event.reason)));
    const originalFetch=window.fetch,originalWarn=console.warn;
    console.warn=(...args)=>{if(args.some(value=>String(value).includes('IPC custom protocol failed')))window.__nativeHubFallback=true;return Reflect.apply(originalWarn,console,args);};
    window.fetch=function(input,init,...rest){
      let name,payload;
      try{const url=new URL(typeof input==='string'?input:input.url);if(url.protocol==='ipc:'||url.hostname==='ipc.localhost'){
        name=decodeURIComponent(url.pathname.slice(1));payload=JSON.parse(typeof init?.body==='string'?init.body:new TextDecoder().decode(init?.body));
        window.__nativeHubCommands.push({name,action:payload.operation?.action});
        if((name==='review_action'&&payload.operation?.action==='save')||(name==='editor_operation'&&payload.operation?.action==='editor_commit'))window.__nativeHubSaveAttempts++;
      }}catch{window.__nativeHubObservationErrors.push('Unsupported native IPC observation.');}
      const response=Reflect.apply(originalFetch,window,[input,init,...rest]);window.__nativeFixtureContext.observe(name,payload,response);
      if(name==='review_action'&&payload.operation?.action==='hub_link'){
        const link={label:payload.operation.label,endpointMatchesFixture:payload.operation.url===window.__nativeHubExpectedPeer,received:false};window.__nativeHubLinks.push(link);
        void Promise.resolve(response).then(async value=>{
          const reply=await value.clone().json();link.received=true;link.ok=value.headers.get('Tauri-Response')==='ok';
          link.reply={code:reply.code,message:reply.message,enabled:reply.enabled,appCount:reply.appCount,labels:reply.apps?.map(app=>app.label)};
        }).catch(error=>{link.received=true;link.ok=false;link.observationError=String(error.message);});
      }
      return response;
    };
    return true;
  `);
  await until(() => execute('return window.__nativeFixtureContext.status().ownerObserved'), 'A genuine native UI request did not reveal its current owner.');
  evidence.renderedAssets = await execute('return [...document.querySelectorAll("script[src],link[rel=stylesheet]")].map(item=>item.src||item.href);');
  await click('.file-button[data-path="main.typ"]');
  await until(() => execute('return document.querySelector(".cm-content")?.textContent.includes("The manuscript stays unchanged.")'), 'Native manuscript did not open.');
  await click('#menu-format-toggle'); await click('#palette-open'); await click('#palette-form button[type="submit"]');
  await until(() => stat(policy), 'Native color-rule setup did not persist.');
  await until(() => execute('return !document.getElementById("palette-dialog").open'), 'Native color-rule setup did not settle.');
  await click('#review-toggle'); await click('#manuscript-share'); await confirmNativeContextShare(click, execute, until);
  await click('#connection-open'); await click('#connection-tab-zrok');
  await execute('document.getElementById("zrok-name").value="native-hub-test";document.getElementById("zrok-origin").value="https://native-hub.example.invalid";');
  await click('#tunnel-start');
  await until(async () => (await review({ action: 'connection' })).running, 'The isolated fake-zrok tunnel did not start.');
  await click('#connection-tab-apps');
  await until(() => execute('return !document.getElementById("connection-hub-enabled").disabled'), 'The native gateway opt-in is unavailable.');
  assert.equal(await execute('return document.getElementById("connection-hub-enabled").checked'), false);
  await click('#connection-hub-enabled');
  await until(async () => (await review({ action: 'connection' })).gateway?.enabled, 'Native gateway opt-in did not succeed.');
  await until(() => execute('return ["connection-hub-label","connection-hub-upstream","connection-hub-link"].every(id=>!document.getElementById(id).disabled);'), 'Native app registration controls did not become ready.');
  await execute('window.__nativeHubExpectedPeer=arguments[0];document.getElementById("connection-hub-label").value="Native fixture app";document.getElementById("connection-hub-upstream").value=arguments[0];', [peerUrl]);
  evidence.registrationInput = await execute('return {label:document.getElementById("connection-hub-label").value,endpointMatchesFixture:document.getElementById("connection-hub-upstream").value===window.__nativeHubExpectedPeer,valid:document.getElementById("connection-hub-form").checkValidity(),disabled:document.getElementById("connection-hub-link").disabled};');
  assert.equal(evidence.registrationInput.endpointMatchesFixture, true); assert.equal(evidence.registrationInput.valid, true); assert.equal(evidence.registrationInput.disabled, false);
  await click('#connection-hub-link');
  await until(() => execute('return window.__nativeHubLinks.length>0;'), 'The native Link action did not dispatch hub_link IPC.', 10_000);
  await until(() => execute('return window.__nativeHubLinks.at(-1).received;'), 'Native app registration IPC did not return.');
  evidence.registrationReceipt = await execute('return window.__nativeHubLinks.at(-1);');
  assert.equal(evidence.registrationReceipt.endpointMatchesFixture, true);
  assert.equal(evidence.registrationReceipt.ok, true, redact(JSON.stringify(evidence.registrationReceipt)));
  await until(async () => (await review({ action: 'hub_status' })).apps.some(app => app.label === 'Native fixture app'), 'Native app registration did not finish.');
  await click('#connection-tab-app');
  await until(() => execute('return !document.getElementById("connection-app-enabled").disabled'), 'Native App-control opt-in is unavailable.');
  await click('#connection-app-enabled');
  await until(async () => (await review({ action: 'connection' })).appControls?.enabled, 'Native App-control grant did not enable.');
  let connection = await review({ action: 'connection' });
  const gatewayUrl = connection.gateway.endpoint, reviewUrl = connection.endpoint;
  for (const url of [gatewayUrl, reviewUrl, connection.appControls.endpoint]) secrets.push(url, new URL(url).pathname, new URL(url).pathname.split('/').pop());
  await click('#connection-tab-mcp');
  await until(() => execute('return document.getElementById("connection-url").value===arguments[0]', [gatewayUrl]), 'Overview did not show the one native gateway URL.');
  const target = await readFile(targetFile, 'utf8');
  const gatewayEndpoint = target + new URL(gatewayUrl).pathname, reviewEndpoint = target + new URL(reviewUrl).pathname;
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-06-18' };
  async function rpc(endpoint, method, params = {}) {
    const response = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }), signal: AbortSignal.timeout(45_000) });
    assert.equal(response.status, 200, method + ' HTTP status');
    const body = await response.json(); assert.equal(body.error, undefined, redact(JSON.stringify(body.error)));
    return body.result;
  }
  const tool = async (name, args = {}) => rpc(gatewayEndpoint, 'tools/call', { name, arguments: args });
  const value = reply => { assert.equal(reply.isError, false, redact(reply.content?.[0]?.text)); return reply.structuredContent.result; };
  const init = { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'Native gateway qualification', version: '1' } };
  await rpc(gatewayEndpoint, 'initialize', init);
  connection = await review({ action: 'connection' });
  assert.equal(connection.gateway.mcpInitialized, true); assert.equal(connection.mcpInitialized, false);
  await rpc(reviewEndpoint, 'initialize', init);
  assert.deepEqual((await rpc(reviewEndpoint, 'tools/list')).tools.map(tool => tool.name), ['list_manuscripts', 'read_manuscript', 'suggest_text', 'highlight_text']);
  const catalogue = (await rpc(gatewayEndpoint, 'tools/list')).tools;
  const alias = catalogue.find(tool => tool._meta?.['undertree/toolName'] === 'set_state')?.name;
  assert.ok(alias); assert.ok(catalogue.some(tool => tool.name === 'control_set_workspace_view'));
  checks.push('Actual native gateway and App-control opt-ins plus app registration expose one combined URL while the Review-only endpoint retains exactly four Review tools.');
  const wrongOwner = await execute('return window.__TAURI_INTERNALS__.invoke("review_action",{ownerId:"retired-fixture-owner",operation:{action:"hub_enable",enabled:false}}).then(()=>({ok:true}),error=>({ok:false,code:error.code}));');
  assert.equal(wrongOwner.ok, false); assert.equal((await review({ action: 'hub_status' })).enabled, true);
  const cli = JSON.parse(await readFile(join(state, 'cli', 'instance.json'), 'utf8')); secrets.push(cli.token);
  async function cliCall(operation) {
    const response = await fetch(cli.endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cli.token}`, 'X-UnderTree-Instance': cli.instanceId }, body: JSON.stringify(operation), signal: AbortSignal.timeout(10_000) });
    return response.json();
  }
  assert.equal((await cliCall({ action: 'hub_enable', enabled: false })).ok, false);
  const cliStatus = await cliCall({ action: 'connection' });
  assert.equal(cliStatus.result.gateway.endpoint, undefined);
  assert.ok(!JSON.stringify(cliStatus).includes(new URL(gatewayUrl).pathname));
  checks.push('The actual desktop IPC rejects a retired owner and its private CLI endpoint cannot configure or obtain the gateway capability.');
  await click('#connection-dialog [data-close]');
  const sourceBefore = hash(await readFile(source)), policyBefore = hash(await readFile(policy));
  const savesBefore = await execute('return window.__nativeHubSaveAttempts');
  const callsBefore = (await review({ action: 'connection' })).toolCalls;
  const remoteInput = { requestId: 'native-peer-effect', arguments: { value: 'through the shared native gateway' } };
  assert.equal((await tool(alias, remoteInput)).isError, false);
  assert.equal((await tool(alias, remoteInput)).isError, false);
  assert.equal(peerState.effects, 1); assert.equal(peerState.value, remoteInput.arguments.value);
  await until(async () => value(await tool('control_get_workspace')).workspace?.activeDocumentId, 'The real App-control bridge did not publish its active manuscript.');
  async function settled(name, args, requestId) {
    let receipt = value(await tool(name, { ...args, requestId }));
    await until(async () => { receipt = value(await tool('control_get_control_result', { requestId })); return !['queued', 'dispatched'].includes(receipt.state); }, name + ' did not receive a native acknowledgement.');
    assert.equal(receipt.state, 'applied', redact(JSON.stringify(receipt))); return receipt;
  }
  await settled('control_set_workspace_view', { reviewVisible: false }, 'native-hub-view');
  assert.equal(await execute('return document.querySelector(".review-workspace").dataset.reviewOpen'), 'false');
  const minimized = await settled('control_set_window_state', { state: 'minimize' }, 'native-hub-minimize');
  await until(() => native('xprop', ['-id', nativeWindow, 'WM_STATE']).includes('Iconic'), 'Gateway minimize did not affect the actual native window.');
  const restored = await settled('control_set_window_state', { state: 'restore' }, 'native-hub-restore');
  await until(() => native('xprop', ['-id', nativeWindow, 'WM_STATE']).includes('Normal'), 'Gateway restore did not affect the actual native window.');
  evidence.windowAcknowledgements = { minimize: minimized.result, restore: restored.result };
  connection = await review({ action: 'connection' });
  assert.ok(connection.toolCalls > callsBefore); assert.ok(connection.lastActivityMs > 0);
  assert.equal(hash(await readFile(source)), sourceBefore); assert.equal(hash(await readFile(policy)), policyBefore);
  assert.equal(await execute('return window.__nativeHubSaveAttempts'), savesBefore);
  assert.equal(await execute('return window.__nativeHubCommands.some(item=>item.name==="control_operation")'), true);
  checks.push('One gateway applies a peer effect once, changes the real native pane and X11 minimize/restore state, and updates activity without source/policy changes or save IPC.');
  await click('#connection-open'); await click('#connection-tab-app');
  await until(() => execute('return !document.getElementById("connection-app-enabled").disabled'), 'Native App-control revoke is unavailable.');
  await click('#connection-app-enabled');
  await until(async () => !(await review({ action: 'connection' })).appControls.enabled, 'Native App controls did not revoke.');
  const remaining = (await rpc(gatewayEndpoint, 'tools/list')).tools.map(tool => tool.name);
  assert.ok(remaining.includes(alias)); assert.ok(remaining.includes('read_manuscript')); assert.ok(!remaining.some(name => name.startsWith('control_')));
  assert.equal((await tool(alias, remoteInput)).isError, false); assert.equal(peerState.effects, 1);
  await click('#connection-tab-apps');
  await until(() => execute('return !document.getElementById("connection-hub-enabled").disabled'), 'Native gateway revoke is unavailable.');
  await click('#connection-hub-enabled');
  await until(async () => !(await review({ action: 'connection' })).gateway.enabled, 'Native gateway did not revoke.');
  const revoked = await fetch(gatewayEndpoint, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'ping' }), signal: AbortSignal.timeout(10_000) });
  assert.equal(revoked.status, 401);
  assert.deepEqual((await rpc(reviewEndpoint, 'tools/list')).tools.map(tool => tool.name), ['list_manuscripts', 'read_manuscript', 'suggest_text', 'highlight_text']);
  assert.equal(hash(await readFile(source)), sourceBefore); assert.equal(hash(await readFile(policy)), policyBefore);
  assert.equal(await execute('return window.__nativeHubSaveAttempts'), savesBefore);
  assert.deepEqual(await execute('return window.__nativeHubErrors'), []); assert.deepEqual(await execute('return window.__nativeHubObservationErrors'), []);
  assert.equal(await execute('return window.__nativeHubFallback'), false);
  assert.equal(hash(await readFile(binary)), evidence.binarySha256, 'The native binary changed during qualification.');
  for (const item of evidence.uiBundle) assert.equal(hash(await readFile(join(uiDist, item.path))), item.sha256, 'The recorded UI bundle changed during qualification.');
  await screenshot('native-gateway.png');
  checks.push('Real native App revocation removes only control aliases; gateway revocation denies its old bearer while the original Review endpoint remains available.');
  evidence.result = 'passed'; evidence.sourceSha256 = sourceBefore; evidence.policySha256 = policyBefore;
  console.log(`Native MCP gateway passed: ${checks.length} native UI/IPC/MCP/window checks; evidence in ${artifacts}. Public zrok and cross-PC ChatGPT remain untested.`);
} catch (error) {
  evidence.result = 'failed'; evidence.error = redact(error.message);
  if (session) evidence.nativeState = await execute('return {registration:window.__nativeHubLinks,errors:window.__nativeHubErrors,observationErrors:window.__nativeHubObservationErrors,buttonDisabled:document.getElementById("connection-hub-link")?.disabled,formValid:document.getElementById("connection-hub-form")?.checkValidity(),hubStatus:document.getElementById("connection-hub-status")?.textContent,connectionError:document.getElementById("connection-error")?.textContent,reviewStatus:document.getElementById("review-status")?.textContent,commands:window.__nativeHubCommands?.slice(-15)};').catch(() => null);
  if (session) await screenshot('native-gateway-failure.png').catch(() => {});
  throw Error(redact(error.message));
} finally {
  if (session) await review({ action: 'tunnel', enabled: false, reservation: '', public_url: '' }).catch(() => {});
  if (nativePid) try { process.kill(nativePid, 'SIGTERM'); } catch {}
  if (session) await command('', undefined, 'DELETE').catch(() => {});
  for (const processChild of [...processes].reverse()) if (processChild.pid) try { process.kill(-processChild.pid, 'SIGTERM'); } catch {}
  await pause(250);
  for (const processChild of processes) if (processChild.exitCode === null && processChild.pid) try { process.kill(-processChild.pid, 'SIGKILL'); } catch {}
  peer.closeAllConnections(); await new Promise(resolve => peer.close(resolve));
  evidence.log = redact(log); await mkdir(artifacts, { recursive: true });
  await writeFile(join(artifacts, 'native-gateway-evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
  await rm(fixture, { recursive: true, force: true });
}
