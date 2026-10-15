import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { captureWordCount } from '../modules/frontend/word-count-controller.js';
import { captureControlState, assertControlState } from '../modules/frontend/manuscript-control-state.js';

const manuscript = await readFile(new URL('../src/manuscript.js', import.meta.url), 'utf8');
const adapterSource = manuscript.slice(manuscript.indexOf('let wordCountReturnFocus'), manuscript.indexOf('function restoreWorkspacePreferences()'));
function setup() {
  const calls = [], session = { project: 'project', path: 'chapter.typ', content: 'latest dirty buffer', version: 4, generation: 4, dirty: true, conflict: {}, reviewProblem: { code: 'policy_missing' }, snapshot: { content: 'old saved text', review: { revision: 'saved' } } };
  const state = { doc: { toString: () => session.content }, selection: { ranges: [{ from: 7, to: 12 }] } };
  const nodes = { 'word-count-dialog': { open: false, showModal() { this.open = true; } } };
  const environment = { active: session, view: { state, compositionStarted: false }, windowClosing: false, localRequestsVersion: 0, sessions: new Map([['project:chapter.typ', session]]), keyFor: (project, path) => `${project}:${path}`,
    $: id => nodes[id], nativeReview: true, wordCountTypstText() { throw Error('Only the controller can issue a literal-text query'); }, captureWordCount,
    crypto: { randomUUID: () => 'snapshot-request' }, document: { activeElement: {}, documentElement: { lang: 'en' } },
    WordCountController: class { constructor(options) { this.options = options; } open(capture, input) { calls.push({ capture, input }); } },
  };
  const open = runInNewContext(adapterSource + '\nopenWordCount;', environment);
  return { environment, nodes, session, state, calls, open };
}
test('actual Word count entry captures dirty conflicted CodeMirror source without a save, mutation or editor transaction', () => {
  const { open, environment, session, state, nodes, calls } = setup();
  const controls = () => ({ sessions: [session], active: session, navigation: 1, requestsVersion: environment.localRequestsVersion, pending: 0, composing: false, closing: false });
  const prepared = captureControlState(controls());
  open(); assert.equal(nodes['word-count-dialog'].open, true); assert.equal(environment.localRequestsVersion, 1);
  assert.equal(calls[0].capture.session, session); assert.equal(calls[0].capture.document, state.doc); assert.equal(calls[0].capture.dirty, true);
  assert.equal(calls[0].capture.reviewProblem, 'policy_missing'); assert.equal(calls[0].input.source, 'latest dirty buffer'); assert.equal(calls[0].input.format, 'typ');
  assert.deepEqual(calls[0].capture.ranges, [{ from: 7, to: 12 }]); assert.equal(environment.view.state, state);
  assert.equal(session.snapshot.content, 'old saved text'); assert.equal(session.version, 4);
  assert.throws(() => assertControlState(prepared, controls()), error => error.code === 'stale');
});
test('IME, native closing and unsupported current files refuse counting without creating work or forcing an editor blur', () => {
  for (const state of ['composition', 'closing', 'unsupported', 'none']) {
    const { open, environment, nodes, calls } = setup();
    if (state === 'composition') environment.view.compositionStarted = true;
    if (state === 'closing') environment.windowClosing = true;
    if (state === 'unsupported') environment.active.path = 'data.csv';
    if (state === 'none') environment.active = null;
    assert.throws(open, error => typeof error.message === 'string');
    assert.equal(nodes['word-count-dialog'].open, false); assert.equal(calls.length, 0); assert.equal(environment.localRequestsVersion, 0);
  }
});
