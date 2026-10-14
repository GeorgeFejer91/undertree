import './manuscript.css';
import { basicSetup } from 'codemirror';
import { EditorView, Decoration } from '@codemirror/view';
import { EditorState, StateEffect, StateField, Compartment } from '@codemirror/state';
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
let saveTimer = null;
let previewTimer = null;
let selection = null;
let refreshing = false;
let sharingSession = null;
let palette = [];
const syncTimers = new Map();
const pausedSync = new Set();
let compiling = false;
const explicitCompiles = [];
let pdfLoadingTask = null;
let pdfBytes = null;
let pdfGeneration = 0;
let windowClosing = false;
let windowFocus = null;
let reviewCursor = -1;
let showingLogs = false;
const expandedFolders = new Set();
try {
  const folders = JSON.parse(localStorage.getItem('undertree.expanded-folders') || '[]');
  if (Array.isArray(folders)) for (const folder of folders.slice(-500)) if (typeof folder === 'string') expandedFolders.add(folder);
} catch { /* Storage availability does not affect editing. */ }
const workspace = document.querySelector('.review-workspace');
const pdfViewer = new ManuscriptPdfViewer({
  scroller: $('typst-preview'), pages: $('typst-pages'), onError: error => status(error.message, true),
  onChange: ({ page, total, scale, fit }) => {
    $('pdf-page-number').value = String(page); $('pdf-page-number').max = String(total);
    $('pdf-page-count').textContent = `of ${total}`; $('pdf-zoom-label').textContent = `${Math.round(scale * 100)}%${fit ? ' · fit' : ''}`;
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
function windowEditorAccess() { return [EditorState.readOnly.of(windowClosing), EditorView.editable.of(!windowClosing)]; }
function setWindowClosing(busy) {
  if (busy && view?.composing) throw new Error('Finish the current text composition before closing the window.');
  if (busy) windowFocus = document.activeElement;
  windowClosing = busy;
  for (const region of document.querySelectorAll('.review-topbar,.review-workspace,.mobile-views,dialog')) region.inert = busy;
  if (view) view.dispatch({ effects: windowEditing.reconfigure(windowEditorAccess()) });
  if (!busy) { if (windowFocus?.isConnected) windowFocus.focus(); windowFocus = null; }
}
function task(callback) { return async event => { try { await callback(event); } catch (error) { status(error.message || String(error), true); } }; }
function closeDialogs() { for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close(); }
function mobileView(name) {
  document.querySelector('.review-workspace').dataset.mobileView = name;
  for (const button of document.querySelectorAll('[data-view]')) button.setAttribute('aria-pressed', String(button.dataset.view === name));
}
function reviewPanel(open) {
  workspace.dataset.reviewOpen = String(open);
  $('review-toggle').setAttribute('aria-pressed', String(open));
  if (open && innerWidth <= 900) mobileView('review');
  else if (!open && workspace.dataset.mobileView === 'review') mobileView('editor');
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
  showPane('files'); $('manuscript-files').hidden = outline; $('manuscript-outline').hidden = !outline;
  $('files-heading').textContent = outline ? 'Outline' : 'Files';
  $('rail-files').setAttribute('aria-pressed', String(!outline)); $('rail-outline').setAttribute('aria-pressed', String(outline));
  if (outline) renderOutline();
}
function reviewAnchors() {
  if (!active) return [];
  return [...active.snapshot.review.markers, ...active.snapshot.review.suggestions.filter(s => s.status === 'pending')].filter(item => !item.anchor.stale).sort((a, b) => a.anchor.from - b.anchor.from);
}
function navigateReview(delta) {
  const entries = reviewAnchors(); if (!entries.length) return;
  reviewCursor = reviewCursor < 0 ? (delta < 0 ? entries.length - 1 : 0) : (reviewCursor + delta + entries.length) % entries.length;
  const item = entries[reviewCursor]; reviewPanel(true); selectAnchor(item.anchor);
  const card = [...$('review-list').querySelectorAll('[data-review-id]')].find(node => node.dataset.reviewId === item.id);
  for (const node of $('review-list').querySelectorAll('[data-review-id]')) node.dataset.selected = String(node === card);
  card?.scrollIntoView({ block: 'nearest' });
}
function keyFor(project, path) { return `${project}:${path}`; }
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
  $('pdf-toolbar').hidden = false;
  await pdfViewer.setDocument(pdf);
  if (generation !== pdfGeneration || session !== active || pdfLoadingTask !== loadingTask) return;
  $('typst-preview-status').textContent = `${result.current && !session.dirty ? 'Current PDF' : 'Last good PDF · source changed'} · ${pdf.numPages} page${pdf.numPages===1?'':'s'}`;
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
    $('compile-log').textContent = `Compiled ${session.path} successfully.\n${result.current && !session.dirty ? 'PDF matches the saved source.' : 'Newer source changes remain in the editor.'}`;
    status(result.current && !session.dirty ? 'Typst PDF compiled locally.' : 'Compiled preview retained; newer source still needs compilation.');
  } catch (error) {
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
      await saveSession(session);
      sessions.delete(keyFor(session.project,session.path));
      if (active === session) {
        view?.destroy();view=null;active=null;compileScheduler.cancel();
        $('manuscript-source').replaceChildren();pdfGeneration+=1;pdfViewer.clear();await pdfLoadingTask?.destroy();pdfLoadingTask=null;pdfBytes=null;
        const next=[...sessions.values()].find(s=>s.project===session.project);
        if (next) await openSession(next);
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
  const list = $('review-list'); list.replaceChildren();
  $('manuscript-share').disabled = !active || !/\.(html?|typ)$/i.test(active.path);
  if (sharingSession !== active) $('manuscript-share').checked = Boolean(active?.snapshot.shared);
  $('review-conflict').hidden = !active?.conflict;
  for (const id of ['manuscript-save','highlight-selection','palette-open','export-manuscript','highlight-rule']) $(id).disabled = !active;
  const noReviewPassages = !reviewAnchors().length;
  $('review-previous').disabled = noReviewPassages; $('review-next').disabled = noReviewPassages;
  if (!active) { $('typst-compile').hidden = true; $('pdf-toolbar').hidden = true; $('export-pdf').hidden = true; list.append(element('p', 'Select text in the editor to add a highlight or reviewer instruction.', 'review-empty')); return; }
  const review = active.snapshot.review;
  for (const id of ['highlight-rule', 'highlight-dialog-rule']) {
    const select = $(id); const previous = select.value; select.replaceChildren();
    for (const rule of review.rules) { const option = element('option', rule.label); option.value = rule.id; select.append(option); }
    if (review.rules.some(r => r.id === previous)) select.value = previous;
  }
  if (review.markers.length) list.append(element('h3', 'Your highlights', 'review-group-heading'));
  for (const marker of review.markers) {
    const rule = review.rules.find(r => r.id === marker.rule);
    const card = element('article', '', 'review-card'); card.style.setProperty('--review-color', rule?.color || '#666666');
    card.dataset.reviewId = marker.id; card.dataset.sourcePosition = String(marker.anchor.from);
    const heading = element('h3', rule?.label || 'Highlight'); heading.dataset.measure = ''; card.append(heading);
    card.append(element('blockquote', marker.anchor.quote));
    if (rule?.prompt || marker.prompt) card.append(element('p', [rule?.prompt, marker.prompt].filter(Boolean).join(' '), 'rationale'));
    if (marker.anchor.stale) card.append(element('p', 'Stale highlight. Remove it and select the current passage again. Stale protection blocks agent suggestions.', 'stale-note'));
    const actions = element('div', '', 'card-actions');
    const locate = actionButton('Locate', () => selectAnchor(marker.anchor)); locate.disabled = marker.anchor.stale;
    actions.append(locate, actionButton('Remove highlight', async () => { const session = active; await session.mutate('unmark', { id: marker.id }); if (active === session) { renderReview(); decorations(); } queueSync(session.project); }));
    card.append(actions); list.append(card);
  }
  const pending = review.suggestions.filter(s => s.status === 'pending');
  list.append(element('h3', `Suggestions (${pending.length})`, 'review-group-heading'));
  if (!pending.length) list.append(element('p', 'Agent suggestions will appear here after you share this manuscript and connect ChatGPT. Your text changes only when you accept.', 'review-empty'));
  for (const suggestion of pending) {
    const card = element('article', '', 'review-card suggestion-card'); card.style.setProperty('--review-color', suggestion.color);
    card.dataset.reviewId = suggestion.id; card.dataset.sourcePosition = String(suggestion.anchor.from);
    const heading = element('h3', 'Proposed wording'); heading.dataset.measure = ''; card.append(heading);
    card.append(element('blockquote', suggestion.anchor.quote), element('p', suggestion.replacement, 'replacement'), element('p', suggestion.rationale, 'rationale'));
    if (suggestion.prompt) card.append(element('p', suggestion.prompt, 'rationale'));
    if (suggestion.anchor.stale) card.append(element('p', 'The original passage changed. Ask for a new suggestion.', 'stale-note'));
    const actions = element('div', '', 'card-actions');
    const decide = async decision => {
      const session = active;
      await session.mutate('decide', { id: suggestion.id, decision });
      if (active === session) {
        if (!session.conflict && view.state.doc.toString() !== session.content) view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: session.content }, annotations: authoritative.of(true) });
        renderReview(); decorations(); preview(); renderTabs();
      }
      queueSync(session.project);
    };
    const accept = actionButton('Accept', () => decide('accepted'), 'accept-suggestion'); accept.disabled = suggestion.anchor.stale || Boolean(active.conflict);
    const locate = actionButton('Locate', () => selectAnchor(suggestion.anchor)); locate.disabled = suggestion.anchor.stale;
    actions.append(accept, actionButton('Reject', () => decide('rejected'), 'reject-suggestion'), locate); card.append(actions); list.append(card);
  }
  const decided = review.suggestions.filter(s => s.status !== 'pending');
  if (decided.length) {
    const details = element('details'); details.append(element('summary', `Reviewed (${decided.length})`));
    for (const s of decided) details.append(element('p', `${s.status === 'accepted' ? 'Accepted' : 'Rejected'}: ${s.replacement}`, 'rationale'));
    list.append(details);
  }
}
import { Annotation } from '@codemirror/state';
const authoritative = Annotation.define();
async function openSession(session) {
  if (active === session && view) return;
  if (active?.dirty) await saveSession(active);
  if (active && view) { active.editorState = view.state; active.editorScroll = { top: view.scrollDOM.scrollTop, left: view.scrollDOM.scrollLeft }; }
  clearTimeout(saveTimer); view?.destroy(); active = session;
  pdfGeneration += 1; pdfBytes = null; pdfViewer.clear(); await pdfLoadingTask?.destroy(); pdfLoadingTask = null;
  $('manuscript-source').replaceChildren();
  const extensions = [basicSetup, EditorView.lineWrapping, reviewField, windowEditing.of(windowEditorAccess()), EditorView.updateListener.of(update => {
    if (!update.docChanged || update.transactions.some(t => t.annotation(authoritative))) return;
    session.edit(update.state.doc.toString());
    if (active === session) { $('save-label').textContent = 'Unsaved changes'; renderTabs(); }
    clearTimeout(saveTimer); saveTimer = setTimeout(() => task(() => saveSession(session))(), 450);
    clearTimeout(previewTimer); previewTimer = setTimeout(() => { preview(); renderOutline(); }, 250);
    if (session.path.endsWith('.typ')) { $('typst-preview-status').textContent='Source changed · last good PDF retained'; compileScheduler.request(keyFor(session.project,session.path)); }
  })];
  if (/\.html?$/i.test(session.path)) extensions.push(html());
  else if (/\.css$/i.test(session.path)) extensions.push(css());
  let editorState = session.editorState;
  if (editorState && editorState.doc.toString() !== session.content) editorState = editorState.update({changes:{from:0,to:editorState.doc.length,insert:session.content},annotations:authoritative.of(true)}).state;
  view = new EditorView({ state: editorState || EditorState.create({ doc: session.content, extensions }), parent: $('manuscript-source') });
  if (session.editorScroll) requestAnimationFrame(() => { if (active === session && view) { view.scrollDOM.scrollTop = session.editorScroll.top; view.scrollDOM.scrollLeft = session.editorScroll.left; } });
  renderTabs(); renderReview(); decorations(); preview(); renderOutline(); showPane('editor');
  const typst = session.path.endsWith('.typ');
  $('typst-compile').hidden = !typst; $('tex-import').hidden = !session.path.endsWith('.tex');
  $('manuscript-preview').hidden = typst || showingLogs; $('typst-preview').hidden = !typst || showingLogs; $('export-pdf').hidden = true; $('pdf-toolbar').hidden = true; $('typst-preview-status').hidden = !typst;
  if (typst) { $('typst-pages').replaceChildren(); $('typst-preview-status').textContent='Compile this Typst manuscript to see its PDF.'; const result=await request({action:'pdf',project:session.project,path:session.path}); await showPdf(result,session); }
  $('save-label').textContent = session.dirty ? 'Unsaved changes' : 'Saved locally';
  for (const button of document.querySelectorAll('.file-button')) {
    button.setAttribute('aria-current', String(button.dataset.path === session.path));
    if (button.dataset.path === session.path) {
      let folder = button.closest('.file-folder');
      while (folder) { folder.open = true; folder = folder.parentElement.closest('.file-folder'); }
    }
  }
}
async function openFile(path) {
  const project = $('project-select').value;
  let session = sessions.get(keyFor(project, path));
  if (!session) {
    if (sessions.size >= 20) throw {message:'Close a file tab before opening another. UnderTree keeps at most 20 editor buffers.'};
    session = new ReviewSession(await request({ action: 'open', project, path }), project, request); sessions.set(keyFor(project, path), session);
  }
  await openSession(session);
}
async function loadFiles() {
  const project = $('project-select').value; $('manuscript-files').replaceChildren();
  if (!project) return;
  const files = await request({ action: 'files', project });
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
async function loadProjects(selected) {
  projects = await request({ action: 'projects' }); const select = $('project-select'); const previous = selected || select.value;
  select.replaceChildren(element('option', 'Choose a project'));
  select.firstChild.value = '';
  for (const p of projects) { const option = element('option', p.name); option.value = p.id; select.append(option); }
  if (projects.some(p => p.id === previous)) select.value = previous;
  else if (projects.length === 1) select.value = projects[0].id;
  await loadFiles();
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
  if (nativeReview) { const project = await chooseProject(); if (project) await loadProjects(project.id); }
  else $('project-dialog').showModal();
});
$('project-form').onsubmit = task(async event => { event.preventDefault(); const project = await request({ action: 'add_project', root: $('project-root').value }); closeDialogs(); await loadProjects(project.id); });
$('project-select').onchange = task(async () => { if (active?.dirty) await saveSession(active); if(active && view) active.editorState=view.state;active = null; view?.destroy(); view = null;compileScheduler.cancel(); $('manuscript-source').replaceChildren(); renderTabs(); renderReview(); await loadFiles(); });
$('file-new').onclick = task(async () => { if (!currentProject()) throw {message:'Choose a project folder first.'}; $('new-dialog').showModal(); });
$('new-form').onsubmit = task(async event => { event.preventDefault(); const project = currentProject(); const snapshot = await request({ action: 'create', project: project.id, path: $('new-path').value }); const session = new ReviewSession(snapshot, project.id, request); sessions.set(keyFor(project.id, snapshot.path), session); closeDialogs(); await loadFiles(); await openSession(session); });
$('manuscript-save').onclick = task(async () => { if (active) await saveSession(active); });
$('highlight-selection').onclick = task(async () => {
  if (!active || !view) return; const selected = view.state.selection.main;
  if (selected.empty) throw {message:'Select a passage in the source editor first.'};
  selection = { session: active, from: selected.from, to: selected.to, quote: view.state.sliceDoc(selected.from, selected.to), version: active.version };
  $('highlight-quote').textContent = selection.quote; $('highlight-dialog-rule').value = $('highlight-rule').value; $('highlight-prompt').value = ''; $('highlight-dialog').showModal();
});
$('highlight-form').onsubmit = task(async event => { event.preventDefault(); if (!selection || selection.session !== active || selection.version !== active.version) throw {message:'The selection changed. Select the passage again.'}; await active.mutate('mark', { from: selection.from, to: selection.to, rule: $('highlight-dialog-rule').value, prompt: $('highlight-prompt').value }); closeDialogs(); renderReview(); decorations(); reviewPanel(true); queueSync(active.project); });
$('palette-open').onclick = task(async () => { if (!active) return; palette = structuredClone(active.snapshot.review.rules); paletteRows(); $('palette-dialog').showModal(); });
$('rule-add').onclick = () => { if (palette.length >= 24) return; palette.push({ id: crypto.randomUUID(), label: 'Custom instruction', color: '#8295d2', action: 'prompt', prompt: '' }); paletteRows(); };
$('palette-form').onsubmit = task(async event => { event.preventDefault(); if (!active) return; await active.mutate('palette', { rules: palette }); closeDialogs(); renderReview(); decorations(); queueSync(active.project); });
$('manuscript-share').onchange = task(async () => {
  if (!active) return;
  const session = active; const enabled = $('manuscript-share').checked; sharingSession = session;
  try { await saveSession(session); const response = await request({action:'share',project:session.project,path:session.path,enabled}); session.snapshot.shared = response.shared; }
  finally { sharingSession = null; renderReview(); }
});
$('review-refresh').onclick = task(async () => { if (!active) return; await active.refresh(); renderReview(); decorations(); });
$('export-buffer').onclick = downloadBuffer;
$('export-manuscript').onclick = downloadBuffer;
$('typst-compile').onclick = task(() => compileSession(active,true));
$('tex-import').onclick = task(async () => {
  if (!active?.path.endsWith('.tex')) return;
  await saveSession(active);
  const project=active.project; const target=active.path.replace(/\.tex$/,'.typ');
  const result=await request({action:'import_tex',project,path:active.path,target});
  const session=new ReviewSession(result.snapshot,project,request);sessions.set(keyFor(project,target),session);
  await loadFiles();await openSession(session);
  status(`Imported to ${target}. ${result.warnings.length} formatting notice(s); see ${target}.import-report.json. The .tex original was kept.`);
});
$('export-pdf').onclick = () => {
  if (!pdfBytes || !active) return;
  const url = URL.createObjectURL(new Blob([pdfBytes],{type:'application/pdf'})); const a=element('a'); a.href=url; a.download=active.path.split('/').pop().replace(/\.typ$/,'.pdf'); a.click(); setTimeout(()=>URL.revokeObjectURL(url),1000);
};
$('reload-buffer').onclick = task(async () => { if (!active) return; const session = active; const snapshot = await request({action:'open',project:session.project,path:session.path}); const replacement = new ReviewSession(snapshot,session.project,request); sessions.set(keyFor(session.project,session.path),replacement); active = null; await openSession(replacement); });
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
$('git-open').onclick = task(async () => { const project = currentProject(); if (!project) throw {message:'Choose a project first.'}; $('github-repository').value = project.repository; $('github-auto').checked = project.autoSync; try { const result = await request({action:'git_status',project:project.id}); $('github-status').textContent = `Branch: ${result.branch}\n${result.status || 'Working tree clean'}`; } catch { $('github-status').textContent = 'Connect this local folder to an existing GitHub repository.'; } $('git-dialog').showModal(); });
$('git-form').onsubmit = task(async event => { event.preventDefault(); const project = currentProject(); await request({action:'bind_github',project:project.id,repository:$('github-repository').value,auto_sync:$('github-auto').checked}); pausedSync.delete(project.id); await loadProjects(project.id); status('GitHub repository connected.'); });
$('github-sync-now').onclick = task(async () => { if (active) await saveSession(active); const project = currentProject(); const result = await request({action:'sync',project:project.id}); pausedSync.delete(project.id); status(result.message); $('github-status').textContent = result.message; });
document.addEventListener('keydown', task(async event => {
  if ((event.ctrlKey || event.metaKey) && event.key === 's') { event.preventDefault(); if (active) await saveSession(active); }
  if (event.key === 'F5' || ((event.ctrlKey || event.metaKey) && event.key === 'Enter')) { event.preventDefault(); await compileSession(active, true); }
  if (event.key === 'Escape') $('workspace-menu').open = false;
}));

$('review-toggle').onclick = () => reviewPanel(workspace.dataset.reviewOpen !== 'true');
$('review-close').onclick = () => reviewPanel(false);
$('review-previous').onclick = () => navigateReview(-1); $('review-next').onclick = () => navigateReview(1);
$('rail-files').onclick = () => treeMode(false); $('rail-outline').onclick = () => treeMode(true);
$('rail-editor').onclick = () => showPane('editor'); $('rail-preview').onclick = () => showPane('preview');
$('files-collapse').onclick = () => { workspace.dataset.filesCollapsed = 'true'; };
$('editor-collapse').onclick = () => { workspace.dataset.editorCollapsed = 'true'; workspace.dataset.previewCollapsed = 'false'; mobileView('preview'); };
$('preview-collapse').onclick = () => { workspace.dataset.previewCollapsed = 'true'; workspace.dataset.editorCollapsed = 'false'; mobileView('editor'); };
$('editor-search').onclick = () => { if (view) { showPane('editor'); openSearchPanel(view); } };
$('pdf-previous').onclick = () => pdfViewer.go(pdfViewer.page - 1); $('pdf-next').onclick = () => pdfViewer.go(pdfViewer.page + 1);
$('pdf-page-number').onchange = () => pdfViewer.go(Number($('pdf-page-number').value));
$('pdf-zoom-out').onclick = () => pdfViewer.zoom(1 / 1.2); $('pdf-zoom-in').onclick = () => pdfViewer.zoom(1.2); $('pdf-fit-width').onclick = () => pdfViewer.fit();
$('compile-log-toggle').onclick = () => {
  showingLogs = !showingLogs; $('compile-log').hidden = !showingLogs; $('compile-log-toggle').setAttribute('aria-pressed', String(showingLogs));
  $('manuscript-preview').hidden = showingLogs || active?.path.endsWith('.typ');
  $('typst-preview').hidden = showingLogs || !active?.path.endsWith('.typ'); $('pdf-toolbar').hidden = showingLogs || !pdfBytes;
};
for (const button of document.querySelectorAll('[data-command]')) button.onclick = task(async () => {
  const command = button.dataset.command; $('workspace-menu').open = false;
  const triggers = { 'open-project': 'project-open', 'new-file': 'file-new', github: 'git-open', connections: 'connection-open', download: 'export-manuscript' };
  if (triggers[command]) $(triggers[command]).click();
  else if (['files', 'editor', 'preview'].includes(command)) showPane(command);
  else if (command === 'review') reviewPanel(true);
  else if (view) { showPane('editor'); ({ undo, redo, 'select-all': selectAll, find: openSearchPanel })[command]?.(view); view.focus(); }
});
document.addEventListener('pointerdown', event => { if (!$('workspace-menu').contains(event.target)) $('workspace-menu').open = false; });

function resizeFiles(width) {
  const available = workspace.clientWidth - 40;
  const next = clampPaneWidth(width, available); workspace.style.setProperty('--files-size', `${next}px`);
  $('files-splitter').setAttribute('aria-valuenow', String(Math.round(next))); $('files-splitter').setAttribute('aria-valuemax', String(Math.max(150, available - 400)));
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
    if (id === 'files-splitter') resizeFiles(event.key === 'Home' ? 220 : Number(splitter.getAttribute('aria-valuenow')) + direction * 20);
    else resizePreview(event.key === 'Home' ? .5 : Number(splitter.getAttribute('aria-valuenow')) / 100 + direction * .05);
  };
  splitter.ondblclick = () => id === 'files-splitter' ? resizeFiles(220) : resizePreview(.5);
}
new ResizeObserver(([entry]) => {
  const { width, height } = entry.contentRect;
  workspace.style.setProperty('--chrome-gap', `${Math.max(4, Math.min(9, width / 180, height / 70))}px`);
  workspace.style.setProperty('--chrome-font-scale', String(Math.max(.9, Math.min(1, width / 700, height / 450))));
  if (workspace.style.getPropertyValue('--files-size') && width > 900) resizeFiles(Number.parseFloat(workspace.style.getPropertyValue('--files-size')));
}).observe(workspace);
window.addEventListener('beforeunload', event => { if ([...sessions.values()].some(s => s.dirty || s.conflict)) { event.preventDefault(); event.returnValue = ''; } });
await setupWindowChrome({
  status,
  onClosing: setWindowClosing,
  canClose: () => ![...sessions.values()].some(session => session.dirty || session.conflict),
  beforeClose: async () => {
    clearTimeout(saveTimer);
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
