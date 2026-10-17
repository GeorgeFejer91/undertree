import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { HistoryController } from '../modules/frontend/history-controller.js';
import { sourceRoot } from '../modules/frontend/review-session.js';
import { createHash } from 'node:crypto';
import { captureControlState, assertControlState } from '../modules/frontend/manuscript-control-state.js';

const code = (await readFile(new URL('../src/history-panel.js', import.meta.url), 'utf8')).replace(/^import .*;\r?\n/gm, '').replace('export class HistoryPanel', 'class HistoryPanel');
const id = n => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const root = { dev: '9007199254740993', ino: '18446744073709551615' }, project = id(1), namespace = id(2), source = id(3);
const summary = (n, content) => ({ versionId: id(n), namespaceId: namespace, sourceId: source, binding: { projectId: project, root, path: 'chapter.typ', sourceEpoch: 7 }, sha256: createHash('sha256').update(content).digest('hex'), bytes: Buffer.byteLength(content), sequence: String(n), capturedAtMs: null, recordedAtMs: null, clockAdjusted: false, afterRecovery: false, cause: 'native_save', suggestionId: null });
const texts = ['Saved earlier', 'Saved later', 'Saved third']; const versions = texts.map((text, i) => summary(i + 4, text));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const list = items => ({ kind: 'list', result: { generation: '9007199254740993', namespaceId: namespace, items, cursor: null } });
function reply(query) {
  if (query.action === 'list') return list(query.sourceId ? versions.map(version => ({ kind: 'version', version })) : [{ kind: 'source', namespaceId: namespace, sourceId: source, path: 'chapter.typ', sourceEpoch: 7 }]);
  const saved = versionId => { const i = versions.findIndex(version => version.versionId === versionId); return { version: versions[i], content: texts[i] }; };
  if (query.action === 'read') return { kind: 'read', result: saved(query.versionId) };
  const from = saved(query.fromVersionId), to = saved(query.toVersionId);
  return { kind: 'compare', result: { from, to, fromChanged: { fromUtf16: 0, toUtf16: from.content.length }, toChanged: { fromUtf16: 0, toUtf16: to.content.length }, method: 'coarse_text_comparison' } };
}
class Element {
  constructor(tag = 'div') { this.tag = tag; this.children = []; this.dataset = {}; this.attributes = {}; this.listeners = {}; this.hidden = false; }
  set textContent(value) { this.text = value; this.children = []; } get textContent() { return this.text || ''; }
  append(...items) { this.children.push(...items); } replaceChildren(...items) { this.children = items; }
  setAttribute(key, value) { this.attributes[key] = value; } addEventListener(name, callback) { this.listeners[name] = callback; }
  focus() { this.focused = true; }
  querySelectorAll(selector) { return this.children.flatMap(child => [...(selector === 'input' && child.tag === 'input' ? [child] : []), ...child.querySelectorAll(selector)]); }
}
function fixture({ request = reply, owner = async () => 'same-owner' } = {}) {
  const nodes = Object.fromEntries(['back', 'current', 'folders', 'sources', 'versions', 'refresh', 'next', 'compare', 'status', 'location', 'details', 'list', 'result', 'actions'].map(name => [name, new Element()]));
  const region = new Element(), navigation = { open: false }, document = { createElement: tag => new Element(tag), querySelector: () => null };
  region.querySelector = selector => selector === '.history-navigation' ? navigation : nodes[selector.slice('#history-'.length)]; region.ownerDocument = document;
  const current = { session: { dirty: true, content: 'Newest draft', generation: 1 }, viewToken: {}, editor: { current: true }, projectId: project, root, path: 'chapter.typ', sourceEpoch: 7 };
  let intents = 0; const visible = [], returned = [], calls = [], created = [], destroyed = [];
  const { HistoryPanel } = runInNewContext(code + '\n({HistoryPanel});', { HistoryController, sourceRoot, document, Object, Error });
  const panel = new HistoryPanel({ root: region, request: async query => { calls.push(query); return request(query); }, owner, context: () => current, intent: () => { intents += 1; }, visibility: value => visible.push(value), back: editor => returned.push(editor), createView: (parent, saved, changed, label) => {
    const view = { parent, saved, changed, label, requestMeasure() {}, destroy() { destroyed.push(this); } }; created.push(view); return view;
  } });
  return { panel, region, nodes, current, calls, created, destroyed, returned, visible, document, intents: () => intents };
}
async function browse(f) { await f.panel.open(); await f.panel.controller.selectSource(source); }

test('owner wait rechecks captured session/view/root/epoch before any History request and never stores draft state', async () => {
  for (const key of ['session', 'viewToken', 'projectId', 'root', 'path', 'sourceEpoch']) {
    const gate = deferred(), f = fixture({ owner: () => gate.promise }), opening = f.panel.open();
    f.current[key] = { session: {}, viewToken: {}, projectId: id(9), root: { ...root, ino: '2' }, path: 'other.typ', sourceEpoch: 8 }[key];
    gate.resolve('same-owner'); assert.equal(await opening, false); assert.equal(f.calls.length, 0, key); assert.equal(f.nodes.status.textContent.includes('identity changed'), true);
    f.panel.back(); assert.equal(f.returned[0], f.current.editor); assert.equal(f.panel.visible, false);
  }
});

test('same-session edits/save advancement leave an immutable saved read usable, and Back returns the latest editor', async () => {
  const gate = deferred(), f = fixture({ request: query => query.action === 'read' ? gate.promise : reply(query) }); await browse(f);
  for (const key of ['saveCurrent', 'flush', 'mutate', 'queue']) Object.defineProperty(f.current.session, key, { get() { throw Error('No writer access'); } });
  const reading = f.panel.controller.read(id(4)); f.current.session.content = 'Newest after typing'; f.current.session.generation += 1; f.current.session.dirty = false; f.panel.changed();
  gate.resolve(reply({ action: 'read', versionId: id(4) })); assert.equal(await reading, true); assert.equal(f.created[0].saved.content, texts[0]);
  f.current.editor = { latest: true }; f.panel.back(); assert.equal(f.returned[0], f.current.editor); assert.equal(f.destroyed.length, 1); assert.equal(f.current.session.content, 'Newest after typing');
  assert.deepEqual(f.visible, [true, false]); assert.equal(f.calls.every(query => ['list', 'read', 'compare'].includes(query.action)), true);
});

test('Back is immediate during native work and a late reply cannot install saved editors or reopen the region', async () => {
  const gate = deferred(), f = fixture({ request: query => query.action === 'read' ? gate.promise : reply(query) }); await browse(f);
  const reading = f.panel.controller.read(id(4)); f.panel.back(); gate.resolve(reply({ action: 'read', versionId: id(4) })); await reading;
  assert.equal(f.panel.visible, false); assert.equal(f.region.hidden, true); assert.equal(f.created.length, 0); assert.equal(f.nodes.result.children.length, 0);
});

test('the page permits at most two comparison choices, orders by sequence and disposes old saved views', async () => {
  const f = fixture(); await browse(f); const choices = f.nodes.list.querySelectorAll('input');
  for (const index of [1, 0, 2]) { choices[index].checked = true; choices[index].onchange(); }
  assert.equal(f.panel.selected.size, 2); assert.equal(choices[2].checked, false); assert.equal(choices[2].disabled, true);
  await f.nodes.compare.onclick(); assert.equal(f.calls.at(-1).fromVersionId, id(4)); assert.equal(f.calls.at(-1).toVersionId, id(5)); assert.equal(f.created.length, 2);
  assert.match(f.nodes.details.textContent, /chapter.typ.*\nSaved versions only.*\nEarlier: Version 4.*\nLater: Version 5.*\nCoarse changed region highlighted./);
  await f.panel.controller.read(id(6)); assert.equal(f.destroyed.length, 2); assert.equal(f.created.length, 3); assert.equal(f.panel.views.length, 1);
  await f.nodes.versions.onclick(); assert.equal(f.panel.showResult, false); assert.equal(f.nodes.list.hidden, false); assert.equal(f.calls.length, 4);
});

test('Escape preserves IME/nested-dialog ownership; ordinary Escape closes only the History region', async () => {
  const f = fixture(); await f.panel.open(); const event = { key: 'Escape', isComposing: true, preventDefault() {}, stopPropagation() {} };
  f.region.listeners.keydown(event); assert.equal(f.panel.visible, true);
  event.isComposing = false; f.document.querySelector = () => ({}); f.region.listeners.keydown(event); assert.equal(f.panel.visible, true);
  f.document.querySelector = () => null; f.region.listeners.keydown(event); assert.equal(f.panel.visible, false); assert.equal(f.calls.length, 1);
});

test('actual manuscript History presentation invalidates a prepared App effect without adding pending work, and logs refusal precedes effects', async () => {
  const source = await readFile(new URL('../src/manuscript.js', import.meta.url), 'utf8');
  const wiring = source.slice(source.indexOf('let historyPresentation ='), source.indexOf('const windowEditing ='));
  const snapshot = source.slice(source.indexOf('function controlWorkspaceSnapshot()'), source.indexOf('function setCompileLogs('));
  const effects = source.slice(source.indexOf('const controlEffects ='), source.indexOf('function publicationPath('));
  let options, writes = 0;
  const workspace = { dataset: new Proxy({}, { set(target, key, value) { writes += 1; target[key] = value; return true; } }) };
  const environment = { HistoryPanel: class { constructor(value) { options = value; this.visible = true; } }, historyRequest() {}, editorOwnerId() {}, $: () => ({ dataset: {} }), workspace, localRequestsVersion: 0,
    document: { querySelector: () => ({ classList: { toggle() {} } }) }, sourceRoot, sessions: new Map(), active: null, view: null, windowClosing: false,
    controlPreparation: () => ({ check: async () => {}, assert() {} }), controlPreviewIdentity: () => { throw Error('A hidden PDF cannot be projected'); }, showingLogs: true,
    pdfViewer: { ready: true }, workspacePreferences: {}, mobileView() {},
  };
  const adapter = runInNewContext(wiring + snapshot + effects + '\n({intent:()=>historyPanel.intent,hiddenPreview:()=>controlPreview(),snapshot:()=>controlWorkspaceSnapshot(),logs:()=>controlEffects.set_workspace_view({logsVisible:true}, {})});', environment);
  const current = () => ({ sessions: [], active: null, navigation: 1, requestsVersion: environment.localRequestsVersion, pending: 0, composing: false, closing: false });
  const before = captureControlState(current()); options.intent(); assert.equal(environment.localRequestsVersion, 1); assert.equal(current().pending, 0);
  assert.throws(() => assertControlState(before, current()), error => error.code === 'stale');
  assert.equal(adapter.hiddenPreview(), null); assert.equal(adapter.snapshot().view.logsVisible, false);
  await assert.rejects(adapter.logs(), error => error.code === 'unavailable'); assert.equal(writes, 0);
});

test('the actual manuscript context retires a selected-project or map replacement before owner/query waits finish', async () => {
  const source = await readFile(new URL('../src/manuscript.js', import.meta.url), 'utf8');
  const wiring = source.slice(source.indexOf('let historyPresentation ='), source.indexOf('const windowEditing ='));
  let options; const selected = { value: project }, session = { project, path: 'chapter.typ', sourceEpoch: 7, expectedRoot: root }, view = {};
  const sessions = new Map([[`${project}:chapter.typ`, session]]);
  const environment = { HistoryPanel: class { constructor(value) { options = value; } }, historyRequest() {}, editorOwnerId() {}, $: () => selected,
    active: session, view, sessions, windowClosing: false, keyFor: (project,path) => `${project}:${path}`, sourceRoot };
  runInNewContext(wiring, environment); assert.equal(options.context().session, session);
  selected.value = id(99); assert.equal(options.context().session, null);
  selected.value = project; sessions.set(`${project}:chapter.typ`, { ...session }); assert.equal(options.context().session, null);
  sessions.set(`${project}:chapter.typ`, session); session.identityProblem = { code: 'stale_root' }; assert.equal(options.context().session, null);
  assert.equal(options.context().editor, view, 'Back still observes the latest real editor without adopting its old source binding');
});
