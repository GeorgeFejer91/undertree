import assert from 'node:assert/strict';
import test from 'node:test';
import { sourceHighlightColors } from '../modules/frontend/highlight-rule-access.js';

test('highlight settings expose every current overlapping color without merging separate snippets', () => {
  const content = 'One [A]. Two [A].';
  const review = { rules: [{ id: 'paragraph' }, { id: 'citations' }], markers: [
    { id: 'paragraph', rule: 'paragraph', anchor: { from: 0, to: 17, quote: content, stale: false } },
    { id: 'first', rule: 'citations', anchor: { from: 4, to: 7, quote: '[A]', stale: false } },
    { id: 'second', rule: 'citations', anchor: { from: 13, to: 16, quote: '[A]', stale: false } },
  ] };
  const original = structuredClone(review);
  assert.deepEqual(sourceHighlightColors(review, content, 5), ['paragraph', 'citations']);
  assert.deepEqual(sourceHighlightColors(review, content, 14), ['paragraph', 'citations']);
  assert.deepEqual(sourceHighlightColors(review, content, 8), ['paragraph']);
  assert.deepEqual(sourceHighlightColors(review, content, 0, 17), ['paragraph', 'citations']);
  assert.deepEqual(review, original);
  review.markers[1].anchor.stale = true;
  assert.deepEqual(sourceHighlightColors(review, content, 5), ['paragraph']);
  assert.deepEqual(sourceHighlightColors(review, 'One [B]. Two [A].', 5), []);
  for (const from of [-1, 100, NaN]) assert.deepEqual(sourceHighlightColors(review, content, from), []);
});
