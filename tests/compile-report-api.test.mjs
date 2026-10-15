import test from 'node:test';
import assert from 'node:assert/strict';
const expectedRoot = { dev: '18446744073709551615', ino: '9007199254740993' }, revision = 'a'.repeat(64), id = '00000000-0000-0000-0000-000000000001';
const operation = () => ({ action: 'compile', project: id, path: 'main.typ', sourceEpoch: 2, expectedRoot: { ...expectedRoot }, revision });
const reply = () => ({ compileDiagnosticsVersion: 1, status: 'succeeded', report: { captureComplete: true, truncated: false, text: '', rows: [], sourceCandidates: [], provenance: { project: id, path: 'main.typ', sourceEpoch: 2, expectedRoot: { ...expectedRoot }, sourceDigest: revision, mainRevision: revision, nativeBuildId: id, instanceId: id } }, preview: { available: true, base64: 'JVBERi0=', revision, sourceEpoch: 2, expectedRoot: { ...expectedRoot }, current: true, diagnostics: '', dependencyCount: 1, dependencyCoverage: 'project', externalDependencyCount: 0 } });
const restore = t => { const previous = Object.fromEntries(['isTauri', 'window', 'location', 'sessionStorage', 'history', 'fetch'].map(key => [key, globalThis[key]])); t.after(() => Object.assign(globalThis, previous)); };
test('native Compile alone opts in outside the typed operation, freezing its root/main/revision before the existing owner await', async t => {
  restore(t); let release; const gate = new Promise(resolve => { release = resolve; }), calls = []; let result = reply(), retired = false;
  globalThis.isTauri = true; globalThis.window = { __TAURI_INTERNALS__: { invoke: async (command, args) => {
    calls.push({ command, args }); if (command === 'editor_connect') { await gate; return { protocolVersion: 1, ownerId: 'existing-owner' }; }
    if (retired) throw { code: 'stale_session' }; return args.operation.action === 'compile' ? result : {};
  } } };
  const api = await import(`../modules/frontend/review-api.js?compile-report=${Date.now()}`), source = operation(), pending = api.reviewRequest(source);
  source.expectedRoot.ino = '8'; source.path = 'chapter.typ'; source.sourceEpoch = 7; source.revision = 'b'.repeat(64); release();
  const compiled = await pending, native = calls.find(call => call.command === 'review_action');
  assert.deepEqual(native.args, { operation: operation(), ownerId: 'existing-owner', compileDiagnosticsVersion: 1 }); assert.equal(Object.hasOwn(native.args.operation, 'compileDiagnosticsVersion'), false);
  assert.equal(compiled.compileReport.status, 'succeeded'); assert.equal(compiled.revision, revision);
  await api.reviewRequest({ action: 'review', project: id, path: 'main.typ', expectedRoot });
  assert.equal(Object.hasOwn(calls.at(-1).args, 'compileDiagnosticsVersion'), false);
  result = { ...reply(), unexpected: true };
  await assert.rejects(api.reviewRequest(operation()), error => error.code === 'compile_report_format');
  assert.equal(calls.filter(call => call.args?.operation?.action === 'compile').length, 2, 'malformed report has no legacy fallback or recompile');
  retired = true; await assert.rejects(api.reviewRequest(operation()), error => error.code === 'stale_session');
  assert.equal(calls.filter(call => call.command === 'editor_connect').length, 1, 'retired owners cannot reconnect');
});
test('a native Compile cannot fall back to an unbound root or ownerless call', async t => {
  restore(t); const calls = [];
  globalThis.isTauri = true; globalThis.window = { __TAURI_INTERNALS__: { invoke: (...args) => { calls.push(args); } } };
  const api = await import(`../modules/frontend/review-api.js?compile-no-root=${Date.now()}`);
  for (const root of [undefined, null, { dev: '01', ino: '2' }]) await assert.rejects(api.reviewRequest({ ...operation(), expectedRoot: root }), error => error.code === 'format');
  assert.deepEqual(calls, []);
});
test('browser Compile keeps its existing HTTP body and legacy result without native diagnostics or another owner handshake', async t => {
  restore(t); const calls = [], legacy = { available: true, current: true, diagnostics: 'legacy text' };
  globalThis.isTauri = false; globalThis.window = {}; globalThis.location = new URL('http://localhost/manuscript.html');
  globalThis.sessionStorage = { getItem: () => 'local-token', setItem() {} }; globalThis.history = { replaceState() {} };
  globalThis.fetch = async (url, options) => { calls.push({ url, options }); return { ok: true, json: async () => ({ ok: true, result: legacy }) }; };
  const api = await import(`../modules/frontend/review-api.js?browser-compile-report=${Date.now()}`), result = await api.reviewRequest(operation());
  assert.equal(result, legacy); assert.equal(calls.length, 1); assert.equal(calls[0].url, '/api/review'); assert.deepEqual(JSON.parse(calls[0].options.body), operation());
});
