import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Execute production callbacks with explicit asynchronous API/PDF boundaries; no renderer is modeled.
const source = readFileSync(new URL('../src/manuscript.js', import.meta.url), 'utf8');
const names = ['publicationPath', 'setMainDocument', 'showPdf', 'loadPublicationPreview'];
const callbacks = Object.fromEntries(names.map(name => {
  const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm'));
  assert.ok(start >= 0, name);
  const tail = source.slice(start), next = tail.slice(1).search(/^(?:async )?function /m);
  assert.ok(next >= 0, name);
  return [name, tail.slice(0, next + 1).trimEnd()];
}));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function harness() {
  const events = [], nodes = new Map(), pending = [];
  const folder = { dev: 'model-device', ino: 'model-project' };
  const session = (project, path) => ({ project, path, sourceEpoch: 0, expectedRoot: folder });
  const privateSession = session('p', 'private.typ');
  const mainSession = session('p', 'main.typ');
  const otherSession = session('q', 'other.typ');
  const sessions = new Map([privateSession, mainSession, otherSession].map(value => [`${value.project}/${value.path}`, value]));
  const binding = value => ({ project: value.project, path: value.path, sourceEpoch: value.sourceEpoch, expectedRoot: value.expectedRoot });
  const keyFor = (project, path) => `${project}/${path}`;
  const context = {
    Uint8Array, atob, console,
    projects: [{ id: 'p', mainDocument: null }, { id: 'q', mainDocument: 'other.typ' }],
    sessions, active: privateSession, pdfGeneration: 0, pdfLoadingTask: null,
    pdfBytes: null, pdfPath: '', pdfSourceEpoch: null, pdfRoot: {}, pdfProject: '',
    showingLogs: false, compiling: false, navigationIntent: {}, keyFor,
    $: id => {
      if (!nodes.has(id)) nodes.set(id, { hidden: false, title: '' });
      return nodes.get(id);
    },
    captureSourceBinding: binding,
    sourceEpoch: value => value.sourceEpoch,
    sourceRoot: value => value.expectedRoot,
    sourceRootsEqual: (a, b) => JSON.stringify(a.expectedRoot) === JSON.stringify(b.expectedRoot),
    sourceBindingCurrent: (value, observed) => sessions.get(keyFor(value.project, value.path)) === value && JSON.stringify(binding(value)) === JSON.stringify(binding(observed)),
    assertSourceBinding(value, observed = value) { assert.ok(context.sourceBindingCurrent(value, observed)); },
    assertSourceSnapshot() { throw Error('unexpected fallback Review in model'); },
    currentProject: () => context.projects.find(project => project.id === context.active?.project),
    observedSourceTarget(project, path) {
      const value = sessions.get(keyFor(project, path));
      return value ? { ...binding(value), session: value } : null;
    },
    inventoryRoot() { throw Error('unexpected tree-only binding in model'); },
    sessionNavigationCurrent: (intent, value) => intent === context.navigationIntent && value === context.active,
    projectInputVersions: () => ({ version: 0, sessions: [] }),
    publicationCurrent: () => true,
    retireCompileNavigation: () => events.push({ event: 'retire-navigation' }),
    renderReview: () => events.push({ event: 'render-review' }),
    status: text => events.push({ event: 'status', text }),
    pdfStatus: (text, state) => events.push({ event: 'pdf-status', state }),
    setCompileLog: () => events.push({ event: 'compile-log' }),
    preview() { throw Error('unexpected HTML preview in model'); },
    pdfViewer: {
      pdf: null,
      clear() { this.pdf = null; events.push({ event: 'viewer-clear' }); },
      async setDocument(pdf) { this.pdf = pdf; events.push({ event: 'viewer-set', label: pdf.label }); },
    },
    pdfjs: {
      getDocument({ data }) {
        const label = String.fromCharCode(...data);
        return { promise: Promise.resolve({ numPages: 1, label }), async destroy() { events.push({ event: 'destroy-task', label }); } };
      },
    },
    request(operation) {
      assert.ok(['set_main_document', 'pdf'].includes(operation.action));
      const gate = deferred();
      pending.push({ operation, ...gate });
      events.push({ event: 'request', action: operation.action, project: operation.project, path: operation.path });
      return gate.promise;
    },
  };
  const setMain = callbacks.setMainDocument;
  vm.createContext(context);
  vm.runInContext(names.map(name => name === 'setMainDocument' ? setMain : callbacks[name]).join('\n\n'), context);
  const result = label => ({ available: true, sourceEpoch: 0, expectedRoot: folder, base64: Buffer.from(label).toString('base64') });
  async function next(action) {
    // Explicit promise turns only; no wall-clock sleeps or retries of a producer.
    for (let turn = 0; turn < 30; turn++) {
      const index = pending.findIndex(entry => entry.operation.action === action);
      if (index >= 0) return pending.splice(index, 1)[0];
      await Promise.resolve();
    }
    throw Error(`model did not reach ${action}`);
  }
  return { context, privateSession, mainSession, otherSession, result, next, events, pending };
}

test('a delayed same-main acknowledgement preserves the exact current PDF without another read', async () => {
  const h = harness(), chosen = h.context.setMainDocument('private.typ');
  const response = await h.next('set_main_document');
  await h.context.showPdf(h.result('new-compile'), h.privateSession);
  const pdf = h.context.pdfViewer.pdf, loading = h.context.pdfLoadingTask, generation = h.context.pdfGeneration;
  const clears = h.events.filter(e => e.event === 'viewer-clear').length;
  const originalRequest = h.context.request;
  h.context.request = operation => {
    assert.notEqual(operation.action, 'pdf', 'A redundant read could fail and erase the valid preview');
    return originalRequest(operation);
  };
  response.resolve({ id: 'p', mainDocument: 'private.typ' });
  await chosen;
  assert.equal(h.context.pdfViewer.pdf, pdf);
  assert.equal(h.context.pdfLoadingTask, loading);
  assert.equal(h.context.pdfGeneration, generation);
  assert.equal(h.context.pdfPath, 'private.typ');
  assert.equal(h.pending.length, 0);
  assert.equal(h.events.filter(e => e.event === 'viewer-clear').length, clears, 'The acknowledgement does not reset the view');
});

test('a changed main target still loads the acknowledged document', async () => {
  const h = harness();
  await h.context.showPdf(h.result('private-before'), h.privateSession);
  const chosen = h.context.setMainDocument('main.typ'), response = await h.next('set_main_document');
  response.resolve({ id: 'p', mainDocument: 'main.typ' });
  const read = await h.next('pdf');
  assert.equal(read.operation.path, 'main.typ');
  read.resolve(h.result('main-after'));
  await chosen;
  assert.equal(h.context.pdfViewer.pdf.label, 'main-after');
  assert.equal(h.context.pdfPath, 'main.typ');
});

test('main selection compares the active publication target when its response arrives', async () => {
  const h = harness(), chosen = h.context.setMainDocument('private.typ');
  const response = await h.next('set_main_document');
  h.context.active = h.mainSession; h.context.navigationIntent = {};
  await h.context.showPdf(h.result('main-before-response'), h.mainSession);
  response.resolve({ id: 'p', mainDocument: 'private.typ' });
  const read = await h.next('pdf');
  assert.equal(read.operation.path, 'private.typ');
  read.resolve(h.result('private-after-response'));
  await chosen;
  assert.equal(h.context.pdfViewer.pdf.label, 'private-after-response');
  assert.equal(h.context.pdfPath, 'private.typ');
});

test('a response for a different project preserves its active preview', async () => {
  const h = harness(), chosen = h.context.setMainDocument('private.typ');
  const response = await h.next('set_main_document');
  h.context.active = h.otherSession; h.context.navigationIntent = {};
  await h.context.showPdf(h.result('other-project'), h.otherSession);
  const pdf = h.context.pdfViewer.pdf, generation = h.context.pdfGeneration;
  response.resolve({ id: 'p', mainDocument: 'private.typ' });
  await chosen;
  assert.equal(h.context.pdfViewer.pdf, pdf);
  assert.equal(h.context.pdfGeneration, generation);
  assert.equal(h.pending.length, 0);
});

test('clearing an explicit main with the same fallback keeps the current PDF', async () => {
  const h = harness(); h.context.projects[0].mainDocument = 'private.typ';
  await h.context.showPdf(h.result('unchanged-fallback'), h.privateSession);
  const pdf = h.context.pdfViewer.pdf, generation = h.context.pdfGeneration;
  const originalRequest = h.context.request;
  h.context.request = operation => {
    assert.notEqual(operation.action, 'pdf', 'An unchanged fallback needs no replacement PDF read');
    return originalRequest(operation);
  };
  const chosen = h.context.setMainDocument(''), response = await h.next('set_main_document');
  response.resolve({ id: 'p', mainDocument: null });
  await chosen;
  assert.equal(h.context.pdfViewer.pdf, pdf);
  assert.equal(h.context.pdfGeneration, generation);
});

test('replaced target sessions are rejected before applying the main selection', async () => {
  const h = harness(), chosen = h.context.setMainDocument('main.typ');
  const response = await h.next('set_main_document');
  h.context.sessions.delete('p/main.typ');
  response.resolve({ id: 'p', mainDocument: 'main.typ' });
  await assert.rejects(chosen, error => error.code === 'stale_document');
  assert.equal(h.context.projects[0].mainDocument, null);
  assert.equal(h.pending.length, 0);
});
