import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { ReviewSession, sourceEpoch, sourceRoot, sourceRootsEqual, captureSourceBinding, sourceBindingCurrent, assertSourceBinding, assertSourceSnapshot } from '../modules/frontend/review-session.js';
import { capturePublicationInputs, manuscriptTree } from '../modules/frontend/manuscript-workspace.js';
import { smartSourceEntries, smartSourceNotice } from '../modules/frontend/smart-source-tree.js';
import { sourceFormat } from '../modules/frontend/source-format.js';

const source = (await readFile(new URL('../src/manuscript.js', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
const pathCode = section('function publicationPath(', 'function publicationCurrent(');
const root = { dev: '1', ino: '9007199254740993' };
const identity = { sourceEpoch, sourceRootsEqual, captureSourceBinding, sourceBindingCurrent, assertSourceBinding, assertSourceSnapshot };

test('active Typst and LaTeX publish directly, while a marked main remains the target from bibliography or included sources', () => {
  const projects = [{ id: 'project' }, { id: 'other', mainDocument: 'other.tex' }];
  const path = runInNewContext(pathCode + '\npublicationPath;', { projects });
  assert.equal(path(null), '');
  for (const file of ['main.typ', 'main.tex']) assert.equal(path({ project: 'project', path: file }), file);
  for (const file of ['refs.bib', 'notes.md', 'draft.tex.bak', 'outline.html', 'chapter.TEX', 'main.TYP']) assert.equal(path({ project: 'project', path: file }), '');
  projects[0].mainDocument = 'manuscript/main.tex';
  for (const file of ['refs.bib', 'sections/results.tex', 'data.csv', 'main.typ']) assert.equal(path({ project: 'project', path: file }), 'manuscript/main.tex');
  projects[0].mainDocument = 'main.typ';
  assert.equal(path({ project: 'project', path: 'appendix.tex' }), 'main.typ');
});

test('LaTeX Set-main is enabled but unsupported source formatting and Typst insertions stay disabled', () => {
  const render = section('function renderReview(', 'function renderTabs(');
  const start = render.indexOf("  for (const button of document.querySelectorAll('[data-command]')) {");
  const code = render.slice(start, render.indexOf('  const noReviewPassages', start));
  assert.ok(start >= 0 && code.includes('set-main-document'));
  const commands = ['set-main-document', 'clear-main-document', 'bold', 'italic', 'heading', 'bullet-list', 'numbered-list', 'citation', 'inline-math', 'figure'];
  for (const blocked of [false, true]) {
    const buttons = commands.map(command => ({ dataset: { command }, disabled: false }));
    runInNewContext(code, { active: { path: 'main.tex' }, reviewBlocked: blocked, currentProject: () => ({}), document: { querySelectorAll: () => buttons }, insertionCommands: new Set(['citation', 'inline-math', 'figure']) });
    assert.equal(buttons[0].disabled, blocked);
    for (const button of buttons.slice(2)) assert.equal(button.disabled, true, button.dataset.command);
  }
  assert.throws(() => sourceFormat('Text', { from: 0, to: 4 }, 'bold', 'tex'), /supports Typst and HTML/);
});

test('Smart preference yields the full LaTeX tree with an explanation and resumes for Typst without changing the saved preference', () => {
  const node = (tag = '', text = '', className = '') => ({ tag, textContent: text, className, dataset: {}, children: [], attributes: {}, scrollTop: 0, disabled: false,
    append(...children) { this.children.push(...children); }, replaceChildren(...children) { this.children = children; }, contains() { return false; }, setAttribute(name, value) { this.attributes[name] = value; } });
  const tree = node(), toggle = node(), projects = [{ id: 'project', mainDocument: 'main.tex' }];
  const entries = [{ path: 'main.tex', editable: true, kind: 'source' }, { path: 'references.bib', editable: true, kind: 'source' }, { path: 'main.typ', editable: true, kind: 'source' }, { path: 'sections', kind: 'directory' }, { path: 'sections/result.tex', editable: true, kind: 'source' }, { path: 'figure.png', kind: 'asset' }];
  const inventory = { project: 'project', expectedRoot: root, entries, typstSources: { main: 'main.typ', paths: ['main.typ'], complete: true } };
  const environment = { projects, active: { project: 'project', path: 'references.bib' }, lastFileInventory: null, smartFileTree: true, sourceEpoch, sourceRoot,
    $: id => id === 'files-smart' ? toggle : tree, document: { activeElement: null }, fileInventoryRoots: new WeakMap(),
    element: node, actionButton: (label, callback, className) => node('button', label, className), manuscriptTree, smartSourceEntries, smartSourceNotice,
    expandedFolders: new Set(['project:sections']), smartCollapsedFolders: new Set(),
  };
  const render = runInNewContext(pathCode + section('function renderFiles(', 'function openNewFolder(') + '\nrenderFiles;', environment);
  render(inventory, 'project');
  assert.equal(toggle.disabled, true); assert.equal(toggle.attributes['aria-checked'], 'false'); assert.equal(tree.dataset.smart, 'false');
  assert.match(toggle.title, /LaTeX files use the full project tree/); assert.match(tree.children.at(-1).textContent, /Smart filtering currently applies to Typst/);
  assert.deepEqual(tree.children.filter(child => child.className === 'file-button').map(child => child.dataset.path), ['main.tex', 'main.typ', 'references.bib']);
  assert.equal(tree.children.find(child => child.className === 'file-folder').open, true);
  assert.equal(environment.fileInventoryRoots.get(tree).expectedRoot.ino, root.ino);
  projects[0].mainDocument = 'main.typ'; render(inventory, 'project');
  assert.equal(toggle.disabled, false); assert.equal(toggle.attributes['aria-checked'], 'true');
  assert.deepEqual(tree.children.filter(child => child.className === 'file-button').map(child => child.dataset.path), ['main.typ']);
  projects[0].mainDocument = ''; environment.active.path = 'main.tex'; render(inventory, 'project'); assert.equal(toggle.disabled, true);
  environment.active.path = 'main.typ'; render(inventory, 'project'); assert.equal(toggle.disabled, false); assert.equal(toggle.attributes['aria-checked'], 'true');
  assert.equal(environment.smartFileTree, true); assert.equal(environment.lastFileInventory, inventory);
});

function compileFixture({ fail = false } = {}) {
  const disk = new Map(), operations = [], saved = [], painted = [], messages = [], nodes = new Map();
  const snapshot = (path, content) => ({ path, content, expectedRoot: root, sourceEpoch: 2, documentId: path, sidecarRevision: null, review: { revision: content, markers: [], rules: [], suggestions: [] } });
  const make = (path, content) => {
    disk.set(path, snapshot(path, content));
    return new ReviewSession(disk.get(path), 'project', async operation => {
      assert.equal(operation.action, 'save');
      const value = snapshot(path, operation.content); disk.set(path, value); saved.push(path); return value;
    });
  };
  const main = make('main.tex', 'Initial main'), bibliography = make('references.bib', 'Initial bibliography');
  main.edit('Latest main'); bibliography.edit('Latest bibliography');
  const sessions = new Map([['project:main.tex', main], ['project:references.bib', bibliography]]);
  const projects = [{ id: 'project', mainDocument: 'main.tex' }], previousPdf = new Uint8Array([1, 2, 3]);
  const environment = { ...identity, projects, sessions, active: bibliography, view: null, navigationIntent: 0, compiling: false, explicitCompiles: [], smartFileTree: false, projectEditVersions: new Map(), pdfBytes: previousPdf,
    keyFor: (project, path) => `${project}:${path}`, inventoryRoot: () => ({ expectedRoot: root }),
    $: id => { if (!nodes.has(id)) nodes.set(id, { textContent: '' }); return nodes.get(id); },
    saveSession: session => session.flush(), projectInputVersions: () => capturePublicationInputs([...sessions.values()], 0),
    request: async operation => { operations.push(operation); if (operation.action === 'open') return disk.get(operation.path); if (fail) throw { code: 'compile', message: 'LaTeX failed' }; return { available: true, current: true, revision: disk.get(operation.path).review.revision, sourceEpoch: 2, expectedRoot: root }; },
    showPdf: async (...args) => painted.push(args), publicationCurrent: () => true, status: message => messages.push(message), setCompileLog: message => messages.push(message), pdfStatus: message => messages.push(message), renderReview() {},
    task: callback => callback, compileScheduler: { request() {}, release() {} },
  };
  const code = pathCode + section('function observedSourceTarget(', 'async function setMainDocument(') + section('async function compileSession(', 'function renderTabs(');
  const compile = runInNewContext(code + '\ncompileSession;', environment);
  return { compile, environment, main, bibliography, operations, saved, painted, messages, previousPdf, projects, nodes };
}

test('actual local LaTeX compilation saves open project inputs and publishes the guarded main while editing its bibliography', async () => {
  const f = compileFixture(); await f.compile(f.bibliography, true);
  assert.deepEqual(f.saved, ['main.tex', 'references.bib']);
  assert.equal(f.main.dirty, false); assert.equal(f.bibliography.dirty, false);
  assert.deepEqual(f.operations.map(operation => [operation.action, operation.path, operation.expectedRoot, operation.sourceEpoch]), [['open', 'main.tex', root, 2], ['compile', 'main.tex', root, 2]]);
  assert.equal(f.operations[1].revision, 'Latest main');
  assert.equal(f.painted.length, 1); assert.equal(f.painted[0][1], f.bibliography); assert.equal(f.painted[0][2], 'main.tex');
  assert.ok(f.messages.includes('PDF compiled locally.')); assert.ok(f.messages.includes('Compiling main.tex…'));
  assert.equal(f.environment.compiling, false); assert.equal(f.nodes.get('source-compile').textContent, 'Compile');
});

test('failed LaTeX compilation keeps the previous PDF and queued jobs reject a changed main target', async () => {
  const failed = compileFixture({ fail: true });
  await assert.rejects(failed.compile(failed.bibliography, true), error => error.code === 'compile');
  assert.equal(failed.environment.pdfBytes, failed.previousPdf); assert.deepEqual(failed.painted, []); assert.equal(failed.environment.compiling, false);
  assert.ok(failed.messages.some(message => message.includes('last good PDF retained')));
  const queued = compileFixture(); queued.environment.compiling = true; await queued.compile(queued.bibliography, true);
  const job = queued.environment.explicitCompiles.shift(); queued.environment.compiling = false; queued.projects[0].mainDocument = 'other.tex';
  await assert.rejects(queued.compile(job.session, true, job.path, job.capture), error => error.code === 'stale_document');
  assert.deepEqual(queued.operations, []); assert.deepEqual(queued.saved, []);
});

test('compile preflight retries only a refused Open and admits exactly one actual build', async () => {
  const f = compileFixture(), original = f.environment.request, operations = [], delays = [];
  f.environment.setTimeout = (callback, delay) => { delays.push(delay); queueMicrotask(callback); };
  let refused = false;
  f.environment.request = async operation => {
    operations.push(operation.action);
    if (operation.action === 'open' && !refused) {
      refused = true;
      throw { code: 'busy', message: 'A local document operation is running. Retry this action.' };
    }
    return original(operation);
  };
  await f.compile(f.bibliography, true);
  assert.deepEqual(operations, ['open', 'open', 'compile']); assert.deepEqual(delays, [50]);
  assert.deepEqual(f.saved, ['main.tex', 'references.bib']); assert.equal(f.painted.length, 1);
});

test('compile preflight contention is bounded and retains the last good PDF', async () => {
  const f = compileFixture(), operations = [], delays = [];
  f.environment.setTimeout = (callback, delay) => { delays.push(delay); queueMicrotask(callback); };
  f.environment.request = async operation => {
    operations.push(operation.action);
    throw { code: 'busy', message: 'A local document operation is running. Retry this action.' };
  };
  await assert.rejects(f.compile(f.bibliography, true), error => error.code === 'busy');
  assert.deepEqual(operations, Array(6).fill('open')); assert.deepEqual(delays, [50, 100, 200, 400, 800]);
  assert.equal(f.environment.pdfBytes, f.previousPdf); assert.equal(f.painted.length, 0);
});

for (const error of [
  { code: 'busy', message: 'Another source operation is running.' },
  { code: 'outcome_unknown', message: 'A local document operation is running. Retry this action.' },
  { code: 'io', message: 'A local document operation is running. Retry this action.' },
]) test(`compile preflight never replays ${error.code}: ${error.message}`, async () => {
  const f = compileFixture(), operations = [];
  f.environment.request = async operation => { operations.push(operation.action); throw error; };
  await assert.rejects(f.compile(f.bibliography, true), observed => observed === error);
  assert.deepEqual(operations, ['open']); assert.equal(f.environment.pdfBytes, f.previousPdf);
});

for (const when of ['during refused Open', 'while waiting', 'during successful Open']) {
  test(`typing ${when} keeps the new draft without a false external conflict or build`, async () => {
    const f = compileFixture(), original = f.environment.request, operations = [];
    f.environment.setTimeout = callback => { f.main.edit('Newest draft'); queueMicrotask(callback); };
    f.environment.request = async operation => {
      operations.push(operation.action);
      if (when !== 'while waiting') f.main.edit('Newest draft');
      if (when !== 'during successful Open') throw { code: 'busy', message: 'A local document operation is running. Retry this action.' };
      return original(operation);
    };
    await assert.rejects(f.compile(f.bibliography, true), error => error.code === 'stale_document');
    assert.deepEqual(operations, ['open']); assert.equal(f.main.content, 'Newest draft');
    assert.equal(f.main.dirty, true); assert.equal(f.main.conflict, null);
    assert.equal(f.environment.pdfBytes, f.previousPdf);
  });
}

test('compile preflight retries stop when navigation changes during the backoff', async () => {
  const f = compileFixture(), operations = [];
  f.environment.setTimeout = callback => { f.environment.navigationIntent += 1; queueMicrotask(callback); };
  f.environment.request = async operation => {
    operations.push(operation.action);
    throw { code: 'busy', message: 'A local document operation is running. Retry this action.' };
  };
  await assert.rejects(f.compile(f.bibliography, true), error => error.code === 'stale_document');
  assert.deepEqual(operations, ['open']); assert.equal(f.painted.length, 0);
});

test('PDF download names replace either source suffix and keep source path directories out of the name', () => {
  const code = section("$('export-pdf').onclick =", "$('reload-buffer').onclick =");
  for (const [pdfPath, expected] of [['paper.tex', 'paper.pdf'], ['chapters/paper.TEX', 'paper.pdf'], ['paper.typ', 'paper.pdf']]) {
    const button = {}, link = { click() { this.clicked = true; } }, bytes = new Uint8Array([1, 2]);
    runInNewContext(code, { $: () => button, pdfPath, pdfBytes: bytes, Blob, URL: { createObjectURL: () => 'blob:fixture', revokeObjectURL() {} }, element: () => link, setTimeout() {} });
    button.onclick(); assert.equal(link.download, expected); assert.equal(link.clicked, true); assert.deepEqual([...bytes], [1, 2]);
  }
});

test('adding local LaTeX PDFs does not enable Typst PDF annotation or saved remote compilation surfaces', async () => {
  const annotationCode = section('function currentColorPdf(', 'function colorPdfHighlights(') + section('function displayedColorPdf(', 'async function refreshPdfAnnotations(') + section('async function refreshPdfAnnotations(', 'async function applyPdfColorSelection(');
  const api = runInNewContext(annotationCode + '\n({currentColorPdf,displayedColorPdf,refreshPdfAnnotations});', { pdfPath: 'main.tex', pdfReviewContext: {}, request() { throw Error('LaTeX must not invoke Typst annotation authority'); } });
  assert.equal(api.currentColorPdf(), false); assert.equal(api.displayedColorPdf(), false); await api.refreshPdfAnnotations();
  const start = source.indexOf('  async compile_manuscript(command, guard) {'), end = source.indexOf('\n};\nfunction publicationPath(', start);
  assert.ok(start >= 0 && end > start);
  const control = runInNewContext('({' + source.slice(start, end) + '\n});', { controlPreparation: () => ({}), sessions: new Map([['tex', { path: 'main.tex', snapshot: { documentId: 'tex' } }]]), compiling: false });
  await assert.rejects(control.compile_manuscript({ documentId: 'tex' }, { compileSaved() { throw Error('Remote LaTeX compilation must stay unavailable'); } }), error => error.code === 'unavailable');
});
