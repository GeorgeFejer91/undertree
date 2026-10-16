import './manuscript.css';
import { invoke } from '@tauri-apps/api/core';
import { basicSetup } from 'codemirror';
import { EditorView, Decoration, highlightSpecialChars } from '@codemirror/view';
import { EditorState, StateEffect, StateField, Compartment, Transaction } from '@codemirror/state';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';
import { ReviewSession, sourceEpoch, sourceRoot, sourceRootsEqual, captureSourceBinding, sourceBindingCurrent, assertSourceBinding, assertSourceSnapshot, localNoSaveClose } from '../modules/frontend/review-session.js';
import { NativeFileMove, nativeFileMoveCommands } from '../modules/frontend/file-move.js';
import { NativeFileImport } from '../modules/frontend/file-import.js';
import { navigateCompileDiagnostic } from '../modules/frontend/compile-report.js';
import { NativeProjectExport } from '../modules/frontend/project-export.js';
import { EditorSessionBridge } from '../modules/frontend/editor-session-bridge.js';
import { reviewRequest as nativeRequest, editorRequest, controlRequest, chooseProject, chooseImportFiles, importRequest, prepareProjectExport, chooseProjectExportDestination, projectExportRequest, wordCountTypstText, nativeReview, editorOwnerId, historyRequest } from '../modules/frontend/review-api.js';
import { HistoryPanel } from './history-panel.js';
import { WordCountController, captureWordCount, wordCountCurrent } from '../modules/frontend/word-count-controller.js';
import { McpControlBridge } from './mcp-control.js';
import { captureControlState, assertControlState, assertControlPassage, controlPreviewIdentity, assertControlPreview } from '../modules/frontend/manuscript-control-state.js';
import { observeReviewText } from '../modules/frontend/review-text-layout.js';
import { setupWindowChrome } from '../modules/frontend/window-chrome.js';
import { setupMenuNavigation } from '../modules/frontend/menu-navigation.js';
import { setupConnectionManager } from './connection-manager.js';
import { LatestCompileScheduler } from '../modules/frontend/latest-compile-scheduler.js';
import { manuscriptTree, clampPaneWidth, capturePublicationInputs, publicationPreviewCurrent, editorLineHeights, normalizeWorkspacePreferences, readWorkspacePreferences, writeWorkspacePreferences } from '../modules/frontend/manuscript-workspace.js';
import { ManuscriptPdfViewer } from '../modules/frontend/manuscript-pdf-viewer.js';
import { positionReviewCards, acceptedTextChange } from '../modules/frontend/review-position.js';
import { sourceFormat } from '../modules/frontend/source-format.js';
import { typstInsertion } from '../modules/frontend/typst-insertion.js';
import { typstLanguage } from '../modules/frontend/typst-language.js';
import { undo, redo, selectAll, isolateHistory } from '@codemirror/commands';
import { openSearchPanel } from '@codemirror/search';
import * as pdfjs from 'pdfjs-dist';
import pdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
pdfjs.GlobalWorkerOptions.workerSrc = pdfWorker;

const $ = id => document.getElementById(id);
const sessions = new Map();
let localRequests = 0, localRequestsVersion = 0;
const readOnlyRequests = new Set(['projects', 'files', 'project_tree', 'review', 'pdf', 'git_status', 'connection', 'capabilities']);
async function request(operation) {
  // Open may recover a local journal; Review and inventory reads never do.
  const pending = !readOnlyRequests.has(operation.action);
  const session = operation.project && operation.path ? sessions.get(keyFor(operation.project, operation.path)) : null;
  const binding = session && (!Object.hasOwn(operation, 'sourceEpoch') || sourceEpoch(operation) === session.sourceEpoch) && (!Object.hasOwn(operation, 'expectedRoot') || sourceRootsEqual(operation, session)) ? captureSourceBinding(session) : null;
  if (pending) { localRequests += 1; localRequestsVersion += 1; }
  try { return await nativeRequest(operation); }
  catch (error) {
    if (session && sessions.get(keyFor(operation.project, operation.path)) === session && binding && sourceBindingCurrent(session, binding) && (session.recordReviewProblem(error) || session.recordIdentityProblem(error, binding))) {
      clearTimeout(saveTimers.get(session)); saveTimers.delete(session); compileScheduler.cancel();
      if (active === session) { renderReview(); if (publicationPath(session)) pdfStatus('Review data needs resolution · last good PDF retained'); }
      void connections.refresh().catch(() => {});
    }
    throw error;
  }
  finally { if (pending) localRequests -= 1; }
}
async function fileActivity(callback) {
  localRequests += 1; localRequestsVersion += 1;
  try { return await callback(); }
  finally { localRequests -= 1; }
}
const insertionCommands = new Set(['inline-math', 'display-math', 'citation', 'reference', 'link', 'figure', 'table']);
const projectEditVersions = new Map();
let workspacePreferences = readWorkspacePreferences();
let projects = [];
let active = null;
let view = null;
const saveTimers = new Map();
let previewTimer = null;
let selection = null;
let refreshing = false;
let sharingSession = null;
let palette = [];
let paletteSession = null;
let paletteBinding = null;
let githubProject = null;
const syncTimers = new Map();
const pausedSync = new Set();
let compiling = false;
let currentCompileReport = null, currentCompileContext = null;
const explicitCompiles = [];
let pdfLoadingTask = null;
let pdfBytes = null;
let pdfPath = '';
let pdfSourceEpoch = null;
let pdfRoot = {};
let pdfProject = '';
let pdfGeneration = 0;
let navigationIntent = 0;
let fileInventoryGeneration = 0;
const fileInventoryRoots = new WeakMap();
let newFileContext = null;
let newFolderContext = null;
let windowClosing = false;
let windowChrome = null;
let sharedManuscripts = [];
let pendingRemoteClose = null;
let appControls = null;
let fileMove = null;
const editorBridge = new EditorSessionBridge({
  request: editorRequest,
  state: session => ({ current: sessions.get(keyFor(session.project, session.path)) === session, composing: active === session && !!view?.compositionStarted, closing: windowClosing }),
  onSaved: session => {
    if (active === session) { renderReview(); renderTabs(); $('save-label').textContent = saveLabel(session); }
    queueSync(session.project);
  },
  onError: (error, session) => {
    if (session.reviewProblem || session.identityProblem) { clearTimeout(saveTimers.get(session)); saveTimers.delete(session); compileScheduler.cancel(); void connections.refresh().catch(() => {}); }
    if (active === session) { renderReview(); status(error.message || 'The requested editor save could not be confirmed. Inspect its native receipt.', true); }
  },
});
function trackSession(snapshot, project, replace = false) {
  const key = keyFor(project, snapshot.path), previous = sessions.get(key);
  if (previous && !replace) throw { message: 'This path already has an editor buffer. Resolve or close it before deliberately opening a new source identity.' };
  if (previous) void editorBridge.unwatch(previous);
  const session = new ReviewSession(snapshot, project, request);
  sessions.set(key, session); editorBridge.watch(session);
  return session;
}
let windowFocus = null;
let reviewCursor = -1;
let selectedReviewId = null;
let reanchorSelection = null;
let reviewLayoutFrame = 0;
let alignReviewSource = false;
let revealReviewId = null;
let restoreReviewScroll = null;
let renderedReviewSession = null;
const reviewActivity = new WeakMap();
const reviewCardsObserved = new Set();
const reviewGeometry = new ResizeObserver(() => scheduleReviewPositions());
reviewGeometry.observe($('review-list'));
let showingLogs = false;
const expandedFolders = new Set();
try {
  const folders = JSON.parse(localStorage.getItem('undertree.expanded-folders') || '[]');
  if (Array.isArray(folders)) for (const folder of folders.slice(-500)) if (typeof folder === 'string') expandedFolders.add(folder);
} catch { /* Storage availability does not affect editing. */ }
const workspace = document.querySelector('.review-workspace');
const workspaceMenus = [...document.querySelectorAll('#workspace-menu,.editor-menu')];
const pdfViewer = new ManuscriptPdfViewer({
  scroller: $('typst-preview'), pages: $('typst-pages'), onError: error => status(error.message, true),
  onChange: ({ page, total, scale, fit }) => {
    if (document.activeElement !== $('pdf-page-number')) $('pdf-page-number').value = String(page);
    $('pdf-page-number').max = String(total);
    $('pdf-page-count').textContent = `of ${total}`; $('pdf-zoom-label').textContent = `${Math.round(scale * 100)}%`;
    $('pdf-fit-width').setAttribute('aria-pressed', String(fit));
    $('pdf-previous').disabled = page <= 1; $('pdf-next').disabled = page >= total;
  },
});
let historyPresentation = null;
let mobileViewIntent = 0;
const historyPanel = new HistoryPanel({
  root: $('history-panel'), request: historyRequest, owner: editorOwnerId,
  context: () => ({
    session: active && active.project === $('project-select').value && !active.identityProblem && !windowClosing && sessions.get(keyFor(active.project, active.path)) === active ? active : null,
    viewToken: view, projectId: active?.project, path: active?.path, sourceEpoch: active?.sourceEpoch, root: active && sourceRoot(active), editor: view,
  }),
  intent: () => { localRequestsVersion += 1; },
  visibility: visible => {
    document.querySelector('.manuscript-preview').classList.toggle('history-visible', visible);
    if (visible && !historyPresentation) {
      historyPresentation = { mobile: workspace.dataset.mobileView || 'editor', collapsed: workspace.dataset.previewCollapsed };
      workspace.dataset.previewCollapsed = 'false'; mobileView('preview'); historyPresentation.intent = mobileViewIntent;
    } else if (!visible && historyPresentation) {
      if (mobileViewIntent === historyPresentation.intent) { workspace.dataset.previewCollapsed = historyPresentation.collapsed; mobileView(historyPresentation.mobile); }
      historyPresentation = null;
    }
  },
  back: editor => { if (editor?.contentDOM?.isConnected) editor.contentDOM.focus({ preventScroll: true }); else $('menu-file-toggle').focus({ preventScroll: true }); },
});
const windowEditing = new Compartment();
const editorWrapping = new Compartment();
const compileScheduler = new LatestCompileScheduler({delayMs:700,isBusy:()=>compiling,run:async key=>{
  const session = sessions.get(key);
  if (session && session.project === active?.project) { try { await compileSession(active); } catch (error) { status(error.message,true); } }
}});
const reviewEffect = StateEffect.define();
const reviewField = StateField.define({
  create: () => Decoration.none,
  update(value, transaction) {
    value = value.map(transaction.changes);
    for (const effect of transaction.effects) if (effect.is(reviewEffect)) value = effect.value;
    return value;
  },
  provide: field => EditorView.decorations.from(field),
});

function element(tag, text, className = '') {
  const node = document.createElement(tag); node.textContent = text; node.className = className; return node;
}
function status(message, error = false) { $('review-status').textContent = message; $('review-status').classList.toggle('error', error); }
function saveLabel(session) {
  const saved = session.identityProblem ? 'Source identity needs resolution' : session.reviewProblem ? session.dirty ? 'Unsaved changes · review blocked' : 'Review data needs resolution' : session.dirty ? 'Unsaved changes' : 'Saved locally';
  return saved + (session.snapshot.historyMaintenancePending === true ? ' · saved History needs attention' : '');
}
function pdfStatus(message, state = 'stale') {
  const node = $('typst-preview-status'); node.textContent = message; node.dataset.state = state;
  node.classList.toggle('sr-only', state === 'current');
}
function windowEditorAccess() { return [EditorState.readOnly.of(windowClosing), EditorView.editable.of(!windowClosing)]; }
function setWindowClosing(busy) {
  if (busy && view?.compositionStarted) throw new Error('Finish the current text composition before closing the window.');
  if (busy) compileScheduler.cancel();
  if (busy) windowFocus = document.activeElement;
  windowClosing = busy;
  historyPanel.changed();
  wordCount.changed();
  for (const session of sessions.values()) editorBridge.changed(session);
  for (const region of document.querySelectorAll('.review-topbar,.review-workspace,.mobile-views,dialog')) region.inert = busy;
  if (view) view.dispatch({ effects: windowEditing.reconfigure(windowEditorAccess()) });
  if (!busy) { if (windowFocus?.isConnected) windowFocus.focus(); windowFocus = null; }
}
function task(callback) { return async event => { const session = active; try { await callback(event); } catch (error) { if (session && active !== session && ['policy_missing','recovery_conflict','stale_document','stale_root'].includes(error.code)) return; status(error.message || String(error), true); } }; }
function closeDialogs() { for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close(); }
function closeWorkspaceMenus(restoreFocus = false) {
  menuNavigation.close(restoreFocus);
}
function formatSource(command) {
  if (!view || !active) return;
  if (view.compositionStarted) throw { message: 'Finish the current text composition before formatting the source.' };
  if (view.state.selection.ranges.length !== 1) throw { message: 'Use a single selection for this source formatting command.' };
  const extension = active.path.split('.').pop().toLowerCase();
  const selection = view.state.selection.main;
  const format = insertionCommands.has(command) ? typstInsertion : sourceFormat;
  const spec = format(view.state.doc.toString(), { from: selection.from, to: selection.to }, command, extension);
  showPane('editor'); view.dispatch({ ...spec, annotations: spec.annotations ?? isolateHistory.of('full'), userEvent: 'input.format' }); view.focus();
}
function mobileView(name) {
  mobileViewIntent += 1;
  document.querySelector('.review-workspace').dataset.mobileView = name;
  for (const button of document.querySelectorAll('[data-view]')) button.setAttribute('aria-pressed', String(button.dataset.view === name));
}
function rememberWorkspace() {
  for (const key of ['filesCollapsed', 'editorCollapsed', 'previewCollapsed', 'reviewOpen']) workspacePreferences[key] = workspace.dataset[key] === 'true';
  workspacePreferences.outlineCollapsed = $('outline-panel').dataset.collapsed === 'true';
  const stored = writeWorkspacePreferences(workspacePreferences);
  if (workspacePreferences.filesWidth !== null) resizeFiles(workspacePreferences.filesWidth, false);
  return stored;
}
function applyEditorPreferences() {
  $('review-app').style.setProperty('--source-font-size', `${workspacePreferences.editorFontSize / 14}rem`);
  $('review-app').style.setProperty('--source-line-height', String(editorLineHeights[workspacePreferences.editorLineHeight]));
  if (view) {
    if (view.lineWrapping !== workspacePreferences.wordWrap) view.dispatch({ effects: editorWrapping.reconfigure(workspacePreferences.wordWrap ? EditorView.lineWrapping : []) });
    const editor = view;
    editor.requestMeasure({ read: () => null, write: () => { if (view === editor) scheduleReviewPositions(); } });
  }
  for (const button of document.querySelectorAll('[data-command="word-wrap"]')) button.setAttribute('aria-pressed', String(workspacePreferences.wordWrap));
}
let settingsReturnFocus = null;
function fillEditorSettings(preferences) {
  $('settings-font-size').value = String(preferences.editorFontSize);
  $('settings-line-height').value = preferences.editorLineHeight;
  $('settings-word-wrap').checked = preferences.wordWrap;
  $('settings-error').hidden = true;
}
function openEditorSettings(trigger) {
  if (windowClosing || view?.compositionStarted) throw { message: 'Finish composing text before opening editor settings. Your buffer is kept.' };
  settingsReturnFocus = trigger?.closest('details')?.querySelector('summary') || document.activeElement;
  fillEditorSettings(workspacePreferences); localRequestsVersion += 1;
  $('editor-settings-dialog').showModal();
}
function applyEditorSettings(event) {
  event.preventDefault();
  if (!$('editor-settings-form').reportValidity()) return;
  if (windowClosing || view?.compositionStarted) {
    $('settings-error').textContent = 'Finish composing text before applying settings. Your buffer is kept.'; $('settings-error').hidden = false; return;
  }
  workspacePreferences = normalizeWorkspacePreferences({ ...workspacePreferences, editorFontSize: Number($('settings-font-size').value), editorLineHeight: $('settings-line-height').value, wordWrap: $('settings-word-wrap').checked });
  localRequestsVersion += 1; applyEditorPreferences(); const stored = rememberWorkspace();
  $('editor-settings-dialog').close();
  status(stored ? 'Editor settings saved.' : 'Editor settings applied for this session. Storage is unavailable; these settings will not be restored after reopening.', !stored);
}
let wordCountReturnFocus = null;
const wordCount = new WordCountController({
  native: nativeReview, analyzeTypst: wordCountTypstText,
  isCurrent: captured => $('word-count-dialog').open && sessions.get(keyFor(captured.project,captured.path)) === captured.session && wordCountCurrent(captured, active, view?.state, wordCount.current?.capture.requestId, { composing: !!view?.compositionStarted, closing: windowClosing }),
  onChange: renderWordCount,
});
function renderWordCount(context) {
  $('word-count-path').textContent = context.capture.path;
  $('word-count-state').textContent = [context.capture.dirty ? 'Unsaved at capture.' : 'Saved at capture.', context.capture.conflict || context.capture.reviewProblem ? 'Local draft; source or review data needs resolution.' : ''].filter(Boolean).join(' ');
  $('word-count-status').textContent = context.message; $('word-count-status').hidden = !context.message;
  $('word-count-results').hidden = context.phase !== 'ready';
  const result = context.result;
  if (!result) return;
  const words = count => `${count.toLocaleString(result.locale)} ${count === 1 ? 'word' : 'words'}`;
  $('word-count-prose').textContent = result.proseWords == null ? 'Unavailable' : words(result.proseWords);
  $('word-count-source').textContent = words(result.sourceWords);
  $('word-count-selection').textContent = result.selectionReason ? 'Unavailable' : result.selectionWords == null ? 'No selected text' : `${words(result.selectionWords)}${result.selectionRanges > 1 ? ` · ${result.selectionRanges} ranges` : ''}`;
  $('word-count-prose-reason').textContent = result.proseReason || ''; $('word-count-prose-reason').hidden = !result.proseReason;
  $('word-count-selection-reason').textContent = result.selectionReason || ''; $('word-count-selection-reason').hidden = !result.selectionReason;
  $('word-count-locale').textContent = `Word segmentation locale: ${result.locale}`;
}
function openWordCount(trigger) {
  if (windowClosing || view?.compositionStarted) throw { message: 'Finish composing text before opening Word count. Your buffer is kept.' };
  if (!active || !view || !/\.(typ|html?)$/i.test(active.path)) throw { message: 'Open a Typst or HTML file to count its current editor text.' };
  const captured = captureWordCount(active, view.state, crypto.randomUUID());
  const source = view.state.doc.toString();
  wordCountReturnFocus = trigger?.closest('details')?.querySelector('summary') || document.activeElement;
  localRequestsVersion += 1; $('word-count-dialog').showModal();
  void wordCount.open(captured, { source, format: /\.typ$/i.test(captured.path) ? 'typ' : 'html', locale: document.documentElement.lang || 'en' });
}
function restoreWorkspacePreferences() {
  for (const key of ['filesCollapsed', 'editorCollapsed', 'previewCollapsed', 'reviewOpen']) workspace.dataset[key] = String(workspacePreferences[key]);
  $('review-toggle').setAttribute('aria-pressed', String(workspacePreferences.reviewOpen));
  $('outline-panel').dataset.collapsed = String(workspacePreferences.outlineCollapsed);
  $('outline-toggle').setAttribute('aria-expanded', String(!workspacePreferences.outlineCollapsed)); $('manuscript-outline').hidden = workspacePreferences.outlineCollapsed;
  if (workspacePreferences.filesWidth === null) resetFilesWidth(false); else resizeFiles(workspacePreferences.filesWidth, false);
  resizePreview(workspacePreferences.editorFraction, false); applyEditorPreferences();
}
function reviewPanel(open) {
  workspace.dataset.reviewOpen = String(open);
  $('review-toggle').setAttribute('aria-pressed', String(open));
  if (open && innerWidth <= 900) mobileView('review');
  else if (!open && workspace.dataset.mobileView === 'review') mobileView('editor');
  rememberWorkspace();
  scheduleReviewPositions();
}
function reviewCue() {
  const pending = active?.snapshot.review.suggestions.filter(item => item.status === 'pending') || [];
  let activity = active && reviewActivity.get(active);
  if (active && !activity) { activity = { known: new Set(pending.map(item => item.id)), unseen: new Set() }; reviewActivity.set(active, activity); }
  if (activity) {
    for (const item of pending) if (!activity.known.has(item.id)) activity.unseen.add(item.id);
    const ids = new Set(pending.map(item => item.id));
    for (const id of activity.unseen) if (!ids.has(id)) activity.unseen.delete(id);
    activity.known = ids;
  }
  const unseen = activity?.unseen.size || 0;
  $('review-pending-count').textContent = String(pending.length);
  for (const id of ['review-toggle-count', 'review-mobile-count']) {
    $(id).hidden = !pending.length; $(id).textContent = String(pending.length); $(id).classList.toggle('has-new', unseen > 0);
  }
  $('review-new-cue').hidden = !unseen;
  $('review-new-cue').textContent = `${unseen} new suggestion${unseen === 1 ? '' : 's'} · show`;
  const announcement = pending.length ? `${pending.length} pending suggestion${pending.length === 1 ? '' : 's'}${unseen ? `; ${unseen} new` : ''}. Open Review to inspect them.` : '';
  if ($('review-announcement').textContent !== announcement) $('review-announcement').textContent = announcement;
}
function acknowledgeReview(id) { reviewActivity.get(active)?.unseen.delete(id); reviewCue(); }
function markSelectedReview(id) {
  selectedReviewId = id;
  if (active) active.reviewSelectedId = id;
  for (const card of $('review-list').querySelectorAll('[data-review-id]')) card.dataset.selected = String(card.dataset.reviewId === id);
}
function scheduleReviewPositions(alignSource = false) {
  alignReviewSource ||= alignSource;
  if (reviewLayoutFrame) return;
  reviewLayoutFrame = requestAnimationFrame(() => {
    reviewLayoutFrame = 0;
    const passages = $('review-passages'); const list = $('review-list');
    if (!passages || !list.clientWidth || !list.clientHeight) return;
    const sourceVisible = view && innerWidth > 900 && view.scrollDOM.getClientRects().length;
    const origin = sourceVisible ? view.documentTop + view.scrollDOM.scrollTop - list.getBoundingClientRect().top - passages.offsetTop : 0;
    const cards = [...passages.children];
    const scrollSpace = $('review-scroll-space');
    const listStyle = getComputedStyle(list);
    const trailingHeight = [...list.children].filter(node => node !== passages && node !== scrollSpace).reduce((height, node) => {
      const style = getComputedStyle(node);
      return height + node.offsetHeight + (parseFloat(style.marginTop) || 0) + (parseFloat(style.marginBottom) || 0);
    }, parseFloat(listStyle.paddingBottom) || 0);
    const positions = positionReviewCards(cards.map(card => {
      const from = Number(card.dataset.sourcePosition);
      const desiredTop = sourceVisible && card.dataset.stale !== 'true' && from <= view.state.doc.length ? view.lineBlockAt(from).top + origin : 0;
      return { id: card.dataset.reviewId, from, desiredTop, height: card.offsetHeight, card };
    }), selectedReviewId);
    const selected = positions.find(item => item.id === selectedReviewId);
    let targetScroll = restoreReviewScroll ?? list.scrollTop;
    if (alignReviewSource && sourceVisible && selected && selected.card.dataset.stale !== 'true') {
      const source = view.coordsAtPos(selected.from);
      if (source) {
        const target = Math.max(0, Math.min(list.clientHeight - Math.min(list.clientHeight, selected.height), source.top - list.getBoundingClientRect().top));
        targetScroll = passages.offsetTop + selected.top - target;
      }
    } else if (revealReviewId) {
      const revealed = positions.find(item => item.id === revealReviewId);
      if (revealed) targetScroll = passages.offsetTop + revealed.top;
    }
    let bottom = -8;
    for (const item of positions) { item.card.style.marginTop = `${Math.max(0, item.top - bottom - 8)}px`; bottom = item.top + item.height; }
    if (scrollSpace) scrollSpace.style.height = `${Math.max(0, targetScroll + list.clientHeight - passages.offsetTop - Math.max(0, bottom) - trailingHeight)}px`;
    list.scrollTop = Math.max(0, targetScroll);
    restoreReviewScroll = null; revealReviewId = null; alignReviewSource = false;
  });
}
function locateReview(id, anchor) { markSelectedReview(id); acknowledgeReview(id); selectAnchor(anchor); scheduleReviewPositions(true); }
function beginReanchor(marker) {
  if (!active || !view) return;
  if (view.compositionStarted) throw { message: 'Finish the current text composition before reanchoring a highlight.' };
  const range = view.state.selection.main;
  if (range.empty) throw { message: 'Select the current passage in the source editor, then choose Reanchor from selection.' };
  reanchorSelection = { session: active, binding: captureSourceBinding(active), version: active.version, id: marker.id, from: range.from, to: range.to, quote: view.state.sliceDoc(range.from, range.to) };
  $('reanchor-old').textContent = marker.anchor.quote; $('reanchor-new').textContent = reanchorSelection.quote;
  $('reanchor-rule').textContent = `Keep the existing “${active.snapshot.review.rules.find(rule => rule.id === marker.rule)?.label || 'Highlight'}” rule and passage prompt.`;
  $('reanchor-dialog').showModal();
}
function showPane(name) {
  workspace.dataset[`${name === 'files' ? 'files' : name}Collapsed`] = 'false';
  mobileView(name);
  rememberWorkspace();
}
function renderOutline() {
  const outline = $('manuscript-outline'); outline.replaceChildren();
  if (!active) return;
  let entries;
  if (active.path.endsWith('.typ')) entries = [...active.content.matchAll(/^(={1,6})\s+(.+)$/gm)].slice(0, 200).map(match => ({ title: match[2], from: match.index, to: match.index + match[0].length }));
  else if (/\.html?$/.test(active.path)) entries = [...active.content.matchAll(/<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/gi)].slice(0, 200).map(match => ({ title: new DOMParser().parseFromString(match[1], 'text/html').body.textContent, from: match.index, to: match.index + match[0].length }));
  else entries = [];
  for (const entry of entries) outline.append(actionButton(entry.title, () => selectAnchor(entry), 'outline-button'));
  if (!entries.length) outline.append(element('p', 'This source has no headings.', 'file-help'));
}
function treeMode(outline) {
  showPane('files');
  if (outline) { $('outline-panel').dataset.collapsed = 'false'; $('outline-toggle').setAttribute('aria-expanded','true'); $('manuscript-outline').hidden = false; renderOutline(); $('outline-toggle').focus(); }
  $('rail-files').setAttribute('aria-pressed', String(!outline)); $('rail-outline').setAttribute('aria-pressed', String(outline));
  rememberWorkspace();
}
function reviewAnchors() {
  if (!active) return [];
  return [...active.snapshot.review.markers, ...active.snapshot.review.suggestions.filter(s => s.status === 'pending')].filter(item => !item.anchor.stale).sort((a, b) => a.anchor.from - b.anchor.from);
}
function navigateReview(delta) {
  const entries = reviewAnchors(); if (!entries.length) return;
  reviewCursor = reviewCursor < 0 ? (delta < 0 ? entries.length - 1 : 0) : (reviewCursor + delta + entries.length) % entries.length;
  const item = entries[reviewCursor]; reviewPanel(true); selectAnchor(item.anchor);
  markSelectedReview(item.id); acknowledgeReview(item.id); scheduleReviewPositions(true);
  const card = [...$('review-list').querySelectorAll('[data-review-id]')].find(node => node.dataset.reviewId === item.id);
  for (const node of $('review-list').querySelectorAll('[data-review-id]')) node.dataset.selected = String(node === card);
  card?.scrollIntoView({ block: 'nearest' });
}
function keyFor(project, path) { return `${project}:${path}`; }
function navigationCurrent(intent, project) { return intent === navigationIntent && project === $('project-select').value; }
function sessionNavigationCurrent(intent, session, binding) {
  return navigationCurrent(intent, session.project) && sessions.get(keyFor(session.project, session.path)) === session && (!binding || (session.project === binding.project && session.path === binding.path && session.sourceEpoch === binding.sourceEpoch && sourceRootsEqual(session, binding) && sourceRootsEqual(session.snapshot, binding)));
}
function requireNavigationReady() {
  if (!view?.compositionStarted) return;
  if (active) $('project-select').value = active.project;
  throw {message:'Finish the current text composition before switching or closing manuscripts.'};
}
function detachEditor(preserve = true) {
  requireNavigationReady();
  retireCompileNavigation();
  const editor = view; const session = active; const cleanup = pdfLoadingTask;
  view = null; active = null; pdfLoadingTask = null; pdfBytes = null; pdfPath = ''; pdfSourceEpoch = null; pdfRoot = {}; pdfProject = ''; pdfGeneration += 1;
  historyPanel.changed();
  wordCount.changed();
  if (preserve && editor && session) {
    session.editorState = editor.state; session.editorScroll = { top: editor.scrollDOM.scrollTop, left: editor.scrollDOM.scrollLeft }; session.reviewScroll = $('review-list').scrollTop;
  }
  clearTimeout(previewTimer); editor?.destroy(); pdfViewer.clear(); $('manuscript-source').replaceChildren();
  return cleanup;
}
async function selectProject(intent, project) {
  historyPanel.changed();
  const previous = active;
  try { if (previous?.dirty) await saveSession(previous); }
  catch (error) {
    if (active === previous && navigationCurrent(intent, project)) $('project-select').value = previous.project;
    throw error;
  }
  if (!navigationCurrent(intent, project)) return;
  const cleanup = detachEditor(); compileScheduler.cancel(); renderTabs(); renderReview();
  await cleanup?.destroy();
  if (navigationCurrent(intent, project)) await loadFiles(intent);
}
function currentProject() { return projects.find(p => p.id === $('project-select').value); }
function controlContext() {
  return { sessions: sessions.values(), active, navigation: navigationIntent, composing: !!view?.compositionStarted, closing: windowClosing, pending: localRequests + fileImport.pendingCount + projectExport.pendingCount + (fileMove?.pendingCount || 0), requestsVersion: localRequestsVersion };
}
function controlPreparation(guard, clean = false) {
  const captured = captureControlState(controlContext());
  const assert = (allowClosing = false) => { guard.assertCurrent(); assertControlState(captured, controlContext(), { clean, allowClosing }); };
  assert();
  return { assert, check: async () => { await guard.check(); assert(); } };
}
function controlWorkspaceSnapshot() {
  return {
    openDocuments: [...sessions.values()].map(session => ({ documentId: session.snapshot.documentId, revision: session.snapshot.review.revision, dirty: session.dirty, conflict: !!(session.conflict || session.reviewProblem || session.identityProblem), composing: active === session && !!view?.compositionStarted })),
    activeDocumentId: active?.snapshot.documentId || null,
    preview: controlPreview() && pdfViewer.ready ? { page: pdfViewer.page, pages: pdfViewer.pdf.numPages, zoomPercent: Math.max(1, Math.min(999, Math.round((pdfViewer.currentScale || 1) * 100))) } : null,
    view: { filesVisible: workspace.dataset.filesCollapsed !== 'true', editorVisible: workspace.dataset.editorCollapsed !== 'true', previewVisible: workspace.dataset.previewCollapsed !== 'true', reviewVisible: workspace.dataset.reviewOpen === 'true', outlineVisible: $('outline-panel').dataset.collapsed !== 'true', logsVisible: showingLogs && !historyPanel.visible },
    editor: { fontSize: workspacePreferences.editorFontSize, wordWrap: workspacePreferences.wordWrap },
  };
}
function controlPreview() {
  if (historyPanel.visible) return null;
  return controlPreviewIdentity({ active, shared: !!active && sharedManuscripts.some(share => share.documentId === active.snapshot.documentId && share.project === active.project && share.path === active.path && sourceEpoch(share) === active.sourceEpoch && sourceRootsEqual(share, active)), pdf: pdfViewer.pdf, pdfPath, publicationPath: publicationPath(active), generation: pdfGeneration, pdfSourceEpoch: pdfSourceEpoch ?? 0, pdfProject, pdfRoot });
}
function retireCompileNavigation() {
  if (!currentCompileContext) return;
  currentCompileContext = null;
  for (const button of $('compile-diagnostics').querySelectorAll('button')) button.disabled = true;
  $('compile-report-status').textContent += ' Source or editor context changed. Recompile locally before selecting a location.';
}
function diagnosticContext() {
  return {
    compilation: currentCompileReport, current: !!currentCompileContext && currentCompileContext() && !historyPanel.visible,
    session: active, view, registered: !!active && sessions.get(keyFor(active.project, active.path)) === active,
    pending: controlContext().pending + (compiling ? 1 : 0), composing: !!view?.compositionStarted, closing: windowClosing,
    intent: localRequestsVersion, navigation: navigationIntent, logsVisible: showingLogs,
    logScrollTop: $('compile-log').scrollTop, logScrollLeft: $('compile-log').scrollLeft,
  };
}
function setCompileLog(message, compilation = null, current = null) {
  currentCompileReport = compilation; currentCompileContext = compilation ? current : null;
  const raw = `${message}${compilation?.report.text ? `\n\n${compilation.report.text}` : ''}`;
  const encoded = new TextEncoder().encode(raw), limit = 128 * 1024;
  $('compile-raw').textContent = encoded.length > limit ? new TextDecoder().decode(encoded.subarray(0, limit)) + '\n[Output truncated for display.]' : raw;
  $('compile-diagnostics').replaceChildren();
  const note = $('compile-report-status'); note.hidden = !compilation;
  if (!compilation) return;
  const report = compilation.report;
  note.textContent = (compilation.status === 'outcome_unknown' ? 'The build outcome is unknown. The previous preview is kept. ' : compilation.status === 'failed' ? 'Compilation failed. ' : '') + 'Compiler locations are untrusted suggestions. Selection requires the active, saved editor to match the copied source.' + (!report.captureComplete || report.truncated ? ' Capture is incomplete or truncated; locations are unavailable.' : '');
  for (const row of report.rows) {
    const item = element('div', '', 'compile-diagnostic');
    const message = element('p', `${row.severity === 'error' ? 'Error' : 'Warning'}: ${row.message}`);
    message.dataset.measure = ''; message.dataset.textDetails = 'Compiler diagnostic'; item.append(message);
    const point = row.locationCandidate;
    if (point) {
      const location = element('p', `${point.projectPath} · line ${point.line1}, scalar column ${point.columnScalar0}`);
      location.dataset.measure = ''; location.dataset.textDetails = 'Compiler location candidate'; item.append(location);
      if (active?.project === report.provenance.project && active.path === point.projectPath) {
        const button = actionButton(`Inspect line ${point.line1}`, async () => {
          localRequestsVersion += 1;
          const clickedSession = active, clickedView = view, clickedIntent = localRequestsVersion;
          try { await navigateCompileDiagnostic(compilation, row, {
            context: diagnosticContext, read: request,
            digest: async content => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content)))].map(byte => byte.toString(16).padStart(2, '0')).join(''),
            select: (editor, offset) => { showPane('editor'); editor.dispatch({ selection: { anchor: offset }, effects: EditorView.scrollIntoView(offset, { y: 'center' }) }); editor.focus(); },
          }); } catch (error) { if (active === clickedSession && view === clickedView && localRequestsVersion === clickedIntent && showingLogs && currentCompileReport === compilation) status(error.message || 'The compiler location could not be verified.', true); }
        });
        button.disabled = !report.captureComplete || report.truncated || !currentCompileContext || !currentCompileContext(); item.append(button);
      } else {
        const guidance = element('p', 'Open this file locally and recompile to inspect its location.'); guidance.dataset.measure = ''; item.append(guidance);
      }
    }
    $('compile-diagnostics').append(item);
  }
  if (currentCompileContext && !currentCompileContext()) retireCompileNavigation();
}
function setCompileLogs(show) {
  showingLogs = show; $('compile-log').hidden = !show; $('compile-log-toggle').setAttribute('aria-pressed', String(show));
  $('manuscript-preview').hidden = show || Boolean(publicationPath(active));
  $('typst-preview').hidden = show || !publicationPath(active); $('pdf-toolbar').hidden = show || !pdfBytes;
}
const controlEffects = {
  async open_manuscript(command, guard) {
    const prepared = controlPreparation(guard, true);
    let session = [...sessions.values()].find(session => session.snapshot.documentId === command.documentId);
    const share = sharedManuscripts.find(share => share.documentId === command.documentId);
    if (!share) throw { code: 'scope', message: 'This manuscript is not currently shared.' };
    if (!session) requireSessionCapacity(share.project, share.path);
    const [snapshot, files] = await Promise.all([
      guard.openSaved(() => prepared.assert()),
      nativeRequest({ action: 'project_tree', project: share.project }),
    ]);
    await prepared.check();
    assertSourceSnapshot(snapshot, captureSourceBinding(share));
    if (!sourceRootsEqual(files, snapshot) || snapshot.documentId !== command.documentId || (session && (!sourceBindingCurrent(session, captureSourceBinding(session)) || !sourceRootsEqual(session, snapshot) || session.sourceEpoch !== sourceEpoch(snapshot) || session.snapshot.review.revision !== snapshot.review.revision || session.content !== snapshot.content))) throw { code: 'stale', message: 'The saved source changed outside its editor. Refresh locally before opening it remotely.' };
    if (!session) session = trackSession(snapshot, share.project);
    if (active === session && view) return { documentId: command.documentId, active: true };
    const generation = session.generation, intent = ++navigationIntent;
    $('project-select').value = session.project;
    fileInventoryGeneration += 1; renderFiles(files, session.project);
    const mounting = captureControlState(controlContext());
    await mountSession(session, intent, nativeRequest);
    await guard.check();
    assertControlState(mounting, { ...controlContext(), active: mounting.active }, { clean: true });
    if (!sessionNavigationCurrent(intent, session) || active !== session || session.generation !== generation || session.dirty || session.conflict || view?.compositionStarted) throw { code: 'stale', message: 'The workspace changed while rendering the requested manuscript.' };
    return { documentId: command.documentId, active: true };
  },
  async select_passage(command, guard) {
    const prepared = controlPreparation(guard); await prepared.check();
    if (!active || !view) throw { code: 'unavailable', message: 'Open the manuscript before selecting its passage.' };
    assertControlPassage(active, command);
    showPane('editor'); view.dispatch({ selection: { anchor: command.from, head: command.to }, scrollIntoView: true });
    prepared.assert();
    if (view.state.selection.main.from !== command.from || view.state.selection.main.to !== command.to) throw { code: 'unavailable', message: 'The requested passage was not selected.' };
    return { documentId: command.documentId, revision: command.revision, from: command.from, to: command.to };
  },
  async set_workspace_view(command, guard) {
    const prepared = controlPreparation(guard); await prepared.check();
    if (historyPanel.visible && command.logsVisible != null) throw { code: 'unavailable', message: 'Return from Saved History before changing the compilation log view.' };
    for (const [field, key] of [['filesVisible', 'filesCollapsed'], ['editorVisible', 'editorCollapsed'], ['previewVisible', 'previewCollapsed']]) if (command[field] != null) workspace.dataset[key] = String(!command[field]);
    if (command.reviewVisible != null) reviewPanel(command.reviewVisible);
    if (command.outlineVisible != null) { $('outline-panel').dataset.collapsed = String(!command.outlineVisible); $('outline-toggle').setAttribute('aria-expanded', String(command.outlineVisible)); $('manuscript-outline').hidden = !command.outlineVisible; }
    if (command.logsVisible != null) setCompileLogs(command.logsVisible);
    if (innerWidth <= 900) {
      const selected = [['reviewVisible', 'review'], ['editorVisible', 'editor'], ['previewVisible', 'preview'], ['filesVisible', 'files']].find(([field]) => command[field] === true);
      if (selected) mobileView(selected[1]);
      else if (workspace.dataset[`${workspace.dataset.mobileView}Collapsed`] === 'true') mobileView(workspace.dataset.editorCollapsed !== 'true' ? 'editor' : 'preview');
    }
    rememberWorkspace(); scheduleReviewPositions(); prepared.assert();
    return { view: controlWorkspaceSnapshot().view, mobileView: workspace.dataset.mobileView || 'editor' };
  },
  async set_editor_preferences(command, guard) {
    const prepared = controlPreparation(guard); await prepared.check();
    if (command.fontSize != null) workspacePreferences.editorFontSize = command.fontSize;
    if (command.wordWrap != null) workspacePreferences.wordWrap = command.wordWrap;
    applyEditorPreferences(); rememberWorkspace(); prepared.assert();
    return { editor: controlWorkspaceSnapshot().editor };
  },
  async set_preview_view(command, guard) {
    const prepared = controlPreparation(guard), identity = controlPreview(), pdf = pdfViewer.pdf;
    await prepared.check();
    assertControlPreview(identity, controlPreview());
    if (!pdf || !pdfViewer.ready || showingLogs || $('typst-preview').hidden) throw { code: 'unavailable', message: 'Show the rendered PDF before changing its view.' };
    if (command.fitWidth === true) pdfViewer.fit();
    else if (command.zoomPercent != null) pdfViewer.zoom(command.zoomPercent / 100 / (pdfViewer.scale || pdfViewer.currentScale));
    else if (command.fitWidth === false && pdfViewer.scale === null) pdfViewer.zoom(1);
    if (command.page != null) pdfViewer.go(command.page);
    const deadline = performance.now() + 5000;
    while (pdfViewer.pending || pdfViewer.rendering) {
      if (performance.now() > deadline) throw { code: 'unavailable', message: 'The requested PDF view did not finish rendering.' };
      await new Promise(resolve => requestAnimationFrame(resolve)); prepared.assert();
      assertControlPreview(identity, controlPreview());
    }
    await prepared.check();
    assertControlPreview(identity, controlPreview());
    const rendered = controlWorkspaceSnapshot().preview;
    if (!rendered || pdfViewer.pdf !== pdf || (command.page != null && rendered.page !== command.page) || (command.zoomPercent != null && Math.abs(rendered.zoomPercent - command.zoomPercent) > 1) || (command.fitWidth != null && (pdfViewer.scale === null) !== command.fitWidth)) throw { code: 'unavailable', message: 'The rendered PDF does not match the requested view.' };
    return { preview: rendered, fitWidth: pdfViewer.scale === null };
  },
  async set_window_state(command, guard) {
    const prepared = controlPreparation(guard, command.state === 'close');
    if (!nativeReview || !windowChrome) throw { code: 'unavailable', message: 'Native window controls are unavailable in this browser.' };
    await prepared.check();
    const appWindow = windowChrome.window;
    if (command.state === 'close') {
      if (pendingRemoteClose) throw { code: 'busy', message: 'A window close is awaiting native acknowledgement.' };
      pendingRemoteClose = prepared;
      return { state: 'close_requested' };
    }
    if (command.state === 'minimize') await appWindow.minimize();
    else if (command.state === 'maximize') await appWindow.maximize();
    else if (command.state === 'focus') await appWindow.setFocus();
    else if (command.state === 'restore') { await appWindow.unminimize(); await prepared.check(); await appWindow.unmaximize(); }
    let actual; const deadline = performance.now() + 2000;
    while (true) {
      const [minimized, maximized, focused] = await Promise.all([appWindow.isMinimized(), appWindow.isMaximized(), appWindow.isFocused()]);
      actual = { minimized, maximized, focused }; prepared.assert();
      if ((command.state === 'minimize' && minimized) || (command.state === 'maximize' && maximized) || (command.state === 'restore' && !minimized && !maximized) || (command.state === 'focus' && focused)) break;
      if (performance.now() > deadline) throw { code: 'unavailable', message: 'The native window did not reach the requested state.' };
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    await prepared.check();
    return { state: command.state, ...actual };
  },
  async compile_manuscript(command, guard) {
    const prepared = controlPreparation(guard, true);
    const session = [...sessions.values()].find(session => session.snapshot.documentId === command.documentId);
    if (!session || !session.path.endsWith('.typ') || compiling) throw { code: 'unavailable', message: 'Open a saved Typst manuscript and wait for the active build before compiling.' };
    const inputs = projectInputVersions(session.project);
    await prepared.check();
    // Rust derives the shared target and saved revision from the acknowledged job.
    const result = await guard.compileSaved(() => prepared.assert());
    await prepared.check();
    if (!result.available || result.revision !== command.revision || sourceEpoch(result) !== session.sourceEpoch || !sourceRootsEqual(result, session)) throw { code: 'stale', message: 'The compiler result does not match the requested saved source and project folder identity.' };
    const render = active?.project === session.project && publicationPath(active) === session.path;
    if (render) await showPdf(result, active, session.path, inputs);
    prepared.assert();
    return { documentId: command.documentId, revision: result.revision, compiled: true, previewRendered: !!render && pdfPath === session.path && !!pdfViewer.pdf, current: publicationCurrent(result, session, session.path, inputs) };
  },
};
function publicationPath(session) {
  if (!session) return '';
  return projects.find(project => project.id === session.project)?.mainDocument || (session.path.endsWith('.typ') ? session.path : '');
}
function publicationCurrent(result, session, path, inputs) {
  return publicationPreviewCurrent(result, {
    main: sessions.get(keyFor(session.project, path)), inputSessions: [...sessions.values()].filter(input => input.project === session.project),
    captured: inputs, projectVersion: projectEditVersions.get(session.project) || 0, composing: active?.project === session.project && view?.compositionStarted,
  });
}
function projectInputVersions(project) { return capturePublicationInputs([...sessions.values()].filter(session => session.project === project), projectEditVersions.get(project) || 0); }
function noteProjectEdit(project) { projectEditVersions.set(project, (projectEditVersions.get(project) || 0) + 1); if (currentCompileReport?.report.provenance.project === project) retireCompileNavigation(); }
function inventoryRoot(project) {
  const files = $('manuscript-files');
  if (files.dataset.project !== project || !fileInventoryRoots.has(files)) throw { code: 'stale_root', message: 'Refresh the intended project file tree before creating or opening a file.' };
  return fileInventoryRoots.get(files);
}
function observedSourceTarget(project, path) {
  const session = sessions.get(keyFor(project, path));
  if (session) { assertSourceBinding(session); return { ...captureSourceBinding(session), session }; }
  if ($('manuscript-files').dataset.project === project) {
    const row = [...$('manuscript-files').querySelectorAll('.file-button')].find(node => node.dataset.path === path);
    if (row) return { project, path, sourceEpoch: sourceEpoch({ sourceEpoch: Number(row.dataset.sourceEpoch) }), ...inventoryRoot(project) };
  }
  return null;
}
function assertPublicationTarget(target, origin, binding, mainChoice) {
  assertSourceBinding(origin, binding);
  if (!sourceRootsEqual(target, binding)) throw { code: 'stale_root', message: 'The main document belongs to another project folder identity. Your buffers are kept.' };
  if (publicationPath(origin) !== mainChoice) throw { code: 'stale_document', message: 'The chosen main document changed while this build was queued. Recompile the intended source explicitly.' };
  const main = sessions.get(keyFor(target.project, target.path));
  if (target.session && main !== target.session) throw { code: 'stale_document', message: 'The captured main editor was closed or replaced. Recompile explicitly.' };
  if (main) { assertSourceBinding(main, target); }
}
async function setMainDocument(path) {
  const project = currentProject();
  if (!project) return;
  const target = path ? observedSourceTarget(project.id, path) : null;
  if (path && !target) throw { message: 'Refresh the file tree before choosing this main document.' };
  const updated = await request({action:'set_main_document',project:project.id,path,...(target ? captureSourceBinding(target) : {})});
  if (target?.session) {
    if (sessions.get(keyFor(target.project, target.path)) !== target.session) throw { code: 'stale_document', message: 'The chosen main editor was closed or replaced while setting the main document.' };
    assertSourceBinding(target.session, target);
  } else if (target && !sourceRootsEqual(target, inventoryRoot(project.id))) throw { code: 'stale_root', message: 'The project file tree changed while setting the main document.' };
  projects = projects.map(existing => existing.id === updated.id ? updated : existing);
  renderReview();
  if (active?.project === updated.id && !active.identityProblem) await loadPublicationPreview(active);
  status(updated.mainDocument ? `Main document: ${updated.mainDocument}` : 'Recompile now uses the selected Typst source.');
}
function queueSync(project, expectedRoot) {
  const root = expectedRoot === undefined ? null : { expectedRoot: sourceRoot({ expectedRoot }) };
  if (root && !sourceRootsEqual(root, inventoryRoot(project))) throw { code: 'stale_root', message: 'The project folder changed. Refresh its file tree before syncing.' };
  if ([...sessions.values()].some(session => session.project === project && session.identityProblem)) return;
  if (!projects.find(p => p.id === project)?.autoSync || pausedSync.has(project)) return;
  clearTimeout(syncTimers.get(project));
  syncTimers.set(project, setTimeout(async () => {
    try {
      if (root && !sourceRootsEqual(root, inventoryRoot(project))) throw { code: 'stale_root', message: 'The project folder changed. Refresh its file tree before syncing.' };
      if ([...sessions.values()].some(session => session.project === project && session.identityProblem)) throw { message: 'Resolve the source identity before syncing this project.' };
      const result = await request({ action: 'sync', project }); status(result.message);
    }
    catch (error) { pausedSync.add(project); status(`Automatic GitHub sync paused: ${error.message}`, true); }
  }, 4000));
}
async function saveSession(session) {
  clearTimeout(saveTimers.get(session)); saveTimers.delete(session);
  let snapshot;
  try { snapshot = await session.flush(); }
  catch (error) { if (session.identityProblem) { clearTimeout(saveTimers.get(session)); saveTimers.delete(session); compileScheduler.cancel(); } if(active === session) renderReview(); throw error; }
  if (active === session) { renderReview(); renderTabs(); $('save-label').textContent = saveLabel(session); }
  queueSync(session.project);
  return snapshot;
}
function decorations() {
  if (!active || !view) return;
  const review = active.snapshot.review;
  const ranges = [];
  for (const marker of review.markers) {
    const rule = review.rules.find(r => r.id === marker.rule);
    if (marker.anchor.stale || !rule || marker.anchor.to > view.state.doc.length) continue;
    ranges.push(Decoration.mark({ attributes: { style: `background-color:${rule.color}55;border-bottom:2px solid ${rule.color}`, title: `${rule.label}${marker.prompt ? ': ' + marker.prompt : ''}` } }).range(marker.anchor.from, marker.anchor.to));
  }
  for (const suggestion of review.suggestions) if (suggestion.status === 'pending' && !suggestion.anchor.stale && suggestion.anchor.to <= view.state.doc.length) {
    ranges.push(Decoration.mark({ attributes: { style: `border-bottom:2px dotted ${suggestion.color}` } }).range(suggestion.anchor.from, suggestion.anchor.to));
  }
  ranges.sort((a, b) => a.from - b.from || a.to - b.to);
  view.dispatch({ effects: reviewEffect.of(Decoration.set(ranges, true)) });
}
function preview() {
  if (publicationPath(active)) return;
  if (!active || !/\.html?$/i.test(active.path)) { $('manuscript-preview').srcdoc = '<p>Open an HTML manuscript to preview it.</p>'; return; }
  // Imported manuscripts are data. The preview never executes scripts or fetches remote resources.
  const parsed = new DOMParser().parseFromString(active.content, 'text/html');
  parsed.querySelectorAll('script,base,meta[http-equiv],link,iframe,object,embed').forEach(n => n.remove());
  for (const node of parsed.querySelectorAll('*')) for (const attribute of [...node.attributes]) if (/^on/i.test(attribute.name)) node.removeAttribute(attribute.name);
  const policy = parsed.createElement('meta'); policy.httpEquiv = 'Content-Security-Policy';
  policy.content = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src 'none'; form-action 'none'; base-uri 'none'; script-src 'none'";
  parsed.head.prepend(policy);
  const style = parsed.createElement('style'); style.textContent = 'body{max-width:52rem;margin:2rem auto;padding:0 1.5rem;color:#222;line-height:1.6;font-family:Georgia,serif;overflow-wrap:anywhere}';
  parsed.head.append(style);
  $('manuscript-preview').srcdoc = '<!doctype html>\n' + parsed.documentElement.outerHTML;
}
async function showPdf(result, session, path = publicationPath(session), inputs) {
  if (session !== active || publicationPath(session) !== path || !result.available) return;
  const binding = captureSourceBinding(session), observedMain = inputs?.main || observedSourceTarget(session.project, path);
  const main = observedMain && { ...captureSourceBinding(observedMain), ...(observedMain.session ? { session: observedMain.session } : {}) };
  assertSourceBinding(session, binding);
  const artifactEpoch = sourceEpoch(result);
  if (!main || artifactEpoch !== main.sourceEpoch || !sourceRootsEqual(result, main) || !sourceRootsEqual(main, binding)) throw { code: 'stale', message: 'This PDF belongs to another source identity or project folder. Your buffer is kept; recompile the intended main document.' };
  const valid = () => {
    const currentMain = sessions.get(keyFor(binding.project, path));
    return sourceBindingCurrent(session, binding) && sourceEpoch(result) === main.sourceEpoch && sourceRootsEqual(result, main)
      && (!main.session || (currentMain === main.session && sourceBindingCurrent(main.session, main)))
      && (!currentMain || sourceBindingCurrent(currentMain, main));
  };
  if (!valid()) throw { code: 'stale', message: 'The captured main editor changed before this PDF could be displayed. Your previous preview is kept.' };
  const generation = ++pdfGeneration;
  const bytes = Uint8Array.from(atob(result.base64),c=>c.charCodeAt(0));
  const loadingTask = pdfjs.getDocument({data:bytes.slice(),isEvalSupported:false,useSystemFonts:true});
  const pdf = await loadingTask.promise;
  if (generation !== pdfGeneration || !valid() || session !== active || publicationPath(session) !== path) { await loadingTask.destroy(); return; }
  await pdfLoadingTask?.destroy();
  if (generation !== pdfGeneration || !valid() || session !== active || publicationPath(session) !== path) { await loadingTask.destroy(); return; }
  pdfViewer.clear(); pdfLoadingTask = loadingTask; pdfBytes = bytes; pdfPath = path; pdfSourceEpoch = sourceEpoch(result); pdfRoot = sourceRoot(result) ? { expectedRoot: sourceRoot(result) } : {}; pdfProject = binding.project;
  $('pdf-toolbar').hidden = showingLogs;
  await pdfViewer.setDocument(pdf);
  if (generation !== pdfGeneration || !valid() || session !== active || pdfLoadingTask !== loadingTask) return;
  const current = publicationCurrent(result, session, path, inputs);
  pdfStatus(`${current ? 'Current PDF' : 'Last good PDF · recompile or verify inputs'} · ${pdf.numPages} page${pdf.numPages===1?'':'s'}`, current ? 'current' : 'stale');
  $('export-pdf').hidden = false;
}
async function loadPublicationPreview(session, intent = navigationIntent, read = request) {
  retireCompileNavigation();
  const path = publicationPath(session);
  const binding = captureSourceBinding(session);
  let main = path ? observedSourceTarget(session.project, path) : null;
  const generation = ++pdfGeneration; const cleanup = pdfLoadingTask;
  pdfLoadingTask = null; pdfBytes = null; pdfPath = ''; pdfSourceEpoch = null; pdfRoot = {}; pdfProject = ''; pdfViewer.clear();
  $('typst-compile').hidden = !path; $('typst-compile').title = path ? `Compile ${path}` : '';
  $('manuscript-preview').hidden = Boolean(path) || showingLogs; $('typst-preview').hidden = !path || showingLogs;
  $('export-pdf').hidden = true; $('pdf-toolbar').hidden = true; $('typst-preview-status').hidden = !path;
  pdfStatus(path ? `Compile ${path} to see its PDF.` : '', 'empty');
  await cleanup?.destroy();
  if (!sourceBindingCurrent(session, binding) || !sessionNavigationCurrent(intent, session) || generation !== pdfGeneration || publicationPath(session) !== path) return;
  if (!path) { preview(); return; }
  if (!main) {
    const observed = await read({ action: 'review', project: binding.project, path });
    if (!sourceBindingCurrent(session, binding) || !sessionNavigationCurrent(intent, session) || generation !== pdfGeneration || publicationPath(session) !== path) return;
    main = captureSourceBinding({ ...observed, project: binding.project, path }); assertSourceSnapshot(observed, main);
  }
  const inputs = { ...projectInputVersions(session.project), main };
  const result = await read({action:'pdf',project:session.project,path});
  if (!sourceBindingCurrent(session, binding) || !sessionNavigationCurrent(intent, session) || generation !== pdfGeneration || publicationPath(session) !== path) return;
  await showPdf(result, session, path, inputs);
  if (!compiling && session === active && publicationPath(session) === path && result.available) setCompileLog(`Last successful build of ${path}.${result.externalDependencyCount ? '\nExternal package inputs are not fully verified.' : ''}${result.diagnostics ? `\n\n${result.diagnostics}` : ''}`);
}
async function compileSession(session, explicit = false, path = publicationPath(session), admitted = null) {
  if (!path) return;
  const binding = admitted?.binding || captureSourceBinding(session), mainChoice = admitted?.mainChoice ?? path;
  assertSourceBinding(session, binding);
  const inputBindings = admitted?.inputBindings || [...sessions.values()].filter(input => input.project === binding.project).map(input => ({ session: input, binding: captureSourceBinding(input) }));
  const checkInputs = () => {
    for (const input of inputBindings) {
      if (sessions.get(keyFor(input.binding.project, input.binding.path)) !== input.session) throw { code: 'stale_document', message: 'A captured project editor was closed or replaced. Recompile explicitly; your buffers are kept.' };
      assertSourceBinding(input.session, input.binding);
      if (!sourceRootsEqual(input.binding, binding)) throw { code: 'stale_root', message: 'Project editor inputs belong to different folder identities. Your buffers are kept.' };
    }
  };
  checkInputs();
  let target = admitted?.target || observedSourceTarget(binding.project, path);
  if (!target) {
    const observed = await request({ action: 'review', project: binding.project, path });
    assertSourceBinding(session, binding);
    target = captureSourceBinding({ ...observed, project: binding.project, path });
    assertSourceSnapshot(observed, target);
  }
  assertPublicationTarget(target, session, binding, mainChoice);
  checkInputs();
  const capture = { binding, mainChoice, target, inputBindings };
  if (compiling) {
    if (explicit) {
      if (explicitCompiles.length >= 8) throw {message:'The compilation queue is full. Wait for a build to finish, then retry.'};
      explicitCompiles.push({session,path,capture}); status('Compilation queued. You can keep editing.');
    } else compileScheduler.request(keyFor(session.project,session.path));
    return;
  }
  const reportSession = active, reportEditor = view, reportNavigation = navigationIntent;
  let reportCurrent = null;
  compiling = true; $('typst-compile').textContent = 'Compiling…';
  setCompileLog(`Compiling ${path} with Typst…`);
  try {
    if (active?.project === session.project && view?.compositionStarted) throw {message:'Finish the current text composition before compiling the project.'};
    for (const input of inputBindings) { checkInputs(); await saveSession(input.session); checkInputs(); }
    if ([...sessions.values()].some(input => input.project === session.project && (input.dirty || input.conflict || input.reviewProblem || input.identityProblem))) throw {message:'Project inputs changed while saving. Your buffers are kept; save them and compile again.'};
    checkInputs(); assertPublicationTarget(target, session, binding, mainChoice);
    const snapshot = await request({action:'open',...captureSourceBinding(target)});
    assertPublicationTarget(target, session, binding, mainChoice);
    assertSourceSnapshot(snapshot, target); checkInputs();
    const main = sessions.get(keyFor(session.project, path));
    if (main && main.content !== snapshot.content) { main.conflict = snapshot; if (main === active) renderReview(); throw {message:'The main document changed outside UnderTree. Its editor buffer is kept; resolve the external change before compiling.'}; }
    const inputs = { ...projectInputVersions(session.project), main: target };
    reportCurrent = () => {
      try {
        checkInputs(); assertPublicationTarget(target, session, binding, mainChoice);
        return active === reportSession && view === reportEditor && navigationIntent === reportNavigation && sourceBindingCurrent(session, binding)
          && inputs.version === (projectEditVersions.get(binding.project) || 0)
          && inputs.sessions.every(([input, version, revision, source]) => sessions.get(keyFor(source.project, source.path)) === input && sourceBindingCurrent(input, source) && input.version === version && input.snapshot.review.revision === revision);
      } catch { return false; }
    };
    const result = await request({action:'compile',...captureSourceBinding(target),revision:snapshot.review.revision});
    checkInputs(); assertPublicationTarget(target, session, binding, mainChoice);
    const previewSession = active?.project === session.project && publicationPath(active) === path ? active : session;
    await showPdf(result,previewSession,path,inputs);
    const current = publicationCurrent(result, session, path, inputs);
    setCompileLog(`Compiled ${path} successfully.\n${current ? 'PDF matches the saved project inputs.' : result.externalDependencyCount ? 'External package inputs are not fully verified.' : 'Source changes are newer than this PDF, inputs could not be verified, or require conflict resolution.'}${!result.compileReport && result.diagnostics ? `\n\n${result.diagnostics}` : ''}`, result.compileReport, current ? reportCurrent : null);
    status(current ? 'Typst PDF compiled locally.' : result.externalDependencyCount ? 'Compiled PDF retained; verify external package inputs.' : 'Compiled preview retained; recompile or verify project inputs.');
  } catch (error) {
    if (active?.project === session.project && publicationPath(active) === path) pdfStatus(`${error.code === 'outcome_unknown' ? 'Build outcome unknown' : 'Compilation failed'}${pdfBytes ? ' · last good PDF retained' : ''}. Open the compilation log for details.`, 'error');
    setCompileLog(error.message || String(error), error.compileReport, reportCurrent); status(error.message, true); throw error;
  } finally {
    compiling=false; $('typst-compile').textContent = 'Recompile';
    releaseCompileQueue();
  }
}
function releaseCompileQueue() {
  if (compiling) return;
  const queued = explicitCompiles.shift();
  if (!queued) { compileScheduler.release(); return; }
  void task(async () => {
    try { await compileSession(queued.session, true, queued.path, queued.capture); }
    finally { releaseCompileQueue(); }
  })();
}
function renderTabs() {
  $('manuscript-tabs').replaceChildren();
  for (const session of sessions.values()) {
    if (session.project !== $('project-select').value) continue;
    const button = element('button', `${session.path}${session.dirty ? ' •' : ''}`);
    button.setAttribute('role', 'tab'); button.setAttribute('aria-selected', String(active === session));
    button.dataset.measure = ''; button.onclick = task(() => openSession(session));
    const tab = element('div','','manuscript-tab');
    const close = actionButton('×',async () => {
      const intent = active === session ? ++navigationIntent : navigationIntent;
      if (!localNoSaveClose(session)) await saveSession(session);
      if (session.dirty || session.conflict || session.pending || session.uncertainMutation || session.unresolvedMove || (session.identityProblem && !localNoSaveClose(session))) throw { message: 'The manuscript changed or still has pending work. Save or resolve it before closing this tab.' };
      if (sessions.get(keyFor(session.project,session.path)) !== session) return;
      if (active === session) requireNavigationReady();
      sessions.delete(keyFor(session.project,session.path));
      void editorBridge.unwatch(session);
      if (active === session) {
        const cleanup = detachEditor(false); compileScheduler.cancel(); renderTabs(); renderReview();
        await cleanup?.destroy();
        if (!navigationCurrent(intent, session.project)) return;
        const next=[...sessions.values()].find(s=>s.project===session.project);
        if (next) await openSession(next, intent);
      }
      renderTabs();renderReview();
    });
    close.setAttribute('aria-label',`Close ${session.path}`);tab.append(button,close);$('manuscript-tabs').append(tab);
  }
  requestAnimationFrame(() => {
    const tabs = $('manuscript-tabs'); const selected = tabs.querySelector('[aria-selected="true"]')?.parentElement;
    if (!selected) return;
    const item = selected.getBoundingClientRect(); const bounds = tabs.getBoundingClientRect();
    if (item.left < bounds.left) tabs.scrollLeft -= bounds.left - item.left;
    else if (item.right > bounds.right) tabs.scrollLeft += item.right - bounds.right;
  });
}
function selectAnchor(anchor) {
  if (!view || anchor.stale || anchor.to > view.state.doc.length) return;
  showPane('editor'); view.dispatch({ selection: { anchor: anchor.from, head: anchor.to }, scrollIntoView: true }); view.focus();
}
function actionButton(text, callback, className = '') {
  const button = element('button', text, className); button.dataset.measure = ''; button.onclick = task(callback); return button;
}
function renderReview() {
  if (currentCompileContext && !currentCompileContext()) retireCompileNavigation();
  historyPanel.changed();
  renderProjectExport();
  const list = $('review-list');
  restoreReviewScroll = renderedReviewSession === active ? list.scrollTop : active?.reviewScroll || 0;
  const historyOpen = list.querySelector('details')?.open || false;
  const focused = list.contains(document.activeElement) ? { id: document.activeElement.closest('[data-review-id]')?.dataset.reviewId, label: document.activeElement.textContent } : null;
  for (const card of reviewCardsObserved) reviewGeometry.unobserve(card);
  reviewCardsObserved.clear(); list.replaceChildren($('review-conflict')); renderedReviewSession = active;
  reviewCue();
  const reviewBlocked = !!(active?.reviewProblem || active?.identityProblem);
  $('manuscript-share').disabled = !active || !/\.(html?|typ)$/i.test(active.path) || (reviewBlocked && !active.snapshot.shared);
  if (sharingSession !== active) $('manuscript-share').checked = Boolean(active?.snapshot.shared);
  $('review-conflict').hidden = !active?.conflict;
  if (active) $('save-label').textContent = saveLabel(active);
  for (const id of ['manuscript-save','highlight-selection','palette-open','export-manuscript','highlight-rule']) $(id).disabled = !active;
  for (const id of ['manuscript-save','highlight-selection','palette-open','highlight-rule']) if (reviewBlocked) $(id).disabled = true;
  for (const button of document.querySelectorAll('[data-command]')) {
    const command = button.dataset.command;
    if (['save','download','undo','redo','find','select-all','highlight','palette','bold','italic','heading','bullet-list','numbered-list'].includes(command)) button.disabled = !active || (['bold','italic','heading','bullet-list','numbered-list'].includes(command) && !/\.(typ|html?)$/i.test(active.path));
    if (reviewBlocked && ['save','highlight','palette','set-main-document'].includes(command)) button.disabled = true;
    if (insertionCommands.has(command)) button.disabled = !active?.path.endsWith('.typ');
    if (command === 'import') button.hidden = !active?.path.endsWith('.tex');
    if (command === 'set-main-document') button.disabled = reviewBlocked || !active?.path.endsWith('.typ') || currentProject()?.mainDocument === active.path;
    if (command === 'clear-main-document') { button.disabled = !currentProject()?.mainDocument; button.title = currentProject()?.mainDocument || ''; }
  }
  const noReviewPassages = reviewBlocked || !reviewAnchors().length;
  $('review-previous').disabled = noReviewPassages; $('review-next').disabled = noReviewPassages;
  if (!active) { $('typst-compile').hidden = true; $('pdf-toolbar').hidden = true; $('export-pdf').hidden = true; list.append(element('p', 'Select text in the editor to add a highlight or reviewer instruction.', 'review-empty')); return; }
  const review = active.snapshot.review;
  if (reviewBlocked) {
    const session = active, problem = session.identityProblem || session.reviewProblem;
    const card = element('article', '', 'review-card'); card.id = 'review-policy-problem'; card.dataset.problem = problem.code; card.setAttribute('role', 'alert'); card.style.setProperty('--review-color', 'var(--danger)');
    card.append(element('h3', session.identityProblem ? 'Source identity changed' : 'Last known review data'));
    const message = element('p', problem.message); message.dataset.measure = ''; card.append(message);
    const instructions = element('p', session.identityProblem ? 'Your draft, history and last known protections are kept. Export your buffer before deliberately choosing Load disk version for the new source at this path. Refreshing does not change this editor identity.' : problem.code === 'policy_missing' ? 'Your draft and last known protections are kept. Restore the review file in the project folder, then check again. Checking does not save or reload your draft.' : 'Your draft and last known protections are kept. Resolve the review-file conflict and any preserved pending save in the project folder, then check again. Checking does not recover or save files.');
    instructions.dataset.measure = ''; card.append(instructions);
    if (!session.identityProblem) card.append(actionButton('Check review data', () => { if (active === session) $('review-refresh').click(); }), actionButton('Export my buffer', () => { if (active === session) downloadBuffer(); }));
    if (session.identityProblem) card.append(actionButton('Export my buffer', () => { if (active === session) downloadBuffer(); }), actionButton('Load disk version', () => { if (active === session) $('reload-buffer').click(); }));
    list.append(card);
  }
  const passages = element('div', '', 'review-passages'); passages.id = 'review-passages';
  list.append(passages);
  for (const id of ['highlight-rule', 'highlight-dialog-rule']) {
    const select = $(id); const previous = select.value; select.replaceChildren();
    for (const rule of review.rules) { const option = element('option', rule.label); option.value = rule.id; select.append(option); }
    if (review.rules.some(r => r.id === previous)) select.value = previous;
  }
  for (const marker of review.markers) {
    const rule = review.rules.find(r => r.id === marker.rule);
    const card = element('article', '', 'review-card'); card.style.setProperty('--review-color', rule?.color || '#666666');
    card.dataset.reviewId = marker.id; card.dataset.sourcePosition = String(marker.anchor.from);
    card.dataset.stale = String(marker.anchor.stale);
    const heading = element('h3', rule?.label || 'Highlight'); heading.dataset.measure = ''; card.append(heading);
    card.append(element('blockquote', marker.anchor.quote));
    if (reviewBlocked) card.append(element('p', 'Last known protection · review data needs resolution.', 'stale-note'));
    if (rule?.prompt || marker.prompt) card.append(element('p', [rule?.prompt, marker.prompt].filter(Boolean).join(' '), 'rationale'));
    if (marker.anchor.stale) card.append(element('p', 'Stale highlight. Select the current passage and reanchor this highlight, or remove it. Stale protection blocks agent suggestions.', 'stale-note'));
    const actions = element('div', '', 'card-actions');
    const locate = actionButton('Locate', () => locateReview(marker.id, marker.anchor)); locate.disabled = reviewBlocked || marker.anchor.stale;
    const remove = actionButton('Remove highlight', async () => { const session = active; await session.mutate('unmark', { id: marker.id }); if (active === session) { renderReview(); decorations(); } queueSync(session.project); }); remove.disabled = reviewBlocked;
    actions.append(locate, remove);
    if (marker.anchor.stale) { const reanchor = actionButton('Reanchor from selection', () => beginReanchor(marker)); reanchor.disabled = reviewBlocked; actions.prepend(reanchor); }
    card.append(actions); passages.append(card);
  }
  const pending = review.suggestions.filter(s => s.status === 'pending');
  if (!pending.length) list.append(element('p', 'Agent suggestions will appear here after you share this manuscript and connect ChatGPT. Your text changes only when you accept.', 'review-empty'));
  for (const suggestion of pending) {
    const card = element('article', '', 'review-card suggestion-card'); card.style.setProperty('--review-color', suggestion.color);
    card.dataset.reviewId = suggestion.id; card.dataset.sourcePosition = String(suggestion.anchor.from);
    card.dataset.stale = String(suggestion.anchor.stale);
    const heading = element('h3', 'Proposed wording'); heading.dataset.measure = ''; card.append(heading);
    card.append(element('blockquote', suggestion.anchor.quote), element('p', suggestion.replacement, 'replacement'), element('p', suggestion.rationale, 'rationale'));
    if (suggestion.prompt) card.append(element('p', suggestion.prompt, 'rationale'));
    if (suggestion.anchor.stale) card.append(element('p', 'The original passage changed. Ask for a new suggestion.', 'stale-note'));
    const actions = element('div', '', 'card-actions');
    const decide = async decision => {
      if (decision === 'accepted' && view?.compositionStarted) throw { message: 'Finish the current text composition before accepting a suggestion.' };
      const session = active;
      await session.mutate('decide', { id: suggestion.id, decision });
      if (decision === 'accepted') noteProjectEdit(session.project);
      if (active === session) {
        if (decision === 'accepted' && view.compositionStarted && view.state.doc.toString() !== session.content) {
          session.edit(view.state.doc.toString()); session.conflict = session.snapshot;
          status('The suggestion was accepted on disk while text composition began. Your editor buffer is kept; finish composing, then resolve the external change.', true);
        }
        acknowledgeReview(suggestion.id);
        if (!session.conflict && view.state.doc.toString() !== session.content) {
          const previous = view.state.doc.toString(); const next = session.content;
          // Replace only the accepted passage so CodeMirror can map the caret and preserve useful undo.
          view.dispatch({ changes: acceptedTextChange(previous, next), annotations: [authoritative.of(true), Transaction.userEvent.of('input.review')] });
        }
        renderReview(); decorations(); preview(); renderTabs();
      }
      if (decision === 'accepted' && active?.project === session.project && publicationPath(active)
        && publicationPath(active) === publicationPath(session)) {
        pdfStatus('Project inputs changed · last good PDF retained');
        compileScheduler.request(keyFor(active.project, active.path));
      }
      queueSync(session.project);
    };
    const accept = actionButton('Accept', () => decide('accepted'), 'accept-suggestion'); accept.disabled = reviewBlocked || suggestion.anchor.stale || Boolean(active.conflict);
    const locate = actionButton('Locate', () => locateReview(suggestion.id, suggestion.anchor)); locate.disabled = reviewBlocked || suggestion.anchor.stale;
    const reject = actionButton('Reject', () => decide('rejected'), 'reject-suggestion'); reject.disabled = reviewBlocked;
    actions.append(accept, reject, locate); card.append(actions); passages.append(card);
  }
  const orderedCards = [...passages.children].sort((a, b) => Number(a.dataset.sourcePosition) - Number(b.dataset.sourcePosition));
  passages.replaceChildren(...orderedCards);
  for (const card of orderedCards) { card.dataset.selected = String(card.dataset.reviewId === selectedReviewId); reviewGeometry.observe(card); reviewCardsObserved.add(card); }
  const decided = review.suggestions.filter(s => s.status !== 'pending');
  if (decided.length) {
    const details = element('details'); details.append(element('summary', `Reviewed (${decided.length})`));
    details.open = historyOpen;
    for (const s of decided) details.append(element('p', `${s.status === 'accepted' ? 'Accepted' : 'Rejected'}: ${s.replacement}`, 'rationale'));
    list.append(details);
  }
  const scrollSpace = element('div', '', 'review-scroll-space'); scrollSpace.id = 'review-scroll-space'; scrollSpace.setAttribute('aria-hidden', 'true'); list.append(scrollSpace);
  if (focused?.id) {
    const card = orderedCards.find(card => card.dataset.reviewId === focused.id);
    [...card?.querySelectorAll('button') || []].find(button => button.textContent === focused.label)?.focus({ preventScroll: true });
  }
  scheduleReviewPositions();
}
import { Annotation } from '@codemirror/state';
const authoritative = Annotation.define();
async function openSession(session, intent = ++navigationIntent) {
  const binding = captureSourceBinding(session);
  if (!sessionNavigationCurrent(intent, session, binding)) return;
  if (active === session && view) return;
  const previous = active;
  if (previous?.dirty) await saveSession(previous);
  if (!sessionNavigationCurrent(intent, session, binding)) return;
  return mountSession(session, intent, request, binding);
}
// This mount never flushes a source buffer; remote callers have their own immutable guards.
async function mountSession(session, intent, read = request, binding = captureSourceBinding(session)) {
  if (!sessionNavigationCurrent(intent, session, binding)) return;
  const cleanup = detachEditor(); renderTabs(); renderReview();
  await cleanup?.destroy();
  if (!sessionNavigationCurrent(intent, session, binding)) return;
  active = session;
  selectedReviewId = session.reviewSelectedId || null;
  // Literal carriage returns stay in the document so review UTF-16 positions match the saved source.
  const extensions = [EditorState.lineSeparator.of('\n'), highlightSpecialChars({ render: code => {
    if (code !== 13) return null;
    const carriage = element('span', '', 'cm-preserved-cr'); carriage.setAttribute('aria-hidden', 'true'); return carriage;
  } }), basicSetup, editorWrapping.of(workspacePreferences.wordWrap ? EditorView.lineWrapping : []), reviewField, windowEditing.of(windowEditorAccess()), EditorView.domEventHandlers({
    compositionstart: () => { queueMicrotask(() => { editorBridge.changed(session); wordCount.changed(); }); },
    compositionend: () => { setTimeout(() => editorBridge.changed(session), 0); },
  }), EditorView.updateListener.of(update => {
    if (update.docChanged || update.selectionSet) queueMicrotask(() => wordCount.changed());
    if (update.selectionSet && !session.dirty && !update.docChanged && !update.view.compositionStarted && active === session) {
      const range = update.state.selection.main;
      const candidates = reviewAnchors().filter(item => range.from < item.anchor.to && range.to >= item.anchor.from);
      const item = candidates.find(item => item.id === selectedReviewId) || candidates[0];
      if (item) { markSelectedReview(item.id); scheduleReviewPositions(true); }
    }
    if (!update.docChanged || update.transactions.some(t => t.annotation(authoritative))) return;
    session.edit(update.state.doc.toString());
    noteProjectEdit(session.project);
    if (active === session) { $('save-label').textContent = 'Unsaved changes'; renderTabs(); }
    clearTimeout(saveTimers.get(session));
    if (!session.reviewProblem && !session.identityProblem) saveTimers.set(session, setTimeout(() => { saveTimers.delete(session); void task(() => saveSession(session))(); }, 450));
    clearTimeout(previewTimer); previewTimer = setTimeout(() => { preview(); renderOutline(); }, 250);
    if (publicationPath(session)) { pdfStatus('Project inputs changed · last good PDF retained'); if (!session.reviewProblem && !session.identityProblem) compileScheduler.request(keyFor(session.project,session.path)); }
  })];
  if (/\.html?$/i.test(session.path)) extensions.push(html());
  else if (/\.css$/i.test(session.path)) extensions.push(css());
  else if (/\.typ$/i.test(session.path)) extensions.push(typstLanguage);
  let editorState = session.editorState;
  if (editorState && editorState.doc.toString() !== session.content) editorState = editorState.update({changes:{from:0,to:editorState.doc.length,insert:session.content},annotations:authoritative.of(true)}).state;
  view = new EditorView({ state: editorState || EditorState.create({ doc: session.content, extensions }), parent: $('manuscript-source') });
  applyEditorPreferences();
  view.scrollDOM.addEventListener('scroll', () => scheduleReviewPositions(true), { passive: true });
  if (session.editorScroll) requestAnimationFrame(() => { if (active === session && view) { view.scrollDOM.scrollTop = session.editorScroll.top; view.scrollDOM.scrollLeft = session.editorScroll.left; } });
  renderTabs(); renderReview(); decorations(); preview(); renderOutline(); showPane('editor');
  $('tex-import').hidden = !session.path.endsWith('.tex');
  await loadPublicationPreview(session, intent, read);
  if (!sessionNavigationCurrent(intent, session, binding)) return;
  $('save-label').textContent = saveLabel(session);
  for (const button of document.querySelectorAll('.file-button')) {
    button.setAttribute('aria-current', String(button.dataset.path === session.path));
    if (button.dataset.path === session.path) {
      let folder = button.closest('.file-folder');
      while (folder) { folder.open = true; folder = folder.parentElement.closest('.file-folder'); }
    }
  }
}
function requireSessionCapacity(project, path) {
  if (!sessions.has(keyFor(project, path)) && sessions.size >= 20) throw {message:'Close a file tab before opening another. UnderTree keeps at most 20 editor buffers.'};
}
async function openFile(path, project = $('project-select').value, expectedEpoch = 0, root = {}) {
  if (project !== $('project-select').value) throw { message: 'The project changed. Refresh its file tree before opening this source.' };
  if (fileMove?.blocks(project, path)) throw { code: 'busy', message: 'Check or resolve the pending Move before opening either file path. Your buffers are kept.' };
  const binding = captureSourceBinding({ project, path, sourceEpoch: expectedEpoch, ...root });
  if (!sourceRootsEqual(binding, inventoryRoot(project))) throw { code: 'stale_root', message: 'The project folder changed. Open the file from its refreshed tree.' };
  const intent = ++navigationIntent;
  let session = sessions.get(keyFor(project, path));
  if (session && !sourceBindingCurrent(session, binding)) {
    session.recordIdentityProblem({ code: sourceRootsEqual(session, binding) ? 'stale_document' : 'stale_root', message: 'The tree lists a different source or project folder identity at this path. Your original tab and history are kept. Use Load disk version deliberately to replace it.' }, captureSourceBinding(session));
    if (session === active) renderReview();
    throw session.identityProblem;
  }
  if (!session) {
    requireSessionCapacity(project, path);
    const snapshot = await request({ action: 'open', ...binding });
    assertSourceSnapshot(snapshot, binding);
    if (!navigationCurrent(intent, project)) return;
    if (!sourceRootsEqual(binding, inventoryRoot(project))) throw { code: 'stale_root', message: 'The project folder changed while opening this file. Your existing buffers are kept.' };
    session = trackSession(snapshot, project);
  }
  await openSession(session, intent);
}
async function loadFiles(intent = navigationIntent, expectedRoot) {
  const project = $('project-select').value;
  const root = expectedRoot === undefined ? null : { expectedRoot: sourceRoot({ expectedRoot }) };
  if (root && !sourceRootsEqual(root, inventoryRoot(project))) throw { code: 'stale_root', message: 'The project folder changed. Refresh its file tree deliberately.' };
  if (!navigationCurrent(intent, project)) return;
  const generation = ++fileInventoryGeneration;
  if (!project) { $('manuscript-files').replaceChildren(); delete $('manuscript-files').dataset.project; return; }
  if ($('manuscript-files').dataset.project !== project) { $('manuscript-files').replaceChildren(); delete $('manuscript-files').dataset.project; }
  const files = await request({ action: 'project_tree', project, ...(root || {}) });
  if (root && (project !== $('project-select').value || !sourceRootsEqual(root, files) || !sourceRootsEqual(root, inventoryRoot(project)))) throw { code: 'stale_root', message: 'The project folder changed while refreshing its tree. Refresh it deliberately.' };
  if (generation !== fileInventoryGeneration || project !== $('project-select').value) return;
  renderFiles(files, project);
}
function rememberExpandedFolders() {
  while (expandedFolders.size > 500) expandedFolders.delete(expandedFolders.values().next().value);
  try { localStorage.setItem('undertree.expanded-folders', JSON.stringify([...expandedFolders])); } catch { /* Offline storage may be unavailable. */ }
}
function renderFiles(inventory, project) {
  if (inventory.project !== project) throw { message: 'The file listing belongs to a different project. Refresh the file tree.' };
  const expectedRoot = sourceRoot(inventory), root = Object.freeze(expectedRoot ? { expectedRoot } : {});
  $('manuscript-files').replaceChildren();
  $('manuscript-files').dataset.project = project;
  fileInventoryRoots.set($('manuscript-files'), root);
  function appendTree(nodes, parent) {
    for (const node of nodes) {
      if (node.kind === 'directory') {
        const folder = element('details', '', 'file-folder'); const key = `${project}:${node.path}`;
        folder.dataset.path = node.path;
        folder.open = expandedFolders.has(key); const summary = element('summary', node.name); summary.dataset.measure = ''; summary.setAttribute('aria-label', `Folder ${node.path}`);
        folder.ontoggle = () => {
          if (folder.open) expandedFolders.add(key); else expandedFolders.delete(key);
          rememberExpandedFolders();
        };
        const children = element('div', '', 'tree-children'); appendTree(node.children, children); folder.append(summary, children); parent.append(folder);
      } else if (node.editable) {
        const epoch = sourceEpoch(node);
        const button = actionButton(node.name, () => openFile(node.path, project, epoch, root), 'file-button'); button.dataset.path = node.path; button.dataset.sourceEpoch = String(epoch); button.title = node.path; button.setAttribute('aria-description', `Open ${node.path}`); button.setAttribute('aria-current', String(active?.project === project && active?.path === node.path)); parent.append(button);
      } else {
        const asset = element('p', `${node.path} · ${node.kind === 'asset' ? 'Asset' : 'Source'} (not editable)`, 'file-asset'); asset.dataset.path = node.path; asset.dataset.measure = ''; parent.append(asset);
      }
    }
  }
  appendTree(manuscriptTree(inventory.entries), $('manuscript-files'));
  const notices = [];
  if (inventory.truncated) notices.push('Inventory limit reached. Some items are not shown.');
  if (inventory.omittedNonUtf8) notices.push(`${inventory.omittedNonUtf8} non-UTF-8 filename${inventory.omittedNonUtf8 === 1 ? ' was' : 's were'} omitted.`);
  if (!inventory.entries.length && !notices.length) notices.push('No visible files or folders yet. Use the File menu to create one.');
  if (notices.length) { const help = element('p', notices.join(' '), 'file-help'); help.setAttribute('role', 'status'); help.dataset.measure = ''; $('manuscript-files').append(help); }
}
function openNewFolder() {
  const project = currentProject();
  if (!project) throw { message: 'Choose a project folder first.' };
  if (view?.compositionStarted) throw { message: 'Finish composing text before creating a folder. Your buffer is kept.' };
  newFolderContext = { project: project.id, ...inventoryRoot(project.id), pending: false };
  $('new-folder-project').textContent = `Project: ${project.name}`;
  $('new-folder-path').value = 'new-folder'; $('new-folder-path').disabled = false;
  $('new-folder-error').hidden = true; $('new-folder-submit').disabled = false;
  $('new-folder-dialog').showModal(); $('new-folder-path').select();
}
let moveReturnFocus = null, moveDraft = null;
const moveSources = new Map();
function assertMoveTree(binding) {
  if (windowClosing || view?.compositionStarted) throw { code: 'busy', message: 'Finish the current text composition or window operation before moving a source. Your buffer is kept.' };
  if (binding.project !== $('project-select').value || !sourceRootsEqual(binding, inventoryRoot(binding.project))) throw { code: 'stale_root', message: 'The selected project folder changed. Refresh its tree and choose the source again.' };
  const row = [...$('manuscript-files').querySelectorAll('.file-button')].find(node => node.dataset.path === binding.from);
  if (!row || sourceEpoch({ sourceEpoch: Number(row.dataset.sourceEpoch) }) !== binding.sourceEpoch) throw { code: 'stale_document', message: 'The source changed in the file tree. Refresh and choose it again.' };
  const parent = binding.to.includes('/') ? binding.to.slice(0, binding.to.lastIndexOf('/')) : '';
  if (parent && ![...$('manuscript-files').querySelectorAll('.file-folder')].some(folder => folder.dataset.path === parent)) throw { message: 'Choose a destination under an existing folder in this project.' };
}
async function refreshMoveMetadata() {
  // Only current observations are used. A historical receipt never supplies project state or navigation.
  const selected = $('project-select').value, intent = navigationIntent, observedProjects = projects;
  const response = await request({ action: 'projects' });
  if (!navigationCurrent(intent, selected)) return;
  if (projects !== observedProjects) {
    if (projects.some(project => project.id === selected)) await loadFiles(intent);
    return;
  }
  const displayed = active, previousPath = publicationPath(displayed);
  const previous = currentProject(); projects = response;
  const select = $('project-select'); select.replaceChildren(element('option', 'Choose a project')); select.firstChild.value = '';
  for (const project of projects) { const option = element('option', project.name); option.value = project.id; select.append(option); }
  if (selected && !projects.some(project => project.id === selected)) { const option = element('option', `${previous?.name || 'Selected project'} (unavailable)`); option.value = selected; option.disabled = true; select.append(option); }
  select.value = selected;
  const path = publicationPath(active);
  if (active && active === displayed && path !== previousPath) {
    $('typst-compile').title = path ? `Compile ${path}` : ''; $('typst-compile').hidden = !path;
    retireCompileNavigation();
    if (pdfBytes && pdfProject === active.project && sourceRootsEqual(active, pdfRoot) && pdfPath !== path) pdfStatus('Main document changed · last good PDF retained');
  }
  renderProjectExport(); renderReview();
  if (projects.some(project => project.id === selected)) await loadFiles(intent);
  else { fileInventoryGeneration += 1; $('manuscript-files').replaceChildren(); delete $('manuscript-files').dataset.project; }
}
// Native Move admission is separate from generic Review/browser/App operations.
if (nativeReview) {
  const commands = nativeFileMoveCommands(invoke, editorOwnerId, nativeReview);
  fileMove = new NativeFileMove({
    prepare: value => fileActivity(() => commands.prepare(value)),
    request: operation => fileActivity(() => commands.request(operation)),
    observe: binding => request({ action: 'review', project: binding.project, path: binding.from, sourceEpoch: binding.sourceEpoch, expectedRoot: binding.expectedRoot }),
    sessions: () => sessions.values(), canStart: assertMoveTree, refresh: refreshMoveMetadata,
    onChange: () => { localRequestsVersion += 1; renderFileMove(); },
  });
}
function chooseMoveSource() {
  const source = moveSources.get($('file-move-source').value);
  moveDraft = source ? { ...source, to: source.from } : null;
  $('file-move-destination').value = moveDraft?.to || '';
  renderFileMove();
}
function startMoveDraft() {
  if (!fileMove || fileMove.busy) return;
  const project = currentProject(); moveSources.clear();
  const select = $('file-move-source'); select.replaceChildren();
  let root = null;
  if (project) { try { root = inventoryRoot(project.id); } catch (error) { fileMove.message = error.message; } }
  if (root) {
    for (const row of $('manuscript-files').querySelectorAll('.file-button')) if (/\.(typ|html)$/.test(row.dataset.path)) {
      const source = { project: project.id, from: row.dataset.path, sourceEpoch: sourceEpoch({ sourceEpoch: Number(row.dataset.sourceEpoch) }), ...root };
      moveSources.set(source.from, source); const option = element('option', source.from); option.value = source.from; select.append(option);
    }
  }
  if (!moveSources.size) { const option = element('option', 'No .typ or .html sources in the current tree'); option.value = ''; select.append(option); }
  if (active?.project === project?.id && moveSources.has(active.path)) select.value = active.path;
  fileMove.select(null); chooseMoveSource();
}
function renderFileMove() {
  if (!fileMove) return;
  const prepare = $('file-move-prepare'), dialog = $('file-move-dialog');
  const prepareHadFocus = document.activeElement === prepare && document.hasFocus();
  const context = fileMove.current, captured = !!context?.request.requestId && context.status !== 'not_submitted';
  const binding = captured ? context.request : moveDraft;
  const requestSelect = $('file-move-requests'); requestSelect.replaceChildren(element('option', 'New source Move')); requestSelect.firstChild.value = '';
  for (const [id, record] of fileMove.records) {
    const option = element('option', `${record.request.from} → ${record.request.to} · ${record.status}`); option.value = id; requestSelect.append(option);
  }
  requestSelect.value = captured ? `${binding.generation}:${binding.requestId}` : ''; requestSelect.disabled = fileMove.busy;
  $('file-move-project').textContent = binding ? `Project: ${projects.find(project => project.id === binding.project)?.name || binding.project}` : 'Choose a project and refresh its file tree before preparing a Move.';
  $('file-move-paths').hidden = !binding;
  $('file-move-from').textContent = binding?.from || ''; $('file-move-to').textContent = captured ? binding.to : $('file-move-destination').value;
  $('file-move-draft').hidden = captured;
  $('file-move-source').disabled = fileMove.busy || !fileMove.canPrepare;
  $('file-move-destination').disabled = fileMove.busy || !fileMove.canPrepare;
  $('file-move-prepare').hidden = captured; $('file-move-prepare').disabled = !moveDraft || !fileMove.canPrepare;
  $('file-move-commit').hidden = !captured || context.phase !== 'prepared' || !context.owned || context.commitSubmitted;
  $('file-move-commit').disabled = fileMove.busy || !fileMove.ready || !!fileMove.storageProblem;
  $('file-move-cancel').hidden = !captured || !context.owned || !context.moveId || !['prepared', 'unknown'].includes(context.status); $('file-move-cancel').disabled = fileMove.busy;
  $('file-move-status-check').hidden = !captured; $('file-move-status-check').disabled = fileMove.busy;
  $('file-move-reconcile').hidden = !captured || !['pending', 'recovery_required'].includes(context.status); $('file-move-reconcile').disabled = fileMove.busy;
  $('file-move-list').disabled = fileMove.busy; $('file-move-new').disabled = fileMove.busy || !fileMove.canPrepare;
  const capacity = fileMove.retainedCount >= 64 ? 'All 64 Move receipt slots are full. Completed or cancelled receipts still use a slot. Receipt maintenance is explicit and can require a successful Git sync; offline capacity is limited.' : '';
  const message = [context?.message, fileMove.message, capacity, fileMove.storageProblem].filter((value, index, values) => value && values.indexOf(value) === index).join(' ');
  $('file-move-status').textContent = message || 'Both source and destination tabs must already be closed, including inactive tabs. No buffers will be saved or discarded.';
  $('file-move-status').setAttribute('role', context?.phase === 'unconfirmed' || fileMove.storageProblem ? 'alert' : 'status');
  $('file-move-capacity').textContent = `${fileMove.retainedCount} of 64 Move receipts retained in this generation. Completing or checking a Move does not free a slot.`;
  $('file-move-request-detail').hidden = !captured;
  $('file-move-identity').textContent = captured ? `Generation ${binding.generation} · request ${binding.requestId}` : '';
  $('file-move-retire').disabled = fileMove.busy || !fileMove.ready || !$('file-move-retire-confirm').checked || !!fileMove.storageProblem || [...fileMove.records.values()].some(record => record.native && !['moved', 'cancelled'].includes(record.status));
  $('file-move-retire-confirm').disabled = fileMove.busy;
  $('file-move-dialog').setAttribute('aria-busy', String(fileMove.busy));
  if (prepareHadFocus && dialog.open && dialog.matches(':modal') && document.hasFocus() && (prepare.hidden || prepare.disabled) && [prepare, document.body].includes(document.activeElement)) $('file-move-status').focus();
}
function openFileMove(trigger) {
  if (!fileMove) throw { code: 'desktop_required', message: 'Moving sources requires the UnderTree desktop app.' };
  if ($('file-move-dialog').open) return;
  moveReturnFocus = trigger?.closest('details')?.querySelector('summary') || trigger;
  $('file-move-retire-confirm').checked = false;
  const captured = !!fileMove.current?.request.requestId && fileMove.current.status !== 'not_submitted';
  if (!captured) startMoveDraft();
  renderFileMove(); $('file-move-dialog').showModal();
  (captured ? $('file-move-status-check') : $('file-move-source').disabled ? $('file-move-list') : $('file-move-source')).focus();
}
$('file-move-source').onchange = chooseMoveSource;
$('file-move-destination').oninput = () => { if (moveDraft) moveDraft.to = $('file-move-destination').value; $('file-move-to').textContent = $('file-move-destination').value; };
$('file-move-requests').onchange = () => { if ($('file-move-requests').value) fileMove?.select($('file-move-requests').value); else startMoveDraft(); };
function moveAction(callback) { return task(async event => { try { await callback(event); } catch (error) { if (fileMove) { fileMove.message = error.message || 'The Move action is unavailable.'; renderFileMove(); } } }); }
$('file-move-new').onclick = moveAction(() => startMoveDraft());
$('file-move-prepare').onclick = moveAction(() => fileMove?.prepare(moveDraft));
for (const [id, action] of [['commit', 'move_commit'], ['cancel', 'move_cancel'], ['status-check', 'move_status'], ['reconcile', 'move_reconcile']]) $('file-move-' + id).onclick = moveAction(() => fileMove?.act(action));
$('file-move-list').onclick = moveAction(() => fileMove?.discover());
$('file-move-retire-confirm').onchange = renderFileMove;
$('file-move-retire').onclick = moveAction(async () => { const confirmed = $('file-move-retire-confirm').checked; $('file-move-retire-confirm').checked = false; await fileMove?.retire(confirmed); });
$('file-move-close').onclick = () => $('file-move-dialog').close();
$('file-move-dialog').addEventListener('cancel', event => { event.preventDefault(); $('file-move-dialog').close(); });
$('file-move-dialog').addEventListener('close', () => {
  const target = [moveReturnFocus, $('menu-file-toggle'), $('workspace-menu').querySelector('summary')].find(node => node?.getClientRects().length);
  target?.focus({ preventScroll: true }); moveReturnFocus = null;
});
for (const button of document.querySelectorAll('[data-command="move-source"]')) if (!nativeReview) { button.disabled = true; button.textContent = 'Rename or move source · desktop only'; button.title = 'Moving sources requires the UnderTree desktop app.'; }
let renderedImportContext = null, renderedImportSelection = null, closingImportContext = null;
const fileImport = new NativeFileImport({
  choose: (project, parent, expectedRoot) => fileActivity(() => chooseImportFiles(project, parent, expectedRoot)),
  request: operation => fileActivity(() => importRequest(operation)),
  canStart: (project, expectedRoot) => {
    if (!nativeReview) throw { message: 'File import requires the UnderTree desktop app.' };
    if (windowClosing || view?.compositionStarted) throw { message: 'Finish composing text and keep UnderTree open before importing files. Your buffer is kept.' };
    if (currentProject()?.id !== project) throw { message: 'The project changed. Reopen Import files in the intended project.' };
    if (!sourceRootsEqual({ expectedRoot }, inventoryRoot(project))) throw { code: 'stale_root', message: 'The project folder changed. Reopen Import files from its refreshed tree.' };
  },
  onChange: renderFileImport,
  onCommitted: async receipt => {
    if (currentProject()?.id !== receipt.project || !sourceRootsEqual(receipt, inventoryRoot(receipt.project))) throw { code: 'stale_root', message: 'Refresh the intended project file tree to see its imported files.' };
    const expectedRoot = sourceRoot(receipt);
    noteProjectEdit(receipt.project);
    if (pdfBytes && pdfProject === receipt.project) pdfStatus('Project inputs changed · last good PDF retained', 'stale');
    queueSync(receipt.project, expectedRoot);
    await loadFiles(navigationIntent, expectedRoot);
  },
});
function renderFileImport(context) {
  $('file-import-project').textContent = `Project: ${context.project.name}`;
  if (document.activeElement !== $('file-import-parent')) $('file-import-parent').value = context.parent;
  const canChooseAgain = ['failed', 'inspected'].includes(context.phase);
  $('file-import-parent').disabled = context.busy || !!context.selection || (!!context.requestId && !canChooseAgain);
  $('file-import-choose').disabled = context.busy || !!context.selection || (!!context.requestId && !canChooseAgain);
  $('file-import-clear').disabled = context.busy || !context.selection || !!context.requestId;
  $('file-import-submit').disabled = context.busy || context.phase !== 'ready' || !!context.requestId;
  $('file-import-check').hidden = !context.requestId || ['committed', 'failed', 'inspected'].includes(context.phase);
  $('file-import-check').disabled = context.busy;
  $('file-import-dismiss').hidden = !['unknown', 'outcome_unknown'].includes(context.lastStatus) || context.phase === 'inspected';
  $('file-import-dismiss').disabled = context.busy;
  $('file-import-close').disabled = context.busy && context.phase !== 'choosing';
  const message = context.message || (context.selection ? `${context.selection.files.length} staged file${context.selection.files.length === 1 ? '' : 's'}. Review the names, then import.` : 'Choose files from this computer.');
  if ($('file-import-status').textContent !== message) $('file-import-status').textContent = message;
  $('file-import-status').setAttribute('role', context.message && ['unconfirmed', 'failed', 'empty', 'ready'].includes(context.phase) ? 'alert' : 'status');
  $('file-import-dialog').setAttribute('aria-busy', String(context.busy));
  if (renderedImportContext !== context || renderedImportSelection !== context.selection) {
    renderedImportContext = context; renderedImportSelection = context.selection;
    $('file-import-list').replaceChildren(...(context.selection?.files || []).map(file => {
      const row = element('li', `${file.name} · ${file.kind === 'asset' ? 'Asset' : 'Source'} · ${file.bytes.toLocaleString()} bytes`); row.dataset.measure = ''; return row;
    }));
  }
}
function openFileImport() {
  if ($('file-import-dialog').open) return;
  const project = currentProject();
  if (!project) throw { message: 'Choose a project folder first.' };
  const parent = active?.project === project.id ? active.path.split('/').slice(0, -1).join('/') : '';
  fileImport.open(project, parent, sourceRoot(inventoryRoot(project.id)));
  localRequestsVersion += 1;
  $('file-import-dialog').showModal();
}
const projectExport = new NativeProjectExport({
  prepare: (project, expectedRoot) => fileActivity(() => prepareProjectExport(project, expectedRoot)),
  choose: (exportId, requestId) => fileActivity(() => chooseProjectExportDestination(exportId, requestId)),
  request: operation => fileActivity(() => projectExportRequest(operation)),
  canStart: () => {
    if (!nativeReview) throw { message: 'Project download requires the UnderTree desktop app.' };
    if (windowClosing || view?.compositionStarted) throw { message: 'Finish composing text and keep UnderTree open before downloading the saved project. Your buffer is kept.' };
  },
  onChange: context => { renderProjectExport(); status(context.message, ['failed', 'unconfirmed'].includes(context.phase)); },
});
function renderProjectExport() {
  const context = projectExport.current;
  for (const button of document.querySelectorAll('[data-command="download-project"]')) {
    button.disabled = !nativeReview || !currentProject() || !!context?.busy || !!projectExport.pendingCount;
    if (!nativeReview) { button.textContent = 'Download saved project (.zip) · desktop only'; button.title = 'Project download requires the UnderTree desktop app.'; }
  }
  for (const button of document.querySelectorAll('[data-command="check-project-download"]')) { button.hidden = !projectExport.pendingCount; button.disabled = !!context?.busy; }
  for (const button of document.querySelectorAll('[data-command="inspect-project-download"]')) { button.hidden = !projectExport.pendingCount || !['unknown', 'outcome_unknown'].includes(context?.lastStatus); button.disabled = !!context?.busy; }
  for (const node of document.querySelectorAll('[data-project-export-status]')) {
    node.hidden = !context; node.textContent = context?.message || '';
    node.setAttribute('role', ['failed', 'unconfirmed'].includes(context?.phase) ? 'alert' : 'status');
  }
}
async function downloadSavedProject() {
  const project = currentProject();
  if (!project) throw { message: 'Choose a project folder first.' };
  await projectExport.start(project, sourceRoot(inventoryRoot(project.id)));
}
async function loadProjects(selected, intent = ++navigationIntent) {
  const response = await request({ action: 'projects' });
  if (intent !== navigationIntent) return;
  projects = response; const select = $('project-select'); const previous = selected || select.value;
  select.replaceChildren(element('option', 'Choose a project'));
  select.firstChild.value = '';
  for (const p of projects) { const option = element('option', p.name); option.value = p.id; select.append(option); }
  if (projects.some(p => p.id === previous)) select.value = previous;
  else if (projects.length === 1) select.value = projects[0].id;
  renderProjectExport();
  if (active && active.project !== select.value) await selectProject(intent, select.value);
  else await loadFiles(intent);
}
function downloadBuffer() {
  if (!active) return;
  const blob = new Blob([active.content], { type: /\.html?$/i.test(active.path) ? 'text/html' : 'text/plain' });
  const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = active.path.split('/').pop(); link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function paletteRows() {
  $('palette-rules').replaceChildren();
  for (const rule of palette) {
    const row = element('div', '', 'palette-row');
    const color = element('input'); color.type = 'color'; color.value = rule.color; color.setAttribute('aria-label', `${rule.label} color`); color.oninput = () => { rule.color = color.value; };
    const label = element('input'); label.value = rule.label; label.maxLength = 100; label.required = true; label.setAttribute('aria-label', 'Rule name'); label.oninput = () => { rule.label = label.value; };
    const action = element('select'); action.setAttribute('aria-label', 'Rule action');
    for (const [value, name] of [['protect', 'No agent changes allowed'], ['prompt', 'Follow custom prompt'], ['reject', 'Reject agent changes']]) { const option = element('option', name); option.value = value; action.append(option); }
    action.value = rule.action; action.onchange = () => { rule.action = action.value; };
    const prompt = element('textarea'); prompt.value = rule.prompt; prompt.rows = 2; prompt.maxLength = 4000; prompt.setAttribute('aria-label', 'Fixed reviewer prompt'); prompt.oninput = () => { rule.prompt = prompt.value; };
    row.append(color, label, action, prompt); $('palette-rules').append(row);
  }
}
for (const button of document.querySelectorAll('[data-close]')) button.onclick = () => button.closest('dialog').close();
$('editor-settings-form').onsubmit = applyEditorSettings;
$('settings-reset').onclick = () => fillEditorSettings(normalizeWorkspacePreferences());
$('editor-settings-dialog').addEventListener('close', () => {
  const target = [settingsReturnFocus, $('menu-view-toggle'), $('workspace-menu').querySelector('summary')].find(node => node?.getClientRects().length);
  target?.focus(); settingsReturnFocus = null;
});
$('word-count-dialog').addEventListener('close', () => {
  wordCount.close();
  const target = [wordCountReturnFocus, $('menu-file-toggle'), $('workspace-menu').querySelector('summary')].find(node => node?.getClientRects().length);
  target?.focus({ preventScroll: true }); wordCountReturnFocus = null;
});
for (const button of document.querySelectorAll('[data-view]')) button.onclick = () => mobileView(button.dataset.view);
$('project-open').onclick = task(async () => {
  if (nativeReview) { const intent = ++navigationIntent; const project = await chooseProject(); if (project && intent === navigationIntent) await loadProjects(project.id, intent); }
  else $('project-dialog').showModal();
});
$('project-form').onsubmit = task(async event => { event.preventDefault(); const intent = ++navigationIntent; const project = await request({ action: 'add_project', root: $('project-root').value }); if (intent !== navigationIntent) return; closeDialogs(); await loadProjects(project.id, intent); });
$('project-select').onchange = task(() => selectProject(++navigationIntent, $('project-select').value));
$('file-new').onclick = task(async () => { const project = currentProject(); if (!project) throw {message:'Choose a project folder first.'}; newFileContext = { project: project.id, ...inventoryRoot(project.id) }; $('new-dialog').showModal(); });
$('file-import-choose').onclick = task(() => fileImport.choose($('file-import-parent').value));
$('file-import-clear').onclick = task(() => fileImport.clear());
$('file-import-submit').onclick = task(() => fileImport.commit());
$('file-import-check').onclick = task(() => fileImport.check());
$('file-import-dismiss').onclick = task(() => fileImport.dismiss());
$('file-import-close').onclick = () => {
  const context = fileImport.current;
  if (context?.busy && context.phase !== 'choosing') return;
  closingImportContext = context; $('file-import-dialog').close();
};
$('file-import-dialog').addEventListener('cancel', event => { event.preventDefault(); $('file-import-close').click(); });
$('file-import-dialog').addEventListener('close', task(async () => {
  const context = closingImportContext || (!$('file-import-dialog').open ? fileImport.current : null); closingImportContext = null;
  if (context) await fileImport.close(context);
}));
for (const button of document.querySelectorAll('[data-command="import-files"]')) if (!nativeReview) { button.disabled = true; button.textContent = 'Import files · desktop only'; button.title = 'File import requires the UnderTree desktop app.'; }
renderProjectExport();
$('new-folder-dialog').addEventListener('close', () => { if (!$('new-folder-dialog').open) newFolderContext = null; });
$('new-folder-form').onsubmit = async event => {
  event.preventDefault();
  const context = newFolderContext;
  if (!context || context.pending) return;
  const showError = message => { $('new-folder-error').textContent = message; $('new-folder-error').hidden = false; };
  if (context.project !== currentProject()?.id) { showError('The project changed. Reopen New folder in the intended project.'); return; }
  if (view?.compositionStarted) { showError('Finish composing text before creating a folder. Your buffer is kept.'); return; }
  const path = $('new-folder-path').value;
  context.pending = true; $('new-folder-submit').disabled = true; $('new-folder-path').disabled = true; $('new-folder-error').hidden = true;
  try {
    if (!sourceRootsEqual(context, inventoryRoot(context.project))) throw { code: 'stale_root', message: 'The project folder changed. Reopen New folder from its refreshed tree.' };
    const result = await request({ action: 'create_directory', project: context.project, path, ...(sourceRoot(context) ? { expectedRoot: sourceRoot(context) } : {}) });
    if (!sourceRootsEqual(result, context)) throw { code: 'stale_root', message: 'The folder creation response belongs to another project folder identity. Refresh its tree.' };
    if (result.project !== context.project || result.path !== path || result.created !== true) throw { message: 'The folder creation could not be confirmed. Refresh the file tree before retrying.' };
    if (currentProject()?.id !== context.project || !sourceRootsEqual(context, inventoryRoot(context.project))) return;
    const parts = path.split('/');
    for (let index = 1; index <= parts.length; index += 1) expandedFolders.add(`${context.project}:${parts.slice(0, index).join('/')}`);
    rememberExpandedFolders();
    if (newFolderContext === context && $('new-folder-dialog').open) $('new-folder-dialog').close();
    try { await loadFiles(); } catch (error) { if (currentProject()?.id === context.project) status(`Folder created. ${error.message || 'Refresh the file tree to see it.'}`, true); }
  } catch (error) {
    if (newFolderContext === context && $('new-folder-dialog').open) showError(error.message || 'The folder could not be created.');
  } finally {
    context.pending = false;
    if (newFolderContext === context) { $('new-folder-submit').disabled = false; $('new-folder-path').disabled = false; }
  }
};
$('new-form').onsubmit = task(async event => {
  event.preventDefault(); const intent = ++navigationIntent; const project = currentProject();
  const context = newFileContext;
  if (!context || context.project !== project?.id || !sourceRootsEqual(context, inventoryRoot(project.id))) throw { code: 'stale_root', message: 'The project folder changed. Reopen New file from its refreshed tree.' };
  const path = $('new-path').value;
  requireSessionCapacity(project.id, $('new-path').value);
  if (sessions.has(keyFor(project.id, $('new-path').value))) throw { message: 'This path has an open buffer. Resolve or close that tab before creating a new source.' };
  const snapshot = await request({ action: 'create', ...context, path });
  assertSourceSnapshot(snapshot, captureSourceBinding({ ...context, path, sourceEpoch: sourceEpoch(snapshot) }));
  if (!navigationCurrent(intent, project.id) || newFileContext !== context || !sourceRootsEqual(context, inventoryRoot(project.id))) return; $('new-dialog').close();
  const session = trackSession(snapshot, project.id);
  await loadFiles(intent); await openSession(session, intent);
});
$('manuscript-save').onclick = task(async () => { closeWorkspaceMenus(); if (active) await saveSession(active); });
$('highlight-selection').onclick = task(async () => {
  closeWorkspaceMenus();
  if (!active || !view) return; const selected = view.state.selection.main;
  if (selected.empty) throw {message:'Select a passage in the source editor first.'};
  selection = { session: active, binding: captureSourceBinding(active), from: selected.from, to: selected.to, quote: view.state.sliceDoc(selected.from, selected.to), version: active.version };
  $('highlight-quote').textContent = selection.quote; $('highlight-dialog-rule').value = $('highlight-rule').value; $('highlight-prompt').value = ''; $('highlight-dialog').showModal();
});
$('highlight-form').onsubmit = task(async event => {
  event.preventDefault(); const selected = selection;
  const session = selected?.session;
  const assertSelected = () => {
    if (session) assertSourceBinding(session, selected.binding);
    if (!session || session !== active || selected.version !== session.version || session.content.slice(selected.from, selected.to) !== selected.quote) throw {message:'The selection changed. Select the passage again.'};
  };
  assertSelected();
  await session.mutate('mark', { from: selected.from, to: selected.to, rule: $('highlight-dialog-rule').value, prompt: $('highlight-prompt').value }, assertSelected);
  if (selection === selected) $('highlight-dialog').close();
  if (active === session) { renderReview(); decorations(); reviewPanel(true); } queueSync(session.project);
});
$('reanchor-form').onsubmit = task(async event => {
  event.preventDefault();
  const selected = reanchorSelection;
  const assertSelected = () => {
    if (selected) assertSourceBinding(selected.session, selected.binding);
    if (!selected || selected.session !== active || selected.version !== selected.session.version || selected.session.content.slice(selected.from, selected.to) !== selected.quote) throw { message: 'The selected passage changed. Select it again before reanchoring.' };
  };
  assertSelected();
  await selected.session.mutate('reanchor', { id: selected.id, from: selected.from, to: selected.to, quote: selected.quote }, assertSelected);
  if (reanchorSelection === selected) { reanchorSelection = null; $('reanchor-dialog').close(); }
  if (active === selected.session) { markSelectedReview(selected.id); renderReview(); decorations(); scheduleReviewPositions(true); }
  queueSync(selected.session.project);
  status('Highlight reanchored.');
});
$('palette-open').onclick = task(async () => { closeWorkspaceMenus(); if (!active) return; paletteSession = active; paletteBinding = captureSourceBinding(active); palette = structuredClone(active.snapshot.review.rules); paletteRows(); $('palette-dialog').showModal(); });
$('rule-add').onclick = () => { if (palette.length >= 24) return; palette.push({ id: crypto.randomUUID(), label: 'Custom instruction', color: '#8295d2', action: 'prompt', prompt: '' }); paletteRows(); };
$('palette-form').onsubmit = task(async event => {
  event.preventDefault(); const session = paletteSession; if (!session || session !== active) throw {message:'The manuscript changed. Open its color rules again.'};
  const rules = palette, binding = paletteBinding;
  await session.mutate('palette', { rules }, () => assertSourceBinding(session, binding));
  if (paletteSession === session && palette === rules) $('palette-dialog').close();
  if (active === session) { renderReview(); decorations(); } queueSync(session.project);
});
$('manuscript-share').onchange = task(async () => {
  if (!active) return;
  const session = active; const binding = captureSourceBinding(session); const enabled = $('manuscript-share').checked; sharingSession = session;
  try {
    if (enabled) { assertSourceBinding(session, binding); await saveSession(session); assertSourceBinding(session, binding); }
    const response = await request({action:'share',project:binding.project,path:binding.path,enabled,...(enabled ? binding : {})});
    if (enabled) { assertSourceBinding(session, binding); if (!sourceRootsEqual(response, binding)) throw { code: 'stale_root', message: 'The sharing response belongs to another project folder identity.' }; if (sourceEpoch(response) !== binding.sourceEpoch) throw { code: 'stale_document', message: 'The sharing response belongs to another source identity.' }; }
    if (typeof response.shared !== 'boolean' || response.shared !== enabled || (enabled && response.documentId !== session.snapshot.documentId)) throw { message: 'The sharing change could not be confirmed. Refresh Connections to check native access.' };
    if (session.project === binding.project && session.path === binding.path && session.sourceEpoch === binding.sourceEpoch && sourceRootsEqual(session, binding) && sessions.get(keyFor(session.project,session.path)) === session && session.snapshot.shared !== response.shared) session.snapshot = { ...session.snapshot, shared: response.shared };
    void connections.refresh().catch(() => {});
  }
  finally { sharingSession = null; renderReview(); }
});
$('review-refresh').onclick = task(async () => {
  const session = active; if (!session) return;
  const problem = session.reviewProblem;
  let refreshed;
  try { refreshed = await session.refresh({ retryProblem: true, isCurrent: () => active === session && !windowClosing && !view?.compositionStarted && sessions.get(keyFor(session.project,session.path)) === session }); }
  catch (error) { if (active === session) throw error; return; }
  if (active !== session) return;
  renderReview(); decorations(); $('save-label').textContent = saveLabel(session);
  if (problem && refreshed && !session.reviewProblem) status(session.conflict ? 'Review data restored. Resolve the source change before saving.' : session.dirty ? 'Review data restored. Your unsaved draft is kept; Save when ready.' : 'Review data restored.');
});
$('export-buffer').onclick = downloadBuffer;
$('export-manuscript').onclick = () => { closeWorkspaceMenus(); downloadBuffer(); };
$('typst-compile').onclick = task(() => compileSession(active,true));
$('tex-import').onclick = task(async () => {
  closeWorkspaceMenus();
  if (!active?.path.endsWith('.tex')) return;
  const importing = active; const binding = captureSourceBinding(importing); assertSourceBinding(importing, binding); const intent = ++navigationIntent;
  const project=importing.project; const target=importing.path.replace(/\.tex$/,'.typ');
  requireSessionCapacity(project, target);
  await saveSession(importing);
  assertSourceBinding(importing, binding);
  const result=await request({action:'import_tex',...binding,target});
  assertSourceBinding(importing, binding);
  assertSourceSnapshot(result.snapshot, captureSourceBinding({ ...binding, path: target, sourceEpoch: sourceEpoch(result.snapshot) }));
  if (!navigationCurrent(intent, project)) return;
  const session=trackSession(result.snapshot,project);
  await loadFiles(intent);await openSession(session, intent);
  status(`Imported to ${target}. ${result.warnings.length} formatting notice(s); see ${target}.import-report.json. The .tex original was kept.`);
});
$('export-pdf').onclick = () => {
  if (!pdfBytes || !pdfPath) return;
  const url = URL.createObjectURL(new Blob([pdfBytes],{type:'application/pdf'})); const a=element('a'); a.href=url; a.download=pdfPath.split('/').pop().replace(/\.typ$/,'.pdf'); a.click(); setTimeout(()=>URL.revokeObjectURL(url),1000);
};
$('reload-buffer').onclick = task(async () => {
  if (!active) return;
  requireNavigationReady();
  const session = active; const binding = captureSourceBinding(session); const problem = session.identityProblem; const intent = ++navigationIntent; const version = session.version;
  if (session.uncertainMutation || session.unresolvedMove || (problem && !['stale_document', 'stale_root'].includes(problem.code))) throw { message: 'Resolve the uncertain source location or operation before loading a disk version. Your draft is kept.' };
  let target = binding;
  if (problem) {
    const observed = await request({action:'review',project:binding.project,path:binding.path});
    if (!navigationCurrent(intent, binding.project) || active !== session || session.version !== version || session.identityProblem !== problem || session.project !== binding.project || session.path !== binding.path || session.sourceEpoch !== binding.sourceEpoch || !sourceRootsEqual(session, binding)) throw { message: 'Your editor changed while observing the disk identity. Your draft is kept; choose Load disk version again deliberately.' };
    requireNavigationReady();
    target = captureSourceBinding({ ...observed, project: binding.project, path: binding.path }); assertSourceSnapshot(observed, target);
  }
  else assertSourceBinding(session, binding);
  const snapshot = await request({action:'open',...target});
  assertSourceSnapshot(snapshot, target);
  if (session.project !== binding.project || session.path !== binding.path || session.sourceEpoch !== binding.sourceEpoch || !sourceRootsEqual(session, binding) || session.identityProblem !== problem) throw { message: 'The editor identity changed while loading. Your buffer is kept.' };
  if (!navigationCurrent(intent, session.project) || active !== session) return;
  requireNavigationReady();
  if (session.version !== version) throw { message: 'Your buffer changed while the disk version was loading. Your edits are kept; choose Load disk version again to discard them.' };
  clearTimeout(saveTimers.get(session)); saveTimers.delete(session);
  const cleanup = detachEditor(false); renderReview(); await cleanup?.destroy();
  if (!navigationCurrent(intent, session.project)) return;
  const replacement = trackSession(snapshot,session.project,true);
  await openSession(replacement, intent);
});
const connections = setupConnectionManager({
  request, controlRequest, status,
  onRevoked: share => {
    sharedManuscripts = share ? sharedManuscripts.filter(existing => existing.documentId !== share.documentId) : [];
    for (const session of sessions.values()) if ((!share || (session.project === share.project && session.path === share.path)) && session.snapshot.shared) session.snapshot = { ...session.snapshot, shared: false };
    renderReview();
  },
  onShares: shares => {
    sharedManuscripts = shares;
    for (const session of sessions.values()) {
      const shared = shares.some(s => s.project === session.project && s.path === session.path && sourceEpoch(s) === session.sourceEpoch && sourceRootsEqual(s, session) && !session.identityProblem);
      if (session.snapshot.shared !== shared) session.snapshot = { ...session.snapshot, shared };
    }
    if (!sharingSession) $('manuscript-share').checked = Boolean(active?.snapshot.shared);
  },
});
$('git-open').onclick = task(async () => { const project = currentProject(); if (!project) throw {message:'Choose a project first.'}; githubProject = project; $('github-repository').value = project.repository; $('github-auto').checked = project.autoSync; try { const result = await request({action:'git_status',project:project.id}); $('github-status').textContent = `Branch: ${result.branch}\n${result.status || 'Working tree clean'}`; } catch { $('github-status').textContent = 'Connect this local folder to an existing GitHub repository.'; } if (currentProject()?.id === project.id) $('git-dialog').showModal(); });
$('git-form').onsubmit = task(async event => { event.preventDefault(); const project = githubProject; if (!project) return; const intent = ++navigationIntent; await request({action:'bind_github',project:project.id,repository:$('github-repository').value,auto_sync:$('github-auto').checked}); pausedSync.delete(project.id); await loadProjects(project.id, intent); status('GitHub repository connected.'); });
$('github-sync-now').onclick = task(async () => { const project = githubProject; if (!project) return; const session = active; if ([...sessions.values()].some(input => input.project === project.id && input.identityProblem)) throw { message: 'Resolve the source identity before syncing this project.' }; if (session?.project === project.id) await saveSession(session); const result = await request({action:'sync',project:project.id}); pausedSync.delete(project.id); status(result.message); $('github-status').textContent = result.message; });
document.addEventListener('keydown', task(async event => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); if (active) await saveSession(active); }
  if (event.key === 'F5' || ((event.ctrlKey || event.metaKey) && event.key === 'Enter')) { event.preventDefault(); await compileSession(active, true); }
  if (event.key === 'Escape') closeWorkspaceMenus(true);
}));

$('review-toggle').onclick = () => reviewPanel(workspace.dataset.reviewOpen !== 'true');
$('review-new-cue').onclick = () => {
  const id = reviewActivity.get(active)?.unseen.values().next().value;
  if (!id) return;
  reviewPanel(true); markSelectedReview(id); acknowledgeReview(id); revealReviewId = id; scheduleReviewPositions();
};
$('review-list').addEventListener('scroll', () => { if (active) active.reviewScroll = $('review-list').scrollTop; }, { passive: true });
$('review-close').onclick = () => reviewPanel(false);
$('review-previous').onclick = () => navigateReview(-1); $('review-next').onclick = () => navigateReview(1);
$('rail-files').onclick = () => treeMode(false); $('rail-outline').onclick = () => treeMode(true);
$('outline-toggle').onclick = () => {
  const collapsed = $('outline-panel').dataset.collapsed !== 'true';
  $('outline-panel').dataset.collapsed = String(collapsed); $('outline-toggle').setAttribute('aria-expanded', String(!collapsed)); $('manuscript-outline').hidden = collapsed;
  rememberWorkspace();
};
$('rail-editor').onclick = () => showPane('editor'); $('rail-preview').onclick = () => showPane('preview');
$('files-collapse').onclick = () => { workspace.dataset.filesCollapsed = 'true'; rememberWorkspace(); };
$('editor-collapse').onclick = () => { workspace.dataset.editorCollapsed = 'true'; workspace.dataset.previewCollapsed = 'false'; mobileView('preview'); rememberWorkspace(); };
$('preview-collapse').onclick = () => { workspace.dataset.previewCollapsed = 'true'; workspace.dataset.editorCollapsed = 'false'; mobileView('editor'); rememberWorkspace(); };
$('editor-search').onclick = () => { if (view) { showPane('editor'); openSearchPanel(view); } };
$('pdf-previous').onclick = () => pdfViewer.go(pdfViewer.page - 1); $('pdf-next').onclick = () => pdfViewer.go(pdfViewer.page + 1);
$('pdf-page-number').onchange = () => { pdfViewer.go(Number($('pdf-page-number').value)); $('pdf-page-number').value = String(pdfViewer.page); };
$('pdf-page-number').onblur = () => { $('pdf-page-number').value = String(pdfViewer.page); };
$('pdf-zoom-out').onclick = () => pdfViewer.zoom(.8); $('pdf-zoom-in').onclick = () => pdfViewer.zoom(1.25); $('pdf-fit-width').onclick = () => pdfViewer.fit();
$('compile-log-toggle').onclick = () => {
  setCompileLogs(!showingLogs);
};
for (const button of document.querySelectorAll('[data-command]')) button.onclick = task(async () => {
  const command = button.dataset.command; closeWorkspaceMenus();
  const triggers = { 'open-project': 'project-open', 'new-file': 'file-new', github: 'git-open', connections: 'connection-open', download: 'export-manuscript', save: 'manuscript-save', highlight: 'highlight-selection', palette: 'palette-open', import: 'tex-import', logs: 'compile-log-toggle' };
  if (triggers[command]) $(triggers[command]).click();
  else if (command === 'new-folder') openNewFolder();
  else if (command === 'import-files') openFileImport();
  else if (command === 'move-source') openFileMove(button);
  else if (command === 'download-project') await downloadSavedProject();
  else if (command === 'check-project-download') await projectExport.check();
  else if (command === 'inspect-project-download') await projectExport.dismiss();
  else if (command === 'refresh-files') await loadFiles();
  else if (['files', 'editor', 'preview'].includes(command)) showPane(command);
  else if (command === 'outline') treeMode(true);
  else if (command === 'review') reviewPanel(true);
  else if (command === 'word-wrap') { workspacePreferences.wordWrap = !workspacePreferences.wordWrap; applyEditorPreferences(); rememberWorkspace(); }
  else if (command === 'editor-settings') openEditorSettings(button);
  else if (command === 'word-count') openWordCount(button);
  else if (command === 'history') {
    if (!nativeReview) throw { code: 'desktop_required', message: 'Saved History requires the UnderTree desktop app.' };
    if (!active || !view || !sourceRoot(active) || active.identityProblem || windowClosing) throw { message: 'Open an editor with a verified project folder before browsing History.' };
    if (view.compositionStarted) throw { message: 'Finish the current text composition before opening History.' };
    await historyPanel.open();
  }
  else if (command === 'text-larger' || command === 'text-smaller') { workspacePreferences.editorFontSize = Math.max(10, Math.min(28, workspacePreferences.editorFontSize + (command === 'text-larger' ? 1 : -1))); applyEditorPreferences(); rememberWorkspace(); }
  else if (command === 'reset-workspace') { workspacePreferences = normalizeWorkspacePreferences(); restoreWorkspacePreferences(); mobileView('editor'); rememberWorkspace(); }
  else if (command === 'help') $('help-dialog').showModal();
  else if (command === 'set-main-document') await setMainDocument(active.path);
  else if (command === 'clear-main-document') await setMainDocument('');
  else if (insertionCommands.has(command) || ['bold','italic','heading','bullet-list','numbered-list'].includes(command)) formatSource(command);
  else if (view) { showPane('editor'); ({ undo, redo, 'select-all': selectAll, find: openSearchPanel })[command]?.(view); if (command !== 'find') view.focus(); }
});
const menuNavigation = setupMenuNavigation(workspaceMenus, {
  isComposing: () => !!view?.compositionStarted,
  isClosing: () => windowClosing,
});

function resizeFiles(width, persist = true) {
  if (getComputedStyle(workspace).display !== 'grid') return;
  const fixed = [...workspace.querySelectorAll('.navigation-rail,.manuscript-review,.pane-splitter')].reduce((sum, node) => sum + node.getBoundingClientRect().width, 0);
  const next = clampPaneWidth(Math.min(1200, width), workspace.clientWidth, 150, 400, fixed);
  workspace.style.setProperty('--files-size', `${next}px`);
  $('files-splitter').setAttribute('aria-valuenow', String(Math.round(next)));
  $('files-splitter').setAttribute('aria-valuemax', String(Math.round(clampPaneWidth(1200, workspace.clientWidth, 150, 400, fixed))));
  if (persist) { workspacePreferences.filesWidth = next; writeWorkspacePreferences(workspacePreferences); }
}
function resetFilesWidth(persist = true) {
  workspace.style.removeProperty('--files-size');
  $('files-splitter').setAttribute('aria-valuenow', String(Math.round(document.querySelector('.manuscript-files').getBoundingClientRect().width)));
  if (persist) { workspacePreferences.filesWidth = null; rememberWorkspace(); }
}
function resizePreview(fraction, persist = true) {
  const next = Math.max(.2, Math.min(.8, fraction));
  workspace.style.setProperty('--editor-size', `${next}fr`); workspace.style.setProperty('--preview-size', `${1 - next}fr`);
  $('preview-splitter').setAttribute('aria-valuenow', String(Math.round(next * 100)));
  if (persist) { workspacePreferences.editorFraction = next; rememberWorkspace(); }
}
for (const id of ['files-splitter', 'preview-splitter']) {
  const splitter = $(id);
  splitter.onpointerdown = event => {
    if (event.button !== 0) return; event.preventDefault(); splitter.setPointerCapture(event.pointerId);
    const move = event => {
      if (id === 'files-splitter') resizeFiles(event.clientX - workspace.getBoundingClientRect().left - 40);
      else {
        const editor = document.querySelector('.manuscript-editor').getBoundingClientRect();
        const preview = document.querySelector('.manuscript-preview').getBoundingClientRect();
        const review = workspace.dataset.reviewOpen === 'true' ? document.querySelector('.manuscript-review').getBoundingClientRect().width : 0;
        resizePreview((event.clientX - editor.left - review) / (preview.right - editor.left - review));
      }
    };
    const finish = () => { splitter.removeEventListener('pointermove', move); splitter.removeEventListener('pointerup', finish); splitter.removeEventListener('lostpointercapture', finish); };
    splitter.addEventListener('pointermove', move); splitter.addEventListener('pointerup', finish); splitter.addEventListener('lostpointercapture', finish);
  };
  splitter.onkeydown = event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home'].includes(event.key)) return; event.preventDefault();
    const direction = event.key === 'ArrowLeft' ? -1 : 1;
    if (id === 'files-splitter') {
      if (event.key === 'Home') resetFilesWidth();
      else resizeFiles(document.querySelector('.manuscript-files').getBoundingClientRect().width + direction * 20);
    }
    else resizePreview(event.key === 'Home' ? .5 : Number(splitter.getAttribute('aria-valuenow')) / 100 + direction * .05);
  };
  splitter.ondblclick = () => id === 'files-splitter' ? resetFilesWidth() : resizePreview(.5);
}
const workspaceGeometry = new ResizeObserver(() => {
  const { width, height } = workspace.getBoundingClientRect();
  workspace.style.setProperty('--chrome-gap', `${Math.max(4, Math.min(9, width / 180, height / 70))}px`);
  workspace.style.setProperty('--chrome-font-scale', String(Math.max(.9, Math.min(1, width / 700, height / 450))));
  if (getComputedStyle(workspace).display === 'grid') {
    if (workspacePreferences.filesWidth !== null) resizeFiles(workspacePreferences.filesWidth, false);
    else if (workspace.dataset.filesCollapsed !== 'true') $('files-splitter').setAttribute('aria-valuenow', String(Math.round(document.querySelector('.manuscript-files').getBoundingClientRect().width)));
  }
});
workspaceGeometry.observe(workspace);
workspaceGeometry.observe(document.querySelector('.manuscript-review'));
window.addEventListener('beforeunload', event => { if (fileMove?.pendingCount || [...sessions.values()].some(s => s.dirty || s.conflict || s.pending || s.uncertainMutation || s.unresolvedMove || (s.identityProblem && !localNoSaveClose(s)))) { event.preventDefault(); event.returnValue = ''; } });
restoreWorkspacePreferences();
windowChrome = await setupWindowChrome({
  status,
  onClosing: setWindowClosing,
  canClose: () => !controlContext().pending && ![...sessions.values()].some(session => session.dirty || session.conflict || session.pending || session.uncertainMutation || session.unresolvedMove || (session.identityProblem && !localNoSaveClose(session))),
  beforeClose: async () => {
    if (controlContext().pending) throw { message: 'Finish pending local operations before closing UnderTree.' };
    for (const session of sessions.values()) {
      if (session.uncertainMutation || session.unresolvedMove) throw { message: 'Resolve the uncertain local operation before closing UnderTree. Your buffer is kept.' };
      if (!localNoSaveClose(session)) await saveSession(session);
    }
  },
});
observeReviewText(document.body);
for (const button of document.querySelectorAll('[data-command="history"]')) button.disabled = !nativeReview;
for (const hint of document.querySelectorAll('.history-desktop-help')) hint.hidden = nativeReview;
editorBridge.start();
window.addEventListener('pagehide', () => { historyPanel.back(); wordCount.close(); appControls?.stop(); editorBridge.stop(); for (const session of sessions.values()) void editorBridge.unwatch(session); });
window.addEventListener('pageshow', event => { if (event.persisted) { for (const session of sessions.values()) editorBridge.watch(session); editorBridge.start(); appControls?.start(); } });
await task(async () => { await loadProjects(); renderReview(); await connections.refresh(); })();
if (fileMove) await fileMove.discover();
appControls = new McpControlBridge({
  request: controlRequest, snapshot: controlWorkspaceSnapshot, effects: controlEffects,
  onError: (error, command) => { if (command?.kind === 'set_window_state' && command.state === 'close') pendingRemoteClose = null; },
  onRevoked: () => { pendingRemoteClose = null; },
  onAcknowledgementFailed: command => { if (command.kind === 'set_window_state' && command.state === 'close') pendingRemoteClose = null; },
  afterAcknowledged: async command => {
    if (command.kind !== 'set_window_state' || command.state !== 'close' || !pendingRemoteClose) return;
    const prepared = pendingRemoteClose; pendingRemoteClose = null;
    await windowChrome.closeWithoutSave(() => prepared.assert(true));
  },
});
appControls.start();
setInterval(async () => {
  if (document.hidden || refreshing || !active || active.dirty || active.conflict || active.reviewProblem || active.identityProblem) return;
  refreshing = true;
  const session = active;
  try {
    const before = JSON.stringify(session.snapshot.review);
    await session.refresh();
    if (active === session && (before !== JSON.stringify(session.snapshot.review) || session.conflict)) { renderReview(); decorations(); queueSync(session.project); }
    if (session.conflict && active?.project === session.project && publicationPath(active)) pdfStatus('Project input conflict · last good PDF retained');
  } catch (error) { if (active === session) { if (session.identityProblem) { clearTimeout(saveTimers.get(session)); saveTimers.delete(session); compileScheduler.cancel(); renderReview(); pdfStatus('Source identity changed · last good PDF retained'); } status(error.message, true); } }
  finally { refreshing = false; }
}, 2000);
