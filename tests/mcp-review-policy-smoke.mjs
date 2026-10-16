import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = await mkdtemp(join(tmpdir(), 'undertree-mcp-policy-'));
const projectRoot = join(root, 'project'), targetFile = join(root, 'target'), zrok = join(root, 'zrok-fixture');
const token = randomBytes(32).toString('hex');
const prose = 'Keep this wording. Reword this sentence. Obsolete idea. Rejected edits.';
const rules = [
  { id: 'keep', label: 'Keep exactly', color: '#196744', action: 'protect', prompt: '' },
  { id: 'revise', label: 'My instruction', color: '#c7a122', action: 'prompt', prompt: 'Use a concise active sentence.' },
  { id: 'remove', label: 'Discard idea', color: '#a54b8b', action: 'discard', prompt: '' },
  { id: 'refuse', label: 'Reject changes', color: '#b04132', action: 'reject', prompt: '' },
];
let service, base, endpoint, spawnFailure, log = '', rpcId = 0;
const delay = duration => new Promise(resolve => setTimeout(resolve, duration));
async function local(operation) {
  const response = await fetch(base + '/api/review', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(operation), signal: AbortSignal.timeout(15_000),
  });
  const body = await response.json();
  assert.equal(body.ok, true, body.error?.message);
  return body.result;
}
async function rpc(method, params = {}) {
  const response = await fetch(endpoint, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-06-18' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }), signal: AbortSignal.timeout(15_000),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.error, undefined, JSON.stringify(body.error));
  return body.result;
}
async function remote(name, args, error = false) {
  const result = await rpc('tools/call', { name, arguments: args });
  assert.equal(result.isError, error, result.content?.[0]?.text);
  return error ? result.content[0].text : JSON.parse(result.content[0].text);
}
try {
  await mkdir(projectRoot);
  await writeFile(join(projectRoot, 'main.typ'), prose);
  await writeFile(join(projectRoot, 'main.html'), `<p>${prose}</p>`);
  await writeFile(zrok, `#!/bin/sh\nprintf '%s' "$3" > '${targetFile}'\nexec sleep 180\n`);
  await chmod(zrok, 0o700);
  service = spawn(resolve(process.env.UNDERTREE_REVIEW_BINARY || 'target/debug/undertree-review'), ['serve'], {
    env: { ...process.env, UNDERTREE_REVIEW_PORT: '0', UNDERTREE_REVIEW_STATE: join(root, 'state'), UNDERTREE_REVIEW_TOKEN: token, UNDERTREE_ZROK: zrok },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  service.on('error', error => { spawnFailure = error; });
  for (const stream of [service.stdout, service.stderr]) stream.on('data', bytes => { log = (log + bytes).slice(-16_000); });
  const deadline = Date.now() + 20_000;
  while (!base && Date.now() < deadline) {
    if (spawnFailure) throw spawnFailure;
    const port = log.match(/127\.0\.0\.1:(\d+)/)?.[1];
    if (port) base = `http://127.0.0.1:${port}`;
    else { assert.equal(service.exitCode, null, log); await delay(50); }
  }
  assert.ok(base, log || 'The isolated Rust service did not start.');
  const project = await local({ action: 'add_project', root: projectRoot });
  const connection = await local({ action: 'tunnel', enabled: true, reservation: 'policy-fixture', public_url: 'https://review.example.org' });
  endpoint = (await readFile(targetFile, 'utf8')) + new URL(connection.endpoint).pathname;
  const notification = params => fetch(endpoint, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'APPLICATION/JSON, TEXT/EVENT-STREAM' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params }), signal: AbortSignal.timeout(15_000),
  });
  assert.equal((await notification({})).status, 400);
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'review-policy-smoke', version: '1' } });
  const initialized = await notification({ _meta: { trace: 'policy-fixture' } });
  assert.equal(initialized.status, 202);
  assert.equal(await initialized.text(), '');
  const legacy = await fetch(endpoint, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/list' }), signal: AbortSignal.timeout(15_000),
  });
  assert.equal(legacy.status, 200);
  assert.equal((await legacy.json()).result.tools.length, 3);
  assert.deepEqual((await rpc('tools/list')).tools.map(tool => tool.name), ['list_manuscripts', 'read_manuscript', 'suggest_text']);
  assert.deepEqual(await remote('list_manuscripts', {}), []);
  for (const path of ['main.typ', 'main.html']) {
    const sourceFile = join(projectRoot, path), original = await readFile(sourceFile, 'utf8');
    const opened = await local({ action: 'open', project: project.id, path });
    const binding = { project: project.id, path, sourceEpoch: opened.sourceEpoch, expectedRoot: opened.expectedRoot };
    await local({ action: 'palette', ...binding, revision: opened.review.revision, rules });
    for (const [quote, rule] of [['Keep this wording.', 'keep'], ['Reword this sentence.', 'revise'], ['Obsolete idea.', 'remove'], ['Rejected edits.', 'refuse']]) {
      const from = original.indexOf(quote);
      await local({ action: 'mark', ...binding, revision: opened.review.revision, from, to: from + quote.length, rule, prompt: rule === 'revise' ? 'Keep the scientific meaning.' : '' });
    }
    const share = await local({ action: 'share', ...binding, enabled: true });
    const documentId = share.documentId;
    const snapshot = await remote('read_manuscript', { documentId });
    assert.equal(snapshot.content, original);
    assert.deepEqual(snapshot.review.rules, rules);
    assert.equal(snapshot.review.markers.length, 4);
    const propose = async (requestId, quote, replacement, overrides = {}) => {
      const error = ['keep', 'refuse', 'not-deletion', 'partial', 'stale'].includes(requestId);
      const result = await remote('suggest_text', {
        documentId, proposal: { requestId: `${path}-${requestId}`, revision: snapshot.review.revision, from: original.indexOf(quote), to: original.indexOf(quote) + quote.length, quote, replacement, rationale: 'Respect the selected color rule and its instructions.', ...overrides },
      }, error);
      if (error) return result;
      assert.equal(result.manuscriptChanged, false);
      return result.suggestion;
    };
    assert.match(await propose('keep', 'Keep this wording.', 'Changed.'), /protect|allow|change/i);
    assert.match(await propose('refuse', 'Rejected edits.', 'Changed.'), /protect|reject|allow|change/i);
    assert.match(await propose('not-deletion', 'Obsolete idea.', 'A new idea.'), /discard|delet|remov/i);
    assert.match(await propose('partial', 'Obsolete', ''), /discard|delet|remov|entire/i);
    assert.match(await propose('stale', 'Reword this sentence.', 'A concise sentence.', { revision: '0'.repeat(64) }), /changed|refresh|revision/i);
    const suggestion = await propose('revise', 'Reword this sentence.', 'A concise sentence.');
    assert.equal(suggestion.color, rules[1].color);
    assert.match(suggestion.prompt, /Use a concise active sentence/);
    assert.match(suggestion.prompt, /Keep the scientific meaning/);
    assert.deepEqual(await propose('revise', 'Reword this sentence.', 'A concise sentence.'), suggestion);
    const deletion = await propose('delete', 'Obsolete idea.', '');
    assert.equal(deletion.replacement, '');
    assert.equal(deletion.color, rules[2].color);
    assert.equal(deletion.status, 'pending');
    assert.equal(await readFile(sourceFile, 'utf8'), original);
    for (const name of ['save', 'decide', 'palette', 'set_review_mode']) await remote(name, { documentId }, true);
    assert.equal(await readFile(sourceFile, 'utf8'), original);
    await local({ action: 'decide', ...binding, revision: snapshot.review.revision, id: suggestion.id, decision: 'rejected' });
    assert.equal(await readFile(sourceFile, 'utf8'), original);
    const accepted = await local({ action: 'decide', ...binding, revision: snapshot.review.revision, id: deletion.id, decision: 'accepted' });
    assert.equal(accepted.content, original.replace('Obsolete idea.', ''));
    assert.equal(await readFile(sourceFile, 'utf8'), accepted.content);
    assert.equal(accepted.review.markers.some(marker => marker.rule === 'remove'), false);
    assert.equal(accepted.review.markers.some(marker => marker.rule === 'keep'), true);
    await local({ action: 'share', ...binding, enabled: false });
    await remote('read_manuscript', { documentId }, true);
  }
  assert.deepEqual(await remote('list_manuscripts', {}), []);
  await local({ action: 'tunnel', enabled: false, reservation: '', public_url: '' });
  await assert.rejects(fetch(endpoint, { method: 'POST', signal: AbortSignal.timeout(2000) }));
  console.log('PASS: real Rust HTTP/MCP, custom colors and prompts, keep/reject precedence, deletion-only discard proposals, idempotency, local acceptance and revocation for Typst and HTML. zrok child simulated; public ChatGPT connection not tested.');
} finally {
  if (base && service?.exitCode === null) await local({ action: 'tunnel', enabled: false, reservation: '', public_url: '' }).catch(() => {});
  if (service?.pid && service.exitCode === null && service.signalCode === null) {
    const closed = new Promise(resolve => service.once('exit', resolve));
    service.kill('SIGTERM');
    await Promise.race([closed, delay(2000)]);
    if (service.exitCode === null && service.signalCode === null) { service.kill('SIGKILL'); await closed; }
  }
  await rm(root, { recursive: true, force: true });
}
