import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { ReviewSession, captureSourceBinding, assertSourceBinding, sourceBindingCurrent, assertSourceSnapshot, sourceRootsEqual } from '../modules/frontend/review-session.js';

const source = await readFile(new URL('../src/manuscript.js', import.meta.url), 'utf8');
const between = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
const callbacks = [between('function task(', 'function closeDialogs('), between('const compileScheduler =', 'const reviewEffect ='),
  between('function observedSourceTarget(', 'async function setMainDocument('), between('async function compileSession(', 'function renderTabs(')].join('\n');
const defer = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const root = { dev: '1', ino: '2' }, project = '00000000-0000-0000-0000-000000000001';
const revision = content => createHash('sha256').update(content).digest('hex');
const turn = () => new Promise(resolve => setImmediate(resolve));
function fixture({ holdSave = false, holdCompile = false, busy = false, succeeded = false } = {}) {
  const snapshot = { path: 'main.typ', documentId: 'main', sourceEpoch: 1, expectedRoot: root, content: 'old source',
    review: { revision: revision('old source'), markers: [], suggestions: [], rules: [] } };
  const makeSession = (content, path = 'main.typ') => new ReviewSession({ ...snapshot, path, content, review: { ...snapshot.review, revision: revision(content) } }, project, async () => assert.fail('No session queue effect'));
  const session = makeSession(snapshot.content), sessions = new Map([[`${project}:main.typ`, session]]);
  const save = defer(), compile = defer(), saveStarted = defer(), compileStarted = defer();
  const calls = { pdf: [], logs: [], statuses: [], requests: [], saves: [], shown: [], releases: 0 }, nodes = new Map();
  const oldPdf = new Uint8Array([1, 2, 3]), retainedPdf = new Uint8Array([4, 5, 6]);
  const failure = { code: 'typst', message: 'Genuine compiler failure', compileReport: { status: 'failed' } };
  const environment = { active: session, view: {}, navigationIntent: 1, compiling: busy, explicitCompiles: [], sessions,
    pdfBytes: oldPdf, projectEditVersions: new Map(), publicationPath: () => 'main.typ', inventoryRoot: () => ({ expectedRoot: root }), keyFor: (p, path) => `${p}:${path}`,
    captureSourceBinding, assertSourceBinding, sourceBindingCurrent, assertSourceSnapshot, sourceRootsEqual,
    $: id => { if (!nodes.has(id)) nodes.set(id, { textContent: '' }); return nodes.get(id); },
    saveSession: async input => { calls.saves.push(input); saveStarted.resolve(); if (holdSave) await save.promise; return input.snapshot; },
    request: async operation => { calls.requests.push(operation); if (operation.action === 'compile') { compileStarted.resolve(); if (holdCompile) await compile.promise; if (succeeded) return { available: true, current: true }; throw failure; } return snapshot; },
    projectInputVersions: () => ({ version: 0, sessions: [...sessions.values()].map(input => [input, input.version, input.snapshot.review.revision, captureSourceBinding(input)]) }),
    setCompileLog: (...args) => calls.logs.push(args), pdfStatus: (...args) => calls.pdf.push(args), status: (...args) => calls.statuses.push(args),
    publicationCurrent: () => true, showPdf: (...args) => calls.shown.push(args), renderReview() {},
    LatestCompileScheduler: class { constructor(options) { this.run = options.run; } release() { calls.releases++; } request() { assert.fail('Explicit fixture must not schedule a producer'); } },
  };
  const adapter = runInNewContext(callbacks + '\n({compileSession,releaseCompileQueue,task,compileScheduler});', environment);
  const replace = () => { const replacement = makeSession('#unknown-function()'); sessions.set(`${project}:main.typ`, replacement); environment.active = replacement; environment.view = {}; environment.navigationIntent++; environment.pdfBytes = retainedPdf; };
  return { adapter, environment, session, sessions, calls, save, compile, saveStarted, compileStarted, replace, failure, oldPdf, retainedPdf, makeSession };
}
function clearPresentation(f) { f.calls.pdf.length = 0; f.calls.logs.length = 0; f.calls.statuses.length = 0; }
function assertNoObsoletePresentation(f) {
  assert.deepEqual(f.calls.pdf, [], 'an obsolete compile cannot overwrite the replacement stale PDF label');
  assert.deepEqual(f.calls.logs, [], 'an obsolete compile cannot replace the newer preview log');
  assert.deepEqual(f.calls.statuses, [], 'outer reporting must not stamp the newer editor status');
}

test('actual compile rejects a replaced input after held Save without overwriting the reloaded same-path preview', async () => {
  const f = fixture({ holdSave: true }), pending = f.adapter.compileSession(f.session, true);
  await f.saveStarted.promise; f.replace(); clearPresentation(f); f.save.resolve();
  await assert.rejects(pending, error => error.code === 'stale_document');
  assertNoObsoletePresentation(f); assert.equal(f.environment.pdfBytes, f.retainedPdf);
  assert.equal(f.calls.requests.length, 0, 'the existing input guard refuses before Open or Compile');
  assert.equal(f.calls.saves.length, 1); assert.equal(f.environment.compiling, false); assert.equal(f.calls.releases, 1);
});
test('actual compile task cannot re-report a superseded editor failure', async () => {
  const f = fixture({ holdSave: true }), pending = f.adapter.task(() => f.adapter.compileSession(f.session, true), true)();
  await f.saveStarted.promise; f.replace(); clearPresentation(f); f.save.resolve(); await pending;
  assertNoObsoletePresentation(f); assert.equal(f.calls.requests.length, 0);
});
test('actual automatic scheduler catch cannot re-report after replacement', async () => {
  const f = fixture({ holdSave: true }), pending = f.adapter.compileScheduler.run(`${project}:main.typ`);
  await f.saveStarted.promise; f.replace(); clearPresentation(f); f.save.resolve(); await pending;
  assertNoObsoletePresentation(f); assert.equal(f.calls.requests.length, 0);
});
for (const change of ['view', 'navigation-away-and-back']) test(`actual held compiler failure cannot report into a changed ${change} context`, async () => {
  const f = fixture({ holdCompile: true }), pending = f.adapter.task(() => f.adapter.compileSession(f.session, true), true)();
  await f.compileStarted.promise;
  if (change === 'view') f.environment.view = {}; else f.environment.navigationIntent += 2;
  clearPresentation(f); f.compile.resolve(); await pending; assertNoObsoletePresentation(f);
  assert.deepEqual(f.calls.requests.map(operation => operation.action), ['open', 'compile']);
});
test('queued explicit request keeps its original reporting context and rejection without a new build', async () => {
  const f = fixture({ busy: true }); await f.adapter.compileSession(f.session, true);
  assert.equal(f.environment.explicitCompiles.length, 1); f.replace(); clearPresentation(f); f.environment.compiling = false;
  f.adapter.releaseCompileQueue(); await turn(); assertNoObsoletePresentation(f);
  assert.equal(f.environment.explicitCompiles.length, 0); assert.equal(f.calls.requests.length, 0); assert.equal(f.calls.saves.length, 0);
});
test('current-context genuine compiler failure still rejects and presents its report while retaining PDF bytes', async () => {
  const f = fixture(); await assert.rejects(f.adapter.compileSession(f.session, true), error => error === f.failure);
  assert.equal(f.calls.pdf.length, 1); assert.equal(f.calls.pdf[0][1], 'error');
  assert.equal(f.calls.logs.at(-1)[1], f.failure.compileReport); assert.deepEqual(f.calls.statuses.at(-1), [f.failure.message, true]);
  assert.deepEqual(f.calls.requests.map(operation => operation.action), ['open', 'compile']); assert.equal(f.environment.compiling, false);
  assert.equal(f.calls.shown.length, 0);
  assert.equal(f.environment.pdfBytes, f.oldPdf);
});
test('ordinary task errors retain their existing reporting behavior', async () => {
  const f = fixture(); await f.adapter.task(async () => { throw { message: 'ordinary action failure' }; })();
  assert.deepEqual(f.calls.statuses, [['ordinary action failure', true]]);
});
test('successful unchanged inputs still deliver the shared-main PDF after same-main source navigation', async () => {
  const f = fixture({ holdCompile: true, succeeded: true }), chapter = f.makeSession('chapter source', 'chapter.typ');
  f.sessions.set(`${project}:chapter.typ`, chapter);
  const pending = f.adapter.compileSession(f.session, true); await f.compileStarted.promise;
  f.environment.active = chapter; f.environment.view = {}; f.environment.navigationIntent++;
  f.compile.resolve(); await pending;
  assert.deepEqual(f.calls.requests.map(operation => operation.action), ['open', 'compile']);
  assert.equal(f.calls.shown.length, 1); assert.equal(f.calls.shown[0][1], chapter); assert.equal(f.calls.shown[0][2], 'main.typ');
  assert.match(f.calls.logs.at(-1)[0], /Compiled main.typ successfully/);
  assert.equal(f.calls.logs.at(-1)[2](), false, 'existing diagnostic navigation remains bound to its captured context');
  assert.deepEqual(f.calls.statuses.at(-1), ['Typst PDF compiled locally.']);
});
test('queued genuine compiler failure keeps the original error predicate while successful admission remains allowed', async () => {
  const f = fixture({ busy: true, holdCompile: true }); await f.adapter.compileSession(f.session, true);
  f.environment.view = {}; f.environment.navigationIntent++; f.environment.compiling = false;
  f.adapter.releaseCompileQueue(); await f.compileStarted.promise;
  assert.equal(f.calls.logs.at(-1)[0], 'Compiling main.typ with Typst…', 'existing start presentation is retained');
  clearPresentation(f); f.compile.resolve(); await turn();
  assertNoObsoletePresentation(f); assert.deepEqual(f.calls.requests.map(operation => operation.action), ['open', 'compile']);
  assert.equal(f.environment.compiling, false); assert.equal(f.environment.explicitCompiles.length, 0);
});
test('shared keyboard handler uses Compile reporting only for F5/Ctrl-Enter and preserves ordinary Save/Escape', async () => {
  const keyboard = between("document.addEventListener('keydown', task(async event => {", "$('review-toggle').onclick");
  const f = fixture(), callbacks = [], calls = [];
  const environment = { document: { addEventListener: (_, callback) => callbacks.push(callback) }, task: f.adapter.task,
    active: f.session, compileActive: async () => calls.push('compile'), saveSession: async () => { calls.push('save'); throw { message: 'Save remains visible' }; }, closeWorkspaceMenus: () => calls.push('escape') };
  runInNewContext(keyboard, environment);
  const key = (name, ctrlKey = false) => ({ key: name, ctrlKey, preventDefault() { calls.push('prevent'); } });
  await callbacks[0](key('s', true)); assert.deepEqual(f.calls.statuses.at(-1), ['Save remains visible', true]);
  await callbacks[0](key('Escape')); await callbacks[0](key('F5')); await callbacks[0](key('Enter', true));
  assert.deepEqual(calls, ['prevent', 'save', 'escape', 'prevent', 'compile', 'prevent', 'compile']);
});
