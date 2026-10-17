import assert from 'node:assert/strict';
import test from 'node:test';
import { assertContextShareReady, validateContextPreview, requestContextPreview, contextTextPage } from '../src/context-sharing.js';
import { captureSourceBinding, ReviewSession } from '../modules/frontend/review-session.js';

const revision = 'a'.repeat(64);
const snapshot = { path: 'chapter.typ', sourceEpoch: 2, documentId: 'chapter', content: 'Saved chapter', review: { revision, rules: [], markers: [], suggestions: [] } };
const preview = () => ({ scopeId: 'b'.repeat(64), main: 'main.typ', snapshot: 'saved', complete: true, files: [{ path: 'main.typ', revision, sourceEpoch: 1 }, { path: 'chapter.typ', revision, sourceEpoch: 2 }] });

test('context text pages retain every original character and never split Unicode graphemes', () => {
  const original = 'chapters/👨‍👩‍👧‍👦/e\u0301/العربية/日本語/long-name.typ\n';
  const boundaries = new Set([...new Intl.Segmenter(undefined,{granularity:'grapheme'}).segment(original)].map(part=>part.index));
  boundaries.add(original.length);
  let offset=0, recovered='';
  while(offset<original.length) {
    const page=contextTextPage(original,offset,text=>[...new Intl.Segmenter(undefined,{granularity:'grapheme'}).segment(text)].length<=3);
    assert.ok(page.end>offset); assert.ok(boundaries.has(page.end)); recovered+=page.text; offset=page.end;
  }
  assert.equal(recovered,original);
  assert.deepEqual(contextTextPage(original,0,()=>false),{text:'',end:0},'a no-fit budget cannot truncate or manufacture consent text');
  assert.deepEqual(contextTextPage('👨‍👩‍👧‍👦',0,text=>text.length<=2),{text:'',end:0},'a page cannot split a family grapheme even if one of its code points would fit');
});

test('preview contention retries only a refused read while retaining consent-time source guards', async () => {
  const busy = { code: 'busy', message: 'A local document operation is running. Retry this action.' };
  let calls = 0;
  const scope = await requestContextPreview(async operation => {
    assert.equal(operation.action, 'context_preview'); calls++;
    if (calls === 1) throw busy;
    return preview();
  }, {path:'chapter.typ'}, () => {});
  assert.equal(scope.complete, true); assert.equal(calls, 2);
  calls = 0;
  await assert.rejects(requestContextPreview(async () => { calls++; throw busy; }, {path:'chapter.typ'}, () => {
    if (calls) throw {code:'context_changed'};
  }), {code:'context_changed'});
  assert.equal(calls, 1, 'A changed source must not receive another preview request.');
  calls = 0;
  await assert.rejects(requestContextPreview(async () => { calls++; throw {code:'busy',message:'An uncertain write is pending.'}; }, {path:'chapter.typ'}, () => {}), {code:'busy'});
  assert.equal(calls, 1, 'Other busy boundaries must not be retried.');
});

test('complete context consent accepts exact saved active and main document scope', () => {
  const session = new ReviewSession(structuredClone(snapshot), 'project', () => { throw Error('Consent validation must never save'); });
  assert.doesNotThrow(() => assertContextShareReady(session, captureSourceBinding(session)));
  const scope = preview();
  assert.equal(validateContextPreview(scope, session.path), scope);
});

test('dirty, busy, conflicted, composing, closing or changed drafts cannot be shared or saved implicitly', () => {
  for (const condition of ['dirty', 'pending', 'conflict', 'uncertainMutation', 'unresolvedMove', 'reviewProblem', 'composing', 'closing', 'version']) {
    let calls = 0;
    const session = new ReviewSession(structuredClone(snapshot), 'project', () => { calls += 1; });
    const options = {};
    if (condition === 'dirty') session.edit('Keep my unsaved draft');
    else if (condition === 'composing' || condition === 'closing') options[condition] = true;
    else if (condition === 'version') options.version = -1;
    else session[condition] = condition === 'pending' ? 1 : {};
    assert.throws(() => assertContextShareReady(session, captureSourceBinding(session), options));
    assert.equal(calls, 0);
    assert.equal(session.content, condition === 'dirty' ? 'Keep my unsaved draft' : snapshot.content);
  }
});

test('partial, unbound, duplicate, malformed or incomplete scope previews cannot authorize sharing', () => {
  for (const change of [
    scope => { scope.complete = false; }, scope => { scope.snapshot = 'draft'; }, scope => { scope.scopeId = 'guessed'; },
    scope => { scope.files = []; }, scope => { scope.files.pop(); }, scope => { scope.files.shift(); },
    scope => { scope.files.push({ ...scope.files[0] }); }, scope => { scope.files[1].revision = ''; },
    scope => { scope.files[1].sourceEpoch = -1; }, scope => { scope.main = 'unapproved.typ'; },
  ]) {
    const scope = preview(); change(scope);
    assert.throws(() => validateContextPreview(scope, snapshot.path), error => error.code === 'context_incomplete');
  }
});
