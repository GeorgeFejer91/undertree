import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeWordCount, countWords, htmlLiteralText, MAX_WORD_COUNT_BYTES } from '../modules/frontend/word-count.js';
import { captureWordCount, wordCountCurrent, WordCountController } from '../modules/frontend/word-count-controller.js';

const proseCount = source => analyzeWordCount({ source, format: 'html', requestId: 'request', locale: 'en' });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
test('HTML estimate decodes ordinary body text and preserves inline, comment, block and cell boundaries', () => {
  assert.equal(proseCount('<p>Alpha &amp; beta</p><p>Gamma</p>').proseWords, 3);
  assert.equal(proseCount('<em>under</em>tree').proseWords, 1);
  assert.equal(proseCount('al<!-- comment -->pha').proseWords, 1);
  assert.equal(proseCount('<p>one</p><p>two<br>three</p><table><tr><td>four</td><td>five</td></tr></table>').proseWords, 5);
  assert.equal(htmlLiteralText('<p>&lt;img src=x onerror=alert(1)&gt;</p>').trim(), '<img src=x onerror=alert(1)>');
});
test('HTML attributes, metadata, raw examples and foreign subtrees are excluded without CSS or script evaluation', () => {
  const source = '<head><title>head words</title><script>globalThis.executed=true</script></head><body><p title="attribute words">ordinary <span hidden>hidden</span></p><style>style words</style><template>template words</template><pre>pre words</pre><code>code words</code><textarea>textarea words</textarea><math>math words</math><svg><text>svg words</text></svg><img src="https://invalid.test/" alt="alt words"></body>';
  assert.equal(proseCount(source).proseWords, 2); assert.equal(globalThis.executed, undefined);
  assert.equal(proseCount('one<script/src=x>ignored script words</script>two').proseWords, 2);
  assert.equal(proseCount('<div>'.repeat(2000) + 'literal words' + '</div>'.repeat(2000)).proseWords, 2);
});
test('exact disjoint source selections preserve fragments, multiple ranges, empty carets and CRLF', () => {
  const source = 'alpha beta\r\ngamma';
  const value = countWords({ source, ranges: [{ from: 0, to: 5 }, { from: 12, to: 17 }] });
  assert.equal(value.sourceWords, 3); assert.equal(value.selectionWords, 2); assert.equal(value.selectionRanges, 2);
  assert.equal(countWords({ source, ranges: [{ from: 6, to: 9 }] }).selectionWords, 1);
  assert.equal(countWords({ source, ranges: [{ from: 6, to: 6 }] }).selectionWords, null);
  assert.equal(source, 'alpha beta\r\ngamma');
});
test('Unicode word segmentation reports locale and counts numbers rather than punctuation or emoji', () => {
  assert.equal(countWords({ source: 'cafe\u0301 👨‍👩‍👧 １２３ one"two"three', locale: 'en' }).sourceWords, 5);
  assert.equal(countWords({ source: '你好世界', locale: 'zh' }).locale, 'zh');
  assert.ok(countWords({ source: 'words', locale: 'invalid_locale' }).locale);
  assert.throws(() => countWords({ source: 'words' }, null), /segmentation is unavailable/);
});
test('range limits or invalid UTF-16 boundaries affect selection only, preserving full-source and prose results', () => {
  for (const ranges of [Array.from({ length: 1001 }, () => ({ from: 0, to: 0 })), [{ from: 1, to: 3 }], [{ from: 2, to: 4 }, { from: 3, to: 5 }]]) {
    const value = countWords({ source: '😀alpha beta', literalText: 'literal prose', ranges });
    assert.equal(value.sourceWords, 2); assert.equal(value.proseWords, 2); assert.equal(value.selectionWords, null); assert.ok(value.selectionReason);
  }
  assert.equal(countWords({ source: 'words', ranges: Array.from({ length: 1000 }, () => ({ from: 0, to: 0 })) }).selectionReason, null);
});
test('supplied text is UTF-8 bounded and an unavailable prose estimate never fabricates zero', () => {
  assert.throws(() => countWords({ source: '😀'.repeat(MAX_WORD_COUNT_BYTES / 4 + 1) }), /2 MiB/);
  const source = 'source words';
  const value = analyzeWordCount({ requestId: 'count', source, format: 'typ', literalText: 'x'.repeat(MAX_WORD_COUNT_BYTES + 1) });
  assert.equal(value.sourceWords, 2); assert.equal(value.proseWords, null); assert.match(value.proseReason, /limit/);
  assert.equal(analyzeWordCount({ requestId: 'count', source, format: 'typ', proseReason: 'Incomplete syntax.' }).proseWords, null);
  assert.throws(() => proseCount('x'.repeat(MAX_WORD_COUNT_BYTES + 1)), /2 MiB/);
});

function context() {
  const session = { project: 'project', path: 'chapter.typ', version: 3, generation: 3, dirty: true, conflict: {}, reviewProblem: { code: 'policy_missing' } };
  const state = { doc: {}, selection: { ranges: [{ from: 0, to: 3 }] } };
  return { session, state, capture: captureWordCount(session, state, 'request') };
}
test('snapshot identity allows independent autosave completion but rejects source, selection, session, IME or dialog changes', () => {
  const { session, state, capture } = context();
  session.dirty = false; assert.equal(wordCountCurrent(capture, session, state, 'request'), true);
  for (const [currentSession, currentState, id, flags] of [[{ ...session }, state, 'request'], [session, { ...state, doc: {} }, 'request'], [session, { ...state, selection: { ranges: [{ from: 0, to: 2 }] } }, 'request'], [session, state, 'new-dialog'], [session, state, 'request', { composing: true }], [session, state, 'request', { closing: true }]]) assert.equal(wordCountCurrent(capture, currentSession, currentState, id, flags), false);
  session.version += 1; assert.equal(wordCountCurrent(capture, session, state, 'request'), false);
});
function controller(options = {}) {
  const workers = [], changes = [];
  const value = new WordCountController({ native: false, isCurrent: () => true, onChange: state => changes.push({ phase: state.phase, result: state.result }), worker: () => {
    const worker = { terminated: false, terminate() { this.terminated = true; }, postMessage(input) { this.input = input; }, finish() { this.onmessage({ data: { ok: true, result: analyzeWordCount(this.input) } }); } };
    workers.push(worker); return worker;
  }, ...options });
  return { value, workers, changes };
}
test('many-range capture and worker payload stay bounded while retaining full-source and prose counts', async t => {
  const { session, state } = context();
  const ranges = new Proxy(Array.from({ length: 20000 }, () => ({ from: 0, to: 0 })), { get(target, key) {
    if (/^\d+$/.test(String(key)) && Number(key) > 1000) throw Error('Capture walked beyond its bounded selection prefix.');
    return Reflect.get(target, key);
  } });
  state.selection = { ranges }; const capture = captureWordCount(session, state, 'request');
  assert.equal(capture.selection, state.selection); assert.equal(capture.selectionRangeCount, 20000); assert.equal(capture.ranges.length, 1001);
  assert.equal(wordCountCurrent(capture, session, state, 'request'), true);
  const { value, workers } = controller(); t.after(() => value.close());
  await value.open(capture, { source: 'current source', format: 'html', locale: 'en' });
  assert.equal(workers[0].input.ranges.length, 1001); workers[0].finish();
  assert.equal(value.current.result.sourceWords, 2); assert.equal(value.current.result.proseWords, 2);
  assert.equal(value.current.result.selectionWords, null); assert.match(value.current.result.selectionReason, /1,000/);
  state.selection = { ranges }; assert.equal(wordCountCurrent(capture, session, state, 'request'), false);
});
test('standalone Typst retains source/selection counts and explicitly unavailable prose without native work', async t => {
  const { capture } = context(), { value, workers } = controller({ analyzeTypst() { throw Error('No browser native call'); } });
  t.after(() => value.close()); await value.open(capture, { source: 'one two', format: 'typ', locale: 'en' });
  workers[0].finish(); assert.equal(value.current.phase, 'ready'); assert.equal(value.current.result.sourceWords, 2);
  assert.equal(value.current.result.selectionWords, 1); assert.equal(value.current.result.proseWords, null); assert.match(value.current.result.proseReason, /desktop/); assert.equal(workers[0].terminated, true);
});
test('native literal input uses exact captured supplied text, and incomplete/busy results retain source counts', async t => {
  for (const outcome of ['ready', 'incomplete', 'busy', 'wrong-id']) {
    const calls = [], { capture } = context();
    const { value, workers } = controller({ native: true, analyzeTypst: async (...args) => {
      calls.push(args); if (outcome === 'busy') throw { code: 'busy', message: 'Native analysis busy.' };
      return { requestId: outcome === 'wrong-id' ? 'wrong' : 'request', method: 'typst-literal-v1', status: outcome === 'incomplete' ? 'unavailable' : 'ready', literalText: 'literal prose', reasonCode: 'incomplete_syntax', reason: 'Incomplete Typst syntax.' };
    } });
    t.after(() => value.close()); await value.open(capture, { source: '#strong[local words]', format: 'typ', locale: 'en' }); workers[0].finish();
    assert.deepEqual(calls, [['request', '#strong[local words]']]); assert.equal(value.current.result.sourceWords, 3);
    assert.equal(value.current.result.proseWords, outcome === 'ready' ? 2 : null);
    if (outcome !== 'ready') assert.ok(value.current.result.proseReason);
  }
});
test('held native replies cannot create workers or paint a closed, replaced or newly edited snapshot', async t => {
  for (const transition of ['close', 'reopen', 'edit']) {
    const gate = deferred(), { capture } = context(); let current = true;
    const { value, workers } = controller({ native: true, isCurrent: () => current, analyzeTypst: async () => { await gate.promise; return { requestId: 'request', method: 'typst-literal-v1', status: 'ready', literalText: 'old words' }; } });
    t.after(() => value.close()); const pending = value.open(capture, { source: 'old', format: 'typ', locale: 'en' });
    if (transition === 'close') value.close();
    if (transition === 'reopen') await value.open({ ...capture, requestId: 'new' }, { source: 'new words', format: 'html', locale: 'en' });
    if (transition === 'edit') current = false;
    gate.resolve(); await pending;
    assert.equal(workers.length, transition === 'reopen' ? 1 : 0);
    assert.equal(value.current?.phase, transition === 'edit' ? 'stale' : transition === 'reopen' ? 'counting' : undefined);
  }
});
test('late worker results and later selection changes cannot repaint another snapshot', async t => {
  const { capture } = context(); let current = true;
  const { value, workers } = controller({ isCurrent: () => current }); t.after(() => value.close());
  await value.open(capture, { source: 'old words', format: 'html', locale: 'en' });
  await value.open({ ...capture, requestId: 'new' }, { source: 'new words here', format: 'html', locale: 'en' });
  workers[0].finish(); assert.equal(value.current.phase, 'counting'); workers[1].finish(); assert.equal(value.current.result.proseWords, 3);
  current = false; value.changed(); assert.equal(value.current.phase, 'stale'); assert.equal(value.current.result, null);
});
