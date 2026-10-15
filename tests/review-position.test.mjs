import test from 'node:test';
import assert from 'node:assert/strict';
import { positionReviewCards, acceptedTextChange } from '../modules/frontend/review-position.js';
import { EditorState, Transaction } from '@codemirror/state';
import { history, undo, redo } from '@codemirror/commands';

test('source-ordered cards retain sparse anchor positions without collisions', () => {
  const positioned = positionReviewCards([{ id: 'later', from: 200, desiredTop: 400, height: 100 }, { id: 'early', from: 10, desiredTop: 50, height: 100 }]);
  assert.deepEqual(positioned.map(item => [item.id, item.top]), [['early', 50], ['later', 400]]);
});

test('focused collision layout keeps earlier and later cards reachable after text enlargement', () => {
  const entries = Array.from({ length: 10 }, (_, index) => ({ id: String(index), from: index * 10, desiredTop: index * 20, height: 240 + index * 25 }));
  const positioned = positionReviewCards(entries, '5');
  assert.equal(positioned[0].top, 0);
  for (let index = 1; index < positioned.length; index += 1) assert.ok(positioned[index].top >= positioned[index - 1].top + positioned[index - 1].height + 8);
  assert.ok(positioned.at(-1).top > 2000, 'long history remains accessible rather than clipped above the focused card');
});

test('cards sharing a passage have stable order and distinct usable bounds', () => {
  const positioned = positionReviewCards([{ id: 'marker', from: 2, desiredTop: 0, height: 120 }, { id: 'suggestion', from: 2, desiredTop: 0, height: 160 }], 'suggestion');
  assert.deepEqual(positioned.map(item => item.id), ['marker', 'suggestion']);
  assert.equal(positioned[1].top, 128);
  assert.deepEqual(positionReviewCards([]), []);
});

test('accepted wording maps later source selections and remains individually undoable', () => {
  let state = EditorState.create({ doc: '<p>Hello world. This sentence.</p>', selection: { anchor: 16, head: 29 }, extensions: [history()] });
  state = state.update({ changes: { from: 8, insert: 'X' }, annotations: Transaction.userEvent.of('input.type') }).state;
  const changed = state.doc.toString().replace('Hello', 'Greetings');
  state = state.update({ changes: acceptedTextChange(state.doc.toString(), changed), annotations: Transaction.userEvent.of('input.review') }).state;
  assert.equal(state.sliceDoc(state.selection.main.from, state.selection.main.to), 'This sentence');
  const target = { get state() { return state; }, dispatch: transaction => { state = state.update(transaction).state; } };
  assert.equal(undo(target), true); assert.equal(state.doc.toString(), '<p>HelloX world. This sentence.</p>', 'undoing acceptance keeps the earlier adjacent typing');
  assert.equal(redo(target), true); assert.equal(state.doc.toString(), changed);
  const emoji = acceptedTextChange('a😀 beta', 'a😃 beta');
  assert.deepEqual(emoji, { from: 1, to: 3, insert: '😃' }, 'accepted changes do not split Unicode surrogate pairs');
});

test('literal CRLF source keeps clean review quotes, UTF-16 positions and roundtrip bytes', () => {
  const source = '<p>First 😀 paragraph.</p>\r\n<p>Second passage.</p>\r\n';
  const from = source.indexOf('Second passage.');
  let state = EditorState.create({ doc: source, extensions: [EditorState.lineSeparator.of('\n'), history()] });
  assert.equal(state.doc.toString(), source); assert.equal(state.doc.length, source.length);
  state = state.update({ selection: { anchor: from, head: from + 'Second passage.'.length } }).state;
  assert.equal(state.sliceDoc(state.selection.main.from, state.selection.main.to), 'Second passage.');
  assert.equal(state.doc.line(2).from, source.indexOf('<p>Second'), 'review coordinates count the literal carriage return');
  state = state.update({ changes: { from: state.selection.main.from, to: state.selection.main.to, insert: 'Revised passage.' }, userEvent: 'input.review' }).state;
  assert.equal(state.doc.toString(), source.replace('Second passage.', 'Revised passage.'));
  const target = { get state() { return state; }, dispatch: transaction => { state = state.update(transaction).state; } };
  assert.equal(undo(target), true); assert.equal(state.doc.toString(), source, 'review undo retains original CRLF bytes');
});
