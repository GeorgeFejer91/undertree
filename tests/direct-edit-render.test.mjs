import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { acceptedTextChange } from '../modules/frontend/review-position.js';

const source = await readFile(new URL('../src/manuscript.js', import.meta.url), 'utf8');
const render = source.match(/function renderDirectEdit\(session, previousSnapshot\) \{[\s\S]*?\n\}/)?.[0];
assert.ok(render);
const snapshot = content => ({ content, review: { revision: content } });

function renderEdit(session, previous) {
  const changes = [], messages = [];
  const apply = runInNewContext(`(${render})`, {
    view: { state: { doc: { toString: () => previous.content } }, dispatch: transaction => changes.push(transaction.changes) },
    acceptedTextChange, authoritative: { of: value => value }, Transaction: { userEvent: { of: value => value } },
    noteProjectEdit() {}, preview() {}, renderTabs() {}, $: () => ({}), saveLabel: () => 'Saved', pdfStatus() {},
    publicationPath: () => null, status: message => messages.push(message),
  });
  apply(session, previous);
  return { changes, messages };
}

test('a confirmed direct source update maps the editor and reports the authorized edit', () => {
  const before = snapshot('Original prose.'), after = snapshot('Clearer prose.');
  after.directEdit = { fromRevision: before.review.revision, toRevision: after.review.revision };
  const result = renderEdit({ snapshot: after, content: after.content, dirty: false, conflict: null }, before);
  assert.equal(result.changes.length, 1); assert.equal(result.messages.length, 1);
  const change = result.changes[0];
  assert.equal(before.content.slice(0, change.from) + change.insert + before.content.slice(change.to), after.content);
});

test('typing or local saves during metadata refresh are never presented as direct AI edits', () => {
  const before = snapshot('Original prose.');
  for (const dirty of [true, false]) {
    const after = snapshot('My local wording.');
    assert.deepEqual(renderEdit({ snapshot: after, content: after.content, dirty, conflict: null }, before), { changes: [], messages: [] });
    after.directEdit = { fromRevision: 'another revision', toRevision: after.review.revision };
    assert.deepEqual(renderEdit({ snapshot: after, content: after.content, dirty, conflict: null }, before), { changes: [], messages: [] });
  }
});
