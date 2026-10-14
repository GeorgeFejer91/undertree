import test from 'node:test';
import assert from 'node:assert/strict';
import { manuscriptTree, clampPaneWidth, pdfPageWindow } from '../modules/frontend/manuscript-workspace.js';

test('hierarchical source inventory sorts folders first without losing duplicate basenames', () => {
  const tree = manuscriptTree(['main.typ', 'chapters/part10.typ', 'appendix/main.typ', 'chapters/part2.typ']);
  assert.deepEqual(tree.map(node => node.name), ['appendix', 'chapters', 'main.typ']);
  assert.deepEqual(tree[1].children.map(node => node.path), ['chapters/part2.typ', 'chapters/part10.typ']);
  assert.equal(tree[0].children[0].path, 'appendix/main.typ');
});

test('pane dragging reserves working editor and preview room', () => {
  assert.equal(clampPaneWidth(800, 1000), 600);
  assert.equal(clampPaneWidth(-10, 1000), 150);
});

test('PDF page window reaches the complete document while bounding live pages', () => {
  assert.deepEqual(pdfPageWindow(70, 100), { page: 70, first: 69, last: 71 });
  assert.deepEqual(pdfPageWindow(100, 100), { page: 100, first: 99, last: 100 });
  assert.deepEqual(pdfPageWindow(0, 1), { page: 1, first: 1, last: 1 });
});
