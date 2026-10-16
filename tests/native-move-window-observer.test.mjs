import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { observeNativeMoveWindows } from './native-move-window-observer.mjs';
import { qualifyNativeMoveSelect } from './native-move-select-contract.mjs';
import { assertPopup } from './native-move-select-guards.mjs';

const childProcess = createRequire(import.meta.url)('node:child_process');
let childAttempts = 0;
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  childProcess[name] = () => { childAttempts++; throw new Error('No real child/tool allowed in observer models'); };
}
syncBuiltinESMExports();
after(() => { assert.equal(childAttempts, 0); console.log('PURE_OBSERVER_AUDIT childAttempts=0'); });
const properties = (pid = 42, type = '_NET_WM_WINDOW_TYPE_COMBO', transient = '0x10') =>
  `_NET_WM_PID(CARDINAL) = ${pid}\n_NET_WM_WINDOW_TYPE(ATOM) = ${type}\nWM_TRANSIENT_FOR(WINDOW): window id # ${transient}\n`;
const geometry = (state = 'IsViewable', width = 100, height = 40, left = 10, top = 20) =>
  `Map State: ${state}\nAbsolute upper-left X: ${left}\nAbsolute upper-left Y: ${top}\nWidth: ${width}\nHeight: ${height}\n`;
function fixture(options = {}) {
  const calls = []; let clock = 0;
  const inspectNative = (tool, args) => {
    calls.push({ tool, args }); clock += options.toolMs || 0;
    assert.ok(['/usr/bin/xprop', '/usr/bin/xwininfo'].includes(tool));
    assert.equal(args[0], '-id'); assert.match(args[1], /^0x[0-9a-f]+$/);
    if (tool.endsWith('xprop')) {
      assert.deepEqual(args.slice(2), ['_NET_WM_PID', '_NET_WM_WINDOW_TYPE', 'WM_TRANSIENT_FOR']);
      if (options.propertyError) throw options.propertyError;
      return options.propertyText ?? properties();
    }
    assert.equal(args.length, 2);
    if (options.geometryError) throw options.geometryError;
    return options.geometryText ?? geometry();
  };
  const observe = (ids = ['0x10'], phase = 'before-first-popup', extra = {}) => observeNativeMoveWindows(ids, {
    phase, appPid: 42, inspectNative, now: () => clock, ...extra,
  });
  return { calls, observe };
}
test('complete existing-ID metadata retains explicit state, ownership, type and geometry', () => {
  const f = fixture(), result = f.observe(['0x10', '0x11']);
  assert.equal(result.complete, true); assert.equal(result.inventoryCount, 2); assert.equal(result.attemptedRows, 2);
  assert.equal(result.skippedCount, 0); assert.equal(result.rows.length, 2); assert.equal(f.calls.length, 4);
  assert.equal(result.startedMs, 0); assert.equal(result.finishedMs, 0);
  const timed = f.observe(['0x10'], 'popup-failure', { now: () => 1234 });
  assert.equal(timed.startedMs, 1234); assert.equal(timed.finishedMs, 1234); assert.equal(timed.elapsedMs, 0);
  assert.deepEqual(result.rows[1], { id: '0x11', startedMs: 0, endedMs: 0, pid: 42, sameAppPid: true,
    popupTypes: ['COMBO'], typeClass: 'recognized-popup', transient: '0x10', mapState: 'IsViewable',
    geometry: { left: 10, top: 20, width: 100, height: 40 }, propertiesAvailable: true, geometryAvailable: true, errors: [] });
});
test('known unmapped and unviewable states remain distinct actual enums', () => {
  for (const state of ['IsUnMapped', 'IsUnviewable']) {
    const value = fixture({ geometryText: geometry(state) }).observe();
    assert.equal(value.complete, true); assert.equal(value.rows[0].mapState, state);
  }
});
test('unknown or missing map state is unavailable, never inferred unmapped', () => {
  for (const text of [geometry('Unknown'), 'Width: 10\nHeight: 20\n', '']) {
    const value = fixture({ geometryText: text }).observe();
    assert.equal(value.complete, false); assert.equal(value.rows[0].mapState, null);
    assert.equal(value.rows[0].geometryAvailable, false); assert.equal(value.unavailableRows, 1);
  }
});
test('missing ownership/type is recorded as missing and never fabricated', () => {
  const value = fixture({ propertyText: '' }).observe();
  assert.equal(value.rows[0].pid, null); assert.equal(value.rows[0].sameAppPid, null);
  assert.equal(value.rows[0].typeClass, 'missing'); assert.deepEqual(value.rows[0].popupTypes, []);
});
test('wrong PID and nonpopup type remain diagnostic without changing original strict acceptance', () => {
  const value = fixture({ propertyText: properties(99, '_NET_WM_WINDOW_TYPE_NORMAL') }).observe();
  assert.equal(value.rows[0].sameAppPid, false); assert.equal(value.rows[0].typeClass, 'other');
  assert.throws(() => assertPopup({ viewable: true, pid: 99, type: '_NET_WM_WINDOW_TYPE_NORMAL', left: 10, top: 20, width: 100, height: 40 }, 42));
});
test('known popup types use fixed classifications without retaining arbitrary property values', () => {
  const f = fixture({ propertyText: properties(42, '_NET_WM_WINDOW_TYPE_DROPDOWN_MENU, _NET_WM_WINDOW_TYPE_POPUP_MENU, PRIVATE_SECRET') });
  const value = f.observe(); assert.deepEqual(value.rows[0].popupTypes, ['DROPDOWN_MENU', 'POPUP_MENU']);
  assert.equal(JSON.stringify(value).includes('PRIVATE_SECRET'), false);
});
test('zero geometry is observable but cannot satisfy the original positive popup assertion', () => {
  const result = fixture({ geometryText: geometry('IsViewable', 0, 0) }).observe();
  assert.equal(result.rows[0].geometryAvailable, true); assert.equal(result.rows[0].geometry.width, 0);
  assert.throws(() => assertPopup({ viewable: true, pid: 42, type: '_NET_WM_WINDOW_TYPE_COMBO', left: 10, top: 20, width: 0, height: 0 }, 42));
});
test('nonfinite, unsafe and negative-size geometry becomes unavailable', () => {
  for (const text of [geometry('IsViewable', -1), geometry('IsViewable', 'Infinity'), geometry('IsViewable', '999999999999999999999999999')]) {
    const value = fixture({ geometryText: text }).observe(); assert.equal(value.rows[0].geometryAvailable, false); assert.equal(value.rows[0].mapState, null);
  }
});
test('tool and disappeared-ID errors retain fixed error metadata only', () => {
  const error = Object.assign(new Error('do not retain private title/source'), { code: 'ENOENT', status: 1, signal: 'SIGKILL', stderr: 'private payload' });
  const value = fixture({ propertyError: error, geometryError: error }).observe();
  assert.equal(value.complete, false); assert.equal(value.unavailable, 'partial-inspection'); assert.equal(value.unavailableRows, 1);
  assert.deepEqual(value.rows[0].errors, [{ part: 'properties', code: 'ENOENT', status: 1, signal: 'SIGKILL' }, { part: 'geometry', code: 'ENOENT', status: 1, signal: 'SIGKILL' }]);
  assert.equal(JSON.stringify(value).includes('private'), false); assert.equal(value.rows[0].mapState, null);
});
test('invalid ownership/transient values and overlong raw parser outputs remain unavailable', () => {
  for (const propertyText of [properties('99999999999999999999999999'), properties(42, '_NET_WM_WINDOW_TYPE_COMBO', '0x' + '1'.repeat(17)), 'x'.repeat(16385)]) {
    const value = fixture({ propertyText }).observe(); assert.equal(value.rows[0].propertiesAvailable, false); assert.equal(value.rows[0].pid, null);
  }
  const value = fixture({ geometryText: 'x'.repeat(16385) }).observe(); assert.equal(value.rows[0].geometryAvailable, false);
});
test('at most128 rows are admitted before growth;129 and malformed IDs launch no tools', () => {
  const ids = Array.from({ length: 128 }, (_, i) => '0x' + (i + 1).toString(16)), f = fixture();
  assert.equal(f.observe(ids).rows.length, 128); assert.equal(f.calls.length, 256);
  for (const value of [[...ids, '0x100'], ['0x10', '0x10'], ['bad'], ['0x' + 'f'.repeat(17)], null]) {
    const next = fixture(), result = next.observe(value); assert.equal(result.complete, false); assert.equal(result.rows.length, 0); assert.equal(next.calls.length, 0);
  }
});
test('pair admission accepts exactly4s remaining and stops before the next pair', () => {
  const f = fixture({ toolMs: 2000 }), result = f.observe(['0x10', '0x11', '0x12']);
  assert.equal(result.elapsedMs, 8000); assert.equal(result.attemptedRows, 2); assert.equal(result.rows.length, 2);
  assert.equal(result.skippedCount, 1); assert.deepEqual(result.skippedIds, ['0x12']); assert.equal(result.unavailable, 'budget');
  assert.equal(result.complete, false); assert.equal(f.calls.length, 4);
});
test('less than4s remaining refuses a pair without retry', () => {
  const f = fixture(); let count = 0;
  const result = f.observe(['0x10'], 'before-first-popup', { now: () => count++ === 0 ? 0 : 4001 });
  assert.equal(result.attemptedRows, 0); assert.equal(f.calls.length, 0); assert.equal(result.skippedCount, 1);
});
test('unknown, regressing or throwing clock records unavailable without original-gate effects', () => {
  for (const now of [() => NaN, () => Infinity, () => -1, () => { throw new Error('private clock error'); }]) {
    const f = fixture(), value = f.observe(['0x10'], 'popup-failure', { now });
    assert.equal(value.unavailable, 'observer'); assert.equal(value.complete, false); assert.equal(f.calls.length, 0);
  }
  let count = 0; const f = fixture(), value = f.observe(['0x10'], 'popup-failure', { now: () => count++ === 0 ? 10 : 9 });
  assert.equal(value.unavailable, 'observer'); assert.equal(f.calls.length, 0);
});
test('invalid phase or missing app authority refuses metadata without any probe', () => {
  const f = fixture(); assert.equal(f.observe(['0x10'], 'arbitrary-private-label').unavailable, 'invalid-input');
  assert.equal(f.observe(['0x10'], 'popup-failure', { appPid: null }).unavailable, 'invalid-input'); assert.equal(f.calls.length, 0);
});

function currentRead(focused) {
  const body = { left: 10, right: 300, top: 100, bottom: 350, width: 290, height: 250 };
  return { dialogOpen: true, modal: true, documentFocused: true, viewport: { width: 320, height: 480 },
    dialog: { left: 0, right: 320, top: 0, bottom: 480 }, body, title: { top: 10, bottom: 90 }, footer: { top: 360, bottom: 470 },
    dialogScrollHeight: 478, dialogClientHeight: 478, bodyScrollWidth: 290, bodyClientWidth: 290,
    status: { fit: 'details', text: 'Prepared status' }, statusSurface: { sourceId: 'file-move-status', focused: !focused,
      connected: true, hidden: false, disabled: false, display: 'block', visibility: 'visible',
      box: { left: 20, right: 280, top: 110, bottom: 150, width: 260, height: 40 }, mode: 'details', sourceDisplay: 'none',
      tag: 'BUTTON', hasPopup: 'dialog', label: 'Move result details', title: 'Move result details', sourceRole: 'status',
      accessibleName: 'Move result details: Prepared status' },
    activeId: focused ? 'file-move-requests' : '', options: [{ value: '', text: 'New source Move' },
      { value: '1:12345678-1234-1234-1234-123456789abc', text: 'z-ui-source.typ → moves/z-ui-moved.typ · prepared' }],
    selected: '1:12345678-1234-1234-1234-123456789abc', identity: { text: 'Generation1' }, detailOpen: false, draftHidden: true,
    associated: true, onlySelect: true, wrapperClass: 'file-move-request-select', focusWithin: true,
    outline: { style: 'solid', width: 2, offset: -2, color: 'rgb(0,96,223)' },
    appearance: 'auto', contain: 'paint', overflowX: 'hidden', overflowY: 'hidden', wrapper: { left: 20, right: 280, top: 160, bottom: 210 } };
}
async function runOriginalFailure(metadataErrors = false, suffix = '') {
  let focused = false, opened = false, trees = 0, executes = 0, firstProperties = true;
  const keys = [], screenshots = [], evidence = {}, original = new Error('Native request popup was not observable as a new viewable same-app X11 popup; popup coverage remains unqualified.' + suffix);
  const inspectNative = (tool, args) => {
    if (tool === '/usr/bin/xwininfo' && args[0] === '-root') {
      trees++; return 'xwininfo: Window id: 0x1\nRoot window id: 0x1\n 0x10 existing app\n 0x11 preexisting popup\n';
    }
    const id = args[1] === '16' ? '0x10' : args[1];
    if (firstProperties) { firstProperties = false; return properties(42, '_NET_WM_WINDOW_TYPE_NORMAL'); }
    if (metadataErrors) throw new Error('private inspection failure');
    if (tool === '/usr/bin/xprop') return properties(42, id === '0x11' ? '_NET_WM_WINDOW_TYPE_COMBO' : '_NET_WM_WINDOW_TYPE_NORMAL');
    return geometry(id === '0x11' && !opened ? 'IsUnMapped' : 'IsViewable');
  };
  const execute = async script => { executes++; return script.includes('__nativeMoveUiDispatch.length') ? 0 : currentRead(focused); };
  const native = (tool, args) => { assert.equal(tool, 'xdotool'); const key = args.at(-1); keys.push(key); if (key === 'shift+Tab') focused = true; if (key === 'alt+Down') opened = true; };
  const waitFor = async check => { const value = await check(); if (value) return value; throw original; };
  await assert.rejects(qualifyNativeMoveSelect({ execute, command: () => { throw Error('unexpected command'); }, click: () => { throw Error('unexpected click'); },
    waitFor, native, nativeWindow: '16', screenshot: async name => { screenshots.push(name); }, inspectNative, evidence, checks: [] }), error => error === original);
  return { keys, screenshots, evidence, trees, executes };
}
test('actual wrapper records an existing unmapped→viewable popup but original new-ID gate still fails', async () => {
  const value = await runOriginalFailure(), popup = value.evidence.nativeMoveSelect.popup;
  assert.deepEqual(value.keys, ['shift+Tab', 'alt+Down']); assert.equal(value.trees, 2); assert.equal(value.executes, 4);
  assert.deepEqual(value.screenshots, ['native-move-request-select-focus.png', 'native-move-request-select-failure.png']);
  assert.deepEqual(popup.latest.added, []); assert.equal(value.evidence.nativeMoveSelect.result, 'failed');
  const before = popup.windowMetadata.before.rows.find(r => r.id === '0x11'), after = popup.windowMetadata.failure.rows.find(r => r.id === '0x11');
  assert.equal(before.mapState, 'IsUnMapped'); assert.equal(after.mapState, 'IsViewable'); assert.equal(after.sameAppPid, true);
  assert.deepEqual(after.popupTypes, ['COMBO']); assert.equal(popup.result, 'not observed');
});
test('actual wrapper preserves original key/read/error counts when metadata inspections fail', async () => {
  const value = await runOriginalFailure(true), metadata = value.evidence.nativeMoveSelect.popup.windowMetadata;
  assert.equal(metadata.before.complete, false); assert.equal(metadata.failure.complete, false);
  assert.equal(metadata.before.rows[0].mapState, null); assert.equal(metadata.failure.rows[0].mapState, null);
  assert.deepEqual(value.keys, ['shift+Tab', 'alt+Down']); assert.equal(value.trees, 2); assert.equal(value.executes, 4);
  assert.equal(JSON.stringify(metadata).includes('private inspection failure'), false);
});
test('original wait error with appended last-inspection detail still captures metadata and retains identity', async () => {
  const value = await runOriginalFailure(false, ': last inspection failure');
  assert.equal(value.evidence.nativeMoveSelect.popup.windowMetadata.failure.complete, true);
  assert.match(value.evidence.nativeMoveSelect.error, /: last inspection failure$/);
  assert.deepEqual(value.keys, ['shift+Tab', 'alt+Down']); assert.equal(value.trees, 2); assert.equal(value.executes, 4);
});
test('original strict positive predicate still needs owner, popup type, viewability and positive geometry', () => {
  const valid = { pid: 42, type: '_NET_WM_WINDOW_TYPE_COMBO', viewable: true, left: 0, top: 0, width: 50, height: 30 };
  assert.doesNotThrow(() => assertPopup(valid, 42));
  for (const change of [{ pid: 99 }, { type: '_NET_WM_WINDOW_TYPE_NORMAL' }, { viewable: false }, { width: 0 }, { height: NaN }]) {
    assert.throws(() => assertPopup({ ...valid, ...change }, 42));
  }
});
