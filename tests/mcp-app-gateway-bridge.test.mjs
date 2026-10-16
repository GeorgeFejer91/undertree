import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import vm from 'node:vm';

const source = await readFile(new URL('../modules/review/src/mcp_hub/secret-tunnel-bridge.js', import.meta.url), 'utf8');
const aliases = { mcp_chat_decide: 'app_fixture_1', mcp_chat_receipt: 'app_fixture_2' };

function widget() {
  const sent = [], refused = [];
  const window = {
    parent: { postMessage: (message, origin) => sent.push({ message, origin }) },
    dispatchEvent: event => refused.push(event.data),
  };
  vm.runInNewContext(source.replace('__UNDERTREE_SECRET_TUNNEL_ALIASES__', JSON.stringify(aliases)), {
    window, crypto: { randomUUID }, queueMicrotask: callback => callback(),
    MessageEvent: class { constructor(_type, options) { Object.assign(this, options); } },
  });
  return { sent, refused, send: window.__undertreeSecretTunnelPostMessage };
}

test('Secret Tunnel bridge namespaces only the two card tools and retains stable bounded replay IDs', () => {
  const view = widget();
  const token = 'a'.repeat(64);
  const request = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
    name: 'mcp_chat_decide', arguments: { approval_token: token, kind: 'access', decision: 'approve' },
  } };
  view.send(request, '*');
  view.send(request, '*');
  const first = view.sent[0].message;
  assert.equal(first.params.name, aliases.mcp_chat_decide);
  assert.deepEqual(first.params.arguments.arguments, request.params.arguments);
  assert.match(first.params.arguments.requestId, /^[a-f0-9-]{36}$/);
  assert.equal(view.sent[1].message.params.arguments.requestId, first.params.arguments.requestId);
  assert.equal(request.params.name, 'mcp_chat_decide');
  view.send({ ...request, id: '1', params: { name: 'mcp_chat_receipt', arguments: { approval_token: token, kind: 'access' } } }, '*');
  assert.equal(view.sent[2].message.params.name, aliases.mcp_chat_receipt);
  assert.notEqual(view.sent[2].message.params.arguments.requestId, first.params.arguments.requestId);
  const other = widget();
  other.send(request, '*');
  assert.notEqual(other.sent[0].message.params.arguments.requestId, first.params.arguments.requestId);
  assert.equal(view.refused.length, 0);
});

test('Secret Tunnel bridge refuses other app/native tools and methods without forwarding private arguments', () => {
  const view = widget();
  for (const name of ['list_manuscripts', 'control_close_window', 'app_other_1', '__proto__', 'unknown']) {
    view.send({ jsonrpc: '2.0', id: name, method: 'tools/call', params: { name, arguments: { private: 'fixture-secret' } } }, '*');
  }
  view.send({ jsonrpc: '2.0', id: 7, method: 'resources/read', params: { uri: 'file:///private' } }, '*');
  view.send({ jsonrpc: '2.0', id: 8, method: 'ui/open-link', params: { url: 'https://private.invalid' } }, '*');
  assert.equal(view.sent.length, 0);
  assert.equal(view.refused.length, 7);
  assert.ok(view.refused.every(reply => reply.error.code === -32601));
  assert.ok(!JSON.stringify(view.refused).includes('fixture-secret'));
});

test('Secret Tunnel bridge preserves existing UI handshake/context and refuses requests beyond its bounded receipt map', () => {
  const view = widget();
  for (const method of ['ui/initialize', 'ui/notifications/initialized', 'ui/notifications/size-changed', 'ui/update-model-context']) {
    const message = { jsonrpc: '2.0', method, params: { fixture: true } };
    view.send(message, '*');
    assert.equal(view.sent.at(-1).message, message);
  }
  for (let id = 0; id < 129; id++) {
    view.send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'mcp_chat_receipt', arguments: {} } }, '*');
  }
  assert.equal(view.sent.length, 132);
  assert.equal(view.refused.length, 1);
  assert.equal(view.refused[0].id, 128);
  view.send({ jsonrpc: '2.0', id: 0, method: 'tools/call', params: { name: 'mcp_chat_receipt', arguments: {} } }, '*');
  assert.equal(view.sent.length, 133, 'A retained request remains retrievable at the bound.');
});
