import assert from 'node:assert/strict';
import test from 'node:test';
import { manuscriptTree } from '../modules/frontend/manuscript-workspace.js';
import { smartSourceEntries, smartSourceNotice } from '../modules/frontend/smart-source-tree.js';

test('Smart navigation intersects dependencies with editable Typst inventory, preserving epochs and ancestors', () => {
  const entries = [
    { path: 'data', kind: 'directory' },
    { path: 'main.typ', kind: 'source', editable: true, sourceEpoch: 3 },
    { path: 'chapters/part.typ', kind: 'source', editable: true, sourceEpoch: 4 },
    { path: 'unused.typ', kind: 'source', editable: true },
    { path: 'figure.png', kind: 'asset' },
    { path: 'notes.html', kind: 'source', editable: true },
  ];
  const inventory = { entries, typstSources: { main: 'main.typ', paths: ['main.typ', 'chapters/part.typ', 'figure.png', 'notes.html', 'missing.typ'], complete: true } };
  const selected = smartSourceEntries(inventory);
  assert.deepEqual(selected, [entries[1], entries[2]]);
  assert.equal(selected[1], entries[2]);
  const tree = manuscriptTree(selected);
  assert.equal(tree[0].path, 'chapters');
  assert.equal(tree[0].children[0].sourceEpoch, 4);
  assert.equal(tree[1].path, 'main.typ');
  assert.equal(inventory.entries.length, 6, 'full inventory is retained for switching back');
});

test('Smart navigation explains unset main and partial resolution instead of showing unrelated files', () => {
  const inventory = { entries: [{ path: 'other.typ', editable: true }] };
  assert.deepEqual(smartSourceEntries(inventory), []);
  assert.match(smartSourceNotice(inventory), /Set as main document/);
  inventory.typstSources = { main: 'main.typ', paths: [], complete: false, reason: 'Dynamic imports could not be resolved.' };
  assert.match(smartSourceNotice(inventory), /Saved Typst sources for main.typ.*Dynamic imports/);
  inventory.typstSources.complete = true;
  assert.equal(smartSourceNotice(inventory), 'Saved Typst sources for main.typ.');
});
