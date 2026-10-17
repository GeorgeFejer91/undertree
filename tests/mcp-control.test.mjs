import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { assertMcpCommand, McpControlBridge } from '../src/mcp-control.js';

const workspace = () => ({
  openDocuments: [{ documentId: 'shared-1', revision: 'revision-1', dirty: false, conflict: false, composing: false }],
  activeDocumentId: 'shared-1',
  view: { filesVisible: true, editorVisible: true, previewVisible: true, reviewVisible: false, outlineVisible: true, logsVisible: false },
  editor: { fontSize: 12, wordWrap: true },
  preview: { page: 1, pages: 4, zoomPercent: 100 },
});
const job = (command, requestId = 'request-1') => ({ command, requestId, ackToken: 'local-ack' });
function fixture(command, overrides = {}) {
  const state = workspace(), calls = [], applied = [], errors = [];
  let jobs = [job(command)];
  const bridge = new McpControlBridge({
    snapshot: () => state,
    effects: { [command.kind]: async value => { applied.push(value); return { visible: true }; } },
    onError: error => errors.push(error),
    request: async operation => {
      calls.push(operation);
      if (overrides.request) return overrides.request(operation, state);
      if (operation.action === 'control_poll') { const pending = jobs; jobs = []; return { enabled: true, generation: 'grant-1', jobs: pending }; }
      if (operation.action === 'control_check') return { authorized: true, generation: 'grant-1' };
      return {};
    },
  });
  return { bridge, state, calls, applied, errors };
}

test('app controls reject content writes, generic proxies and extra replacement payloads', () => {
  for (const kind of ['save', 'save_editor', 'replace_source', 'accept', 'decide', 'sync', 'undo', 'format', 'create', 'import_tex', 'set_policy', 'review_action', 'constructor', '__proto__']) {
    assert.throws(() => assertMcpCommand({ kind, content: 'replacement' }, workspace()), error => error.code === 'arguments');
  }
  assert.throws(() => assertMcpCommand({ kind: 'open_manuscript', documentId: 'shared-1', content: 'replacement' }, workspace()), error => error.code === 'arguments');
});

test('open, compile and close reject dirty, conflicted or composing buffers including unshared tabs', () => {
  for (const flag of ['dirty', 'conflict', 'composing']) {
    const state = workspace();
    state.openDocuments.push({ documentId: 'private-tab', revision: 'private-revision', dirty: false, conflict: false, composing: false, [flag]: true });
    for (const command of [
      { kind: 'open_manuscript', documentId: 'shared-1' },
      { kind: 'compile_manuscript', documentId: 'shared-1', revision: 'revision-1' },
      { kind: 'set_window_state', state: 'close' },
    ]) assert.throws(() => assertMcpCommand(command, state), error => error.code === 'busy');
    assert.doesNotThrow(() => assertMcpCommand({ kind: 'set_workspace_view', logsVisible: true }, state));
  }
});

test('selection uses active saved revisions and UTF-16 ranges without replacement text', () => {
  const command = { kind: 'select_passage', documentId: 'shared-1', revision: 'revision-1', from: 2, to: 4, quote: '🌳' };
  assert.doesNotThrow(() => assertMcpCommand(command, workspace()));
  assert.throws(() => assertMcpCommand({ ...command, to: 3 }, workspace()));
  assert.throws(() => assertMcpCommand(command, { ...workspace(), activeDocumentId: 'other' }));
  assert.throws(() => assertMcpCommand({ ...command, revision: 'old' }, workspace()));
  assert.doesNotThrow(() => assertMcpCommand({ ...command, from: 2_097_150, to: 2_097_152 }, workspace()));
});

test('view settings retain readable bounds and a visible editor or preview', () => {
  for (const command of [
    { kind: 'set_workspace_view', editorVisible: false, previewVisible: false },
    { kind: 'set_editor_preferences', fontSize: 9 },
    { kind: 'set_editor_preferences', wordWrap: 'false' },
    { kind: 'set_preview_view', zoomPercent: 401 },
    { kind: 'set_preview_view', zoomPercent: 200, fitWidth: true },
    { kind: 'set_preview_view', page: 5 },
    { kind: 'set_window_state', state: 'execute' },
  ]) assert.throws(() => assertMcpCommand(command, workspace()));
  assert.doesNotThrow(() => assertMcpCommand({ kind: 'set_editor_preferences', fontSize: 28, wordWrap: null }, workspace()));
});

test('a new edit during native authorization blocks effects and returns a rejected receipt', async () => {
  const command = { kind: 'open_manuscript', documentId: 'shared-1' };
  const f = fixture(command, { request: async (operation, state) => {
    if (operation.action === 'control_poll') return { enabled: true, generation: 'grant-1', jobs: [job(command)] };
    if (operation.action === 'control_check') { state.openDocuments[0].dirty = true; return { authorized: true, generation: 'grant-1' }; }
    return {};
  } });
  await f.bridge.poll(); await f.bridge.drain();
  assert.equal(f.applied.length, 0);
  const completion = f.calls.find(call => call.action === 'control_complete');
  assert.equal(completion.outcome.state, 'rejected');
  assert.equal(completion.outcome.code, 'busy');
  assert.equal(f.state.openDocuments[0].dirty, true);
});

test('revoked grants and changed preview targets do not apply dispatched commands', async () => {
  for (const condition of ['revoked', 'navigation']) {
    const command = { kind: 'set_preview_view', page: 2 };
    const f = fixture(command, { request: async (operation, state) => {
      if (operation.action === 'control_poll') return { enabled: true, generation: 'grant-1', jobs: [job(command)] };
      if (operation.action === 'control_check') {
        if (condition === 'navigation') state.activeDocumentId = 'other';
        return { authorized: condition !== 'revoked', generation: 'grant-1' };
      }
      return {};
    } });
    await f.bridge.poll(); await f.bridge.drain();
    assert.equal(f.applied.length, 0);
    assert.equal(f.calls.at(-1).outcome.state, 'rejected');
  }
});

test('lost completion acknowledgements retry only the receipt, including duplicate dispatches', async () => {
  const command = { kind: 'set_workspace_view', logsVisible: true };
  let completions = 0;
  const f = fixture(command, { request: async operation => {
    if (operation.action === 'control_poll') return { enabled: true, generation: 'grant-1', jobs: [job(command)] };
    if (operation.action === 'control_check') return { authorized: true, generation: 'grant-1' };
    if (++completions === 1) throw new Error('Lost reply');
    return {};
  } });
  await f.bridge.poll(); await f.bridge.drain(); await f.bridge.poll(); await f.bridge.drain();
  assert.equal(f.applied.length, 1);
  assert.equal(completions, 2);
  assert.equal(f.errors.length, 1);
});

test('uncertain authorization before or after an effect never completes or replays that request', async () => {
  for (const phase of ['before', 'after']) {
    const command = { kind: 'set_window_state', state: 'focus' };
    const uncertain = { code: 'outcome_unknown', message: 'Inspect the existing request before another action.' };
    let checks = 0, effects = 0, acknowledged = 0;
    const f = fixture(command, { request: async operation => {
      if (operation.action === 'control_poll') return { enabled: true, generation: 'grant-1', jobs: [job(command)] };
      if (operation.action === 'control_check') {
        if (++checks === (phase === 'before' ? 1 : 2)) throw uncertain;
        return { authorized: true, generation: 'grant-1' };
      }
      return {};
    } });
    f.bridge.effects.set_window_state = async (value, guard) => {
      effects++;
      await guard.check();
      return { focused: true };
    };
    f.bridge.afterAcknowledged = () => { acknowledged++; };
    for (let poll = 0; poll < 3; poll++) { await f.bridge.poll(); await f.bridge.drain(); }
    assert.equal(effects, phase === 'before' ? 0 : 1);
    assert.equal(f.calls.filter(call => call.action === 'control_poll').length, 3, 'heartbeats remain available');
    assert.equal(f.calls.some(call => call.action === 'control_complete'), false, 'no false applied or rejected receipt');
    assert.equal(f.bridge.handled.has('grant-1:request-1'), true);
    assert.equal(f.bridge.handled.get('grant-1:request-1'), null, 'reserved without completion retry');
    assert.deepEqual(f.errors, [uncertain]);
    assert.equal(acknowledged, 0);
  }
});

test('uncertain Close preparation reports its error without running acknowledged Close', async () => {
  const command = { kind: 'set_window_state', state: 'close' };
  const f = fixture(command);
  const source = (await readFile(new URL('../src/manuscript.js', import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
  const environment = { pendingRemoteClose: null };
  const onError = runInNewContext(`(${source.match(/  onError: (.*),\n  onRevoked:/)[1]})`, environment);
  let closed = 0;
  f.bridge.effects.set_window_state = () => {
    environment.pendingRemoteClose = {};
    throw { code: 'outcome_unknown', message: 'Inspect the existing request.' };
  };
  f.bridge.onError = (error, failedCommand) => { f.errors.push(error); onError(error, failedCommand); };
  f.bridge.afterAcknowledged = () => { closed++; };
  await f.bridge.poll(); await f.bridge.drain();
  assert.equal(environment.pendingRemoteClose, null);
  assert.equal(closed, 0);
  assert.equal(f.calls.some(call => call.action === 'control_complete'), false);
  assert.equal(f.errors[0].code, 'outcome_unknown');
});

test('stopping while authorization is pending blocks the effect', async () => {
  const command = { kind: 'set_window_state', state: 'close' };
  let authorize;
  let ready;
  const checking = new Promise(resolve => { ready = resolve; });
  const f = fixture(command, { request: async operation => {
    if (operation.action === 'control_poll') return { enabled: true, generation: 'grant-1', jobs: [job(command)] };
    if (operation.action === 'control_check') return new Promise(resolve => { authorize = resolve; ready(); });
    return {};
  } });
  const pending = f.bridge.poll();
  await checking;
  f.bridge.stop();
  authorize({ authorized: true, generation: 'grant-1' });
  await pending;
  assert.equal(f.applied.length, 0);
});

test('preview jobs retain the document published before an awaiting poll', async () => {
  const command = { kind: 'set_preview_view', page: 2 };
  const f = fixture(command, { request: async (operation, state) => {
    if (operation.action === 'control_poll') {
      state.activeDocumentId = 'other';
      return { enabled: true, generation: 'grant-1', jobs: [job(command)] };
    }
    if (operation.action === 'control_check') return { authorized: true, generation: 'grant-1' };
    return {};
  } });
  await f.bridge.poll(); await f.bridge.drain();
  assert.equal(f.applied.length, 0);
  assert.equal(f.calls.at(-1).outcome.code, 'stale');
});

test('slow effects leave polling available and queued effects apply in order', async () => {
  const command = { kind: 'compile_manuscript', documentId: 'shared-1', revision: 'revision-1' };
  const f = fixture(command);
  let finish, began;
  const started = new Promise(resolve => { began = resolve; });
  f.bridge.effects.compile_manuscript = async () => {
    began(); await new Promise(resolve => { finish = resolve; });
    return { revision: 'revision-1' };
  };
  await f.bridge.poll(); await started;
  await f.bridge.poll();
  assert.equal(f.calls.filter(call => call.action === 'control_poll').length, 2, 'heartbeat continues while the build awaits');
  finish(); await f.bridge.drain();
  assert.equal(f.calls.at(-1).outcome.state, 'applied');
});

test('batched view changes recheck the state changed by the previous effect', async () => {
  const state = workspace(), outcomes = [];
  const bridge = new McpControlBridge({
    snapshot: () => state,
    effects: { set_workspace_view: command => { state.view.editorVisible = command.editorVisible ?? state.view.editorVisible; state.view.previewVisible = command.previewVisible ?? state.view.previewVisible; } },
    request: async operation => {
      if (operation.action === 'control_poll') return { enabled: true, generation: 'grant-1', jobs: [job({ kind: 'set_workspace_view', editorVisible: false }, 'hide-editor'), job({ kind: 'set_workspace_view', previewVisible: false }, 'hide-preview')] };
      if (operation.action === 'control_check') return { authorized: true, generation: 'grant-1' };
      outcomes.push(operation.outcome); return {};
    },
  });
  await bridge.poll(); await bridge.drain();
  assert.equal(state.view.editorVisible, false);
  assert.equal(state.view.previewVisible, true);
  assert.deepEqual(outcomes.map(outcome => outcome.state), ['applied', 'rejected']);
});

test('close lifecycle runs only after acknowledged completion and once after a lost reply', async () => {
  const command = { kind: 'set_window_state', state: 'close' };
  let completions = 0, closed = 0, restored = 0;
  const f = fixture(command, { request: async operation => {
    if (operation.action === 'control_poll') return { enabled: true, generation: 'grant-1', jobs: [job(command)] };
    if (operation.action === 'control_check') return { authorized: true, generation: 'grant-1' };
    if (++completions === 1) throw new Error('Lost receipt');
    return {};
  } });
  f.bridge.onAcknowledgementFailed = () => { restored++; };
  f.bridge.afterAcknowledged = (value, outcome) => { assert.deepEqual(value, command); assert.equal(outcome.state, 'applied'); closed++; };
  await f.bridge.poll(); await f.bridge.drain();
  assert.equal(closed, 0); assert.equal(restored, 1);
  await f.bridge.poll(); await f.bridge.drain();
  await f.bridge.poll(); await f.bridge.drain();
  assert.equal(closed, 1); assert.equal(f.applied.length, 1);
});

test('an unrelated heartbeat error preserves a prepared Close until its valid acknowledgement', async () => {
  const command = { kind: 'set_window_state', state: 'close' };
  const source = (await readFile(new URL('../src/manuscript.js', import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
  const environment = { pendingRemoteClose: null };
  const onError = runInNewContext(`(${source.match(/  onError: (.*),\n  onRevoked:/)[1]})`, environment);
  let polls = 0, completions = 0, acknowledge, ready, closed = 0;
  const completing = new Promise(resolve => { ready = resolve; });
  const f = fixture(command, { request: async operation => {
    if (operation.action === 'control_poll') {
      if (++polls === 2) throw { code: 'busy', message: 'The connection is processing another operation.' };
      return { enabled: true, generation: 'grant-1', jobs: [job(command)] };
    }
    if (operation.action === 'control_check') return { authorized: true, generation: 'grant-1' };
    completions++; ready();
    return new Promise(resolve => { acknowledge = resolve; });
  } });
  f.bridge.effects.set_window_state = () => { environment.pendingRemoteClose = {}; return { state: 'close_requested' }; };
  f.bridge.onError = onError;
  f.bridge.afterAcknowledged = () => { if (environment.pendingRemoteClose) { environment.pendingRemoteClose = null; closed++; } };
  await f.bridge.poll(); await completing;
  await f.bridge.poll();
  assert.notEqual(environment.pendingRemoteClose, null, 'unrelated poll error cannot cancel acknowledged Close');
  acknowledge({}); await f.bridge.drain();
  await f.bridge.poll(); await f.bridge.drain();
  assert.equal(closed, 1); assert.equal(completions, 1);
});

test('heartbeats do not duplicate an in-flight completion acknowledgement', async () => {
  const command = { kind: 'set_window_state', state: 'close' };
  let completions = 0, acknowledge, ready, closed = 0, failed = 0;
  const completing = new Promise(resolve => { ready = resolve; });
  const f = fixture(command, { request: async operation => {
    if (operation.action === 'control_poll') return { enabled: true, generation: 'grant-1', jobs: [job(command)] };
    if (operation.action === 'control_check') return { authorized: true, generation: 'grant-1' };
    completions++; ready();
    return new Promise(resolve => { acknowledge = resolve; });
  } });
  f.bridge.afterAcknowledged = () => { closed++; };
  f.bridge.onAcknowledgementFailed = () => { failed++; };
  await f.bridge.poll(); await completing;
  const heartbeat = f.bridge.poll(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(completions, 1, 'the original acknowledgement is still pending');
  assert.equal(failed, 0); assert.equal(closed, 0);
  await heartbeat;
  acknowledge({}); await f.bridge.drain();
  assert.equal(closed, 1); assert.equal(f.applied.length, 1);
});

test('a held receipt retry leaves later heartbeats available without replaying the effect', async () => {
  const command = { kind: 'set_workspace_view', logsVisible: true };
  let polls = 0, completions = 0, acknowledge, ready;
  const retrying = new Promise(resolve => { ready = resolve; });
  const f = fixture(command, { request: async operation => {
    if (operation.action === 'control_poll') { polls++; return { enabled: true, generation: 'grant-1', jobs: [job(command)] }; }
    if (operation.action === 'control_check') return { authorized: true, generation: 'grant-1' };
    if (++completions === 1) throw new Error('Lost first acknowledgement');
    ready(); return new Promise(resolve => { acknowledge = resolve; });
  } });
  await f.bridge.poll(); await f.bridge.drain();
  const retryPoll = f.bridge.poll(); await retrying;
  await f.bridge.poll();
  assert.equal(polls, 3, 'a pending receipt retry cannot hold the heartbeat lock');
  assert.equal(completions, 2); assert.equal(f.applied.length, 1);
  acknowledge({}); await retryPoll; await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.bridge.handled.get('grant-1:request-1'), null);
  assert.equal(f.errors.length, 1);
});

test('generation replacement discards late effects and pending completion callbacks', async () => {
  for (const phase of ['effect', 'ack']) {
    const command = { kind: 'set_window_state', state: 'close' };
    let grant = 'grant-1', polls = 0, finish, began, closed = 0, revoked = 0;
    const waiting = new Promise(resolve => { began = resolve; });
    const f = fixture(command, { request: async operation => {
      if (operation.action === 'control_poll') return { enabled: true, generation: grant, jobs: polls++ === 0 ? [job(command)] : [] };
      if (operation.action === 'control_check') return { authorized: true, generation: grant };
      if (phase === 'ack') { began(); return new Promise(resolve => { finish = resolve; }); }
      return {};
    } });
    f.bridge.afterAcknowledged = () => { closed++; };
    f.bridge.onRevoked = () => { revoked++; };
    if (phase === 'effect') f.bridge.effects.set_window_state = async () => { began(); await new Promise(resolve => { finish = resolve; }); };
    await f.bridge.poll(); await waiting;
    grant = 'grant-2';
    await f.bridge.poll();
    finish({}); await f.bridge.drain();
    assert.equal(f.bridge.handled.size, 0);
    assert.equal(closed, 0); assert.equal(revoked, 1);
  }
});

test('Unicode errors and numeric codes produce bounded valid acknowledgement values', async () => {
  const f = fixture({ kind: 'set_preview_view', page: 2 });
  f.bridge.effects.set_preview_view = () => { throw { code: 500, message: '🌳'.repeat(4000) }; };
  await f.bridge.poll(); await f.bridge.drain();
  const outcome = f.calls.at(-1).outcome;
  assert.equal(outcome.code, 'unavailable');
  assert.ok(Buffer.byteLength(outcome.message) <= 4000);
  assert.equal(outcome.state, 'rejected');
});

test('saved compilation callback is bound to the job and rechecks edits after async preparation', async () => {
  const command = { kind: 'compile_manuscript', documentId: 'shared-1', revision: 'revision-1' };
  const f = fixture(command);
  f.bridge.effects.compile_manuscript = async (value, guard) => {
    await Promise.resolve();
    f.state.openDocuments[0].dirty = true;
    return guard.compileSaved();
  };
  await f.bridge.poll(); await f.bridge.drain();
  assert.equal(f.calls.some(call => call.action === 'control_compile'), false);
  assert.equal(f.calls.at(-1).outcome.state, 'rejected');
});

test('native open and compile recheck the prepared local-operation guard immediately before sending', async () => {
  for (const kind of ['open_manuscript', 'compile_manuscript']) {
    const command = { kind, documentId: 'shared-1', ...(kind === 'compile_manuscript' ? { revision: 'revision-1' } : {}) };
    const f = fixture(command);
    f.bridge.effects[kind] = async (value, guard) => guard[kind === 'open_manuscript' ? 'openSaved' : 'compileSaved'](() => { throw { code: 'busy', message: 'A local operation began.' }; });
    await f.bridge.poll(); await f.bridge.drain();
    assert.equal(f.calls.some(call => call.action === 'control_open' || call.action === 'control_compile'), false);
    assert.equal(f.calls.at(-1).outcome.code, 'busy');
  }
});
