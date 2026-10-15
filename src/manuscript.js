import './manuscript.css';
import { basicSetup } from 'codemirror';
import { EditorView, Decoration, highlightSpecialChars } from '@codemirror/view';
import { EditorState, StateEffect, StateField, Compartment, Transaction } from '@codemirror/state';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';
import { ReviewSession } from '../modules/frontend/review-session.js';
import { reviewRequest as request, chooseProject, nativeReview } from '../modules/frontend/review-api.js';
import { observeReviewText } from '../modules/frontend/review-text-layout.js';
import { setupWindowChrome } from '../modules/frontend/window-chrome.js';
import { setupConnectionManager } from './connection-manager.js';
import { LatestCompileScheduler } from '../modules/frontend/latest-compile-scheduler.js';
import { manuscriptTree, clampPaneWidth } from '../modules/frontend/manuscript-workspace.js';
import { ManuscriptPdfViewer } from '../modules/frontend/manuscript-pdf-viewer.js';
import { positionReviewCards, acceptedTextChange } from '../modules/frontend/review-position.js';
import { sourceFormat } from '../modules/frontend/source-format.js';
import { undo, redo, selectAll } from '@codemirror/commands';
import { openSearchPanel } from '@codemirror/search';
import * as pdfjs from 'pdfjs-dist';
import pdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
pdfjs.GlobalWorkerOptions.workerSrc = pdfWorker;

const $ = id => document.getElementById(id);
const sessions = new Map();
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
let githubProject = null;
const syncTimers = new Map();
const pausedSync = new Set();
let compiling = false;
const explicitCompiles = [];
let pdfLoadingTask = null;
let pdfBytes = null;
let pdfGeneration = 0;
let navigationIntent = 0;
let fileInventoryGeneration = 0;
let windowClosing = false;
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
    $('pdf-page-number').value = String(page); $('pdf-page-number').max = String(total);
    $('pdf-page-count').textContent = `of ${total}`; $('pdf-zoom-label').textContent = `${Math.round(scale * 100)}%`;
    $('pdf-fit-width').setAttribute('aria-pressed', String(fit));
    $('pdf-previous').disabled = page <= 1; $('pdf-next').disabled = page >= total;
  },
});
const windowEditing = new Compartment();
const compileScheduler = new LatestCompileScheduler({delayMs:700,isBusy:()=>compiling,run:async key=>{
  const session = sessions.get(key);
  if (session && session === active) { try { await compileSession(session); } catch (error) { status(error.message,true); } }
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
function pdfStatus(message, state = 'stale') {
  const node = $('typst-preview-status'); node.textContent = message; node.dataset.state = state;
  node.classList.toggle('sr-only', state === 'current');
}
function windowEditorAccess() { return [EditorState.readOnly.of(windowClosing), EditorView.editable.of(!windowClosing)]; }
function setWindowClosing(busy) {
  if (busy && view?.compositionStarted) throw new Error('Finish the current text composition before closing the window.');
  if (busy) windowFocus = document.activeElement;
  windowClosing = busy;
  for (const region of document.querySelectorAll('.review-topbar,.review-workspace,.mobile-views,dialog')) region.inert = busy;
  if (view) view.dispatch({ effects: windowEditing.reconfigure(windowEditorAccess()) });
  if (!busy) { if (windowFocus?.isConnected) windowFocus.focus(); windowFocus = null; }
}
function task(callback) { return async event => { try { await callback(event); } catch (error) { status(error.message || String(error), true); } }; }
function closeDialogs() { for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close(); }
function closeWorkspaceMenus(restoreFocus = false) {
  for (const menu of workspaceMenus) if (menu.open) { menu.open = false; if (restoreFocus) menu.querySelector('summary').focus(); }
}
function formatSource(command) {
  if (!view || !active) return;
  if (view.compositionStarted) throw { message: 'Finish the current text composition before formatting the source.' };
  if (view.state.selection.ranges.length !== 1) throw { message: 'Use a single selection for this source formatting command.' };
  const extension = active.path.split('.').pop().toLowerCase();
  const selection = view.state.selection.main;
  const spec = sourceFormat(view.state.doc.toString(), { from: selection.from, to: selection.to }, command, extension);
  showPane('editor'); view.dispatch({ ...spec, userEvent: 'input.format' }); view.focus();
}
function mobileView(name) {
  document.querySelector('.review-workspace').dataset.mobileView = name;
  for (const button of document.querySelectorAll('[data-view]')) button.setAttribute('aria-pressed', String(button.dataset.view === name));
}
function reviewPanel(open) {
  workspace.dataset.reviewOpen = String(open);
  $('review-toggle').setAttribute('aria-pressed', String(open));
  if (open && innerWidth <= 900) mobileView('review');
  else if (!open && workspace.dataset.mobileView === 'review') mobileView('editor');
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
  reanchorSelection = { session: active, version: active.version, id: marker.id, from: range.from, to: range.to, quote: view.state.sliceDoc(range.from, range.to) };
  $('reanchor-old').textContent = marker.anchor.quote; $('reanchor-new').textContent = reanchorSelection.quote;
  $('reanchor-rule').textContent = `Keep the existing “${active.snapshot.review.rules.find(rule => rule.id === marker.rule)?.label || 'Highlight'}” rule and passage prompt.`;
  $('reanchor-dialog').showModal();
}
function showPane(name) {
  workspace.dataset[`${name === 'files' ? 'files' : name}Collapsed`] = 'false';
  mobileView(name);
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
function sessionNavigationCurrent(intent, session) {
  return navigationCurrent(intent, session.project) && sessions.get(keyFor(session.project, session.path)) === session;
}
function requireNavigationReady() {
  if (!view?.compositionStarted) return;
  if (active) $('project-select').value = active.project;
  throw {message:'Finish the current text composition before switching or closing manuscripts.'};
}
function detachEditor(preserve = true) {
  requireNavigationReady();
  const editor = view; const session = active; const cleanup = pdfLoadingTask;
  view = null; active = null; pdfLoadingTask = null; pdfBytes = null; pdfGeneration += 1;
  if (preserve && editor && session) {
    session.editorState = editor.state; session.editorScroll = { top: editor.scrollDOM.scrollTop, left: editor.scrollDOM.scrollLeft }; session.reviewScroll = $('review-list').scrollTop;
  }
  clearTimeout(previewTimer); editor?.destroy(); pdfViewer.clear(); $('manuscript-source').replaceChildren();
  return cleanup;
}
async function selectProject(intent, project) {
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
function queueSync(project) {
  if (!projects.find(p => p.id === project)?.autoSync || pausedSync.has(project)) return;
  clearTimeout(syncTimers.get(project));
  syncTimers.set(project, setTimeout(async () => {
    try { const result = await request({ action: 'sync', project }); status(result.message); }
    catch (error) { pausedSync.add(project); status(`Automatic GitHub sync paused: ${error.message}`, true); }
  }, 4000));
}
async function saveSession(session) {
  clearTimeout(saveTimers.get(session)); saveTimers.delete(session);
  let snapshot;
  try { snapshot = await session.flush(); }
  catch (error) { if(active === session) renderReview(); throw error; }
  if (active === session) { renderReview(); renderTabs(); $('save-label').textContent = session.dirty ? 'Unsaved changes' : 'Saved locally'; }
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
  if (active?.path.endsWith('.typ')) return;
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
function publicationCurrent(result, session) {
  return result.current === true && !session.dirty && !session.conflict
    && result.revision === session.snapshot.review.revision;
}
async function showPdf(result, session) {
  if (session !== active || !result.available) return;
  const generation = ++pdfGeneration;
  const bytes = Uint8Array.from(atob(result.base64),c=>c.charCodeAt(0));
  const loadingTask = pdfjs.getDocument({data:bytes.slice(),isEvalSupported:false,useSystemFonts:true});
  const pdf = await loadingTask.promise;
  if (generation !== pdfGeneration || session !== active) { await loadingTask.destroy(); return; }
  await pdfLoadingTask?.destroy();
  if (generation !== pdfGeneration || session !== active) { await loadingTask.destroy(); return; }
  pdfViewer.clear(); pdfLoadingTask = loadingTask; pdfBytes = bytes;
  $('pdf-toolbar').hidden = showingLogs;
  await pdfViewer.setDocument(pdf);
  if (generation !== pdfGeneration || session !== active || pdfLoadingTask !== loadingTask) return;
  const current = publicationCurrent(result, session);
  pdfStatus(`${current ? 'Current PDF' : 'Last good PDF · source changed'} · ${pdf.numPages} page${pdf.numPages===1?'':'s'}`, current ? 'current' : 'stale');
  $('export-pdf').hidden = false;
}
async function compileSession(session, explicit = false) {
  if (!session || !session.path.endsWith('.typ')) return;
  if (compiling) {
    if (explicit) {
      if (explicitCompiles.length >= 8) throw {message:'The compilation queue is full. Wait for a build to finish, then retry.'};
      explicitCompiles.push(session); status('Compilation queued. You can keep editing.');
    } else compileScheduler.request(keyFor(session.project,session.path));
    return;
  }
  compiling = true; $('typst-compile').textContent = 'Compiling…';
  $('compile-log').textContent = `Compiling ${session.path} with Typst…`;
  try {
    const snapshot = await saveSession(session);
    const result = await request({action:'compile',project:session.project,path:session.path,revision:snapshot.review.revision});
    await showPdf(result,session);
    $('compile-log').textContent = `Compiled ${session.path} successfully.\n${publicationCurrent(result, session) ? 'PDF matches the saved source.' : 'Newer source changes remain in the editor.'}`;
    status(publicationCurrent(result, session) ? 'Typst PDF compiled locally.' : 'Compiled preview retained; newer source still needs compilation.');
  } catch (error) {
    if (session === active) pdfStatus(`Compilation failed${pdfBytes ? ' · last good PDF retained' : ''}. Open the compilation log for details.`, 'error');
    $('compile-log').textContent = error.message || String(error); status(error.message, true); throw error;
  } finally {
    compiling=false; $('typst-compile').textContent = 'Recompile';
    if (explicitCompiles.length) void task(() => compileSession(explicitCompiles.shift(),true))();
    else compileScheduler.release();
  }
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
      await saveSession(session);
      if (session.dirty || session.conflict) throw { message: 'The manuscript changed while saving. Save it before closing this tab.' };
      if (sessions.get(keyFor(session.project,session.path)) !== session) return;
      if (active === session) requireNavigationReady();
      sessions.delete(keyFor(session.project,session.path));
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
  const list = $('review-list');
  restoreReviewScroll = renderedReviewSession === active ? list.scrollTop : active?.reviewScroll || 0;
  const historyOpen = list.querySelector('details')?.open || false;
  const focused = list.contains(document.activeElement) ? { id: document.activeElement.closest('[data-review-id]')?.dataset.reviewId, label: document.activeElement.textContent } : null;
  for (const card of reviewCardsObserved) reviewGeometry.unobserve(card);
  reviewCardsObserved.clear(); list.replaceChildren(); renderedReviewSession = active;
  reviewCue();
  $('manuscript-share').disabled = !active || !/\.(html?|typ)$/i.test(active.path);
  if (sharingSession !== active) $('manuscript-share').checked = Boolean(active?.snapshot.shared);
  $('review-conflict').hidden = !active?.conflict;
  for (const id of ['manuscript-save','highlight-selection','palette-open','export-manuscript','highlight-rule']) $(id).disabled = !active;
  for (const button of document.querySelectorAll('[data-command]')) {
    const command = button.dataset.command;
    if (['save','download','undo','redo','find','select-all','highlight','palette','bold','italic','heading','bullet-list','numbered-list'].includes(command)) button.disabled = !active || (['bold','italic','heading','bullet-list','numbered-list'].includes(command) && !/\.(typ|html?)$/i.test(active.path));
    if (command === 'import') button.hidden = !active?.path.endsWith('.tex');
  }
  const noReviewPassages = !reviewAnchors().length;
  $('review-previous').disabled = noReviewPassages; $('review-next').disabled = noReviewPassages;
  if (!active) { $('typst-compile').hidden = true; $('pdf-toolbar').hidden = true; $('export-pdf').hidden = true; list.append(element('p', 'Select text in the editor to add a highlight or reviewer instruction.', 'review-empty')); return; }
  const review = active.snapshot.review;
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
    if (rule?.prompt || marker.prompt) card.append(element('p', [rule?.prompt, marker.prompt].filter(Boolean).join(' '), 'rationale'));
    if (marker.anchor.stale) card.append(element('p', 'Stale highlight. Select the current passage and reanchor this highlight, or remove it. Stale protection blocks agent suggestions.', 'stale-note'));
    const actions = element('div', '', 'card-actions');
    const locate = actionButton('Locate', () => locateReview(marker.id, marker.anchor)); locate.disabled = marker.anchor.stale;
    actions.append(locate, actionButton('Remove highlight', async () => { const session = active; await session.mutate('unmark', { id: marker.id }); if (active === session) { renderReview(); decorations(); } queueSync(session.project); }));
    if (marker.anchor.stale) actions.prepend(actionButton('Reanchor from selection', () => beginReanchor(marker)));
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
        if (decision === 'accepted' && session.path.endsWith('.typ')) {
          pdfStatus('Source changed · last good PDF retained');
          compileScheduler.request(keyFor(session.project, session.path));
        }
      }
      queueSync(session.project);
    };
    const accept = actionButton('Accept', () => decide('accepted'), 'accept-suggestion'); accept.disabled = suggestion.anchor.stale || Boolean(active.conflict);
    const locate = actionButton('Locate', () => locateReview(suggestion.id, suggestion.anchor)); locate.disabled = suggestion.anchor.stale;
    actions.append(accept, actionButton('Reject', () => decide('rejected'), 'reject-suggestion'), locate); card.append(actions); passages.append(card);
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
  if (!sessionNavigationCurrent(intent, session)) return;
  if (active === session && view) return;
  const previous = active;
  if (previous?.dirty) await saveSession(previous);
  if (!sessionNavigationCurrent(intent, session)) return;
  const cleanup = detachEditor(); renderTabs(); renderReview();
  await cleanup?.destroy();
  if (!sessionNavigationCurrent(intent, session)) return;
  active = session;
  selectedReviewId = session.reviewSelectedId || null;
  // Literal carriage returns stay in the document so review UTF-16 positions match the saved source.
  const extensions = [EditorState.lineSeparator.of('\n'), highlightSpecialChars({ render: code => {
    if (code !== 13) return null;
    const carriage = element('span', '', 'cm-preserved-cr'); carriage.setAttribute('aria-hidden', 'true'); return carriage;
  } }), basicSetup, EditorView.lineWrapping, reviewField, windowEditing.of(windowEditorAccess()), EditorView.updateListener.of(update => {
    if (update.selectionSet && !session.dirty && !update.docChanged && !update.view.compositionStarted && active === session) {
      const range = update.state.selection.main;
      const candidates = reviewAnchors().filter(item => range.from < item.anchor.to && range.to >= item.anchor.from);
      const item = candidates.find(item => item.id === selectedReviewId) || candidates[0];
      if (item) { markSelectedReview(item.id); scheduleReviewPositions(true); }
    }
    if (!update.docChanged || update.transactions.some(t => t.annotation(authoritative))) return;
    session.edit(update.state.doc.toString());
    if (active === session) { $('save-label').textContent = 'Unsaved changes'; renderTabs(); }
    clearTimeout(saveTimers.get(session));
    saveTimers.set(session, setTimeout(() => { saveTimers.delete(session); void task(() => saveSession(session))(); }, 450));
    clearTimeout(previewTimer); previewTimer = setTimeout(() => { preview(); renderOutline(); }, 250);
    if (session.path.endsWith('.typ')) { pdfStatus('Source changed · last good PDF retained'); compileScheduler.request(keyFor(session.project,session.path)); }
  })];
  if (/\.html?$/i.test(session.path)) extensions.push(html());
  else if (/\.css$/i.test(session.path)) extensions.push(css());
  let editorState = session.editorState;
  if (editorState && editorState.doc.toString() !== session.content) editorState = editorState.update({changes:{from:0,to:editorState.doc.length,insert:session.content},annotations:authoritative.of(true)}).state;
  view = new EditorView({ state: editorState || EditorState.create({ doc: session.content, extensions }), parent: $('manuscript-source') });
  view.scrollDOM.addEventListener('scroll', () => scheduleReviewPositions(true), { passive: true });
  if (session.editorScroll) requestAnimationFrame(() => { if (active === session && view) { view.scrollDOM.scrollTop = session.editorScroll.top; view.scrollDOM.scrollLeft = session.editorScroll.left; } });
  renderTabs(); renderReview(); decorations(); preview(); renderOutline(); showPane('editor');
  const typst = session.path.endsWith('.typ');
  $('typst-compile').hidden = !typst; $('tex-import').hidden = !session.path.endsWith('.tex');
  $('manuscript-preview').hidden = typst || showingLogs; $('typst-preview').hidden = !typst || showingLogs; $('export-pdf').hidden = true; $('pdf-toolbar').hidden = true; $('typst-preview-status').hidden = !typst;
  if (typst) {
    $('typst-pages').replaceChildren(); pdfStatus('Compile this Typst manuscript to see its PDF.', 'empty');
    const result=await request({action:'pdf',project:session.project,path:session.path});
    if (!navigationCurrent(intent, session.project)) return;
    await showPdf(result,session);
    if (!navigationCurrent(intent, session.project)) return;
  }
  $('save-label').textContent = session.dirty ? 'Unsaved changes' : 'Saved locally';
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
async function openFile(path) {
  const intent = ++navigationIntent;
  const project = $('project-select').value;
  let session = sessions.get(keyFor(project, path));
  if (!session) {
    requireSessionCapacity(project, path);
    const snapshot = await request({ action: 'open', project, path });
    if (!navigationCurrent(intent, project)) return;
    session = new ReviewSession(snapshot, project, request); sessions.set(keyFor(project, path), session);
  }
  await openSession(session, intent);
}
async function loadFiles(intent = navigationIntent) {
  const project = $('project-select').value;
  if (!navigationCurrent(intent, project)) return;
  const generation = ++fileInventoryGeneration; $('manuscript-files').replaceChildren();
  if (!project) return;
  const files = await request({ action: 'files', project });
  if (generation !== fileInventoryGeneration || project !== $('project-select').value) return;
  function appendTree(nodes, parent) {
    for (const node of nodes) {
      if (node.file) {
        const button = actionButton(node.name, () => openFile(node.path), 'file-button'); button.dataset.path = node.path; button.title = node.path; button.setAttribute('aria-current', String(active?.path === node.path)); parent.append(button);
      } else {
        const folder = element('details', '', 'file-folder'); const key = `${project}:${node.path}`;
        folder.open = expandedFolders.has(key); const summary = element('summary', node.name); summary.dataset.measure = ''; summary.setAttribute('aria-label', `Folder ${node.path}`);
        folder.ontoggle = () => {
          if (folder.open) expandedFolders.add(key); else expandedFolders.delete(key);
          while (expandedFolders.size > 500) expandedFolders.delete(expandedFolders.values().next().value);
          try { localStorage.setItem('undertree.expanded-folders', JSON.stringify([...expandedFolders])); } catch { /* Offline storage may be unavailable. */ }
        };
        const children = element('div', '', 'tree-children'); appendTree(node.children, children); folder.append(summary, children); parent.append(folder);
      }
    }
  }
  appendTree(manuscriptTree(files), $('manuscript-files'));
  if (!files.length) $('manuscript-files').append(element('p', 'No manuscript sources yet. Use + to create one.', 'file-help'));
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
for (const button of document.querySelectorAll('[data-view]')) button.onclick = () => mobileView(button.dataset.view);
$('project-open').onclick = task(async () => {
  if (nativeReview) { const intent = ++navigationIntent; const project = await chooseProject(); if (project && intent === navigationIntent) await loadProjects(project.id, intent); }
  else $('project-dialog').showModal();
});
$('project-form').onsubmit = task(async event => { event.preventDefault(); const intent = ++navigationIntent; const project = await request({ action: 'add_project', root: $('project-root').value }); if (intent !== navigationIntent) return; closeDialogs(); await loadProjects(project.id, intent); });
$('project-select').onchange = task(() => selectProject(++navigationIntent, $('project-select').value));
$('file-new').onclick = task(async () => { if (!currentProject()) throw {message:'Choose a project folder first.'}; $('new-dialog').showModal(); });
$('new-form').onsubmit = task(async event => {
  event.preventDefault(); const intent = ++navigationIntent; const project = currentProject();
  requireSessionCapacity(project.id, $('new-path').value);
  const snapshot = await request({ action: 'create', project: project.id, path: $('new-path').value });
  if (!navigationCurrent(intent, project.id)) return; $('new-dialog').close();
  const session = new ReviewSession(snapshot, project.id, request); sessions.set(keyFor(project.id, snapshot.path), session);
  await loadFiles(intent); await openSession(session, intent);
});
$('manuscript-save').onclick = task(async () => { closeWorkspaceMenus(); if (active) await saveSession(active); });
$('highlight-selection').onclick = task(async () => {
  closeWorkspaceMenus();
  if (!active || !view) return; const selected = view.state.selection.main;
  if (selected.empty) throw {message:'Select a passage in the source editor first.'};
  selection = { session: active, from: selected.from, to: selected.to, quote: view.state.sliceDoc(selected.from, selected.to), version: active.version };
  $('highlight-quote').textContent = selection.quote; $('highlight-dialog-rule').value = $('highlight-rule').value; $('highlight-prompt').value = ''; $('highlight-dialog').showModal();
});
$('highlight-form').onsubmit = task(async event => {
  event.preventDefault(); const selected = selection;
  if (!selected || selected.session !== active || selected.version !== active.version) throw {message:'The selection changed. Select the passage again.'};
  const session = selected.session;
  await session.mutate('mark', { from: selected.from, to: selected.to, rule: $('highlight-dialog-rule').value, prompt: $('highlight-prompt').value });
  if (selection === selected) $('highlight-dialog').close();
  if (active === session) { renderReview(); decorations(); reviewPanel(true); } queueSync(session.project);
});
$('reanchor-form').onsubmit = task(async event => {
  event.preventDefault();
  const selected = reanchorSelection;
  if (!selected || selected.session !== active || selected.version !== active.version) throw { message: 'The selected passage changed. Select it again before reanchoring.' };
  await saveSession(selected.session);
  if (selected.session !== active || selected.version !== active.version) throw { message: 'The selected passage changed while saving. Select it again before reanchoring.' };
  await selected.session.mutate('reanchor', { id: selected.id, from: selected.from, to: selected.to, quote: selected.quote });
  if (reanchorSelection === selected) { reanchorSelection = null; $('reanchor-dialog').close(); }
  if (active === selected.session) { markSelectedReview(selected.id); renderReview(); decorations(); scheduleReviewPositions(true); }
  queueSync(selected.session.project);
  status('Highlight reanchored.');
});
$('palette-open').onclick = task(async () => { closeWorkspaceMenus(); if (!active) return; paletteSession = active; palette = structuredClone(active.snapshot.review.rules); paletteRows(); $('palette-dialog').showModal(); });
$('rule-add').onclick = () => { if (palette.length >= 24) return; palette.push({ id: crypto.randomUUID(), label: 'Custom instruction', color: '#8295d2', action: 'prompt', prompt: '' }); paletteRows(); };
$('palette-form').onsubmit = task(async event => {
  event.preventDefault(); const session = paletteSession; if (!session || session !== active) throw {message:'The manuscript changed. Open its color rules again.'};
  const rules = palette;
  await session.mutate('palette', { rules });
  if (paletteSession === session && palette === rules) $('palette-dialog').close();
  if (active === session) { renderReview(); decorations(); } queueSync(session.project);
});
$('manuscript-share').onchange = task(async () => {
  if (!active) return;
  const session = active; const enabled = $('manuscript-share').checked; sharingSession = session;
  try { await saveSession(session); const response = await request({action:'share',project:session.project,path:session.path,enabled}); session.snapshot.shared = response.shared; }
  finally { sharingSession = null; renderReview(); }
});
$('review-refresh').onclick = task(async () => { if (!active) return; await active.refresh(); renderReview(); decorations(); });
$('export-buffer').onclick = downloadBuffer;
$('export-manuscript').onclick = () => { closeWorkspaceMenus(); downloadBuffer(); };
$('typst-compile').onclick = task(() => compileSession(active,true));
$('tex-import').onclick = task(async () => {
  closeWorkspaceMenus();
  if (!active?.path.endsWith('.tex')) return;
  const importing = active; const intent = ++navigationIntent;
  const project=importing.project; const target=importing.path.replace(/\.tex$/,'.typ');
  requireSessionCapacity(project, target);
  await saveSession(importing);
  const result=await request({action:'import_tex',project,path:importing.path,target});
  if (!navigationCurrent(intent, project)) return;
  const session=new ReviewSession(result.snapshot,project,request);sessions.set(keyFor(project,target),session);
  await loadFiles(intent);await openSession(session, intent);
  status(`Imported to ${target}. ${result.warnings.length} formatting notice(s); see ${target}.import-report.json. The .tex original was kept.`);
});
$('export-pdf').onclick = () => {
  if (!pdfBytes || !active) return;
  const url = URL.createObjectURL(new Blob([pdfBytes],{type:'application/pdf'})); const a=element('a'); a.href=url; a.download=active.path.split('/').pop().replace(/\.typ$/,'.pdf'); a.click(); setTimeout(()=>URL.revokeObjectURL(url),1000);
};
$('reload-buffer').onclick = task(async () => {
  if (!active) return;
  requireNavigationReady();
  const session = active; const intent = ++navigationIntent; const version = session.version;
  const snapshot = await request({action:'open',project:session.project,path:session.path});
  if (!navigationCurrent(intent, session.project) || active !== session) return;
  requireNavigationReady();
  if (session.version !== version) throw { message: 'Your buffer changed while the disk version was loading. Your edits are kept; choose Load disk version again to discard them.' };
  clearTimeout(saveTimers.get(session)); saveTimers.delete(session);
  const cleanup = detachEditor(false); renderReview(); await cleanup?.destroy();
  if (!navigationCurrent(intent, session.project)) return;
  const replacement = new ReviewSession(snapshot,session.project,request); sessions.set(keyFor(session.project,session.path),replacement);
  await openSession(replacement, intent);
});
const connections = setupConnectionManager({
  request, status,
  onRevoked: share => {
    for (const session of sessions.values()) if (!share || (session.project === share.project && session.path === share.path)) session.snapshot.shared = false;
    renderReview();
  },
  onShares: shares => {
    for (const session of sessions.values()) session.snapshot.shared = shares.some(s => s.project === session.project && s.path === session.path);
    if (!sharingSession) $('manuscript-share').checked = Boolean(active?.snapshot.shared);
  },
});
$('git-open').onclick = task(async () => { const project = currentProject(); if (!project) throw {message:'Choose a project first.'}; githubProject = project; $('github-repository').value = project.repository; $('github-auto').checked = project.autoSync; try { const result = await request({action:'git_status',project:project.id}); $('github-status').textContent = `Branch: ${result.branch}\n${result.status || 'Working tree clean'}`; } catch { $('github-status').textContent = 'Connect this local folder to an existing GitHub repository.'; } if (currentProject()?.id === project.id) $('git-dialog').showModal(); });
$('git-form').onsubmit = task(async event => { event.preventDefault(); const project = githubProject; if (!project) return; const intent = ++navigationIntent; await request({action:'bind_github',project:project.id,repository:$('github-repository').value,auto_sync:$('github-auto').checked}); pausedSync.delete(project.id); await loadProjects(project.id, intent); status('GitHub repository connected.'); });
$('github-sync-now').onclick = task(async () => { const project = githubProject; if (!project) return; const session = active; if (session?.project === project.id) await saveSession(session); const result = await request({action:'sync',project:project.id}); pausedSync.delete(project.id); status(result.message); $('github-status').textContent = result.message; });
document.addEventListener('keydown', task(async event => {
  if ((event.ctrlKey || event.metaKey) && event.key === 's') { event.preventDefault(); if (active) await saveSession(active); }
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
};
$('rail-editor').onclick = () => showPane('editor'); $('rail-preview').onclick = () => showPane('preview');
$('files-collapse').onclick = () => { workspace.dataset.filesCollapsed = 'true'; };
$('editor-collapse').onclick = () => { workspace.dataset.editorCollapsed = 'true'; workspace.dataset.previewCollapsed = 'false'; mobileView('preview'); };
$('preview-collapse').onclick = () => { workspace.dataset.previewCollapsed = 'true'; workspace.dataset.editorCollapsed = 'false'; mobileView('editor'); };
$('editor-search').onclick = () => { if (view) { showPane('editor'); openSearchPanel(view); } };
$('pdf-previous').onclick = () => pdfViewer.go(pdfViewer.page - 1); $('pdf-next').onclick = () => pdfViewer.go(pdfViewer.page + 1);
$('pdf-page-number').onchange = () => pdfViewer.go(Number($('pdf-page-number').value));
$('pdf-zoom-out').onclick = () => pdfViewer.zoom(.8); $('pdf-zoom-in').onclick = () => pdfViewer.zoom(1.25); $('pdf-fit-width').onclick = () => pdfViewer.fit();
$('compile-log-toggle').onclick = () => {
  showingLogs = !showingLogs; $('compile-log').hidden = !showingLogs; $('compile-log-toggle').setAttribute('aria-pressed', String(showingLogs));
  $('manuscript-preview').hidden = showingLogs || active?.path.endsWith('.typ');
  $('typst-preview').hidden = showingLogs || !active?.path.endsWith('.typ'); $('pdf-toolbar').hidden = showingLogs || !pdfBytes;
};
for (const button of document.querySelectorAll('[data-command]')) button.onclick = task(async () => {
  const command = button.dataset.command; closeWorkspaceMenus();
  const triggers = { 'open-project': 'project-open', 'new-file': 'file-new', github: 'git-open', connections: 'connection-open', download: 'export-manuscript', save: 'manuscript-save', highlight: 'highlight-selection', palette: 'palette-open', import: 'tex-import', logs: 'compile-log-toggle' };
  if (triggers[command]) $(triggers[command]).click();
  else if (['files', 'editor', 'preview'].includes(command)) showPane(command);
  else if (command === 'outline') treeMode(true);
  else if (command === 'review') reviewPanel(true);
  else if (command === 'help') $('help-dialog').showModal();
  else if (['bold','italic','heading','bullet-list','numbered-list'].includes(command)) formatSource(command);
  else if (view) { showPane('editor'); ({ undo, redo, 'select-all': selectAll, find: openSearchPanel })[command]?.(view); view.focus(); }
});
for (const menu of workspaceMenus) {
  menu.addEventListener('toggle', () => { if (menu.open) for (const other of workspaceMenus) if (other !== menu) other.open = false; });
  menu.querySelector('summary').addEventListener('keydown', event => {
    if (event.key === 'ArrowDown') { event.preventDefault(); menu.open = true; menu.querySelector('button:not(:disabled):not([hidden])')?.focus(); }
    else if (['ArrowLeft','ArrowRight'].includes(event.key) && menu.classList.contains('editor-menu')) {
      event.preventDefault(); const siblings = workspaceMenus.filter(item => item.classList.contains('editor-menu'));
      const next = siblings[(siblings.indexOf(menu) + (event.key === 'ArrowRight' ? 1 : siblings.length - 1)) % siblings.length];
      closeWorkspaceMenus(); next.querySelector('summary').focus();
    }
  });
}
document.addEventListener('pointerdown', event => { for (const menu of workspaceMenus) if (!menu.contains(event.target)) menu.open = false; });

function resizeFiles(width) {
  const available = workspace.clientWidth - 40;
  const next = clampPaneWidth(width, available); workspace.style.setProperty('--files-size', `${next}px`);
  $('files-splitter').setAttribute('aria-valuenow', String(Math.round(next))); $('files-splitter').setAttribute('aria-valuemax', String(Math.max(150, available - 400)));
}
function resetFilesWidth() {
  workspace.style.removeProperty('--files-size');
  $('files-splitter').setAttribute('aria-valuenow', String(Math.round(document.querySelector('.manuscript-files').getBoundingClientRect().width)));
}
function resizePreview(fraction) {
  const next = Math.max(.2, Math.min(.8, fraction));
  workspace.style.setProperty('--editor-size', `${next}fr`); workspace.style.setProperty('--preview-size', `${1 - next}fr`);
  $('preview-splitter').setAttribute('aria-valuenow', String(Math.round(next * 100)));
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
new ResizeObserver(([entry]) => {
  const { width, height } = entry.contentRect;
  workspace.style.setProperty('--chrome-gap', `${Math.max(4, Math.min(9, width / 180, height / 70))}px`);
  workspace.style.setProperty('--chrome-font-scale', String(Math.max(.9, Math.min(1, width / 700, height / 450))));
  if (width > 900) {
    if (workspace.style.getPropertyValue('--files-size')) resizeFiles(Number.parseFloat(workspace.style.getPropertyValue('--files-size')));
    else if (workspace.dataset.filesCollapsed !== 'true') $('files-splitter').setAttribute('aria-valuenow', String(Math.round(document.querySelector('.manuscript-files').getBoundingClientRect().width)));
  }
}).observe(workspace);
window.addEventListener('beforeunload', event => { if ([...sessions.values()].some(s => s.dirty || s.conflict)) { event.preventDefault(); event.returnValue = ''; } });
await setupWindowChrome({
  status,
  onClosing: setWindowClosing,
  canClose: () => ![...sessions.values()].some(session => session.dirty || session.conflict),
  beforeClose: async () => {
    for (const session of sessions.values()) await saveSession(session);
  },
});
observeReviewText(document.body);
await task(async () => { await loadProjects(); renderReview(); await connections.refresh(); })();
setInterval(async () => {
  if (document.hidden || refreshing || !active || active.dirty || active.conflict) return;
  refreshing = true;
  const session = active;
  try {
    const before = JSON.stringify(session.snapshot.review);
    await session.refresh();
    if (active === session && (before !== JSON.stringify(session.snapshot.review) || session.conflict)) { renderReview(); decorations(); queueSync(session.project); }
  } catch (error) { status(error.message, true); }
  finally { refreshing = false; }
}, 2000);
