import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { editorLineHeights, normalizeWorkspacePreferences } from '../modules/frontend/manuscript-workspace.js';
import { captureControlState, assertControlState } from '../modules/frontend/manuscript-control-state.js';

const source = await readFile(new URL('../src/manuscript.js', import.meta.url), 'utf8');
const functions = source.slice(source.indexOf('function applyEditorPreferences()'), source.indexOf('function restoreWorkspacePreferences()'));
function setup({ composing = false, stored = true } = {}) {
  const props = {}, transactions = [], measures = [], messages = [];
  let opened = 0, closed = 0;
  const nodes = {
    'review-app': { style: { setProperty: (key, value) => { props[key] = value; } } },
    'settings-font-size': {}, 'settings-line-height': {}, 'settings-word-wrap': {}, 'settings-error': {},
    'editor-settings-form': { reportValidity: () => true }, 'editor-settings-dialog': { showModal: () => { opened += 1; }, close: () => { closed += 1; } },
  };
  const environment = {
    $: id => nodes[id], editorLineHeights, normalizeWorkspacePreferences,
    workspacePreferences: normalizeWorkspacePreferences({ version: 1, filesWidth: 375, editorFraction: .7, reviewOpen: true }),
    view: { compositionStarted: composing, lineWrapping: true, dispatch: value => transactions.push(value), requestMeasure: value => measures.push(value) },
    editorWrapping: { reconfigure: value => value }, EditorView: { lineWrapping: 'wrap' },
    document: { activeElement: {}, querySelectorAll: () => [] }, windowClosing: false, localRequestsVersion: 0,
    scheduleReviewPositions: () => {}, rememberWorkspace: () => stored, status: (...args) => messages.push(args),
  };
  const adapter = runInNewContext(functions + '\n({applyEditorPreferences,openEditorSettings,applyEditorSettings,fillEditorSettings});', environment);
  return { adapter, environment, nodes, props, transactions, measures, messages, opened: () => opened, closed: () => closed };
}
test('font and pinned spacing are presentation-only and request fresh review geometry without editor transactions', () => {
  const { adapter, environment, props, transactions, measures } = setup();
  environment.workspacePreferences.editorFontSize = 18; environment.workspacePreferences.editorLineHeight = 'compact';
  adapter.applyEditorPreferences();
  assert.equal(props['--source-font-size'], `${18 / 14}rem`); assert.equal(props['--source-line-height'], '1.33');
  assert.equal(transactions.length, 0); assert.equal(measures.length, 1);
  let aligned = 0; environment.scheduleReviewPositions = () => { aligned += 1; }; measures[0].write(); assert.equal(aligned, 1);
});
test('wrap applies only a Compartment effect, while Apply preserves pane choices and reports blocked persistence truthfully', () => {
  const { adapter, environment, nodes, transactions, messages, closed } = setup({ stored: false });
  nodes['settings-font-size'].value = '20'; nodes['settings-line-height'].value = 'wide'; nodes['settings-word-wrap'].checked = false;
  let prevented = false; adapter.applyEditorSettings({ preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true); assert.equal(closed(), 1); assert.equal(environment.workspacePreferences.editorLineHeight, 'wide');
  assert.equal(environment.workspacePreferences.filesWidth, 375); assert.equal(environment.workspacePreferences.editorFraction, .7); assert.equal(environment.workspacePreferences.reviewOpen, true);
  assert.deepEqual(Object.keys(transactions[0]), ['effects']); assert.equal(environment.localRequestsVersion, 1);
  assert.match(messages[0][0], /this session.*not be restored/); assert.equal(messages[0][1], true);
});
test('opening/settings reset only fill a draft; IME prevents opening and Apply without discarding that draft', () => {
  const { adapter, environment, nodes, opened, closed } = setup({ composing: true });
  assert.throws(() => adapter.openEditorSettings(), /./); assert.equal(opened(), 0); assert.equal(environment.localRequestsVersion, 0);
  environment.view.compositionStarted = false; environment.workspacePreferences.editorLineHeight = 'wide'; adapter.openEditorSettings();
  assert.equal(nodes['settings-line-height'].value, 'wide'); assert.equal(opened(), 1); assert.equal(environment.localRequestsVersion, 1);
  adapter.fillEditorSettings(normalizeWorkspacePreferences()); assert.equal(nodes['settings-line-height'].value, 'normal');
  assert.equal(environment.workspacePreferences.editorLineHeight, 'wide', 'Reset defaults does not apply until the local user submits');
  environment.view.compositionStarted = true; adapter.applyEditorSettings({ preventDefault: () => {} });
  assert.equal(closed(), 0); assert.equal(environment.workspacePreferences.editorLineHeight, 'wide'); assert.equal(nodes['settings-error'].hidden, false);
});
test('a held App effect cannot overwrite a newer local Apply even when it causes no source transaction', () => {
  const { adapter, environment, nodes, transactions } = setup();
  const context = () => ({ sessions: [], active: null, navigation: 1, requestsVersion: environment.localRequestsVersion, pending: 0, composing: false, closing: false });
  const captured = captureControlState(context());
  nodes['settings-font-size'].value = '18'; nodes['settings-line-height'].value = 'wide'; nodes['settings-word-wrap'].checked = true;
  adapter.applyEditorSettings({ preventDefault: () => {} });
  assert.equal(transactions.length, 0);
  assert.throws(() => assertControlState(captured, context()), error => error.code === 'stale');
  assert.equal(environment.workspacePreferences.editorFontSize, 18); assert.equal(environment.workspacePreferences.editorLineHeight, 'wide');
});
