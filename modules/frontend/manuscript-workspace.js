import { captureSourceBinding, sourceBindingCurrent, sourceEpoch, sourceRootsEqual } from './review-session.js';

// File inventory is authoritative; this only groups its existing paths for navigation.
export function manuscriptTree(entries) {
  const root = { children: new Map() };
  for (const entry of entries) {
    const { path } = entry;
    const parts = path.split('/');
    let parent = root;
    for (let index = 0; index < parts.length; index += 1) {
      const name = parts[index];
      if (!parent.children.has(name)) parent.children.set(name, { name, path: parts.slice(0, index + 1).join('/'), children: new Map(), kind: 'directory', editable: false });
      parent = parent.children.get(name);
    }
    Object.assign(parent, entry);
  }
  const sorted = node => [...node.children.values()].sort((a, b) => Number(a.kind !== 'directory') - Number(b.kind !== 'directory') || a.name.localeCompare(b.name, undefined, { numeric: true })).map(child => ({ ...child, children: sorted(child) }));
  return sorted(root);
}

export function clampPaneWidth(requested, available, minimum = 150, reserved = 400, fixed = 0) {
  const usable = Math.max(0, available - fixed);
  const floor = Math.min(minimum, usable);
  return Math.max(floor, Math.min(requested, Math.max(floor, usable - reserved)));
}

export function pdfPageWindow(current, total, radius = 1) {
  const page = Math.max(1, Math.min(total, Math.round(current) || 1));
  return { page, first: Math.max(1, page - radius), last: Math.min(total, page + radius) };
}

export function capturePublicationInputs(inputSessions, projectVersion) {
  return { version: projectVersion, sessions: inputSessions.map(session => [session, session.version, session.snapshot.review.revision, captureSourceBinding(session)]) };
}

export function publicationPreviewCurrent(result, { main, inputSessions, captured, projectVersion, composing }) {
  return result.current === true && (!main || (sourceBindingCurrent(main, captureSourceBinding(main)) && result.revision === main.snapshot.review.revision && sourceEpoch(result) === sourceEpoch(main) && sourceRootsEqual(result, main)))
    && (!captured?.main || (sourceEpoch(result) === captured.main.sourceEpoch && sourceRootsEqual(result, captured.main)))
    && !inputSessions.some(input => input.dirty || input.conflict || input.reviewProblem || input.identityProblem || !sourceRootsEqual(input, result))
    && (!captured || (captured.version === projectVersion && captured.sessions.every(([input, version, revision, binding]) => (!binding || sourceBindingCurrent(input, binding)) && input.version === version
      && input.snapshot.review.revision === revision && !inputSessions.some(current => current.path === input.path && current !== input))))
    && !composing;
}

export const workspacePreferencesKey = 'undertree.workspace-preferences';
export const editorLineHeights = Object.freeze({ compact: 1.33, normal: 1.6, wide: 2 });
export function normalizeWorkspacePreferences(value) {
  const defaults = { version: 1, filesWidth: null, editorFraction: .5, filesCollapsed: false, editorCollapsed: false, previewCollapsed: false, reviewOpen: false, outlineCollapsed: false, editorFontSize: 12, editorLineHeight: 'normal', wordWrap: true };
  if (!value || value.version !== 1) return defaults;
  const result = { ...defaults };
  for (const key of ['filesCollapsed', 'editorCollapsed', 'previewCollapsed', 'reviewOpen', 'outlineCollapsed', 'wordWrap']) if (typeof value[key] === 'boolean') result[key] = value[key];
  if (Number.isFinite(value.filesWidth) && value.filesWidth >= 150 && value.filesWidth <= 1200) result.filesWidth = value.filesWidth;
  if (Number.isFinite(value.editorFraction) && value.editorFraction >= .2 && value.editorFraction <= .8) result.editorFraction = value.editorFraction;
  if (Number.isInteger(value.editorFontSize) && value.editorFontSize >= 10 && value.editorFontSize <= 28) result.editorFontSize = value.editorFontSize;
  if (typeof value.editorLineHeight === 'string' && Object.hasOwn(editorLineHeights, value.editorLineHeight)) result.editorLineHeight = value.editorLineHeight;
  if (result.editorCollapsed && result.previewCollapsed) result.editorCollapsed = false;
  return result;
}

export function readWorkspacePreferences(storage) {
  try { return normalizeWorkspacePreferences(JSON.parse((storage ?? globalThis.localStorage).getItem(workspacePreferencesKey))); }
  catch { return normalizeWorkspacePreferences(); }
}

export function writeWorkspacePreferences(preferences, storage) {
  try { (storage ?? globalThis.localStorage).setItem(workspacePreferencesKey, JSON.stringify(normalizeWorkspacePreferences(preferences))); return true; }
  catch { return false; }
}
