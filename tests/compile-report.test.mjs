import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { unwrapNativeCompile, diagnosticOffset, navigateCompileDiagnostic } from '../modules/frontend/compile-report.js';
import { capturePublicationInputs, publicationPreviewCurrent } from '../modules/frontend/manuscript-workspace.js';
import { ReviewSession, captureSourceBinding, assertSourceBinding, sourceBindingCurrent, assertSourceSnapshot, sourceRootsEqual, sourceRoot } from '../modules/frontend/review-session.js';
const root = { dev: '18446744073709551615', ino: '9007199254740993' }, hash = text => createHash('sha256').update(text).digest('hex');
const content = 'First.\r\n💛e\u0301\t#missing\r\n', revision = hash(content), id = '00000000-0000-0000-0000-000000000001';
const point = { projectPath: 'chapter:7.typ', sourceDigest: revision, line1: 2, columnScalar0: 5, byteOffset: Buffer.byteLength(content.slice(0, content.indexOf('missing'))), utf16Offset: content.indexOf('missing') };
const operation = () => ({ action: 'compile', project: id, path: 'main.typ', sourceEpoch: 2, expectedRoot: root, revision: hash('main inputs') });
const envelope = (status = 'succeeded') => ({
  compileDiagnosticsVersion: 1, status,
  report: { captureComplete: true, truncated: false, text: '<script>untrusted compiler output</script>', rows: [{ severity: 'error', message: '<img onerror=evil()> missing name', locationCandidate: { ...point } }],
    sourceCandidates: [{ projectPath: point.projectPath, sourceDigest: revision, sourceEpoch: 7 }],
    provenance: { project: id, path: 'main.typ', sourceEpoch: 2, expectedRoot: { ...root }, sourceDigest: operation().revision, mainRevision: operation().revision, nativeBuildId: id, instanceId: id } },
  ...(status === 'succeeded' ? { preview: { available: true, base64: 'JVBERi0=', pdfHash: hash(Buffer.from('JVBERi0=', 'base64')), revision: operation().revision, sourceEpoch: 2, expectedRoot: { ...root }, current: true, diagnostics: '', dependencyCount: 2, dependencyCoverage: 'project', externalDependencyCount: 0 } } : { error: { code: status === 'outcome_unknown' ? status : 'typst', message: 'Compilation failed; previous PDF retained.' } }),
});
const defer = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const turn = () => new Promise(resolve => setImmediate(resolve));
test('native success admits its PDF identity and refuses malformed or missing identities', () => {
  const value = envelope(); value.preview.pdfHash = hash(Buffer.from(value.preview.base64, 'base64'));
  assert.equal(unwrapNativeCompile(value, operation()).pdfHash, value.preview.pdfHash);
  for (const identity of [undefined, null, '', 'A'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), 'g'.repeat(64), 42]) {
    const invalid = envelope();
    if (identity === undefined) delete invalid.preview.pdfHash;
    else invalid.preview.pdfHash = identity;
    assert.throws(() => unwrapNativeCompile(invalid, operation()), error => error.code === 'compile_report_format');
  }
});
function setup() {
  const result = unwrapNativeCompile(envelope(), operation()), compilation = result.compileReport;
  const snapshot = { path: point.projectPath, documentId: 'chapter-7', expectedRoot: { ...root }, sourceEpoch: 7, content, sidecarRevision: null, review: { revision, markers: [], rules: [], suggestions: [] } };
  const session = new ReviewSession(snapshot, id, async () => { throw Error('Navigation must not use the editor queue'); });
  const state = { doc: { toString: () => content }, selection: { head: 0 } }, view = { state, scrollDOM: { scrollTop: 20, scrollLeft: 5 } };
  const current = { compilation, current: true, session, view, registered: true, pending: 0, composing: false, closing: false, intent: 0, navigation: 0, logsVisible: true, logScrollTop: 10, logScrollLeft: 0 };
  const calls = [], selections = [], options = { context: () => current, read: async request => { calls.push(request); return snapshot; }, digest: async text => hash(text), select: (...args) => selections.push(args) };
  return { result, compilation, row: compilation.report.rows[0], snapshot, session, view, state, current, calls, selections, options };
}
test('closed native report validates captured MAIN provenance and returns an immutable bounded report independently of chapter epoch', () => {
  const raw = envelope(), result = unwrapNativeCompile(raw, operation());
  assert.equal(result.available, true); assert.equal(result.sourceEpoch, 2); assert.equal(result.compileReport.report.sourceCandidates[0].sourceEpoch, 7);
  assert.equal(Object.isFrozen(result.compileReport.report.provenance.expectedRoot), true); assert.equal(Object.isFrozen(result.compileReport.report.rows[0].locationCandidate), true);
  raw.report.rows[0].message = 'changed'; raw.report.provenance.expectedRoot.ino = '8';
  assert.match(result.compileReport.report.rows[0].message, /onerror/); assert.deepEqual(result.expectedRoot, root);
  for (const change of [value => value.extra = 1, value => value.report.extra = 1, value => value.report.provenance.path = 'chapter:7.typ', value => value.report.provenance.sourceEpoch = 7, value => value.report.provenance.expectedRoot.ino = '8', value => value.report.provenance.mainRevision = revision, value => value.report.sourceCandidates[0].sourceDigest = 'b'.repeat(64), value => value.report.sourceCandidates.push(value.report.sourceCandidates[0]), value => value.report.rows[0].locationCandidate.utf16Offset = 1.2, value => value.preview.expectedRoot.ino = '8', value => value.preview.extra = 1, value => value.preview.base64 = 'not pdf?', value => value.report.text = 'x'.repeat(131073), value => value.report.rows = Array(129).fill(value.report.rows[0])]) {
    const value = envelope(); change(value); assert.throws(() => unwrapNativeCompile(value, operation()), error => ['compile_report_format', 'format'].includes(error.code));
  }
});
test('native failed/unknown reports are retained as failures without any replacement preview or fabricated success', () => {
  for (const status of ['failed', 'outcome_unknown']) {
    assert.throws(() => unwrapNativeCompile(envelope(status), operation()), error => error.compileReport.status === status && error.code === (status === 'failed' ? 'typst' : status) && !Object.hasOwn(error, 'base64'));
    const wrong = envelope(status); wrong.preview = envelope().preview; assert.throws(() => unwrapNativeCompile(wrong, operation()), error => error.code === 'compile_report_format');
  }
});
test('offset verification matches scalar columns, UTF8 and UTF16 across all Typst newlines without clamping or splitting Unicode', () => {
  assert.equal(diagnosticOffset(content, point), content.indexOf('missing'));
  for (const newline of ['\n', '\r', '\r\n', '\v', '\f', '\u0085', '\u2028', '\u2029']) {
    const text = `Before.${newline}💛\t#missing`, offset = text.indexOf('missing');
    const location = { ...point, line1: 2, columnScalar0: 3, byteOffset: Buffer.byteLength(text.slice(0, offset)), utf16Offset: offset };
    assert.equal(diagnosticOffset(text, location), offset);
    for (const key of ['line1', 'columnScalar0', 'byteOffset', 'utf16Offset']) assert.throws(() => diagnosticOffset(text, { ...location, [key]: location[key] + 1 }));
  }
  assert.throws(() => diagnosticOffset('💛', { ...point, line1: 1, columnScalar0: 1, byteOffset: 1, utf16Offset: 1 }));
  const maximum = 'x'.repeat(2097152);
  assert.equal(diagnosticOffset(maximum, { ...point, line1: 1, columnScalar0: maximum.length, byteOffset: maximum.length, utf16Offset: maximum.length }), maximum.length);
  assert.throws(() => diagnosticOffset('x'.repeat(2097153), point));
});
test('a verified active-clean chapter selection performs one bound pure Review plus two exact byte digests and only a selection', async () => {
  const f = setup(), queue = f.session.queue, snapshot = f.session.snapshot; const digested = [];
  f.options.digest = async text => { digested.push(text); return hash(text); };
  assert.equal(await navigateCompileDiagnostic(f.compilation, f.row, f.options), point.utf16Offset);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].action, 'review'); assert.equal(f.calls[0].sourceEpoch, 7); assert.deepEqual(f.calls[0].expectedRoot, root);
  assert.deepEqual(digested, [content, content]); assert.deepEqual(f.selections, [[f.view, point.utf16Offset]]);
  assert.equal(f.session.queue, queue); assert.equal(f.session.snapshot, snapshot); assert.equal(f.session.dirty, false);
});
test('dirty, pending, IME, conflict, other files and incomplete captures refuse BEFORE any native read or selection', async () => {
  for (const change of [f => f.session.edit('new draft'), f => f.current.pending = 1, f => f.session.pending = 1, f => f.current.composing = true, f => f.current.closing = true, f => f.current.registered = false, f => f.session.conflict = {}, f => f.session.reviewProblem = {}, f => f.session.identityProblem = {}, f => f.session.uncertainMutation = {}, f => f.session.unresolvedMove = {}, f => f.current.current = false, f => f.session.path = 'other.typ']) {
    const f = setup(); change(f); await assert.rejects(navigateCompileDiagnostic(f.compilation, f.row, f.options)); assert.deepEqual(f.calls, []); assert.deepEqual(f.selections, []);
  }
  for (const field of ['captureComplete', 'truncated']) {
    const f = setup(), raw = envelope(); raw.report[field] = field === 'truncated'; if (field === 'captureComplete') { raw.report.rows = []; raw.report.sourceCandidates = []; } const compilation = unwrapNativeCompile(raw, operation()).compileReport; f.current.compilation = compilation;
    await assert.rejects(navigateCompileDiagnostic(compilation, compilation.report.rows[0] || f.row, f.options)); assert.deepEqual(f.calls, []);
  }
});
test('held genuine-shaped Review cannot override newer state, scroll, selection, epoch/root, map/view/report or user intent', async () => {
  for (const change of [f => f.session.edit('new typing'), f => f.view.state = { ...f.state, selection: { head: 1 } }, f => f.view.scrollDOM.scrollTop++, f => f.view.scrollDOM.scrollLeft++, f => f.current.registered = false, f => f.current.view = { ...f.view }, f => f.current.session = { ...f.session }, f => f.session.sourceEpoch++, f => f.session.expectedRoot = { ...root, ino: '8' }, f => f.current.compilation = {}, f => f.current.intent++, f => f.current.navigation++, f => f.current.logsVisible = false, f => f.current.logScrollTop++, f => f.current.logScrollLeft++, f => f.current.pending++, f => f.current.composing = true, f => f.current.closing = true]) {
    const f = setup(), gate = defer(); f.options.read = request => { f.calls.push(request); return gate.promise; };
    const pending = navigateCompileDiagnostic(f.compilation, f.row, f.options); change(f); gate.resolve(f.snapshot);
    await assert.rejects(pending); assert.equal(f.calls.length, 1); assert.deepEqual(f.selections, []);
  }
});
test('late byte hashes and mismatched source proof never cause a second read, buffer adoption or arbitrary-offset selection', async () => {
  const f = setup(), hashes = defer(); f.options.digest = () => hashes.promise;
  const pending = navigateCompileDiagnostic(f.compilation, f.row, f.options); await turn(); f.view.state = { ...f.state }; hashes.resolve(revision); await assert.rejects(pending); assert.deepEqual(f.selections, []);
  for (const change of [s => s.expectedRoot.ino = '8', s => s.sourceEpoch++, s => s.documentId = 'new', s => s.content = 'external source', s => s.review.revision = hash('external source')]) {
    const f = setup(), snapshot = structuredClone(f.snapshot); change(snapshot); f.options.read = async () => snapshot;
    await assert.rejects(navigateCompileDiagnostic(f.compilation, f.row, f.options)); assert.deepEqual(f.selections, []); assert.equal(f.session.content, content);
  }
  const bad = setup(); bad.options.digest = async () => 'f'.repeat(64); await assert.rejects(navigateCompileDiagnostic(bad.compilation, bad.row, bad.options)); assert.deepEqual(bad.selections, []);
});
test('actual log adapter renders raw messages as text, gives other-file guidance and retires existing buttons without source/PDF effects', async () => {
  const manuscript = await readFile(new URL('../src/manuscript.js', import.meta.url), 'utf8');
  const code = manuscript.slice(manuscript.indexOf('function retireCompileNavigation('), manuscript.indexOf('function setCompileLogs('));
  const nodes = new Map(), make = (tag, text = '', className = '') => ({ tag, textContent: text, className, dataset: {}, children: [], append(...children) { this.children.push(...children); }, replaceChildren(...children) { this.children = children; }, querySelectorAll(name) { return this.children.flatMap(child => [...(child.tag === name ? [child] : []), ...child.querySelectorAll(name)]); }, set innerHTML(_) { throw Error('Never render compiler output as HTML'); } });
  const node = id => { if (!nodes.has(id)) nodes.set(id, make('div')); return nodes.get(id); };
  const f = setup(), actions = [], environment = { TextEncoder, TextDecoder, currentCompileReport: null, currentCompileContext: null, active: f.session, element: make, $: node, actionButton: (label, callback) => { const button = make('button', label); button.onclick = callback; actions.push(button); return button; } };
  const adapter = runInNewContext(code + '\n({setCompileLog,retireCompileNavigation});', environment);
  adapter.setCompileLog('Build failed.', f.compilation, () => true);
  assert.match(node('compile-raw').textContent, /<script>/); assert.match(node('compile-diagnostics').children[0].children[0].textContent, /<img onerror/); assert.equal(actions.length, 1); assert.equal(actions[0].disabled, false);
  adapter.retireCompileNavigation(); assert.equal(actions[0].disabled, true); assert.match(node('compile-report-status').textContent, /context changed/);
  environment.active = { ...f.session, path: 'other.typ' }; adapter.setCompileLog('Build failed.', f.compilation, () => true);
  assert.equal(actions.length, 1, 'other-file rows never get a navigation action'); assert.match(node('compile-diagnostics').children[0].children.at(-1).textContent, /Open this file locally/);
});

test('actual failed compile attaches its immutable report, retires it on newer inputs and keeps last-good PDF bytes without painting', async () => {
  const source = await readFile(new URL('../src/manuscript.js', import.meta.url), 'utf8'), f = setup();
  const mainSnapshot = { ...f.snapshot, path: 'main.typ', sourceEpoch: 2, content: 'main inputs', review: { ...f.snapshot.review, revision: operation().revision } };
  const main = new ReviewSession(mainSnapshot, id, async () => {}), sessions = new Map([[`${id}:main.typ`, main], [`${id}:${f.session.path}`, f.session]]);
  const calls = [], logs = [], nodes = new Map(), lastPDF = new Uint8Array([1, 2, 3]); let failure;
  try { unwrapNativeCompile(envelope('failed'), operation()); } catch (error) { failure = error; }
  const environment = {
    active: f.session, view: f.view, navigationIntent: 4, projectEditVersions: new Map(), compiling: false, explicitCompiles: [], sessions, pdfBytes: lastPDF,
    publicationPath: () => 'main.typ', inventoryRoot: () => ({ expectedRoot: root }), keyFor: (project, path) => `${project}:${path}`,
    $: id => { if (!nodes.has(id)) nodes.set(id, { textContent: '' }); return nodes.get(id); },
    captureSourceBinding, assertSourceBinding, sourceBindingCurrent, assertSourceSnapshot, sourceRootsEqual,
    saveSession: async session => { calls.push(['save-existing-build-input', session.path]); return session.snapshot; },
    request: async operation => { calls.push([operation.action, operation.path]); if (operation.action === 'compile') throw failure; return mainSnapshot; },
    projectInputVersions: () => ({ version: 0, sessions: [...sessions.values()].map(session => [session, session.version, session.snapshot.review.revision, { project: id, path: session.path, sourceEpoch: session.sourceEpoch, expectedRoot: root }]) }),
    setCompileLog: (...args) => logs.push(args), showPdf: () => { throw Error('A failed compile must not parse or paint a replacement PDF'); },
    status() {}, pdfStatus() {}, renderReview() {}, compileScheduler: { release() {} },
  };
  const helpers = source.slice(source.indexOf('function observedSourceTarget('), source.indexOf('async function setMainDocument('));
  const compile = source.slice(source.indexOf('async function compileSession('), source.indexOf('function renderTabs('));
  const run = runInNewContext(helpers + compile + '\ncompileSession;', environment);
  await assert.rejects(run(f.session, true), error => error === failure);
  assert.equal(environment.pdfBytes, lastPDF); assert.equal(environment.compiling, false); assert.equal(logs.at(-1)[1], failure.compileReport);
  assert.equal(logs.at(-1)[2](), true); f.session.edit('new draft'); assert.equal(logs.at(-1)[2](), false);
  assert.deepEqual(calls.map(call => call[0]), ['save-existing-build-input', 'save-existing-build-input', 'open', 'compile']);
});

test('actual Inspect callback applies only a verified selection and suppresses a late error after a newer local intent', async () => {
  const source = await readFile(new URL('../src/manuscript.js', import.meta.url), 'utf8');
  const code = source.slice(source.indexOf('function retireCompileNavigation('), source.indexOf('function setCompileLogs('));
  const f = setup(), nodes = new Map(), actions = [], selections = [], statuses = [], reads = [];
  const make = (tag, text = '') => ({ tag, textContent: text, dataset: {}, children: [], scrollTop: 0, scrollLeft: 0, append(...items) { this.children.push(...items); }, replaceChildren(...items) { this.children = items; }, querySelectorAll() { return []; } });
  const $ = id => { if (!nodes.has(id)) nodes.set(id, make('div')); return nodes.get(id); };
  f.view.dispatch = selection => selections.push(selection); f.view.focus = () => {};
  const environment = { navigateCompileDiagnostic, TextEncoder, TextDecoder, crypto: webcrypto, currentCompileReport: null, currentCompileContext: null,
    active: f.session, view: f.view, sessions: new Map([[`${id}:${f.session.path}`, f.session]]), keyFor: (p, path) => `${p}:${path}`, controlContext: () => ({ pending: 0 }), compiling: false, windowClosing: false, localRequestsVersion: 0, navigationIntent: 0, showingLogs: true, historyPanel: { visible: false },
    $: $, element: make, actionButton: (label, callback) => { const button = make('button', label); button.onclick = callback; actions.push(button); return button; },
    request: async operation => { reads.push(operation); return f.snapshot; }, EditorView: { scrollIntoView: offset => ({ offset }) }, showPane() {}, status: (...args) => statuses.push(args),
  };
  const adapter = runInNewContext(code + '\n({setCompileLog});', environment); adapter.setCompileLog('Failed.', f.compilation, () => true);
  await actions[0].onclick(); assert.equal(reads.length, 1); assert.equal(reads[0].action, 'review'); assert.equal(selections.length, 1); assert.equal(selections[0].selection.anchor, point.utf16Offset); assert.equal(Object.hasOwn(selections[0], 'changes'), false);
  const gate = defer(); environment.request = () => gate.promise;
  const pending = actions[0].onclick(); environment.localRequestsVersion++; gate.resolve(f.snapshot); await pending;
  assert.equal(selections.length, 1); assert.deepEqual(statuses, [], 'an old click cannot stamp an error over newer local intent');
});

test('incomplete native capture is text-only while bounded presentation truncation may retain disabled candidates', () => {
  const inconsistent = envelope(); inconsistent.report.captureComplete = false;
  assert.throws(() => unwrapNativeCompile(inconsistent, operation()), error => error.code === 'compile_report_format');
  inconsistent.report.rows = []; inconsistent.report.sourceCandidates = [];
  const textOnly = unwrapNativeCompile(inconsistent, operation()).compileReport;
  assert.equal(textOnly.report.captureComplete, false); assert.equal(textOnly.report.rows.length, 0); assert.equal(textOnly.report.sourceCandidates.length, 0);
  const cut = envelope(); cut.report.truncated = true;
  assert.equal(unwrapNativeCompile(cut, operation()).compileReport.report.rows.length, 1);
});

test('held actual Compile followed by actual committed Import retires the report/project PDF; a replacement-root receipt changes no epoch or tree', async () => {
  const source = await readFile(new URL('../src/manuscript.js', import.meta.url), 'utf8');
  for (const outcome of ['succeeded', 'failed']) for (const replacedRoot of [false, true]) {
    const f = setup(), gate = defer(), epochs = new Map(), calls = [], logs = [], pdfStates = [], listing = [], syncs = [], nodes = new Map(); let treeRoot = root;
    const mainSnapshot = { ...f.snapshot, path: 'main.typ', sourceEpoch: 2, content: 'main inputs', review: { ...f.snapshot.review, revision: operation().revision } };
    const main = new ReviewSession(mainSnapshot, id, async () => {}), sessions = new Map([[`${id}:main.typ`, main], [`${id}:${f.session.path}`, f.session]]), bytes = new Uint8Array([1, 2, 3]);
    const environment = {
      active: f.session, view: f.view, navigationIntent: 4, projectEditVersions: epochs, currentCompileReport: null, compiling: false, explicitCompiles: [], smartFileTree: false, sessions, pdfBytes: bytes, pdfProject: id,
      publicationPath: () => 'main.typ', inventoryRoot: () => ({ expectedRoot: treeRoot }), currentProject: () => ({ id }), keyFor: (project, path) => `${project}:${path}`,
      $: id => { if (!nodes.has(id)) nodes.set(id, { textContent: '' }); return nodes.get(id); },
      captureSourceBinding, assertSourceBinding, sourceBindingCurrent, assertSourceSnapshot, sourceRootsEqual, sourceRoot,
      capturePublicationInputs, publicationPreviewCurrent,
      saveSession: async session => session.snapshot, request: async operation => { calls.push(operation); if (operation.action === 'compile') { const result = await gate.promise; if (result.code) throw result; return result; } return mainSnapshot; },
      setCompileLog: (...args) => logs.push(args), showPdf() {}, status() {}, pdfStatus: (...args) => pdfStates.push(args), renderReview() {}, compileScheduler: { release() {} }, retireCompileNavigation() {},
      NativeFileImport: class { constructor(options) { Object.assign(this, options); } }, renderFileImport() {}, queueSync: (...args) => syncs.push(args), loadFiles: async (...args) => listing.push(args),
    };
    const freshness = source.slice(source.indexOf('function publicationCurrent('), source.indexOf('function inventoryRoot('));
    const helpers = source.slice(source.indexOf('function observedSourceTarget('), source.indexOf('async function setMainDocument('));
    const compile = source.slice(source.indexOf('async function compileSession('), source.indexOf('function renderTabs('));
    const importer = source.slice(source.indexOf('let renderedImportContext ='), source.indexOf('function renderFileImport('));
    const adapter = runInNewContext(freshness + helpers + compile + importer + '\n({compileSession,fileImport});', environment);
    const pending = adapter.compileSession(f.session, true); await turn(); assert.equal(calls.at(-1).action, 'compile');
    const savedVersions = [...sessions.values()].map(session => session.version);
    if (replacedRoot) treeRoot = { ...root, ino: '8' };
    const committed = { project: id, expectedRoot: root };
    if (replacedRoot) await assert.rejects(adapter.fileImport.onCommitted(committed), error => error.code === 'stale_root');
    else await adapter.fileImport.onCommitted(committed);
    assert.equal(epochs.get(id) || 0, replacedRoot ? 0 : 1); assert.equal(listing.length, replacedRoot ? 0 : 1); assert.equal(syncs.length, replacedRoot ? 0 : 1);
    assert.deepEqual([...sessions.values()].map(session => session.version), savedVersions, 'unopened imported inputs do not need an editor mutation');
    assert.equal(environment.pdfBytes, bytes); assert.equal(pdfStates.length, replacedRoot ? 0 : 1);
    if (outcome === 'succeeded') { gate.resolve(f.result); await pending; }
    else { let failure; try { unwrapNativeCompile(envelope('failed'), operation()); } catch (error) { failure = error; } gate.resolve(failure); await assert.rejects(pending, error => error === failure); }
    assert.equal(calls.filter(call => call.action === 'compile').length, 1, 'the import never requests another build');
    if (!replacedRoot) {
      if (outcome === 'succeeded') { assert.equal(logs.at(-1)[2], null); assert.match(logs.at(-1)[0], /Source changes are newer/); }
      else assert.equal(logs.at(-1)[2](), false, 'failed reports also use the captured project epoch without a preview current flag');
      assert.deepEqual(listing[0][1], root);
    }
  }
});

test('actual successful-but-stale publication keeps report text and gives it no location-navigation context', async () => {
  const source = await readFile(new URL('../src/manuscript.js', import.meta.url), 'utf8');
  const start = source.indexOf('    const current = publicationCurrent(result, session, path, inputs);', source.indexOf('async function compileSession('));
  const code = source.slice(start, source.indexOf('\n  } catch (error)', start));
  for (const current of [false, true]) {
    const f = setup(), calls = [], reportCurrent = () => true, bytes = new Uint8Array([1, 2, 3]);
    const run = runInNewContext('(function(){' + code + '\n});', { result: f.result, session: f.session, path: 'main.typ', inputs: {}, reportCurrent, treeRefreshError: null, publicationCurrent: () => current, setCompileLog: (...args) => calls.push(args), status() {}, pdfBytes: bytes });
    run(); assert.equal(calls[0][1], f.compilation); assert.equal(calls[0][2], current ? reportCurrent : null);
    assert.match(calls[0][0], current ? /PDF matches/ : /Source changes are newer/);
    assert.deepEqual([...bytes], [1, 2, 3]);
  }
});
