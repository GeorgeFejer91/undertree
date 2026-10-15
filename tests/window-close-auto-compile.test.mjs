import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { LatestCompileScheduler } from '../modules/frontend/latest-compile-scheduler.js';
import { createWindowCloseGuard } from '../modules/frontend/window-chrome.js';
import * as review from '../modules/frontend/review-session.js';

const source = await readFile(new URL('../src/manuscript.js', import.meta.url), 'utf8');
const between = (start, end) => {
  const from = source.indexOf(start), to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `Actual manuscript adapter section exists: ${start}`);
  return source.slice(from, to);
};
const callbacks = [
  between('const readOnlyRequests =', 'async function fileActivity('),
  between('const compileScheduler =', 'const reviewEffect ='),
  between('function setWindowClosing(', 'function closeDialogs('),
  between('function controlContext(', 'function controlPreparation('),
  between('async function saveSession(', 'function decorations('),
  between('async function compileSession(', 'function renderTabs('),
  between('windowChrome = await setupWindowChrome({', '\nobserveReviewText('),
].join('\n');

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture(t) {
  const save = deferred(), saveStarted = deferred(), build = deferred(), buildStarted = deferred();
  const removal = deferred(), removalStarted = deferred();
  const calls = [], errors = [], regions = [{}], timers = new Map(), nodes = new Map();
  let nextTimer = 0, now = 0, revision = 0, failSave = false;
  const environment = {
    ...review, sessions: new Map(), active: null, windowClosing: false, windowFocus: null,
    compiling: false, explicitCompiles: [], localRequests: 0, localRequestsVersion: 0,
    navigationIntent: 0, saveTimers: new Map(), pdfBytes: null, windowChrome: null,
    fileImport: { pendingCount: 0 }, projectExport: { pendingCount: 0 },
    keyFor: (project, path) => `${project}:${path}`,
    view: { compositionStarted: false, dispatch: () => {} },
    document: { activeElement: { isConnected: true, focus: () => {} }, querySelectorAll: () => regions },
    windowEditing: { reconfigure: value => value }, windowEditorAccess: () => environment.windowClosing,
    historyPanel: { changed: () => {} }, wordCount: { changed: () => {} }, editorBridge: { changed: () => {} },
    clearTimeout: () => {}, renderReview: () => {}, renderTabs: () => {}, queueSync: () => {}, saveLabel: () => '',
    status: (message, error) => { if (error) errors.push(message); }, setCompileLog: () => {}, pdfStatus: () => {}, showPdf: async () => {},
    publicationPath: () => 'main.typ', publicationCurrent: () => true,
    observedSourceTarget: () => review.captureSourceBinding(environment.active), assertPublicationTarget: () => {},
    projectInputVersions: () => ({ version: 0, sessions: [] }), projectEditVersions: new Map(),
    $: id => { if (!nodes.has(id)) nodes.set(id, {}); return nodes.get(id); },
    LatestCompileScheduler: class extends LatestCompileScheduler {
      constructor(options) {
        super({ ...options,
          setTimer: (callback, delay) => { const id = ++nextTimer; timers.set(id, { at: now + delay, callback }); return id; },
          clearTimer: id => timers.delete(id),
        });
      }
    },
    nativeRequest: async operation => {
      calls.push(operation.action);
      if (operation.action === 'save') {
        saveStarted.resolve(); await save.promise;
        if (failSave) throw new Error('Disk write failed');
        return { ...environment.active.snapshot, content: operation.content, review: { revision: `saved-${++revision}` } };
      }
      if (operation.action === 'compile') { buildStarted.resolve(); await build.promise; return {}; }
      if (operation.action === 'open') return environment.active.snapshot;
      assert.fail(`Unexpected operation: ${operation.action}`);
    },
    setupWindowChrome: async options => {
      const guard = createWindowCloseGuard({
        onCloseRequested: async () => async () => { removalStarted.resolve(); await removal.promise; },
        close: async () => { calls.push('native-close'); },
      }, { ...options, onError: error => errors.push(error.message) });
      await guard.listen();
      return guard;
    },
  };
  const adapter = await runInNewContext(`(async () => { ${callbacks}\nreturn { request, compileScheduler, compileSession, close: windowChrome.close }; })()`, environment);
  const session = new review.ReviewSession({ path: 'main.typ', content: 'Original', review: { revision: 'original' } }, 'project', adapter.request);
  environment.active = session; environment.sessions.set('project:main.typ', session);
  const turn = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
  const advance = async milliseconds => {
    now += milliseconds;
    for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.callback(); }
    await turn();
  };
  t.after(async () => { save.resolve(); build.resolve(); removal.resolve(); adapter.compileScheduler.cancel(); await turn(); });
  return { adapter, environment, session, calls, errors, regions, timers, save, saveStarted, build, buildStarted, removal, removalStarted, advance, turn, failSave: value => { failSave = value; } };
}

test('actual Close cancels an unsent automatic compile before a held Save crosses 700 ms', { timeout: 2000 }, async t => {
  const f = await fixture(t);
  f.session.edit('Latest manuscript'); f.adapter.compileScheduler.request('project:main.typ');
  const closing = f.adapter.close();
  await f.saveStarted.promise;
  assert.equal(f.environment.windowClosing, true); assert.equal(f.regions[0].inert, true);
  await f.advance(701);
  f.save.resolve(); await f.removalStarted.promise; await f.turn();
  f.removal.resolve(); await closing;
  assert.deepEqual(f.calls, ['save', 'native-close'], 'Close must save and close without admitting automatic Open/Compile');
  assert.deepEqual(f.errors, []); assert.equal(f.session.snapshot.content, 'Latest manuscript');
  assert.equal(f.session.dirty, false); assert.equal(f.adapter.compileScheduler.pending, false);
});

test('failed actual Close restores editing and a new edit still automatically builds', { timeout: 2000 }, async t => {
  const f = await fixture(t);
  f.session.edit('Draft'); f.adapter.compileScheduler.request('project:main.typ'); f.failSave(true);
  const closing = f.adapter.close(); await f.saveStarted.promise;
  await f.advance(701); f.save.resolve(); await closing; await f.turn();
  assert.equal(f.calls.includes('native-close'), false); assert.equal(f.session.dirty, true);
  assert.equal(f.environment.windowClosing, false); assert.equal(f.regions[0].inert, false);
  assert.match(f.errors[0], /Disk write failed/);
  f.failSave(false); f.session.edit('Retry draft'); f.adapter.compileScheduler.request('project:main.typ');
  await f.advance(701); await f.buildStarted.promise;
  assert.equal(f.calls.filter(action => action === 'compile').length, 1);
  f.build.resolve(); await f.turn();
  assert.equal(f.session.dirty, false); assert.equal(f.session.snapshot.content, 'Retry draft');
});

test('actual Close preserves an admitted build, its explicit queue, and the pending-work veto', { timeout: 2000 }, async t => {
  const f = await fixture(t); f.save.resolve();
  const admitted = f.adapter.compileSession(f.session); await f.buildStarted.promise;
  await f.adapter.compileSession(f.session, true);
  const queued = f.environment.explicitCompiles[0];
  f.adapter.compileScheduler.request('project:main.typ');
  await f.adapter.close();
  assert.equal(f.environment.compiling, true); assert.equal(f.environment.localRequests, 1);
  assert.equal(f.environment.explicitCompiles.length, 1); assert.equal(f.environment.explicitCompiles[0], queued);
  assert.equal(f.adapter.compileScheduler.pending, false); assert.equal(f.timers.size, 0);
  assert.equal(f.calls.includes('native-close'), false); assert.match(f.errors[0], /pending local operations/);
  f.build.resolve(); await admitted; await f.turn();
  assert.equal(f.calls.filter(action => action === 'compile').length, 2, 'The explicit queued build must still run');
  assert.equal(f.environment.explicitCompiles.length, 0); assert.equal(f.environment.compiling, false);
});

test('actual IME Close veto leaves the automatic timer intact and cannot save the composition', { timeout: 2000 }, async t => {
  const f = await fixture(t); f.save.resolve(); f.build.resolve();
  f.adapter.compileScheduler.request('project:main.typ');
  const timer = [...f.timers.keys()][0]; f.environment.view.compositionStarted = true;
  await f.adapter.close();
  assert.equal(f.environment.windowClosing, false); assert.deepEqual(f.calls, []);
  assert.equal(f.adapter.compileScheduler.pending, true); assert.equal(f.timers.has(timer), true);
  assert.match(f.errors[0], /text composition/);
  f.environment.view.compositionStarted = false; await f.advance(701);
  assert.equal(f.calls.filter(action => action === 'compile').length, 1);
});
