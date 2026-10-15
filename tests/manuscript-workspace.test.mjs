import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { manuscriptTree, clampPaneWidth, pdfPageWindow, capturePublicationInputs, publicationPreviewCurrent, editorLineHeights, workspacePreferencesKey, normalizeWorkspacePreferences, readWorkspacePreferences, writeWorkspacePreferences } from '../modules/frontend/manuscript-workspace.js';

test('native inventory retains empty directories, assets and duplicate source basenames in folder-first order', () => {
  const source = path => ({ path, kind: 'source', editable: true });
  const tree = manuscriptTree([source('main.typ'), source('chapters/part10.typ'), { path: 'empty', kind: 'directory', editable: false }, source('appendix/main.typ'), source('chapters/part2.typ'), { path: 'chapters', kind: 'directory', editable: false }, { path: 'image.png', kind: 'asset', editable: false, bytes: 4 }]);
  assert.deepEqual(tree.map(node => node.name), ['appendix', 'chapters', 'empty', 'image.png', 'main.typ']);
  assert.deepEqual(tree[1].children.map(node => node.path), ['chapters/part2.typ', 'chapters/part10.typ']);
  assert.equal(tree[0].children[0].path, 'appendix/main.typ');
  assert.equal(tree[0].children[0].editable, true);
  assert.equal(tree[2].kind, 'directory'); assert.deepEqual(tree[2].children, []);
  assert.equal(tree[3].editable, false); assert.equal(tree[3].kind, 'asset'); assert.equal(tree[3].bytes, 4);
});

test('actual Save shortcut accepts either letter case and Caps Lock with Ctrl or Meta only', async () => {
  const source = await readFile(new URL('../src/manuscript.js', import.meta.url), 'utf8');
  const shortcut = source.slice(source.indexOf("document.addEventListener('keydown', task(async event =>"), source.indexOf("$('review-toggle').onclick"));
  let handler, saved = 0;
  const active = { content: 'Unsaved user buffer' };
  runInNewContext(shortcut, { document: { addEventListener: (type, callback) => { handler = callback; } }, task: callback => callback, active, saveSession: async session => { assert.equal(session, active); saved += 1; } });
  for (const modifiers of [{ ctrlKey: true }, { metaKey: true }]) for (const key of ['s', 'S']) {
    const before = saved; let prevented = false;
    await handler({ key, ...modifiers, getModifierState: name => name === 'CapsLock' && key === 'S', preventDefault: () => { prevented = true; } });
    assert.equal(saved, before + 1); assert.equal(prevented, true);
  }
  let prevented = false; const before = saved;
  await handler({ key: 'S', preventDefault: () => { prevented = true; } });
  assert.equal(saved, before); assert.equal(prevented, false); assert.equal(active.content, 'Unsaved user buffer');
});

test('pane dragging reserves working editor and preview room', () => {
  assert.equal(clampPaneWidth(800, 1000), 600);
  assert.equal(clampPaneWidth(-10, 1000), 150);
});

test('file pane clamping reserves visible rail, review and splitters without consuming the content minimum', () => {
  const preferred = 1200, width = 1100, fixed = 40 + 240 + 7 + 7;
  const effective = clampPaneWidth(preferred, width, 150, 400, fixed);
  assert.equal(effective, 406);
  assert.equal(width - fixed - effective, 400);
  assert.equal(clampPaneWidth(preferred, width, 150, 400, 40 + 7 + 7), 646, 'closing review releases its actual width');
  assert.equal(clampPaneWidth(preferred, 901, 150, 400, fixed), 207);
  assert.equal(clampPaneWidth(preferred, 2200, 150, 400, 40 + 280 + 7 + 7), preferred, 'expansion restores the stored preference');
  assert.equal(clampPaneWidth(preferred, 100, 150, 400, 80), 20, 'an undersized budget cannot allocate beyond its remaining box');
});

test('PDF page window reaches the complete document while bounding live pages', () => {
  assert.deepEqual(pdfPageWindow(70, 100), { page: 70, first: 69, last: 71 });
  assert.deepEqual(pdfPageWindow(100, 100), { page: 100, first: 99, last: 100 });
  assert.deepEqual(pdfPageWindow(0, 1), { page: 1, first: 1, last: 1 });
});

test('a delayed PDF response cannot mark a newer saved revision current', () => {
  const result = { current: true, revision: 'compiled-source' };
  const main = { path: 'main.typ', version: 0, snapshot: { review: { revision: 'compiled-source' } }, dirty: false, conflict: null };
  const state = { main, inputSessions: [main], captured: capturePublicationInputs([main], 0), projectVersion: 0, composing: false };
  assert.equal(publicationPreviewCurrent(result, state), true);
  main.snapshot.review.revision = 'newer-autosaved-source';
  assert.equal(publicationPreviewCurrent(result, state), false);
});

test('PDF current status requires a clean, conflict-free buffer without active composition', () => {
  const result = { current: true, revision: 'source' };
  const main = { path: 'main.typ', version: 0, snapshot: { review: { revision: 'source' } }, dirty: false, conflict: null };
  const state = { main, inputSessions: [main], captured: capturePublicationInputs([main], 0), projectVersion: 0, composing: false };
  assert.equal(publicationPreviewCurrent(result, { ...state, inputSessions: [{ ...main, dirty: true }] }), false);
  assert.equal(publicationPreviewCurrent(result, { ...state, inputSessions: [{ ...main, conflict: { content: 'external' } }] }), false);
  assert.equal(publicationPreviewCurrent(result, { ...state, composing: true }), false);
  assert.equal(publicationPreviewCurrent({ ...result, current: false }, state), false);
});

test('closed and reopened autosaved inputs cannot reuse an older publication snapshot', () => {
  const result = { current: true, revision: 'main-source' };
  const main = { path: 'main.typ', version: 0, snapshot: { review: { revision: 'main-source' } }, dirty: false, conflict: null };
  const chapter = { ...main, path: 'chapter.typ', snapshot: { review: { revision: 'chapter-source' } } };
  const captured = capturePublicationInputs([main, chapter], 3);
  const state = { main, inputSessions: [main, chapter], captured, projectVersion: 3, composing: false };
  assert.equal(publicationPreviewCurrent(result, state), true);
  const reopened = { ...chapter, version: 1, snapshot: { review: { revision: 'reopened-autosaved-source' } } };
  assert.equal(publicationPreviewCurrent(result, { ...state, inputSessions: [main, reopened] }), false, 'session identity cannot reset the captured buffer generation');
  assert.equal(publicationPreviewCurrent(result, { ...state, inputSessions: [main], projectVersion: 4 }), false, 'project edit generation survives closing the changed tab');
  chapter.snapshot.review.revision = 'changed-without-a-buffer-version';
  assert.equal(captured.sessions[1][2], 'chapter-source', 'captured revisions are immutable values');
  assert.equal(publicationPreviewCurrent(result, state), false);
});

test('a saved dependency edit invalidates publication even when the main document is unchanged', () => {
  const result = { current: true, revision: 'main-source' };
  const main = { path: 'main.typ', version: 0, snapshot: { review: { revision: 'main-source' } }, dirty: false, conflict: null };
  const chapter = { ...main, path: 'chapter.typ' };
  const state = { main, inputSessions: [main, chapter], captured: capturePublicationInputs([main, chapter], 0), projectVersion: 0, composing: false };
  chapter.version += 1;
  assert.equal(publicationPreviewCurrent(result, state), false);
});

test('workspace preferences retain only valid user-owned fields and leave one content pane visible', () => {
  const preferences = normalizeWorkspacePreferences({ version: 1, filesWidth: 375, editorFraction: .65, filesCollapsed: true, editorCollapsed: true, previewCollapsed: true, reviewOpen: true, outlineCollapsed: true, editorFontSize: 18, wordWrap: false, arbitrary: 'discard' });
  assert.deepEqual(preferences, { version: 1, filesWidth: 375, editorFraction: .65, filesCollapsed: true, editorCollapsed: false, previewCollapsed: true, reviewOpen: true, outlineCollapsed: true, editorFontSize: 18, editorLineHeight: 'normal', wordWrap: false });
  assert.deepEqual(normalizeWorkspacePreferences({ version: 1, filesWidth: Infinity, editorFraction: .1, editorFontSize: '18', wordWrap: 'false' }), normalizeWorkspacePreferences());
  assert.deepEqual(normalizeWorkspacePreferences({ version: 2, filesWidth: 375 }), normalizeWorkspacePreferences());
});
test('pinned editor line heights extend the existing v1 store without resetting earlier pane preferences', () => {
  assert.deepEqual(editorLineHeights, { compact: 1.33, normal: 1.6, wide: 2 });
  for (const editorLineHeight of Object.keys(editorLineHeights)) {
    const value = normalizeWorkspacePreferences({ version: 1, editorLineHeight, editorFontSize: 18, filesWidth: 420, reviewOpen: true });
    assert.equal(value.editorLineHeight, editorLineHeight); assert.equal(value.filesWidth, 420); assert.equal(value.reviewOpen, true);
    let stored; const storage = { getItem: () => stored, setItem: (_, value) => { stored = value; } };
    assert.equal(writeWorkspacePreferences(value, storage), true); assert.deepEqual(readWorkspacePreferences(storage), value);
  }
  for (const editorLineHeight of [undefined, null, 2, 'huge', '__proto__', 'constructor']) assert.equal(normalizeWorkspacePreferences({ version: 1, editorLineHeight }).editorLineHeight, 'normal');
});

test('workspace preferences round trip and unavailable or corrupt storage preserves defaults', () => {
  let stored;
  const storage = { setItem(key, value) { assert.equal(key, workspacePreferencesKey); stored = value; }, getItem(key) { assert.equal(key, workspacePreferencesKey); return stored; } };
  const preferences = normalizeWorkspacePreferences({ version: 1, filesWidth: 420, editorFraction: .7, editorFontSize: 16, wordWrap: false });
  assert.equal(writeWorkspacePreferences(preferences, storage), true);
  assert.deepEqual(readWorkspacePreferences(storage), preferences);
  stored = '{broken'; assert.deepEqual(readWorkspacePreferences(storage), normalizeWorkspacePreferences());
  const unavailable = { getItem() { throw new Error('Storage denied'); }, setItem() { throw new Error('Storage denied'); } };
  assert.deepEqual(readWorkspacePreferences(unavailable), normalizeWorkspacePreferences());
  assert.equal(writeWorkspacePreferences(preferences, unavailable), false);
});
