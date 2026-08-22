import "./styles.css";
import { basicSetup } from "codemirror";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { defaultKeymap, indentWithTab, redo, undo } from "@codemirror/commands";
import { openSearchPanel, searchKeymap } from "@codemirror/search";
import { StreamLanguage } from "@codemirror/language";
import { stex } from "@codemirror/legacy-modes/mode/stex";
import { xml } from "@codemirror/legacy-modes/mode/xml";
import { html as htmlLanguage } from "@codemirror/lang-html";
import { css as cssLanguage } from "@codemirror/lang-css";
import * as pretextRich from "@chenglou/pretext/rich-inline";
import pdfWorkerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";
import { pdfSourceTree } from "./file-tree-filter.js";
import { absoluteProjectPath, dirnamePath, pathIsEntry, remapPath } from "./file-tree-actions.js";
import { boundedPdfOutputScale, clampPdfPage, destroyPdfResource, nextPdfScale } from "./pdf-viewer-state.js";
import { PDF_PREVIEW_CACHE_LIMIT, pdfPreviewCacheKey, pdfPreviewEvictionKeys, touchPdfPreviewCache } from "./pdf-preview-cache.js";
import { normalizeProjectSort, projectActivityTime, sortProjects } from "./project-sorting.js";
import { isSelectedTexPdfTarget, shouldReuseSelectedPdf } from "./tex-recovery.js";
import { EXTERNAL_TEX_SCAN_MS, LIVE_COMPILE_DELAY_MS, externalTexChanged } from "./tex-monitor.js";
import { documentOutline } from "./outline.js";
import { insertBoxlet, patchEditableHtml, patchElementAttributes, patchElementStyle, removeVisualElement } from "./html-print-profile.js";
import { fitPrintDocument } from "./pretext-fit-core.js";
import { gridTrackRange, parsePixelTracks, pixelDeltaToMillimetres, resizeTrackBoundary, tracksToMillimetres } from "./html-visual-layout.js";
import { acceptBuildSave, buildTabSnapshot, flushTabSave, markPathEdited, markTabEdited, persistWithConflictRecovery, saveTabSnapshot, tabContent } from "./save-coordinator.js";

let pdfjsPromise = null;

async function loadPdfjs() {
  if (!pdfjsPromise) {
    // The standard PDF.js worker uses Uint8Array.prototype.toHex, which is not
    // available in every Chromium runtime supported by the Windows desktop app.
    // The legacy build carries the same renderer plus the required typed-array
    // polyfills in both the page and worker contexts.
    pdfjsPromise = import("pdfjs-dist/legacy/build/pdf.mjs").then((pdfjs) => {
      pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
      return pdfjs;
    });
  }
  return pdfjsPromise;
}

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const elements = {
  projectPicker: $("#project-picker"),
  projectIcon: $("#project-icon"),
  projectModal: $("#project-modal"),
  projectFilter: $("#project-filter"),
  projectSort: $("#project-sort"),
  projectList: $("#project-list"),
  fileTree: $("#file-tree"),
  fileContextMenu: $("#file-context-menu"),
  sourceFilesOnly: $("#source-files-only"),
  fileOutline: $("#file-outline"),
  editorHost: $("#editor-host"),
  editorTabs: $("#editor-tabs"),
  saveState: $("#save-state"),
  pdfViewer: $("#pdf-viewer"),
  htmlProof: $("#html-proof"),
  pdfPages: $("#pdf-pages"),
  previewPane: $("#preview-pane"),
  previewStage: $("#preview-stage"),
  pdfPlaceholder: $("#pdf-placeholder"),
  downloadPdf: $("#download-pdf"),
  downloadAllPdfs: $("#download-all-pdfs"),
  compileButton: $("#compile"),
  compileLog: $("#compile-log"),
  logsPanel: $("#logs-panel"),
  projectSearch: $("#project-search"),
  searchResults: $("#search-results"),
  gitSummary: $("#git-summary"),
  syncLog: $("#sync-log"),
  buildConfig: $("#build-config"),
  gitState: $("#git-state"),
  statusMessage: $("#status-message"),
  htmlModeToggle: $("#html-mode-toggle"),
  htmlVisualToolbar: $("#html-visual-toolbar"),
  htmlSelectionLabel: $("#html-selection-label"),
  workspace: $("#workspace"),
  toastRegion: $("#toast-region"),
};

function isLayoutSource(path = state.activePath) {
  return String(path).toLowerCase().endsWith(".layout.xml");
}

function isTexSource(path = state.activePath) {
  return String(path).toLowerCase().endsWith(".tex");
}

function isHtmlSource(path = state.activePath) {
  return String(path).toLowerCase().endsWith(".html");
}

function isCssSource(path = state.activePath) {
  return String(path).toLowerCase().endsWith(".css");
}

function previewSourcePath(path = state.activePath) {
  if (isTexSource(path) || isLayoutSource(path) || isHtmlSource(path)) return path;
  return state.build?.rootDocument || state.currentProject?.rootDocument || "";
}

const state = {
  projects: [],
  currentProject: null,
  tree: [],
  build: null,
  tabs: new Map(),
  activePath: "",
  editor: null,
  replacingEditor: false,
  saveTimers: new Map(),
  outlineTimer: null,
  searchTimer: null,
  pdfDocument: null,
  pdfLoadingTask: null,
  pdfProjectId: "",
  pdfSourcePath: "",
  pdfFingerprint: "",
  pdfStale: false,
  pdfPage: 1,
  pdfScale: null,
  pdfCurrentScale: 1,
  pdfRenderTasks: new Map(),
  pdfRenderVersion: 0,
  nativePdfUrl: "",
  pdfRefreshVersion: 0,
  pdfPageObserver: null,
  pdfScrollFrame: null,
  pdfResizeTimer: null,
  pdfCache: new Map(),
  failedTexBuilds: new Map(),
  autoCompileMode: "0",
  autoCompileTimer: null,
  autoCompileChangeTimer: null,
  externalTexScanTimer: null,
  compileInFlight: false,
  pendingHtmlCompile: false,
  codexRecoveryEnabled: false,
  monitoredRecoveries: new Set(),
  recoverySources: new Set(),
  pendingTexSelection: "",
  autoSave: true,
  wordWrap: true,
  projectSort: "activity",
  projectActivity: {},
  sourceFilesOnly: true,
  expandedPaths: new Set(),
  treeContextNode: null,
  treeContextTrigger: null,
  htmlMode: "source",
  htmlVisualFrame: null,
  htmlVisualShell: null,
  htmlInspector: null,
  visualEditor: null,
  visualSelection: null,
  visualHandles: [],
  htmlCompileTimer: null,
  visualRefitTimer: null,
};

const PROJECT_SORT_STORAGE_KEY = "localtex-project-sort";
const PROJECT_ACTIVITY_STORAGE_KEY = "localtex-project-activity";
const AUTOSAVE_DELAY_MS = 100;
const HTML_COMPILE_DELAY_MS = 750;

async function api(path, options = {}) {
  const response = await fetch(path, {
    cache: "no-store",
    credentials: "same-origin",
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {}),
    },
  });
  const contentType = response.headers.get("content-type") || "";
  const body = contentType.includes("application/json") ? await response.json() : await response.text();
  if (!response.ok) {
    const error = new Error(body?.error || body || `${response.status} ${response.statusText}`);
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
}

function projectApi(action = "") {
  if (!state.currentProject) throw new Error("No project selected");
  return `/api/project/${state.currentProject.id}${action ? `/${action}` : ""}`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
}

function toast(message, kind = "success", duration = 4200) {
  const duplicate = [...elements.toastRegion.children].find((item) => item.dataset.message === message);
  if (duplicate) return duplicate;
  const item = document.createElement("div");
  item.className = `toast ${kind}`;
  item.dataset.message = message;
  item.textContent = message;
  elements.toastRegion.append(item);
  setTimeout(() => item.remove(), duration);
}

function status(message) {
  elements.statusMessage.textContent = message;
}

function setSaveState(label, kind = "") {
  elements.saveState.textContent = label;
  elements.saveState.className = `save-state ${kind}`;
}

function orderedProjects() {
  return sortProjects(state.projects, state.projectSort, state.projectActivity);
}

function recordProjectActivity(projectId, field) {
  if (!projectId || !["openedAt", "editedAt"].includes(field)) return;
  state.projectActivity[projectId] = { ...(state.projectActivity[projectId] || {}), [field]: Date.now() };
  const currentIds = new Set(state.projects.map((project) => project.id));
  state.projectActivity = Object.fromEntries(Object.entries(state.projectActivity).filter(([id]) => currentIds.has(id)));
  localStorage.setItem(PROJECT_ACTIVITY_STORAGE_KEY, JSON.stringify(state.projectActivity));
}

function renderProjectPicker() {
  const projects = orderedProjects();
  elements.projectPicker.innerHTML = projects.length
    ? projects.map((project) => `<option value="${project.id}">${escapeHtml(project.name)}</option>`).join("")
    : `<option value="" selected>Choose or add a project</option>`;
  elements.projectPicker.disabled = !projects.length;
  if (state.currentProject) elements.projectPicker.value = state.currentProject.id;
}

function projectMonogram(name) {
  return name.split(/[^A-Za-z0-9ÄÖÜäöüß]+/).filter(Boolean).slice(0, 2).map((word) => word[0]).join("").toUpperCase() || "TX";
}

function formatProjectDate(timestamp) {
  if (!timestamp) return "Date unavailable";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(timestamp));
}

function projectSortDetail(project) {
  if (state.projectSort === "activity") {
    const local = state.projectActivity[project.id] || {};
    const latest = projectActivityTime(project, state.projectActivity);
    if (Number(local.editedAt) === latest) return `Edited ${formatProjectDate(latest)}`;
    if (Number(local.openedAt) === latest) return `Opened ${formatProjectDate(latest)}`;
    return `Updated ${formatProjectDate(latest)}`;
  }
  return `Created ${formatProjectDate(project.createdAt)}`;
}

function renderProjectDialog(filter = "") {
  const needle = filter.trim().toLocaleLowerCase();
  const projects = orderedProjects().filter((project) => !needle || [project.name, project.repository, project.semanticDomain, project.themes, project.documentFunction].join(" ").toLocaleLowerCase().includes(needle));
  elements.projectList.innerHTML = projects.map((project) => `
    <button class="project-row" data-project="${project.id}">
      ${project.hasIcon ? `<img src="/api/project/${project.id}/icon" alt="" />` : `<span class="project-monogram">${escapeHtml(projectMonogram(project.name))}</span>`}
      <span class="project-details"><strong>${escapeHtml(project.name)}</strong><small>${escapeHtml(project.semanticDomain || project.repository || project.localPath)}</small></span>
      <span class="project-row-meta"><span class="project-engine">${escapeHtml(project.engine || "TeX")}</span><small>${escapeHtml(projectSortDetail(project))}</small></span>
    </button>`).join("") || `<p>No local projects match “${escapeHtml(filter)}”.</p>`;
  elements.projectList.querySelectorAll("[data-project]").forEach((button) => button.addEventListener("click", () => {
    closeProjectModal();
    selectProject(button.dataset.project);
  }));
}

function openProjectModal(focusSort = false) {
  elements.projectModal.hidden = false;
  elements.projectFilter.value = "";
  elements.projectSort.value = state.projectSort;
  renderProjectDialog();
  requestAnimationFrame(() => (focusSort ? elements.projectSort : elements.projectFilter).focus());
}

function closeProjectModal() {
  elements.projectModal.hidden = true;
}

async function addProjectFolder() {
  if (typeof window.undertree?.chooseProjectFolder !== "function") {
    toast("Folder selection is available in the UnderTree desktop app.", "error");
    return;
  }
  const localPath = await window.undertree.chooseProjectFolder();
  if (!localPath) return;
  const data = await api("/api/projects/bridge", { method: "POST", body: JSON.stringify({ localPath }) });
  state.projects = [...state.projects.filter((project) => project.id !== data.project.id), data.project];
  renderProjectPicker();
  renderProjectDialog(elements.projectFilter.value);
  toast(`Added ${data.project.name}. UnderTree will keep using this folder directly.`);
  await selectProject(data.project.id);
}

function iconForFile(name) {
  const extension = name.split(".").pop()?.toLowerCase();
  if (extension === "tex") return "T";
  if (["bib", "bst"].includes(extension)) return "⌘";
  if (["png", "jpg", "jpeg", "svg", "pdf"].includes(extension)) return "▧";
  if (["sty", "cls"].includes(extension)) return "⚙";
  return "▱";
}

function bindTreeRowContext(row, node) {
  row.dataset.path = node.path;
  row.dataset.type = node.type;
  row.setAttribute("aria-haspopup", "menu");
  row.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    event.stopPropagation();
    showTreeContextMenu(node, row, event.clientX, event.clientY);
  });
  row.addEventListener("keydown", (event) => {
    if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
      event.preventDefault();
      const bounds = row.getBoundingClientRect();
      showTreeContextMenu(node, row, bounds.left + 24, bounds.top + bounds.height);
    } else if (event.key === "F2") {
      event.preventDefault();
      void runTreeContextAction("rename", node);
    }
  });
}

function renderTree(nodes, depth = 0) {
  const container = document.createDocumentFragment();
  for (const node of nodes) {
    if (node.type === "directory") {
      const directory = document.createElement("div");
      directory.className = `tree-directory ${state.expandedPaths.has(node.path) ? "open" : ""}`;
      const row = document.createElement("button");
      row.className = "tree-row";
      row.style.paddingLeft = `${7 + depth * 14}px`;
      row.innerHTML = `<span class="tree-caret">${directory.classList.contains("open") ? "⌄" : "›"}</span><span class="tree-icon">▰</span><span class="tree-label">${escapeHtml(node.name)}</span>`;
      row.title = node.path;
      row.setAttribute("role", "treeitem");
      row.setAttribute("aria-expanded", String(directory.classList.contains("open")));
      row.addEventListener("click", () => {
        directory.classList.toggle("open");
        const open = directory.classList.contains("open");
        if (open) state.expandedPaths.add(node.path);
        else state.expandedPaths.delete(node.path);
        row.querySelector(".tree-caret").textContent = open ? "⌄" : "›";
        row.setAttribute("aria-expanded", String(open));
      });
      bindTreeRowContext(row, node);
      const children = document.createElement("div");
      children.className = "tree-children";
      children.append(renderTree(node.children || [], depth + 1));
      directory.append(row, children);
      container.append(directory);
    } else {
      const file = document.createElement("div");
      file.className = `tree-file ${node.editable ? "editable" : ""}`;
      const row = document.createElement("button");
      row.className = `tree-row ${state.activePath === node.path ? "active" : ""}`;
      row.style.paddingLeft = `${21 + depth * 14}px`;
      row.title = node.path;
      row.setAttribute("role", "treeitem");
      row.setAttribute("aria-label", `${node.name}${node.editable ? "" : ", preview only"}`);
      row.innerHTML = `<span class="tree-icon">${iconForFile(node.name)}</span><span class="tree-label">${escapeHtml(node.name)}</span>`;
      row.addEventListener("click", () => node.editable ? openFile(node.path) : toast("This binary or large file is not editable as text.", "error"));
      bindTreeRowContext(row, node);
      file.append(row);
      container.append(file);
    }
  }
  return container;
}

function renderFileTree() {
  const visibleTree = state.sourceFilesOnly ? pdfSourceTree(state.tree) : state.tree;
  elements.fileTree.replaceChildren();
  if (visibleTree.length) {
    elements.fileTree.append(renderTree(visibleTree));
  } else {
    const message = document.createElement("p");
    message.className = "tree-empty";
    message.textContent = state.sourceFilesOnly ? "No TeX, Bib, HTML, or CSS files found." : "This project is empty.";
    elements.fileTree.append(message);
  }
}

function setSourceFilesOnly(checked) {
  state.sourceFilesOnly = checked;
  elements.sourceFilesOnly.checked = checked;
  localStorage.setItem("localtex-source-files-only", String(checked));
  renderFileTree();
}

function refreshTreeSelection() {
  elements.fileTree.querySelectorAll(".tree-row.active").forEach((row) => row.classList.remove("active"));
  elements.fileTree.querySelectorAll(".tree-row").forEach((row) => {
    if (row.dataset.path === state.activePath) row.classList.add("active");
  });
}

function renderTabs() {
  if (!state.tabs.size) {
    elements.editorTabs.innerHTML = '<span class="empty-tab">No file open</span>';
    return;
  }
  elements.editorTabs.innerHTML = "";
  for (const tab of state.tabs.values()) {
    const item = document.createElement("div");
    item.className = `editor-tab ${tab.path === state.activePath ? "active" : ""} ${tab.dirty ? "dirty" : ""}`;
    item.title = tab.path;
    item.innerHTML = `<span class="tree-icon">${iconForFile(tab.path)}</span><button class="editor-tab-label">${escapeHtml(basenamePath(tab.path))}</button><span class="dirty-marker">●</span><button class="close-tab" title="Close">×</button>`;
    item.querySelector(".editor-tab-label").addEventListener("click", () => { void openFile(tab.path); });
    item.querySelector(".close-tab").addEventListener("click", () => closeTab(tab.path));
    elements.editorTabs.append(item);
  }
}

function basenamePath(path) {
  return path.split("/").pop() || path;
}

function projectAbsolutePath(relativePath = "") {
  return absoluteProjectPath(state.currentProject?.localPath, relativePath);
}

function treeContextItem(action, icon, label, shortcut = "", className = "") {
  return `<button type="button" role="menuitem" data-tree-action="${action}" class="${className}"><span class="context-icon">${icon}</span><span class="context-label">${escapeHtml(label)}</span><span class="context-shortcut">${escapeHtml(shortcut)}</span></button>`;
}

function closeTreeContextMenu(restoreFocus = false) {
  if (elements.fileContextMenu.hidden) return;
  const trigger = state.treeContextTrigger;
  trigger?.classList.remove("context-selected");
  elements.fileContextMenu.hidden = true;
  state.treeContextNode = null;
  state.treeContextTrigger = null;
  if (restoreFocus && trigger?.isConnected) trigger.focus();
}

function showTreeContextMenu(node, trigger, clientX, clientY) {
  closeTreeContextMenu();
  const isRoot = node.type === "root";
  const isFile = node.type === "file";
  const isOpenDirectory = node.type === "directory" && state.expandedPaths.has(node.path);
  const items = [`<span class="context-heading" title="${escapeHtml(node.path || state.currentProject?.localPath || "Project")}">${escapeHtml(node.name || state.currentProject?.name || "Project")}</span>`];
  if (isFile && node.editable) items.push(treeContextItem("open", "↗", "Open"));
  if (node.type === "directory") items.push(treeContextItem("toggle", isOpenDirectory ? "⌃" : "⌄", isOpenDirectory ? "Collapse folder" : "Expand folder"));
  if (!isRoot) items.push(treeContextItem("rename", "✎", "Rename", "F2"), treeContextItem("duplicate", "▣", "Duplicate"));
  if (!isRoot) items.push('<div class="context-separator" role="separator"></div>');
  items.push(treeContextItem("new-file", "＋", isRoot ? "New file" : "New file here"), treeContextItem("new-folder", "▱", isRoot ? "New folder" : "New folder here"));
  items.push('<div class="context-separator" role="separator"></div>');
  if (!isRoot) items.push(treeContextItem("copy-relative-path", "⌘", "Copy relative path"));
  items.push(treeContextItem("copy-full-path", "⧉", isRoot ? "Copy project path" : "Copy full path"), treeContextItem("reveal", "▰", isRoot ? "Open project location" : "Open file location"));
  items.push('<div class="context-separator" role="separator"></div>');
  if (!isRoot) items.push(treeContextItem("delete", "×", `Delete ${node.type === "directory" ? "folder" : "file"}`, "", "danger"));
  items.push(treeContextItem("refresh", "↻", "Refresh file tree"));

  elements.fileContextMenu.innerHTML = items.join("");
  elements.fileContextMenu.hidden = false;
  state.treeContextNode = node;
  state.treeContextTrigger = trigger || null;
  trigger?.classList.add("context-selected");
  elements.fileContextMenu.style.left = "0px";
  elements.fileContextMenu.style.top = "0px";
  const bounds = elements.fileContextMenu.getBoundingClientRect();
  const left = Math.max(8, Math.min(clientX, window.innerWidth - bounds.width - 8));
  const top = Math.max(8, Math.min(clientY, window.innerHeight - bounds.height - 8));
  elements.fileContextMenu.style.left = `${left}px`;
  elements.fileContextMenu.style.top = `${top}px`;
  elements.fileContextMenu.querySelectorAll("[data-tree-action]").forEach((button) => button.addEventListener("click", () => {
    const action = button.dataset.treeAction;
    closeTreeContextMenu();
    void runTreeContextAction(action, node);
  }));
  elements.fileContextMenu.querySelector("[data-tree-action]")?.focus({ preventScroll: true });
}

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const field = document.createElement("textarea");
  field.value = text;
  field.style.position = "fixed";
  field.style.opacity = "0";
  document.body.append(field);
  field.select();
  const copied = document.execCommand("copy");
  field.remove();
  if (!copied) throw new Error("Clipboard access is unavailable");
}

async function flushTabsForEntry(entryPath) {
  for (const [path, tab] of state.tabs) {
    if (pathIsEntry(path, entryPath)) await saveFile(tab, { flush: true });
  }
}

function remapOpenEntry(oldPath, newPath) {
  const remappedTabs = new Map();
  for (const [path, tab] of state.tabs) {
    const nextPath = pathIsEntry(path, oldPath) ? remapPath(path, oldPath, newPath) : path;
    if (nextPath !== path) {
      clearSaveTimer(path);
      tab.path = nextPath;
    }
    remappedTabs.set(nextPath, tab);
  }
  state.tabs = remappedTabs;
  state.expandedPaths = new Set([...state.expandedPaths].map((path) => pathIsEntry(path, oldPath) ? remapPath(path, oldPath, newPath) : path));
  if (pathIsEntry(state.activePath, oldPath)) state.activePath = remapPath(state.activePath, oldPath, newPath);
  if (state.activePath && state.tabs.has(state.activePath)) activateTab(state.activePath);
  else renderTabs();
}

function showEmptyEditor() {
  state.activePath = "";
  state.editor?.destroy();
  state.editor = null;
  elements.editorHost.innerHTML = '<div class="empty-editor"><div class="empty-document-icon">T</div><h1>UnderTree</h1><p>Choose a source file from the project tree.</p></div>';
  elements.fileOutline.innerHTML = "<p>Open a TeX file to see its structure.</p>";
  setSaveState("No file");
}

async function discardOpenEntry(entryPath) {
  const removedActive = pathIsEntry(state.activePath, entryPath);
  for (const [path, tab] of [...state.tabs]) {
    if (!pathIsEntry(path, entryPath)) continue;
    clearSaveTimer(path);
    if (tab.savePromise) await tab.savePromise.catch(() => {});
    state.tabs.delete(path);
  }
  if (removedActive) {
    const nextPath = state.tabs.keys().next().value;
    if (nextPath) activateTab(nextPath);
    else showEmptyEditor();
  }
  renderTabs();
  refreshTreeSelection();
}

async function renameTreeEntry(node) {
  const nextName = prompt(`Rename ${node.type === "directory" ? "folder" : "file"}:`, node.name)?.trim();
  if (!nextName || nextName === node.name) return;
  if ([".", ".."].includes(nextName) || /[\\/\0]/.test(nextName)) throw new Error("Enter a name without slashes");
  const parent = dirnamePath(node.path);
  const newPath = parent ? `${parent}/${nextName}` : nextName;
  await flushTabsForEntry(node.path);
  const result = await api(projectApi("entry"), { method: "PATCH", body: JSON.stringify({ path: node.path, newPath }) });
  remapOpenEntry(node.path, result.path);
  await refreshTree();
  recordProjectActivity(state.currentProject?.id, "editedAt");
  scheduleStatusRefresh();
  toast(`Renamed to ${result.path}.`);
}

async function duplicateTreeEntry(node) {
  await flushTabsForEntry(node.path);
  const result = await api(projectApi("entry/duplicate"), { method: "POST", body: JSON.stringify({ path: node.path }) });
  await refreshTree();
  if (result.type === "file" && result.editable) await openFile(result.path);
  recordProjectActivity(state.currentProject?.id, "editedAt");
  scheduleStatusRefresh();
  toast(`Created ${result.path}.`);
}

async function deleteTreeEntry(node) {
  const affectedTabs = [...state.tabs.entries()].filter(([path]) => pathIsEntry(path, node.path));
  const dirtyCount = affectedTabs.filter(([, tab]) => tab.dirty).length;
  const warning = dirtyCount ? ` This will also discard unsaved changes in ${dirtyCount} open ${dirtyCount === 1 ? "file" : "files"}.` : "";
  if (!confirm(`Delete “${node.name}”?${warning}\n\nThis cannot be undone in UnderTree.`)) return;
  for (const [path, tab] of affectedTabs) {
    clearSaveTimer(path);
    if (tab.savePromise) await tab.savePromise.catch(() => {});
  }
  await api(projectApi("entry"), { method: "DELETE", body: JSON.stringify({ path: node.path }) });
  await discardOpenEntry(node.path);
  state.expandedPaths = new Set([...state.expandedPaths].filter((path) => !pathIsEntry(path, node.path)));
  await refreshTree();
  recordProjectActivity(state.currentProject?.id, "editedAt");
  scheduleStatusRefresh();
  toast(`${node.type === "directory" ? "Folder" : "File"} deleted.`);
}

function contextDirectory(node) {
  if (node.type === "root") return "";
  return node.type === "directory" ? node.path : dirnamePath(node.path);
}

async function runTreeContextAction(action, node) {
  try {
    if (action === "open") await openFile(node.path);
    else if (action === "toggle") {
      const row = [...elements.fileTree.querySelectorAll(".tree-row")].find((item) => item.dataset.path === node.path);
      row?.click();
    } else if (action === "rename") await renameTreeEntry(node);
    else if (action === "duplicate") await duplicateTreeEntry(node);
    else if (action === "new-file") await createEntry("file", contextDirectory(node));
    else if (action === "new-folder") await createEntry("directory", contextDirectory(node));
    else if (action === "copy-relative-path") {
      await copyText(node.path);
      toast("Relative path copied.");
    } else if (action === "copy-full-path") {
      await copyText(projectAbsolutePath(node.path));
      toast(node.type === "root" ? "Project path copied." : "Full path copied.");
    } else if (action === "reveal") {
      status("Opening the system file manager…");
      await api(projectApi("entry/reveal"), { method: "POST", body: JSON.stringify({ path: node.path }) });
      status(`Opened ${node.path || state.currentProject?.name} in the system file manager`);
    } else if (action === "delete") await deleteTreeEntry(node);
    else if (action === "refresh") {
      await refreshTree();
      toast("File tree refreshed.");
    }
  } catch (error) {
    toast(error.message, "error", 6500);
    status("File operation failed");
  }
}

function destroyVisualEditor() {
  state.visualEditor?.destroy();
  state.visualEditor = null;
  state.visualSelection = null;
  state.visualHandles.forEach((handle) => handle.remove());
  state.visualHandles = [];
  clearTimeout(state.visualRefitTimer);
  state.visualRefitTimer = null;
  state.htmlVisualFrame = null;
  state.htmlVisualShell = null;
  state.htmlInspector = null;
}

function updateHtmlModeUi() {
  const active = isHtmlSource();
  elements.htmlModeToggle.hidden = !active;
  $$(".html-control").forEach((control) => { control.hidden = !active; });
  elements.htmlVisualToolbar.hidden = !active || state.htmlMode !== "visual";
  elements.htmlModeToggle.querySelectorAll("[data-html-mode]").forEach((button) => button.classList.toggle("active", button.dataset.htmlMode === state.htmlMode));
  const codeMirror = elements.editorHost.querySelector(".cm-editor");
  if (codeMirror) codeMirror.hidden = active && state.htmlMode === "visual";
  if (state.htmlVisualShell) state.htmlVisualShell.hidden = !active || state.htmlMode !== "visual";
}

function dispatchProfilePatch(patch) {
  if (!state.editor || !patch) return;
  const changes = patch.changes || { from: patch.from, to: patch.to, insert: patch.insert };
  state.editor.dispatch({ changes, userEvent: "input.visual" });
}

function currentHtmlSource() {
  return state.editor?.state.doc.toString() || "";
}

function visualInspectorMarkup() {
  return `<aside class="html-inspector" aria-label="Selected HTML object inspector">
    <h3>Object</h3>
    <p class="html-inspector-id">No object selected</p>
    <div class="html-inspector-grid">
      <label>Layout<select data-ut-attribute="data-ut-layout"><option value="">Inherit</option><option value="grid">Grid</option><option value="flex">Flex</option></select></label>
      <label>Width mm<input type="number" min="5" max="210" step="0.1" data-ut-style="width" data-ut-unit="mm"></label>
      <label>Height mm<input type="number" min="5" max="296.7" step="0.1" data-ut-style="height" data-ut-unit="mm"></label>
      <label>Left mm<input type="number" min="0" max="210" step="0.1" data-ut-style="left" data-ut-unit="mm"></label>
      <label>Top mm<input type="number" min="0" max="296.7" step="0.1" data-ut-style="top" data-ut-unit="mm"></label>
      <label>Padding mm<input type="number" min="0" max="40" step="0.1" data-ut-style="padding" data-ut-unit="mm"></label>
      <label>Gap mm<input type="number" min="0" max="40" step="0.1" data-ut-style="gap" data-ut-unit="mm"></label>
      <label>Border mm<input type="number" min="0" max="5" step="0.1" data-ut-style="border-width" data-ut-unit="mm"></label>
      <label>Radius mm<input type="number" min="0" max="40" step="0.1" data-ut-style="border-radius" data-ut-unit="mm"></label>
      <label>Grid column<input type="text" data-ut-style="grid-column" placeholder="1 / span 2"></label>
      <label>Grid row<input type="text" data-ut-style="grid-row" placeholder="1 / span 1"></label>
      <label>Columns<input type="text" data-ut-style="grid-template-columns" placeholder="1fr 1fr"></label>
      <label>Flex direction<select data-ut-style="flex-direction"><option value="">Inherit</option><option value="row">Row</option><option value="column">Column</option></select></label>
      <label>Min font px<input type="number" min="5" max="96" step="0.1" data-ut-attribute="data-ut-fit-min-font"></label>
      <label>Max font px<input type="number" min="5" max="120" step="0.1" data-ut-attribute="data-ut-fit-max-font"></label>
      <label>Image fit<select data-ut-style="object-fit"><option value="">Inherit</option><option value="contain">Contain</option><option value="cover">Cover</option><option value="fill">Fill</option></select></label>
      <label class="wide">Image alt text<input type="text" data-ut-attribute="alt"></label>
      <label>Background<input type="color" data-ut-style="background-color" value="#ffffff"></label>
      <label>Border color<input type="color" data-ut-style="border-color" value="#1f6950"></label>
    </div>
  </aside>`;
}

function cssNumeric(style, name, unit = "") {
  const value = Number.parseFloat(style.getPropertyValue(name));
  if (!Number.isFinite(value)) return "";
  if (unit === "mm") return (value * 25.4 / 96).toFixed(1);
  return String(value);
}

function populateInspector(element) {
  if (!state.htmlInspector) return;
  state.htmlInspector.querySelector(".html-inspector-id").textContent = element ? element.getAttribute("data-ut-id") : "No object selected";
  state.htmlInspector.querySelectorAll("input,select").forEach((control) => { control.disabled = !element; });
  if (!element) return;
  const style = element.ownerDocument.defaultView.getComputedStyle(element);
  for (const control of state.htmlInspector.querySelectorAll("[data-ut-style]")) {
    const name = control.dataset.utStyle;
    const value = cssNumeric(style, name, control.dataset.utUnit) || style.getPropertyValue(name).trim();
    if (control.type === "color") {
      const match = value.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
      if (match) control.value = `#${match.slice(1, 4).map((item) => Number(item).toString(16).padStart(2, "0")).join("")}`;
    } else if (control.type === "number") control.value = Number.isFinite(Number.parseFloat(value)) ? Number.parseFloat(value) : "";
    else control.value = value === "none" || value === "auto" ? "" : value;
  }
  for (const control of state.htmlInspector.querySelectorAll("[data-ut-attribute]")) {
    const target = control.dataset.utAttribute === "alt" ? element.matches("img") ? element : element.querySelector("img") : element;
    control.value = target?.getAttribute(control.dataset.utAttribute) || "";
  }
}

function clearVisualHandles() {
  state.visualHandles.forEach((handle) => handle.remove());
  state.visualHandles = [];
}

function updateVisualHandles() {
  const element = state.visualSelection;
  if (!element) return;
  const rect = element.getBoundingClientRect();
  for (const handle of state.visualHandles) {
    const direction = handle.dataset.utDirection;
    const x = direction === "move" ? rect.left + 18 : direction.includes("w") ? rect.left : direction.includes("e") ? rect.right : (rect.left + rect.right) / 2;
    const y = direction.includes("n") ? rect.top : direction.includes("s") ? rect.bottom : direction === "move" ? rect.top : (rect.top + rect.bottom) / 2;
    handle.style.left = `${x - 7}px`;
    handle.style.top = `${y - 7}px`;
  }
}

function scheduleVisualRefit(delay = 120) {
  clearTimeout(state.visualRefitTimer);
  state.visualRefitTimer = setTimeout(() => { void refitVisualDocument(); }, delay);
}

async function refitVisualDocument({ announce = false } = {}) {
  const document = state.htmlVisualFrame?.contentDocument;
  if (!document) return null;
  try {
    const result = await fitPrintDocument(document, { pretextRich, timeoutMs: 10000 });
    document.querySelectorAll("[data-ut-fit-error]").forEach((element) => {
      element.removeAttribute("data-ut-fit-error");
      element.style.boxShadow = "";
    });
    for (const diagnostic of result.diagnostics) {
      const element = document.querySelector(`[data-ut-id="${CSS.escape(diagnostic.dataUtId)}"]`);
      if (!element) continue;
      element.setAttribute("data-ut-fit-error", "true");
      element.style.boxShadow = "inset 0 0 0 3px #d24b3f";
    }
    updateVisualHandles();
    const summary = result.diagnostics.length ? `${result.diagnostics.length} boxlet${result.diagnostics.length === 1 ? "" : "s"} overflow` : "All boxlets fit";
    if (state.visualSelection) elements.htmlSelectionLabel.textContent = `${state.visualSelection.getAttribute("data-ut-id")} · ${summary}`;
    if (announce) toast(summary, result.diagnostics.length ? "error" : "success", 3500);
    return result;
  } catch (error) {
    if (announce) toast(`Could not refit boxlets: ${error.message}`, "error", 6500);
    return null;
  }
}

function gridResizeContext(element) {
  const container = element.parentElement;
  if (!container?.hasAttribute("data-ut-id") || container.ownerDocument.defaultView.getComputedStyle(container).display !== "grid") return null;
  const containerStyle = container.ownerDocument.defaultView.getComputedStyle(container);
  const columns = parsePixelTracks(containerStyle.gridTemplateColumns);
  const rows = parsePixelTracks(containerStyle.gridTemplateRows);
  const style = element.ownerDocument.defaultView.getComputedStyle(element);
  const columnRange = gridTrackRange(style.gridColumnStart, style.gridColumnEnd, columns.length);
  const rowRange = gridTrackRange(style.gridRowStart, style.gridRowEnd, rows.length);
  return columns.length && rows.length && columnRange && rowRange ? { container, columns, rows, columnRange, rowRange } : null;
}

function beginAbsoluteBoxDrag(element, direction, event) {
  event.preventDefault();
  const handle = event.currentTarget;
  handle.setPointerCapture(event.pointerId);
  const style = element.ownerDocument.defaultView.getComputedStyle(element);
  const page = element.closest("[data-ut-page]");
  const pageRect = page?.getBoundingClientRect();
  const start = {
    left: Number.parseFloat(style.left) || element.offsetLeft,
    top: Number.parseFloat(style.top) || element.offsetTop,
    width: element.getBoundingClientRect().width,
    height: element.getBoundingClientRect().height,
  };
  const origin = { x: event.clientX, y: event.clientY };
  const move = (moveEvent) => {
    const dx = moveEvent.clientX - origin.x;
    const dy = moveEvent.clientY - origin.y;
    let { left, top, width, height } = start;
    if (direction === "move") { left += dx; top += dy; }
    else {
      if (direction.includes("e")) width += dx;
      if (direction.includes("s")) height += dy;
      if (direction.includes("w")) { left += dx; width -= dx; }
      if (direction.includes("n")) { top += dy; height -= dy; }
    }
    if (width < 18.9) { if (direction.includes("w")) left -= 18.9 - width; width = 18.9; }
    if (height < 18.9) { if (direction.includes("n")) top -= 18.9 - height; height = 18.9; }
    if (pageRect) {
      left = Math.max(0, Math.min(left, pageRect.width - width));
      top = Math.max(0, Math.min(top, pageRect.height - height));
    }
    Object.assign(element.style, { left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px` });
    updateVisualHandles();
  };
  const end = () => {
    handle.removeEventListener("pointermove", move);
    handle.removeEventListener("pointerup", end);
    handle.removeEventListener("pointercancel", end);
    const finalStyle = element.ownerDocument.defaultView.getComputedStyle(element);
    dispatchProfilePatch(patchElementStyle(currentHtmlSource(), element.getAttribute("data-ut-id"), {
      left: `${pixelDeltaToMillimetres(Number.parseFloat(finalStyle.left) || 0).toFixed(2)}mm`,
      top: `${pixelDeltaToMillimetres(Number.parseFloat(finalStyle.top) || 0).toFixed(2)}mm`,
      width: `${pixelDeltaToMillimetres(element.getBoundingClientRect().width).toFixed(2)}mm`,
      height: `${pixelDeltaToMillimetres(element.getBoundingClientRect().height).toFixed(2)}mm`,
    }));
    populateInspector(element);
    scheduleVisualRefit(0);
  };
  handle.addEventListener("pointermove", move);
  handle.addEventListener("pointerup", end);
  handle.addEventListener("pointercancel", end);
}

function beginGridBoundaryDrag(element, direction, context, event) {
  event.preventDefault();
  const handle = event.currentTarget;
  handle.setPointerCapture(event.pointerId);
  const origin = { x: event.clientX, y: event.clientY };
  const horizontalBoundary = direction.includes("w") ? context.columnRange.start : direction.includes("e") ? context.columnRange.end : null;
  const verticalBoundary = direction.includes("n") ? context.rowRange.start : direction.includes("s") ? context.rowRange.end : null;
  let columns = context.columns;
  let rows = context.rows;
  const move = (moveEvent) => {
    const dx = moveEvent.clientX - origin.x;
    const dy = moveEvent.clientY - origin.y;
    if (horizontalBoundary !== null) columns = resizeTrackBoundary(context.columns, horizontalBoundary, dx) || columns;
    if (verticalBoundary !== null) rows = resizeTrackBoundary(context.rows, verticalBoundary, dy) || rows;
    context.container.style.gridTemplateColumns = `${columns.map((value) => `${value}px`).join(" ")}`;
    context.container.style.gridTemplateRows = `${rows.map((value) => `${value}px`).join(" ")}`;
    updateVisualHandles();
  };
  const end = () => {
    handle.removeEventListener("pointermove", move);
    handle.removeEventListener("pointerup", end);
    handle.removeEventListener("pointercancel", end);
    dispatchProfilePatch(patchElementStyle(currentHtmlSource(), context.container.getAttribute("data-ut-id"), {
      "grid-template-columns": tracksToMillimetres(columns),
      "grid-template-rows": tracksToMillimetres(rows),
    }));
    populateInspector(element);
    scheduleVisualRefit(0);
  };
  handle.addEventListener("pointermove", move);
  handle.addEventListener("pointerup", end);
  handle.addEventListener("pointercancel", end);
}

function addVisualHandle(element, direction, callback) {
  const document = element.ownerDocument;
  const handle = document.createElement("button");
  handle.type = "button";
  handle.dataset.utDirection = direction;
  handle.className = `ut-visual-handle ut-visual-handle-${direction}`;
  handle.title = direction === "move" ? "Drag this boxlet" : "Drag this box border";
  const cursors = { n: "ns-resize", s: "ns-resize", e: "ew-resize", w: "ew-resize", ne: "nesw-resize", sw: "nesw-resize", nw: "nwse-resize", se: "nwse-resize", move: "move" };
  Object.assign(handle.style, {
    position: "fixed", width: "14px", height: "14px", zIndex: "2147483647", padding: "0",
    border: "2px solid white", borderRadius: direction === "move" ? "3px" : "50%", background: direction === "move" ? "#006c76" : "#0aa25c",
    boxShadow: "0 1px 5px rgba(0,0,0,.4)", cursor: cursors[direction] || "default",
  });
  handle.addEventListener("pointerdown", callback);
  document.body.append(handle);
  state.visualHandles.push(handle);
}

function attachVisualHandles(element) {
  clearVisualHandles();
  if (!element.hasAttribute("data-ut-box")) return;
  const position = element.ownerDocument.defaultView.getComputedStyle(element).position;
  if (position === "absolute" || position === "fixed") {
    for (const direction of ["n", "ne", "e", "se", "s", "sw", "w", "nw", "move"]) {
      addVisualHandle(element, direction, (event) => beginAbsoluteBoxDrag(element, direction, event));
    }
  } else {
    const context = gridResizeContext(element);
    if (!context) return;
    const directions = [];
    if (context.rowRange.start > 0) directions.push("n");
    if (context.rowRange.end < context.rows.length) directions.push("s");
    if (context.columnRange.start > 0) directions.push("w");
    if (context.columnRange.end < context.columns.length) directions.push("e");
    if (directions.includes("n") && directions.includes("w")) directions.push("nw");
    if (directions.includes("n") && directions.includes("e")) directions.push("ne");
    if (directions.includes("s") && directions.includes("w")) directions.push("sw");
    if (directions.includes("s") && directions.includes("e")) directions.push("se");
    for (const direction of directions) addVisualHandle(element, direction, (event) => beginGridBoundaryDrag(element, direction, context, event));
  }
  updateVisualHandles();
}

function selectVisualElement(element) {
  state.visualEditor?.destroy();
  state.visualEditor = null;
  if (state.visualSelection) state.visualSelection.style.outline = "";
  state.visualSelection = element;
  elements.htmlSelectionLabel.textContent = element ? element.getAttribute("data-ut-id") : "Select a marked region";
  if (!element) {
    populateInspector(null);
    return;
  }
  element.style.outline = "2px solid #0aa25c";
  element.style.outlineOffset = "2px";
  populateInspector(element);
  attachVisualHandles(element);
  if (!element.hasAttribute("data-ut-editable")) return;
  const id = element.getAttribute("data-ut-id");
  const previousContentEditable = element.getAttribute("contenteditable");
  const previousSpellcheck = element.getAttribute("spellcheck");
  const sync = () => {
    try {
      dispatchProfilePatch(patchEditableHtml(currentHtmlSource(), id, element.innerHTML));
      scheduleVisualRefit();
    } catch (error) { toast(error.message, "error", 6500); }
  };
  element.setAttribute("contenteditable", "true");
  element.setAttribute("spellcheck", "true");
  element.addEventListener("input", sync);
  state.visualEditor = {
    element,
    sync,
    destroy() {
      element.removeEventListener("input", sync);
      if (previousContentEditable === null) element.removeAttribute("contenteditable"); else element.setAttribute("contenteditable", previousContentEditable);
      if (previousSpellcheck === null) element.removeAttribute("spellcheck"); else element.setAttribute("spellcheck", previousSpellcheck);
    },
  };
}

async function loadHtmlVisual() {
  if (!isHtmlSource()) return;
  await saveActiveFile();
  if (!state.htmlVisualShell) {
    elements.editorHost.insertAdjacentHTML("beforeend", `<div class="html-visual-shell" hidden><div class="html-visual-canvas"><iframe class="html-visual-frame" title="Visual HTML print editor" sandbox="allow-same-origin"></iframe></div>${visualInspectorMarkup()}</div>`);
    state.htmlVisualShell = elements.editorHost.querySelector(".html-visual-shell");
    state.htmlVisualFrame = elements.editorHost.querySelector(".html-visual-frame");
    state.htmlInspector = elements.editorHost.querySelector(".html-inspector");
    state.htmlInspector.addEventListener("change", (event) => {
      const control = event.target.closest("[data-ut-style],[data-ut-attribute]");
      const selected = state.visualSelection;
      if (!control || !selected) return;
      try {
        if (control.dataset.utStyle) {
          const unit = control.dataset.utUnit || "";
          const value = control.value ? `${control.value}${unit}` : "";
          const target = control.dataset.utStyle === "object-fit" && !selected.matches("img") ? selected.querySelector("img") : selected;
          if (!target?.hasAttribute("data-ut-id")) throw new Error("Give the image its own data-ut-id before editing image properties visually.");
          dispatchProfilePatch(patchElementStyle(currentHtmlSource(), target.getAttribute("data-ut-id"), { [control.dataset.utStyle]: value }));
          target.style.setProperty(control.dataset.utStyle, value);
        } else {
          const target = control.dataset.utAttribute === "alt" ? selected.matches("img") ? selected : selected.querySelector("img") : selected;
          if (!target?.hasAttribute("data-ut-id")) throw new Error("Give the image its own data-ut-id before editing image properties visually.");
          dispatchProfilePatch(patchElementAttributes(currentHtmlSource(), target.getAttribute("data-ut-id"), { [control.dataset.utAttribute]: control.value }));
          if (control.value) target?.setAttribute(control.dataset.utAttribute, control.value); else target?.removeAttribute(control.dataset.utAttribute);
        }
        updateVisualHandles();
        scheduleVisualRefit();
      } catch (error) { toast(error.message, "error", 6500); }
    });
  }
  state.htmlVisualShell.hidden = false;
  const frame = state.htmlVisualFrame;
  await new Promise((resolve) => {
    frame.onload = () => {
      const document = frame.contentDocument;
      document.addEventListener("click", (event) => {
        const selected = event.target.closest("[data-ut-id]");
        if (!selected) return;
        event.preventDefault();
        selectVisualElement(selected);
      });
      document.addEventListener("scroll", updateVisualHandles, true);
      document.defaultView.addEventListener("resize", updateVisualHandles);
      selectVisualElement(document.querySelector("[data-ut-editable]") || document.querySelector("[data-ut-id]"));
      scheduleVisualRefit(0);
      resolve();
    };
    frame.src = `${projectApi("html-source")}?path=${encodeURIComponent(state.activePath)}&v=${Date.now()}`;
  });
}

async function setHtmlMode(mode) {
  if (!isHtmlSource() || !["source", "visual"].includes(mode)) return;
  state.htmlMode = mode;
  updateHtmlModeUi();
  if (mode === "visual") await loadHtmlVisual();
  else {
    state.visualEditor?.destroy();
    state.visualEditor = null;
    state.editor?.focus();
  }
}

function runVisualCommand(command, value) {
  const editor = state.visualEditor;
  const element = editor?.element;
  const document = element?.ownerDocument;
  if (!editor || !document) return toast("Select an editable text region first.", "error");
  document.defaultView.focus();
  document.execCommand("styleWithCSS", false, true);
  if (command === "bold") document.execCommand("bold");
  else if (command === "italic") document.execCommand("italic");
  else if (command === "underline") document.execCommand("underline");
  else if (command === "bulletList") document.execCommand("insertUnorderedList");
  else if (command === "orderedList") document.execCommand("insertOrderedList");
  else if (command === "hardBreak" && !document.execCommand("insertLineBreak")) document.execCommand("insertHTML", false, "<br>");
  else if (command === "align") document.execCommand({ left: "justifyLeft", center: "justifyCenter", right: "justifyRight" }[value] || "justifyLeft");
  else if (command === "color") document.execCommand("foreColor", false, value);
  else if (command === "fontSize") {
    document.execCommand("fontSize", false, "7");
    for (const font of element.querySelectorAll('font[size="7"]')) {
      const span = document.createElement("span");
      span.style.fontSize = value || "inherit";
      span.append(...font.childNodes);
      font.replaceWith(span);
    }
  }
  else if (command === "paragraph") document.execCommand("formatBlock", false, "p");
  else if (command === "heading") document.execCommand("formatBlock", false, `h${Number(value)}`);
  else if (command === "link") {
    const selection = document.getSelection();
    const anchor = selection?.anchorNode?.nodeType === 1 ? selection.anchorNode : selection?.anchorNode?.parentElement;
    const href = prompt("Link URL", anchor?.closest?.("a")?.getAttribute("href") || "https://");
    if (href === null) return;
    if (!href) document.execCommand("unlink"); else document.execCommand("createLink", false, href);
  }
  editor.sync();
}

async function addVisualBoxlet() {
  if (!isHtmlSource()) return;
  const document = state.htmlVisualFrame?.contentDocument;
  const page = state.visualSelection?.closest("[data-ut-page]") || document?.querySelector("[data-ut-page]");
  if (!page?.hasAttribute("data-ut-id")) return toast("Select an A4 page before adding a boxlet.", "error", 5000);
  try {
    const patch = insertBoxlet(currentHtmlSource(), page.getAttribute("data-ut-id"));
    dispatchProfilePatch(patch);
    await loadHtmlVisual();
    const added = state.htmlVisualFrame?.contentDocument?.querySelector(`[data-ut-id="${CSS.escape(patch.id)}"]`);
    if (added) selectVisualElement(added);
    toast("Adaptive boxlet added. Drag its teal handle to move it and its border handles to resize it.");
  } catch (error) { toast(error.message, "error", 6500); }
}

async function deleteVisualObject() {
  const element = state.visualSelection;
  if (!element) return toast("Select a boxlet first.", "error");
  const id = element.getAttribute("data-ut-id");
  if (!confirm(`Delete “${id}”? You can use Undo to restore it.`)) return;
  try {
    dispatchProfilePatch(removeVisualElement(currentHtmlSource(), id));
    await loadHtmlVisual();
    toast(`${id} deleted.`);
  } catch (error) { toast(error.message, "error", 6500); }
}

function scheduleHtmlCompile() {
  clearTimeout(state.htmlCompileTimer);
  if (!isHtmlSource()) return;
  if (state.compileInFlight) {
    state.pendingHtmlCompile = true;
    return;
  }
  state.htmlCompileTimer = setTimeout(() => {
    state.htmlCompileTimer = null;
    void compileProject({ automatic: true });
  }, HTML_COMPILE_DELAY_MS);
}

function editorExtensions(path) {
  const language = isHtmlSource(path) ? htmlLanguage() : isCssSource(path) ? cssLanguage() : StreamLanguage.define(isLayoutSource(path) ? xml : stex);
  const extensions = [
    basicSetup,
    language,
    keymap.of([...defaultKeymap, ...searchKeymap, indentWithTab]),
    EditorView.updateListener.of((update) => {
      if (!update.docChanged || state.replacingEditor) return;
      const wasDirty = state.tabs.get(path)?.dirty;
      const tab = markPathEdited(state.tabs, path, update.state.doc);
      if (!tab) return;
      if (state.activePath === path) {
        setSaveState("Unsaved", "dirty");
        if (!wasDirty) renderTabs();
        scheduleOutline(path);
      }
      if (state.autoSave) {
        clearSaveTimer(tab.path);
        const timer = setTimeout(() => {
          state.saveTimers.delete(tab.path);
          void saveFile(tab).catch(() => {});
        }, AUTOSAVE_DELAY_MS);
        state.saveTimers.set(tab.path, timer);
      }
      if (state.activePath === path) {
        if (state.pdfDocument
          && state.pdfProjectId === state.currentProject?.id
          && state.pdfSourcePath === previewSourcePath(path)) {
          setPdfStale(true);
        }
        if (isHtmlSource(path)) scheduleHtmlCompile();
        else scheduleChangeCompile();
      }
    }),
    EditorView.theme({
      "&": { fontSize: "var(--editor-font-size)" },
      ".cm-content": { padding: "10px 0", caretColor: "#1b222c" },
      ".cm-line": { padding: "0 12px" },
      ".cm-scroller": { lineHeight: "1.48" },
    }),
  ];
  if (state.wordWrap) extensions.push(EditorView.lineWrapping);
  return extensions;
}

function createEditor(content, path) {
  destroyVisualEditor();
  state.editor?.destroy();
  elements.editorHost.innerHTML = "";
  state.replacingEditor = true;
  state.editor = new EditorView({
    state: EditorState.create({ doc: content, extensions: editorExtensions(path) }),
    parent: elements.editorHost,
  });
  state.replacingEditor = false;
  state.editor.focus();
  updateHtmlModeUi();
}

async function openFile(path, line = 0) {
  if (!state.currentProject) return;
  if (state.activePath && state.activePath !== path) {
    try {
      await saveFile(state.tabs.get(state.activePath), { flush: true });
    } catch {
      status("Could not switch files because the current file was not saved");
      return;
    }
  }
  if (state.tabs.has(path)) return activateTab(path, line);
  status(`Opening ${path}…`);
  try {
    const file = await api(`${projectApi("file")}?path=${encodeURIComponent(path)}`);
    state.tabs.set(path, { ...file, dirty: false });
    activateTab(path, line);
    status(`Opened ${path}`);
  } catch (error) {
    toast(error.message, "error");
    status("Could not open file");
  }
}

function activateTab(path, line = 0) {
  const tab = state.tabs.get(path);
  if (!tab) return;
  const sourceChanged = Boolean(state.activePath && state.activePath !== path);
  state.activePath = path;
  if (sourceChanged) showLogs(false);
  createEditor(tabContent(tab), path);
  renderTabs();
  refreshTreeSelection();
  renderOutline(tabContent(tab));
  setSaveState(tab.dirty ? "Unsaved" : "Saved locally", tab.dirty ? "dirty" : "saved");
  elements.compileButton.textContent = isLayoutSource(path) ? "Render layout" : isHtmlSource(path) ? "Render HTML" : "Recompile";
  state.htmlMode = "source";
  updateHtmlModeUi();
  elements.editorHost.inert = state.recoverySources.has(`${state.currentProject?.id || ""}:${path}`);
  void refreshOrCompileSelectedTex(path);
  if (line > 0) goToLine(line);
}

async function refreshOrCompileSelectedTex(path) {
  const projectId = state.currentProject?.id || "";
  const tab = state.tabs.get(path);
  const sourcePath = previewSourcePath(path);
  if (!projectId || !tab || state.activePath !== path) return false;
  // Restore a parsed PDF and its already-painted canvases before making any
  // server request. The lightweight fingerprint check below then confirms
  // whether this instant preview is still current.
  const bufferedKey = pdfPreviewCacheKey(projectId, sourcePath);
  const bufferedPreview = state.pdfCache.get(bufferedKey);
  if (bufferedPreview) await activateBufferedPdf(bufferedKey, bufferedPreview);
  if (isHtmlSource(path)) {
    try {
      const info = await api(`${projectApi("pdf-info")}?sourcePath=${encodeURIComponent(sourcePath)}`);
      if (info.available && !info.stale && !tab.dirty) return refreshPdf(sourcePath, { fingerprint: info.fingerprint });
      scheduleHtmlCompile();
      return false;
    } catch (error) {
      if (error?.status !== 404) toast(`Could not inspect ${path}: ${error.message}`, "error", 6500);
      scheduleHtmlCompile();
      return false;
    }
  }
  if (!isSelectedTexPdfTarget(path, tabContent(tab), state.build?.rootDocument || state.currentProject?.rootDocument || "")) {
    return refreshPdf(sourcePath);
  }
  try {
    const info = await api(`${projectApi("pdf-info")}?sourcePath=${encodeURIComponent(sourcePath)}`);
    if (projectId !== state.currentProject?.id || path !== state.activePath) return false;
    if (shouldReuseSelectedPdf(info) && !tab.dirty) {
      state.failedTexBuilds.delete(texBuildFailureKey(projectId, sourcePath));
      return refreshPdf(sourcePath, { stale: false, fingerprint: info.fingerprint });
    }
    // Switch to the source's existing PDF immediately, then rebuild it in the
    // background when the TeX source is newer. This keeps tab switching fast
    // without leaving a stale preview in place.
    let cachedPreviewShown = false;
    if (info.available) cachedPreviewShown = await refreshPdf(sourcePath, { stale: true, fingerprint: info.fingerprint });
    else if (!bufferedPreview) showPendingPdfPreview(sourcePath);
    if (failedTexBuildMatches(projectId, sourcePath, tab)) {
      if (cachedPreviewShown) status(`Showing the last compiled PDF for ${path}; edit the source or recompile manually to retry.`);
      else showPendingPdfPreview(sourcePath, "No PDF is available. Edit the source or recompile manually to retry.");
      return cachedPreviewShown;
    }
    if (state.compileInFlight) {
      state.pendingTexSelection = `${projectId}:${path}`;
      return cachedPreviewShown;
    }
    void compileProject({ automatic: true });
    return cachedPreviewShown;
  } catch (error) {
    if (error?.status === 404 && projectId === state.currentProject?.id && path === state.activePath) {
      try {
        markTabEdited(tab, tab.content);
        setSaveState("Restoring local file…");
        await saveFile(tab, { flush: true });
        await refreshTree();
        return compileProject({ automatic: true });
      } catch (restoreError) {
        toast(`Could not restore ${path}: ${restoreError.message}`, "error", 6500);
        return false;
      }
    }
    if (projectId === state.currentProject?.id && path === state.activePath) toast(`Could not inspect ${path}: ${error.message}`, "error", 6500);
    return false;
  }
}

async function closeTab(path) {
  const tab = state.tabs.get(path);
  if (!tab) return;
  if (tab.dirty) {
    try { await saveFile(tab, { flush: true }); } catch {
      if (!confirm(`${basenamePath(path)} could not be saved. Close it anyway?`)) return;
    }
  }
  const paths = [...state.tabs.keys()];
  const index = paths.indexOf(path);
  state.tabs.delete(path);
  if (state.activePath === path) {
    const next = paths[index + 1] || paths[index - 1];
    state.activePath = "";
    if (next && state.tabs.has(next)) activateTab(next);
    else {
      state.editor?.destroy();
      state.editor = null;
      elements.editorHost.innerHTML = '<div class="empty-editor"><div class="empty-document-icon">T</div><h1>UnderTree</h1><p>Choose a source file from the project tree.</p></div>';
      elements.fileOutline.innerHTML = "<p>Open a TeX file to see its structure.</p>";
      setSaveState("No file");
    }
  }
  renderTabs();
  refreshTreeSelection();
}

function clearSaveTimer(path) {
  const timer = state.saveTimers.get(path);
  if (timer) clearTimeout(timer);
  state.saveTimers.delete(path);
}

function clearAllSaveTimers() {
  for (const timer of state.saveTimers.values()) clearTimeout(timer);
  state.saveTimers.clear();
}

async function persistTab(tab, snapshot) {
  const persist = (candidate) => api(projectApi("file"), {
    method: "PUT",
    body: JSON.stringify({
      path: tab.path,
      content: candidate.content,
      expectedMtimeMs: candidate.expectedMtimeMs,
      preserveCurrent: candidate.preserveCurrent === true,
    }),
  });
  const refresh = () => api(`${projectApi("file")}?path=${encodeURIComponent(tab.path)}`);
  return persistWithConflictRecovery(snapshot, persist, refresh);
}

async function saveFile(tab, { flush = false } = {}) {
  if (!tab || (!tab.dirty && !tab.savePromise)) return tab;
  clearSaveTimer(tab.path);
  if (tab.path === state.activePath) setSaveState("Saving…");
  try {
    const save = (snapshot) => persistTab(tab, snapshot);
    await (flush ? flushTabSave(tab, save) : saveTabSnapshot(tab, save));
    recordProjectActivity(state.currentProject?.id, "editedAt");
    if (tab.path === state.activePath) setSaveState(tab.dirty ? "Unsaved" : "Saved locally", tab.dirty ? "dirty" : "saved");
    renderTabs();
    renderProjectPicker();
    if (!elements.projectModal.hidden) renderProjectDialog(elements.projectFilter.value);
    status(`Saved ${tab.path}`);
    scheduleStatusRefresh();
    return tab;
  } catch (error) {
    setSaveState("Save conflict", "error");
    toast(error.message, "error", 6500);
    throw error;
  }
}

async function saveActiveFile() {
  return saveFile(state.tabs.get(state.activePath), { flush: true });
}

function scheduleOutline(path) {
  clearTimeout(state.outlineTimer);
  state.outlineTimer = setTimeout(() => {
    state.outlineTimer = null;
    if (path === state.activePath) renderOutline(tabContent(state.tabs.get(path)));
  }, 120);
}

function renderOutline(content) {
  clearTimeout(state.outlineTimer);
  state.outlineTimer = null;
  const layout = isLayoutSource();
  const html = isHtmlSource();
  const headings = documentOutline(content, layout ? "layout" : html ? "html" : false);
  if (layout) {
    elements.fileOutline.innerHTML = headings.length ? headings.map((heading) => `<button class="outline-item level-1" data-line="${heading.line}">${escapeHtml(heading.title)}</button>`).join("") : "<p>No layout headings in this file.</p>";
    elements.fileOutline.querySelectorAll("[data-line]").forEach((button) => button.addEventListener("click", () => goToLine(Number(button.dataset.line))));
    return;
  }
  if (html) {
    elements.fileOutline.innerHTML = headings.length ? headings.map((heading) => `<button class="outline-item level-${heading.level}" data-line="${heading.line}">${escapeHtml(heading.title)}</button>`).join("") : "<p>No semantic HTML headings in this file.</p>";
    elements.fileOutline.querySelectorAll("[data-line]").forEach((button) => button.addEventListener("click", () => goToLine(Number(button.dataset.line))));
    return;
  }
  elements.fileOutline.innerHTML = headings.length ? headings.map((heading) => `<button class="outline-item level-${heading.level}" data-line="${heading.line}">${escapeHtml(heading.title)}</button>`).join("") : "<p>No sections or subsections in this file.</p>";
  elements.fileOutline.querySelectorAll("[data-line]").forEach((button) => button.addEventListener("click", () => goToLine(Number(button.dataset.line))));
}

function goToLine(line) {
  if (!state.editor) return;
  const document = state.editor.state.doc;
  const target = document.line(Math.min(Math.max(1, line), document.lines));
  state.editor.dispatch({ selection: { anchor: target.from }, scrollIntoView: true });
  state.editor.focus();
}

function wrapSelection(prefix, suffix = prefix) {
  if (!state.editor) return;
  const transactions = state.editor.state.changeByRange((range) => {
    const selected = state.editor.state.sliceDoc(range.from, range.to);
    const replacement = `${prefix}${selected}${suffix}`;
    return { changes: { from: range.from, to: range.to, insert: replacement }, range: { anchor: range.from + prefix.length, head: range.from + prefix.length + selected.length } };
  });
  state.editor.dispatch(transactions);
  state.editor.focus();
}

async function refreshTree() {
  if (!state.currentProject) return;
  const data = await api(projectApi("tree"));
  state.tree = data.tree;
  state.build = data.build;
  renderFileTree();
  elements.buildConfig.textContent = `${state.build.rootDocument || "No root"} · ${state.build.engine || "TeX"}`;
}

function firstEditable(nodes, preferred = "") {
  let fallback = "";
  for (const node of nodes) {
    if (node.type === "directory") {
      const found = firstEditable(node.children || [], preferred);
      if (found === preferred) return found;
      fallback ||= found;
    } else if (node.editable) {
      if (node.path === preferred) return preferred;
      if (!fallback && node.path.endsWith(".tex")) fallback = node.path;
    }
  }
  return fallback;
}

async function selectProject(id) {
  if (state.currentProject?.id === id) return;
  try {
    await saveActiveFile();
  } catch {
    if (!confirm("The active file could not be saved. Switch projects anyway?")) return;
  }
  clearAllSaveTimers();
  clearInterval(state.autoCompileTimer);
  clearTimeout(state.autoCompileChangeTimer);
  clearInterval(state.externalTexScanTimer);
  state.autoCompileTimer = null;
  state.autoCompileChangeTimer = null;
  state.externalTexScanTimer = null;
  state.autoCompileMode = "0";
  state.pendingTexSelection = "";
  closeTreeContextMenu();
  state.expandedPaths.clear();
  $("#auto-compile-interval").value = "0";
  state.currentProject = state.projects.find((project) => project.id === id) || null;
  if (!state.currentProject) return;
  restoreCodexRecovery();
  state.build = null;
  recordProjectActivity(id, "openedAt");
  localStorage.setItem("localtex-project", id);
  state.tabs.clear();
  state.activePath = "";
  state.editor?.destroy();
  state.editor = null;
  renderTabs();
  renderProjectPicker();
  elements.projectIcon.removeAttribute("src");
  if (state.currentProject.hasIcon) elements.projectIcon.src = `/api/project/${id}/icon`;
  status(`Loading ${state.currentProject.name}…`);
  try {
    await Promise.all([refreshTree(), refreshGitStatus()]);
    const opening = firstEditable(state.tree, state.build?.rootDocument || state.currentProject.rootDocument);
    if (opening) await openFile(opening);
    else await refreshPdf();
    restoreAutoCompile();
    startExternalTexScan();
    status(`${state.currentProject.name} is ready offline`);
  } catch (error) {
    toast(error.message, "error", 6500);
    status("Project load failed");
  }
}

function activePdfCacheKey() {
  return pdfPreviewCacheKey(state.pdfProjectId, state.pdfSourcePath);
}

function texBuildFailureKey(projectId, sourcePath) {
  return `${projectId}:${String(sourcePath || "")}`;
}

function texTabBuildStamp(tab) {
  return tab ? `${tab.revision || 0}:${Number(tab.mtimeMs) || 0}:${Number(tab.size) || 0}` : "";
}

function failedTexBuildMatches(projectId, sourcePath, tab) {
  const failedStamp = state.failedTexBuilds.get(texBuildFailureKey(projectId, sourcePath));
  return Boolean(failedStamp && failedStamp === texTabBuildStamp(tab) && !tab?.dirty);
}

function rememberFailedTexBuild(projectId, sourcePath) {
  const tab = state.tabs.get(sourcePath);
  if (tab) state.failedTexBuilds.set(texBuildFailureKey(projectId, sourcePath), texTabBuildStamp(tab));
}

function setPdfPlaceholderMessage(message = "Compile the project to render its PDF.") {
  const paragraph = elements.pdfPlaceholder.querySelector("p");
  if (paragraph) paragraph.textContent = message;
}

function showPendingPdfPreview(sourcePath, message = `Compiling ${basenamePath(sourcePath)}…`) {
  rememberActivePdfPreview();
  state.pdfRefreshVersion += 1;
  cancelPdfRenders();
  state.pdfDocument = null;
  state.pdfLoadingTask = null;
  state.pdfProjectId = state.currentProject?.id || "";
  state.pdfSourcePath = sourcePath;
  state.pdfFingerprint = "";
  state.pdfStale = false;
  state.pdfPage = 1;
  state.pdfScale = null;
  state.pdfCurrentScale = 1;
  const container = window.document.createElement("div");
  container.className = "pdf-pages";
  container.id = "pdf-pages";
  elements.pdfPages.replaceWith(container);
  elements.pdfPages = container;
  clearNativePdfFallback();
  elements.htmlProof.hidden = true;
  elements.htmlProof.removeAttribute("src");
  elements.previewPane?.classList.remove("stale-pdf");
  elements.pdfViewer.classList.remove("visible");
  delete elements.pdfViewer.dataset.buffered;
  elements.pdfViewer.dataset.previewSource = sourcePath;
  elements.pdfPlaceholder.classList.remove("hidden");
  setPdfPlaceholderMessage(message);
  elements.downloadPdf.removeAttribute("href");
  elements.downloadPdf.classList.add("disabled");
  elements.downloadPdf.setAttribute("aria-disabled", "true");
  $("#page-status").textContent = "Preparing PDF…";
}

function rememberActivePdfPreview() {
  const key = activePdfCacheKey();
  const entry = key ? state.pdfCache.get(key) : null;
  if (!entry || entry.document !== state.pdfDocument) return null;
  Object.assign(entry, {
    container: elements.pdfPages,
    stale: state.pdfStale,
    page: state.pdfPage,
    scale: state.pdfScale,
    currentScale: state.pdfCurrentScale,
    scrollLeft: elements.pdfViewer.scrollLeft,
    scrollTop: elements.pdfViewer.scrollTop,
  });
  return touchPdfPreviewCache(state.pdfCache, key, entry);
}

function updateActivePdfBuffer() {
  const key = activePdfCacheKey();
  const entry = key ? state.pdfCache.get(key) : null;
  if (!entry || entry.document !== state.pdfDocument) return;
  Object.assign(entry, {
    container: elements.pdfPages,
    stale: state.pdfStale,
    page: state.pdfPage,
    scale: state.pdfScale,
    currentScale: state.pdfCurrentScale,
    scrollLeft: elements.pdfViewer.scrollLeft,
    scrollTop: elements.pdfViewer.scrollTop,
  });
}

function showPdfPreviewShell(sourceQuery) {
  elements.htmlProof.hidden = true;
  elements.htmlProof.removeAttribute("src");
  clearNativePdfFallback();
  elements.pdfViewer.classList.add("visible");
  elements.pdfPlaceholder.classList.add("hidden");
  setPdfPlaceholderMessage();
  elements.downloadPdf.href = `${projectApi("pdf")}?${sourceQuery}download=1`;
  elements.downloadPdf.classList.remove("disabled");
  elements.downloadPdf.removeAttribute("aria-disabled");
}

async function activateBufferedPdf(key, entry, { stale = entry.stale } = {}) {
  rememberActivePdfPreview();
  cancelPdfRenders();
  state.pdfDocument = entry.document;
  state.pdfLoadingTask = entry.loadingTask;
  state.pdfProjectId = entry.projectId;
  state.pdfSourcePath = entry.sourcePath;
  state.pdfFingerprint = entry.fingerprint;
  state.pdfStale = Boolean(stale);
  state.pdfPage = Math.min(entry.page || 1, entry.document.numPages);
  state.pdfScale = entry.scale ?? null;
  state.pdfCurrentScale = entry.currentScale || 1;
  if (entry.container !== elements.pdfPages) {
    elements.pdfPages.replaceWith(entry.container);
    elements.pdfPages = entry.container;
  }
  elements.previewPane?.classList.toggle("stale-pdf", state.pdfStale);
  const sourceQuery = entry.sourcePath ? `sourcePath=${encodeURIComponent(entry.sourcePath)}&` : "";
  showPdfPreviewShell(sourceQuery);
  elements.pdfViewer.dataset.buffered = "true";
  elements.pdfViewer.dataset.previewSource = entry.sourcePath;
  setupPdfObserver();
  elements.pdfViewer.scrollTo({ left: entry.scrollLeft || 0, top: entry.scrollTop || 0 });
  updatePdfToolbar();
  touchPdfPreviewCache(state.pdfCache, key, entry);
  return true;
}

async function storeBufferedPdf(key, entry) {
  touchPdfPreviewCache(state.pdfCache, key, entry);
  for (const evictedKey of pdfPreviewEvictionKeys(state.pdfCache, activePdfCacheKey(), PDF_PREVIEW_CACHE_LIMIT)) {
    const evicted = state.pdfCache.get(evictedKey);
    state.pdfCache.delete(evictedKey);
    evicted?.container?.remove();
    if (evicted) await destroyPdfResource(evicted.loadingTask, evicted.document);
  }
}

async function refreshPdf(sourcePath = previewSourcePath(), { stale, fingerprint = "", forceReload = false } = {}) {
  if (!state.currentProject) return;
  const requestedSource = String(sourcePath || "");
  const refreshVersion = ++state.pdfRefreshVersion;
  const projectId = state.currentProject.id;
  const cacheKey = pdfPreviewCacheKey(projectId, requestedSource);
  const buffered = state.pdfCache.get(cacheKey);
  if (!forceReload && buffered && (!fingerprint || buffered.fingerprint === fingerprint)) {
    return activateBufferedPdf(cacheKey, buffered, { stale: stale ?? buffered.stale });
  }
  const previousDocument = state.pdfDocument;
  const previousLoadingTask = state.pdfLoadingTask;
  const previousProjectId = state.pdfProjectId;
  const previousSourcePath = state.pdfSourcePath;
  const previousFingerprint = state.pdfFingerprint;
  const previousStale = state.pdfStale;
  const previousPage = state.pdfPage;
  const previousScale = state.pdfScale;
  const previousCurrentScale = state.pdfCurrentScale;
  const previousContainer = elements.pdfPages;
  const restorePrevious = Boolean(previousDocument && previousProjectId === state.currentProject.id);
  const preserveExisting = Boolean(previousDocument
    && previousProjectId === state.currentProject.id
    && previousSourcePath === requestedSource);
  const requestedStale = stale ?? (preserveExisting ? previousStale : false);
  const viewAnchor = preserveExisting ? capturePdfViewAnchor() : null;
  let nextDocument = null;
  let nextLoadingTask = null;
  let previewData = null;
  try {
    const sourceQuery = requestedSource ? `sourcePath=${encodeURIComponent(requestedSource)}&` : "";
    const response = await fetch(`${projectApi("pdf")}?${sourceQuery}v=${Date.now()}`, { cache: "no-store", credentials: "same-origin" });
    if (!response.ok) throw new Error(`PDF request failed (${response.status})`);
    const responseFingerprint = response.headers.get("X-UnderTree-PDF-Fingerprint") || fingerprint;
    previewData = await response.arrayBuffer();
    const pdfjs = await loadPdfjs();
    nextLoadingTask = pdfjs.getDocument({ data: previewData });
    nextDocument = await nextLoadingTask.promise;
    if (refreshVersion !== state.pdfRefreshVersion || projectId !== state.currentProject?.id) throw new Error("PDF refresh superseded");
    rememberActivePdfPreview();
    const sameSource = previousProjectId === state.currentProject.id && previousSourcePath === requestedSource;
    state.pdfDocument = nextDocument;
    state.pdfLoadingTask = nextLoadingTask;
    state.pdfProjectId = state.currentProject.id;
    state.pdfSourcePath = requestedSource;
    state.pdfFingerprint = responseFingerprint;
    state.pdfStale = Boolean(requestedStale);
    elements.previewPane?.classList.toggle("stale-pdf", state.pdfStale);
    state.pdfPage = sameSource ? Math.min(previousPage, nextDocument.numPages) : 1;
    state.pdfScale = sameSource ? previousScale : null;
    if (!(await renderPdfPages({ viewAnchor, resetScroll: !sameSource }))) throw new Error("PDF rendering was superseded");
    if (refreshVersion !== state.pdfRefreshVersion || projectId !== state.currentProject?.id) throw new Error("PDF refresh superseded");
    showPdfPreviewShell(sourceQuery);
    elements.pdfViewer.dataset.buffered = "false";
    elements.pdfViewer.dataset.previewSource = requestedSource;
    const replacedBuffer = state.pdfCache.get(cacheKey);
    await storeBufferedPdf(cacheKey, {
      projectId,
      sourcePath: requestedSource,
      fingerprint: responseFingerprint,
      document: nextDocument,
      loadingTask: nextLoadingTask,
      container: elements.pdfPages,
      stale: state.pdfStale,
      page: state.pdfPage,
      scale: state.pdfScale,
      currentScale: state.pdfCurrentScale,
      scrollLeft: elements.pdfViewer.scrollLeft,
      scrollTop: elements.pdfViewer.scrollTop,
    });
    if (replacedBuffer && replacedBuffer.document !== nextDocument) {
      replacedBuffer.container?.remove();
      await destroyPdfResource(replacedBuffer.loadingTask, replacedBuffer.document);
    }
    return true;
  } catch (error) {
    const superseded = refreshVersion !== state.pdfRefreshVersion || projectId !== state.currentProject?.id;
    if (superseded) {
      if (nextLoadingTask && nextLoadingTask !== state.pdfLoadingTask) {
        await destroyPdfResource(nextLoadingTask, nextDocument);
      }
      return true;
    }
    if (nextLoadingTask && nextLoadingTask !== previousLoadingTask) {
      await destroyPdfResource(nextLoadingTask, nextDocument);
    }
    state.pdfDocument = restorePrevious ? previousDocument : null;
    state.pdfLoadingTask = restorePrevious ? previousLoadingTask : null;
    state.pdfProjectId = restorePrevious ? previousProjectId : "";
    state.pdfSourcePath = restorePrevious ? previousSourcePath : "";
    state.pdfFingerprint = restorePrevious ? previousFingerprint : "";
    state.pdfStale = restorePrevious ? previousStale : false;
    elements.previewPane?.classList.toggle("stale-pdf", state.pdfStale);
    state.pdfPage = restorePrevious ? previousPage : 1;
    state.pdfScale = restorePrevious ? previousScale : null;
    state.pdfCurrentScale = restorePrevious ? previousCurrentScale : 1;
    if (restorePrevious) {
      if (previousContainer !== elements.pdfPages) {
        elements.pdfPages.replaceWith(previousContainer);
        elements.pdfPages = previousContainer;
      }
      setupPdfObserver();
    }
    else if (previewData?.byteLength) return showNativePdfFallback(previewData, sourceQuery, requestedSource);
    else await clearPdfPreview(previousDocument, previousLoadingTask);
    appendCompileLog(`[PDF preview] ${error?.message || String(error)}`);
    return false;
  }
}

function clearNativePdfFallback() {
  const fallback = $("#pdf-native-preview");
  fallback.hidden = true;
  fallback.removeAttribute("src");
  if (state.nativePdfUrl) URL.revokeObjectURL(state.nativePdfUrl);
  state.nativePdfUrl = "";
}

function showNativePdfFallback(data, sourceQuery, requestedSource) {
  clearNativePdfFallback();
  state.nativePdfUrl = URL.createObjectURL(new Blob([data], { type: "application/pdf" }));
  const fallback = $("#pdf-native-preview");
  fallback.src = state.nativePdfUrl;
  fallback.hidden = false;
  elements.htmlProof.hidden = true;
  elements.pdfViewer.classList.remove("visible");
  elements.pdfPlaceholder.classList.add("hidden");
  elements.downloadPdf.href = `${projectApi("pdf")}?${sourceQuery}download=1`;
  elements.downloadPdf.classList.remove("disabled");
  elements.downloadPdf.removeAttribute("aria-disabled");
  state.pdfProjectId = state.currentProject?.id || "";
  state.pdfSourcePath = requestedSource;
  $("#page-status").textContent = "PDF preview";
  return true;
}

async function clearPdfPreview(document = state.pdfDocument, loadingTask = state.pdfLoadingTask) {
  cancelPdfRenders();
  if (document || loadingTask) await destroyPdfResource(loadingTask, document);
  state.pdfDocument = null;
  state.pdfLoadingTask = null;
  state.pdfProjectId = "";
  state.pdfSourcePath = "";
  state.pdfFingerprint = "";
  state.pdfStale = false;
  elements.previewPane?.classList.remove("stale-pdf");
  state.pdfPage = 1;
  state.pdfScale = null;
  clearNativePdfFallback();
  elements.pdfPages.replaceChildren();
  elements.pdfViewer.classList.remove("visible");
  delete elements.pdfViewer.dataset.buffered;
  delete elements.pdfViewer.dataset.previewSource;
  elements.pdfViewer.removeAttribute("aria-busy");
  elements.pdfPlaceholder.classList.remove("hidden");
  setPdfPlaceholderMessage();
  elements.downloadPdf.removeAttribute("href");
  elements.downloadPdf.classList.add("disabled");
  elements.downloadPdf.setAttribute("aria-disabled", "true");
  $("#page-status").textContent = "No PDF yet";
}

async function showHtmlProof() {
  if (!state.currentProject) return;
  try {
    const info = await api(projectApi("layout-info"));
    if (!info.available) throw new Error("Compile a .layout.xml source before opening its HTML proof.");
    elements.pdfViewer.classList.remove("visible");
    elements.pdfPlaceholder.classList.add("hidden");
    elements.htmlProof.src = `${projectApi("layout-html")}?v=${Date.now()}`;
    elements.htmlProof.hidden = false;
    $("#page-status").textContent = `HTML proof · ${info.name}`;
    status(`Viewing adaptive HTML proof for ${info.sourcePath}`);
  } catch (error) {
    toast(error.message, "error", 6500);
  }
}

function setPdfStale(stale) {
  state.pdfStale = Boolean(stale && state.pdfDocument);
  elements.previewPane?.classList.toggle("stale-pdf", state.pdfStale);
  updatePdfToolbar();
  updateActivePdfBuffer();
}

function updatePdfToolbar() {
  const totalPages = state.pdfDocument?.numPages || 0;
  const scale = state.pdfScale ?? state.pdfCurrentScale;
  $("#page-status").textContent = totalPages
    ? `${state.pdfPage} of ${totalPages} · ${Math.round(scale * 100)}%${state.pdfStale ? " · cached (source changed)" : ""}`
    : "No PDF yet";
  $("#page-status").title = state.pdfStale
    ? "Showing the last compiled PDF for this source. Recompile to update it."
    : "";
  const previous = $("#pdf-previous");
  const next = $("#pdf-next");
  previous.disabled = totalPages <= 1 || state.pdfPage <= 1;
  next.disabled = totalPages <= 1 || state.pdfPage >= totalPages;
  previous.title = totalPages <= 1 ? "This PDF has only one page" : "Previous PDF page";
  next.title = totalPages <= 1 ? "This PDF has only one page" : "Next PDF page";
}

function cancelPdfRenders() {
  state.pdfRenderVersion += 1;
  state.pdfPageObserver?.disconnect();
  state.pdfPageObserver = null;
  for (const task of state.pdfRenderTasks.values()) task.cancel();
  state.pdfRenderTasks.clear();
}

function capturePdfViewAnchor() {
  const viewer = elements.pdfViewer;
  return {
    x: viewer.scrollWidth ? (viewer.scrollLeft + viewer.clientWidth / 2) / viewer.scrollWidth : 0.5,
    y: viewer.scrollHeight ? (viewer.scrollTop + viewer.clientHeight / 2) / viewer.scrollHeight : 0,
  };
}

function restorePdfViewAnchor(anchor) {
  if (!anchor) return;
  const viewer = elements.pdfViewer;
  viewer.scrollLeft = Math.max(0, anchor.x * viewer.scrollWidth - viewer.clientWidth / 2);
  viewer.scrollTop = Math.max(0, anchor.y * viewer.scrollHeight - viewer.clientHeight / 2);
}

async function renderPdfPageElement(pageNumber, { document = state.pdfDocument, version = state.pdfRenderVersion, container = elements.pdfPages, page = null } = {}) {
  const pageElement = container.querySelector(`.pdf-page[data-page-number="${pageNumber}"]`);
  if (!pageElement || pageElement.dataset.rendered === "true" || pageElement.dataset.rendering === "true") return Boolean(pageElement);
  pageElement.dataset.rendering = "true";
  let pdfPage;
  try {
    pdfPage = page || await document.getPage(pageNumber);
  } catch (error) {
    delete pageElement.dataset.rendering;
    throw error;
  }
  if (version !== state.pdfRenderVersion || document !== state.pdfDocument) {
    delete pageElement.dataset.rendering;
    return false;
  }
  const viewport = pdfPage.getViewport({ scale: state.pdfCurrentScale });
  pageElement.style.width = `${Math.floor(viewport.width)}px`;
  pageElement.style.height = `${Math.floor(viewport.height)}px`;
  const outputScale = boundedPdfOutputScale(viewport.width, viewport.height, window.devicePixelRatio || 1);
  const canvas = window.document.createElement("canvas");
  const context = canvas.getContext("2d", { alpha: false });
  canvas.width = Math.max(1, Math.floor(viewport.width * outputScale));
  canvas.height = Math.max(1, Math.floor(viewport.height * outputScale));
  canvas.style.width = `${Math.floor(viewport.width)}px`;
  canvas.style.height = `${Math.floor(viewport.height)}px`;
  pageElement.replaceChildren(canvas);
  const transform = outputScale === 1 ? null : [outputScale, 0, 0, outputScale, 0, 0];
  const renderTask = pdfPage.render({ canvasContext: context, viewport, transform });
  state.pdfRenderTasks.set(pageNumber, renderTask);
  try {
    await renderTask.promise;
  } catch (error) {
    if (error?.name !== "RenderingCancelledException") throw error;
    return false;
  } finally {
    if (state.pdfRenderTasks.get(pageNumber) === renderTask) state.pdfRenderTasks.delete(pageNumber);
    delete pageElement.dataset.rendering;
  }
  if (version !== state.pdfRenderVersion || document !== state.pdfDocument) return false;
  pageElement.dataset.rendered = "true";
  return true;
}

function setupPdfObserver() {
  state.pdfPageObserver?.disconnect();
  state.pdfPageObserver = null;
  const pages = [...elements.pdfPages.querySelectorAll(".pdf-page")];
  if (!pages.length || !state.pdfDocument) return;
  if (!("IntersectionObserver" in window)) {
    const current = clampPdfPage(state.pdfPage, 0, state.pdfDocument.numPages);
    [current - 1, current, current + 1].filter((page) => page > 0 && page <= state.pdfDocument.numPages)
      .forEach((page) => renderPdfPageElement(page).catch((error) => toast(error.message, "error")));
    return;
  }
  state.pdfPageObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const page = Number(entry.target.dataset.pageNumber);
      renderPdfPageElement(page).catch((error) => toast(error.message, "error"));
    }
  }, { root: elements.pdfViewer, rootMargin: "100% 0px", threshold: 0.01 });
  pages.forEach((page) => state.pdfPageObserver.observe(page));
}

function syncCurrentPdfPage() {
  state.pdfScrollFrame = null;
  if (!state.pdfDocument) return;
  const viewerRect = elements.pdfViewer.getBoundingClientRect();
  let current = state.pdfPage;
  let largestOverlap = -1;
  for (const page of elements.pdfPages.querySelectorAll(".pdf-page")) {
    const rect = page.getBoundingClientRect();
    const overlap = Math.max(0, Math.min(rect.bottom, viewerRect.bottom) - Math.max(rect.top, viewerRect.top));
    if (overlap > largestOverlap) {
      largestOverlap = overlap;
      current = Number(page.dataset.pageNumber);
    }
  }
  if (current !== state.pdfPage) {
    state.pdfPage = current;
    updatePdfToolbar();
  }
  updateActivePdfBuffer();
}

function schedulePdfScrollSync() {
  if (!state.pdfScrollFrame) state.pdfScrollFrame = requestAnimationFrame(syncCurrentPdfPage);
}

async function renderPdfPages({ viewAnchor = null, resetScroll = false } = {}) {
  if (!state.pdfDocument) return false;
  cancelPdfRenders();
  const version = state.pdfRenderVersion;
  const document = state.pdfDocument;
  const requestedPage = clampPdfPage(state.pdfPage, 0, document.numPages);
  elements.pdfViewer.setAttribute("aria-busy", "true");
  elements.pdfViewer.classList.add("visible");
  let stagingContainer = null;
  let committed = false;
  try {
    const referencePage = await document.getPage(requestedPage);
    if (version !== state.pdfRenderVersion || document !== state.pdfDocument) return false;
    const natural = referencePage.getViewport({ scale: 1 });
    const fitScale = Math.max(0.2, (elements.previewStage.clientWidth - 34) / natural.width);
    state.pdfCurrentScale = state.pdfScale ?? fitScale;
    const placeholder = referencePage.getViewport({ scale: state.pdfCurrentScale });
    const container = window.document.createElement("div");
    stagingContainer = container;
    container.className = "pdf-pages";
    container.style.cssText = "position:absolute;left:0;top:0;opacity:0;pointer-events:none";
    for (let page = 1; page <= document.numPages; page += 1) {
      const pageElement = window.document.createElement("div");
      pageElement.className = "pdf-page";
      pageElement.dataset.pageNumber = String(page);
      pageElement.setAttribute("aria-label", `PDF page ${page}`);
      pageElement.style.width = `${Math.floor(placeholder.width)}px`;
      pageElement.style.height = `${Math.floor(placeholder.height)}px`;
      container.append(pageElement);
    }
    // WebKitGTK can lose incremental PDF.js canvas paints while the page tree
    // is detached. Render in an invisible attached staging tree, then swap it
    // in atomically so the previous complete preview remains visible.
    elements.pdfViewer.append(container);
    if (!(await renderPdfPageElement(requestedPage, { document, version, container, page: referencePage }))) return false;
    if (version !== state.pdfRenderVersion || document !== state.pdfDocument) return false;
    container.removeAttribute("style");
    container.id = "pdf-pages";
    elements.pdfPages.replaceWith(container);
    elements.pdfPages = container;
    committed = true;
    setupPdfObserver();
    if (resetScroll) elements.pdfViewer.scrollTo({ left: 0, top: 0 });
    else restorePdfViewAnchor(viewAnchor);
    updatePdfToolbar();
    updateActivePdfBuffer();
    requestAnimationFrame(() => {
      syncCurrentPdfPage();
      const current = state.pdfPage;
      [current - 1, current + 1].filter((page) => page > 0 && page <= document.numPages)
        .forEach((page) => renderPdfPageElement(page).catch((error) => toast(error.message, "error")));
    });
    return true;
  } finally {
    if (!committed) stagingContainer?.remove();
    if (version === state.pdfRenderVersion) elements.pdfViewer.removeAttribute("aria-busy");
  }
}

function schedulePdfFit() {
  clearTimeout(state.pdfResizeTimer);
  if (!state.pdfDocument || state.pdfScale !== null) return;
  const anchor = capturePdfViewAnchor();
  state.pdfResizeTimer = setTimeout(() => renderPdfPages({ viewAnchor: anchor }).catch((error) => toast(error.message, "error")), 120);
}

function changePdfPage(delta) {
  if (!state.pdfDocument) return;
  const nextPage = clampPdfPage(state.pdfPage, delta, state.pdfDocument.numPages);
  if (nextPage === state.pdfPage) {
    updatePdfToolbar();
    return;
  }
  state.pdfPage = nextPage;
  updatePdfToolbar();
  updateActivePdfBuffer();
  const page = elements.pdfPages.querySelector(`.pdf-page[data-page-number="${nextPage}"]`);
  renderPdfPageElement(nextPage).catch((error) => toast(error.message, "error"));
  if (page) {
    const viewerRect = elements.pdfViewer.getBoundingClientRect();
    const pageRect = page.getBoundingClientRect();
    elements.pdfViewer.scrollTo({ top: elements.pdfViewer.scrollTop + pageRect.top - viewerRect.top - 16, behavior: "smooth" });
  }
}

function zoomPdf(factor) {
  if (!state.pdfDocument) return;
  const anchor = capturePdfViewAnchor();
  state.pdfScale = nextPdfScale(state.pdfScale, state.pdfCurrentScale, factor);
  state.pdfCurrentScale = state.pdfScale;
  updatePdfToolbar();
  renderPdfPages({ viewAnchor: anchor }).catch((error) => toast(error.message, "error"));
}

function fitPdfToWidth() {
  if (!state.pdfDocument) return;
  const anchor = capturePdfViewAnchor();
  state.pdfScale = null;
  renderPdfPages({ viewAnchor: anchor }).catch((error) => toast(error.message, "error"));
}

function showCompileMenu(show = $("#compile-popover").hidden) {
  const popover = $("#compile-popover");
  popover.hidden = !show;
  $("#compile-menu").setAttribute("aria-expanded", String(show));
}

function autoCompileStorageKey() {
  // v2 changes the product default from manual builds to live recompilation.
  // A new key lets existing installations receive that default once, while
  // still preserving an explicit Off choice made after this update.
  return state.currentProject ? `localtex-auto-compile-v2:${state.currentProject.id}` : "";
}

function codexRecoveryStorageKey() {
  return state.currentProject ? `localtex-codex-recovery:${state.currentProject.id}` : "";
}

function setCodexRecovery(enabled, { persist = true, announce = true } = {}) {
  state.codexRecoveryEnabled = false;
}

function setAutoCompile(seconds, { persist = true, announce = true } = {}) {
  const allowed = new Set([0, 5, 10, 30, 60, 120]);
  const requested = String(seconds ?? "0");
  const numeric = Number(requested);
  const selected = requested === "changes" ? "changes" : String(allowed.has(numeric) ? numeric : 0);
  clearInterval(state.autoCompileTimer);
  clearTimeout(state.autoCompileChangeTimer);
  state.autoCompileTimer = null;
  state.autoCompileChangeTimer = null;
  state.autoCompileMode = selected;
  $("#auto-compile-interval").value = selected;
  elements.compileButton.title = selected === "changes"
    ? "Automatically recompile shortly after editing stops"
    : Number(selected) ? `Automatic recompile every ${selected} seconds` : "Recompile PDF";
  const key = autoCompileStorageKey();
  if (persist && key) localStorage.setItem(key, selected);
  if (Number(selected)) {
    state.autoCompileTimer = setInterval(() => {
      if (!state.currentProject || elements.compileButton.disabled) return;
      compileProject({ automatic: true });
    }, Number(selected) * 1000);
  }
  if (announce) {
    const message = selected === "changes"
      ? "Live PDF recompilation will run shortly after edits stop."
      : Number(selected) ? `Automatic recompile set to every ${selected} seconds for this project.` : "Automatic recompile turned off for this project.";
    toast(message);
  }
}

function scheduleChangeCompile() {
  if (state.autoCompileMode !== "changes" || !state.currentProject) return;
  clearTimeout(state.autoCompileChangeTimer);
  const projectId = state.currentProject.id;
  state.autoCompileChangeTimer = setTimeout(() => {
    if (state.currentProject?.id !== projectId || state.autoCompileMode !== "changes") return;
    if (state.compileInFlight) {
      scheduleChangeCompile();
      return;
    }
    compileProject({ automatic: true });
  }, LIVE_COMPILE_DELAY_MS);
}

function restoreAutoCompile() {
  const key = autoCompileStorageKey();
  const stored = key ? localStorage.getItem(key) : null;
  setAutoCompile(stored === null ? "changes" : stored, { persist: false, announce: false });
}

async function scanSelectedTexForExternalChanges() {
  const projectId = state.currentProject?.id || "";
  const path = state.activePath;
  const tab = state.tabs.get(path);
  if (!projectId || !isTexSource(path) || !tab || tab.dirty || state.compileInFlight) return false;
  try {
    const file = await api(`${projectApi("file")}?path=${encodeURIComponent(path)}`);
    if (projectId !== state.currentProject?.id || path !== state.activePath) return false;
    if (externalTexChanged(tab, file)) {
      const line = state.editor?.state.doc.lineAt(state.editor.state.selection.main.head).number || 1;
      state.tabs.set(path, { ...file, dirty: false });
      activateTab(path, line);
      status(`Detected external changes in ${path}; recompiling…`);
      return true;
    }
    const info = await api(`${projectApi("pdf-info")}?sourcePath=${encodeURIComponent(path)}`);
    if (!info.available || info.stale) {
      void compileProject({ automatic: true });
      return true;
    }
    const buffered = state.pdfCache.get(pdfPreviewCacheKey(projectId, path));
    if (info.fingerprint && buffered && buffered.fingerprint !== info.fingerprint) {
      await refreshPdf(path, { stale: false, fingerprint: info.fingerprint });
      return true;
    }
  } catch (error) {
    appendCompileLog(`[External TeX scan] ${error.message}`);
  }
  return false;
}

function startExternalTexScan() {
  clearInterval(state.externalTexScanTimer);
  state.externalTexScanTimer = setInterval(() => { void scanSelectedTexForExternalChanges(); }, EXTERNAL_TEX_SCAN_MS);
}

function restoreCodexRecovery() {
  state.codexRecoveryEnabled = false;
}

async function reloadCleanTabsFromDisk() {
  const activePath = state.activePath;
  const activeLine = state.editor ? state.editor.state.doc.lineAt(state.editor.state.selection.main.head).number : 0;
  const conflicts = [];
  for (const [path, tab] of state.tabs) {
    try {
      const file = await api(`${projectApi("file")}?path=${encodeURIComponent(path)}`);
      if (tab.dirty && Math.abs(file.mtimeMs - tab.mtimeMs) > 1) {
        conflicts.push(path);
        continue;
      }
      if (!tab.dirty) state.tabs.set(path, { ...file, dirty: false });
    } catch {}
  }
  if (activePath && state.tabs.has(activePath) && !state.tabs.get(activePath).dirty) activateTab(activePath, activeLine);
  else renderTabs();
  return conflicts;
}

async function monitorCodexRecovery(initial, projectId, sourcePath, { quiet = false } = {}) {
  if (!initial?.id || state.monitoredRecoveries.has(initial.id)) return;
  const recoverySourceKey = `${projectId}:${sourcePath}`;
  state.monitoredRecoveries.add(initial.id);
  state.recoverySources.add(recoverySourceKey);
  if (state.currentProject?.id === projectId && state.activePath === sourcePath) elements.editorHost.inert = true;
  let lastState = "";
  const deadline = Date.now() + 41 * 60 * 1000;
  try {
    while (Date.now() < deadline) {
      const recovery = await api(`${projectApi("codex-recovery")}?id=${encodeURIComponent(initial.id)}`);
      if (recovery.state !== lastState) {
        if (!quiet || ["unresolved", "failed", "rejected"].includes(recovery.state)) {
          appendCompileLog(`[Codex recovery] ${recovery.message}`);
        }
        lastState = recovery.state;
      }
      if (["fixed", "unresolved", "failed", "rejected"].includes(recovery.state)) {
        if (recovery.state === "fixed" && state.currentProject?.id === projectId) {
          const conflicts = await reloadCleanTabsFromDisk();
          await refreshTree();
          if (previewSourcePath() === sourcePath) await refreshPdf(sourcePath, { stale: false, forceReload: true });
          if (!quiet) {
            toast(recovery.message, "success", 6500);
            status("PDF refreshed");
          }
          if (conflicts.length) toast(`Codex changed ${conflicts.join(", ")} while it also has unsaved editor changes. Your unsaved text was preserved; review the save conflict.`, "error", 10000);
        } else if (state.currentProject?.id === projectId) {
          toast(recovery.message, "error", 9000);
          status("Codex could not restore a clean PDF build");
          showLogs(true);
        }
        return;
      }
      if (state.currentProject?.id !== projectId) return;
      if (!quiet) status(recovery.message);
      await new Promise((resolve) => setTimeout(resolve, 800));
    }
    if (state.currentProject?.id === projectId) toast("Background Codex recovery is still running.", "error", 8000);
  } catch (error) {
    if (state.currentProject?.id === projectId) toast(`Could not monitor Codex recovery: ${error.message}`, "error", 8000);
  } finally {
    state.monitoredRecoveries.delete(initial.id);
    state.recoverySources.delete(recoverySourceKey);
    if (state.currentProject?.id === projectId && state.activePath === sourcePath) elements.editorHost.inert = false;
  }
}

async function compileProject({ clean = false, automatic = false, exportTex = false } = {}) {
  if (!state.currentProject || state.compileInFlight) return false;
  const projectId = state.currentProject.id;
  const buildEndpoint = projectApi("build");
  const activePath = state.activePath;
  const sourcePath = previewSourcePath(activePath);
  if (state.recoverySources.has(`${projectId}:${sourcePath}`)) {
    if (!automatic) toast("Codex is already repairing this TeX source; verification will refresh the PDF automatically.", "error", 6500);
    return false;
  }
  state.compileInFlight = true;
  elements.compileButton.disabled = true;
  elements.compileButton.classList.add("busy");
  elements.editorHost.inert = true;
  void loadPdfjs();
  try {
    if (!automatic) {
      showCompileMenu(false);
      showLogs(false);
    }
    const layoutSource = isLayoutSource(sourcePath) ? sourcePath : "";
    const htmlSource = isHtmlSource(sourcePath) ? sourcePath : "";
    elements.compileButton.textContent = clean ? "Cleaning…" : layoutSource || htmlSource ? "Rendering…" : "Compiling…";
    const buildLabel = sourcePath || "project";
    status(`${clean ? "Cleaning and compiling" : htmlSource ? "Fitting and rendering HTML" : layoutSource ? "Rendering adaptive layout" : "Compiling"} ${buildLabel}…`);
    const recoverWithCodex = false;
    const sourceTab = activePath === sourcePath ? state.tabs.get(activePath) : null;
    let sourceSnapshot = null;
    if (sourceTab) {
      clearSaveTimer(sourceTab.path);
      sourceSnapshot = await buildTabSnapshot(sourceTab);
    } else {
      await saveFile(state.tabs.get(activePath), { flush: true });
    }
    const result = await api(buildEndpoint, {
      method: "POST",
      body: JSON.stringify({
        clean,
        sourcePath,
        sourceContent: sourceSnapshot?.content,
        recoverWithCodex,
        exportTex,
      }),
    });
    if (acceptBuildSave(sourceTab, sourceSnapshot, result.sourceSave)) {
      if (sourceSnapshot.dirty || result.sourceSave.conflictPreserved || result.sourceSave.recreated) {
        recordProjectActivity(projectId, "editedAt");
      }
      setSaveState("Saved locally", "saved");
      renderTabs();
      renderProjectPicker();
      if (!elements.projectModal.hidden) renderProjectDialog(elements.projectFilter.value);
      scheduleStatusRefresh();
    }
    elements.compileLog.textContent = result.output || "Compilation finished without output.";
    if (result.code !== 0 || !result.pdfAvailable) {
      rememberFailedTexBuild(projectId, sourcePath);
      if (result.codexRecovery?.id) {
        const recoveryMessage = result.codexRecovery.duplicate
          ? "This TeX failure is already being repaired in the background."
          : "Compilation failed; background formatting-only repair started.";
        if (!automatic) {
          appendCompileLog(`[Codex recovery] ${recoveryMessage}`);
          showLogs(true);
          toast(recoveryMessage, "error", 6500);
          status(result.codexRecovery.message);
        } else {
          status(`${state.currentProject.name} is ready offline`);
        }
        void monitorCodexRecovery(result.codexRecovery, projectId, sourcePath, { quiet: automatic });
        return false;
      }
      const sourceStillSelected = state.currentProject?.id === projectId && previewSourcePath() === sourcePath;
      const cachedPdfKept = sourceStillSelected
        && result.pdfAvailable
        && state.pdfDocument
        && state.pdfProjectId === projectId
        && state.pdfSourcePath === sourcePath;
      if (automatic && cachedPdfKept) {
        setPdfStale(true);
        showLogs(false);
        toast("Background recompile failed; the last good PDF remains visible.", "error", 5500);
        status("Showing cached PDF · background recompile failed");
        return false;
      }
      if (automatic && !sourceStillSelected) return false;
      const recoveryDetail = result.codexRecovery?.message ? ` ${result.codexRecovery.message}` : "";
      throw new Error(`Compilation did not produce a clean PDF.${recoveryDetail} Open the log for details.`);
    }
    state.failedTexBuilds.delete(texBuildFailureKey(projectId, sourcePath));
    if (result.html?.resolvedFits?.length && sourceTab) {
      for (const fit of result.html.resolvedFits) {
        const current = currentHtmlSource();
        const patch = patchElementStyle(current, fit.dataUtId, {
          "--ut-fit-font-size": `${fit.fontSize.toFixed(2)}px`,
          "--ut-fit-line-height": `${fit.lineHeight.toFixed(2)}px`,
          "--ut-fit-gap": `${fit.gap.toFixed(2)}px`,
        });
        if (patch.source !== current) dispatchProfilePatch(patch);
      }
      await saveFile(sourceTab, { flush: true });
    }
    if (state.currentProject?.id === projectId && previewSourcePath() === sourcePath && !(await refreshPdf(sourcePath, { stale: false, forceReload: true }))) {
      appendCompileLog("The PDF compiled successfully, but its preview could not be refreshed.");
      toast("PDF compiled, but the preview renderer failed. The PDF remains available for download.", "error", 8000);
      status("PDF compiled; preview unavailable");
      return false;
    }
    elements.previewPane?.classList.remove("stale-pdf");
    const successMessage = result.html
      ? exportTex ? "HTML PDF and generated LuaLaTeX exported." : "HTML fitted with Pretext and rendered to PDF."
      : result.layout ? "Adaptive HTML, LuaLaTeX, and PDF generated." : "PDF compiled successfully.";
    if (!automatic) toast(successMessage);
    status(`${automatic ? "Auto-compiled" : "Compiled"} at ${new Date(result.compiledAt).toLocaleTimeString()}`);
    return true;
  } catch (error) {
    appendCompileLog(error.message);
    const sourceStillSelected = state.currentProject?.id === projectId && previewSourcePath() === sourcePath;
    if (!automatic) showLogs(true);
    if (!automatic || sourceStillSelected) toast(error.message, "error", 7000);
    if (sourceStillSelected) {
      status("Compilation failed");
      if (automatic && !state.pdfDocument) showPendingPdfPreview(sourcePath, "PDF compilation failed. Open the compile log for details.");
    }
    if (isHtmlSource(sourcePath) && state.pdfDocument) {
      $("#preview-pane").classList.add("stale-pdf");
      $("#page-status").textContent = "Stale PDF · HTML diagnostics in log";
    }
    return false;
  } finally {
    state.compileInFlight = false;
    elements.compileButton.disabled = false;
    elements.compileButton.classList.remove("busy");
    elements.compileButton.textContent = isLayoutSource() ? "Render layout" : isHtmlSource() ? "Render HTML" : "Recompile";
    elements.editorHost.inert = state.recoverySources.has(`${state.currentProject?.id || ""}:${state.activePath}`);
    const pendingSelection = state.pendingTexSelection;
    state.pendingTexSelection = "";
    if (pendingSelection === `${state.currentProject?.id || ""}:${state.activePath}`) {
      queueMicrotask(() => { void refreshOrCompileSelectedTex(state.activePath); });
    }
    if (state.pendingHtmlCompile && isHtmlSource()) {
      state.pendingHtmlCompile = false;
      scheduleHtmlCompile();
    }
  }
}

function attachmentFilename(header, fallback) {
  const encoded = header.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  if (encoded) { try { return decodeURIComponent(encoded); } catch {} }
  return header.match(/filename="([^"]+)"/i)?.[1] || fallback;
}

async function downloadAllPdfs() {
  if (!state.currentProject || elements.downloadAllPdfs.disabled) return;
  try {
    await saveActiveFile();
    elements.downloadAllPdfs.disabled = true; elements.compileButton.disabled = true;
    elements.downloadAllPdfs.textContent = "Bundling…"; status("Compiling every standalone TeX document…");
    const response = await fetch(projectApi("pdf-bundle"), { method: "POST", cache: "no-store", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: "{}" });
    if (!response.ok) {
      const responseText = await response.text(); let body = null;
      try { body = JSON.parse(responseText); } catch {}
      throw new Error(body?.error || responseText || `Bundle request failed (${response.status})`);
    }
    const compiled = Number(response.headers.get("X-LocalTeX-Compiled") || 0);
    const failed = Number(response.headers.get("X-LocalTeX-Failed") || 0);
    const failedSources = decodeURIComponent(response.headers.get("X-LocalTeX-Failed-Sources") || "").split("\n").filter(Boolean);
    const blobUrl = URL.createObjectURL(await response.blob());
    const link = document.createElement("a"); link.href = blobUrl;
    link.download = attachmentFilename(response.headers.get("Content-Disposition") || "", "project-pdfs.zip");
    document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
    const failedDetail = failedSources.length ? ` (${failedSources.slice(0, 3).join(", ")}${failedSources.length > 3 ? ", …" : ""})` : "";
    const message = `Downloaded ${compiled} PDF${compiled === 1 ? "" : "s"}${failed ? `; ${failed} source${failed === 1 ? "" : "s"} could not compile${failedDetail}` : ""}.`;
    toast(message, failed ? "error" : "success", 7000); status(message);
  } catch (error) { toast(error.message, "error", 7000); status("PDF bundle failed"); }
  finally { elements.downloadAllPdfs.disabled = false; elements.compileButton.disabled = false; elements.downloadAllPdfs.textContent = "All PDFs"; }
}

function showLogs(show = !elements.logsPanel.classList.contains("visible")) {
  elements.logsPanel.classList.toggle("visible", show);
  if (show) requestAnimationFrame(() => { elements.compileLog.scrollTop = elements.compileLog.scrollHeight; });
}

function appendCompileLog(message) {
  elements.compileLog.textContent += `\n\n${message}`;
  requestAnimationFrame(() => { elements.compileLog.scrollTop = elements.compileLog.scrollHeight; });
}

async function refreshGitStatus() {
  if (!state.currentProject) return;
  try {
    const git = await api(projectApi("status"));
    const shortHead = git.head ? git.head.slice(0, 9) : "no commit";
    elements.gitState.textContent = git.clean ? `Git clean · ${shortHead}` : `${git.changes.length} local change${git.changes.length === 1 ? "" : "s"}`;
    elements.gitSummary.innerHTML = `
      <div class="git-card"><strong>${git.clean ? "Working tree clean" : `${git.changes.length} uncommitted change${git.changes.length === 1 ? "" : "s"}`}</strong><span>${escapeHtml(git.branchLine || "Git repository")}</span>${git.changes.length ? `<ul class="change-list">${git.changes.slice(0, 80).map((change) => `<li><code>${escapeHtml(change)}</code></li>`).join("")}</ul>` : ""}</div>
      <div class="git-card"><strong>Build</strong><span>${escapeHtml(git.rootDocument)} · ${escapeHtml(git.engine)}</span></div>
      <div class="git-card"><strong>Bridge</strong><span>${escapeHtml(git.repository || "No GitHub mapping")}</span>${git.overleafUrl ? `<br><small>Overleaf mapping configured</small>` : ""}</div>`;
    elements.buildConfig.textContent = `${git.rootDocument || "No root"} · ${git.engine || "TeX"}`;
  } catch (error) {
    elements.gitState.textContent = "Git status unavailable";
    elements.gitSummary.innerHTML = `<p>${escapeHtml(error.message)}</p>`;
  }
}

let statusTimer;
function scheduleStatusRefresh() {
  clearTimeout(statusTimer);
  statusTimer = setTimeout(refreshGitStatus, 1000);
}

async function syncProject(action) {
  if (!state.currentProject) return;
  const labels = {
    pull: ["Pulling remote changes", "Remote changes pulled"],
    push: ["Synchronizing GitHub and Overleaf", "GitHub and Overleaf synchronized"],
    github: ["Synchronizing GitHub", "GitHub synchronized"],
    overleaf: ["Synchronizing Overleaf", "Overleaf synchronized"],
  };
  const [progressLabel, successLabel] = labels[action] || ["Synchronizing", "Synchronization completed"];
  const remoteButtons = [$("#github-sync"), $("#overleaf-sync")];
  try {
    remoteButtons.forEach((button) => { button.disabled = true; });
    await saveActiveFile();
    elements.syncLog.textContent = `${progressLabel} through the direct Git bridge…`;
    status(`${progressLabel}…`);
    const result = await api(projectApi("sync"), { method: "POST", body: JSON.stringify({ action }) });
    elements.syncLog.textContent = result.output || "Synchronization completed.";
    toast(`${successLabel}.`);
    status(successLabel);
    await Promise.all([refreshTree(), refreshGitStatus()]);
  } catch (error) {
    elements.syncLog.textContent += `\n${error.message}`;
    toast(error.message, "error", 7000);
    status("Synchronization stopped safely");
  } finally {
    remoteButtons.forEach((button) => { button.disabled = false; });
  }
}

async function runProjectSearch() {
  const query = elements.projectSearch.value.trim();
  if (query.length < 2) {
    elements.searchResults.innerHTML = "<p>Enter at least two characters.</p>";
    return;
  }
  elements.searchResults.innerHTML = "<p>Searching local source files…</p>";
  try {
    const data = await api(`${projectApi("search")}?q=${encodeURIComponent(query)}`);
    elements.searchResults.innerHTML = data.results.length ? data.results.map((result) => `<button class="search-result" data-path="${escapeHtml(result.path)}" data-line="${result.line}"><strong>${escapeHtml(result.path)}:${result.line}</strong><small>${escapeHtml(result.preview)}</small></button>`).join("") : `<p>No matches for “${escapeHtml(query)}”.</p>`;
    elements.searchResults.querySelectorAll("[data-path]").forEach((button) => button.addEventListener("click", () => openFile(button.dataset.path, Number(button.dataset.line))));
  } catch (error) {
    elements.searchResults.innerHTML = `<p>${escapeHtml(error.message)}</p>`;
  }
}

async function createEntry(type, baseDirectory = null) {
  if (!state.currentProject) return;
  const contextual = typeof baseDirectory === "string";
  const destinationLabel = baseDirectory ? ` in ${baseDirectory}` : " in the project root";
  const label = contextual
    ? `New ${type === "file" ? "file" : "folder"} name${destinationLabel}:`
    : type === "file" ? "New project-relative file path (for example chapters/method.tex):" : "New project-relative folder path:";
  const input = prompt(label)?.trim();
  if (!input) return;
  const path = contextual && baseDirectory ? `${baseDirectory}/${input}` : input;
  try {
    await api(projectApi("files"), { method: "POST", body: JSON.stringify({ path, type }) });
    await refreshTree();
    if (type === "file") await openFile(path);
    toast(`${type === "file" ? "File" : "Folder"} created.`);
  } catch (error) {
    toast(error.message, "error");
  }
}

function switchLeftPanel(name) {
  $$(".rail-button").forEach((button) => button.classList.toggle("active", button.dataset.panel === name));
  $$(".left-view").forEach((view) => view.classList.toggle("active", view.dataset.view === name));
  elements.workspace.classList.remove("left-hidden");
  if (name === "git") refreshGitStatus();
  if (name === "search") requestAnimationFrame(() => elements.projectSearch.focus());
}

function setupResizer(element, side) {
  element.addEventListener("pointerdown", (event) => {
    element.classList.add("dragging");
    element.setPointerCapture(event.pointerId);
    const move = (moveEvent) => {
      if (side === "left") {
        document.documentElement.style.setProperty("--left-width", `${Math.max(190, Math.min(520, moveEvent.clientX - 40))}px`);
      } else {
        const left = 40 + $("#left-panel").getBoundingClientRect().width + 6;
        const available = window.innerWidth - left - 6;
        const editorWidth = Math.max(300, Math.min(available - 350, moveEvent.clientX - left));
        document.documentElement.style.setProperty("--editor-width", `${editorWidth}px`);
      }
    };
    const end = () => {
      element.classList.remove("dragging");
      element.removeEventListener("pointermove", move);
      element.removeEventListener("pointerup", end);
    };
    element.addEventListener("pointermove", move);
    element.addEventListener("pointerup", end);
  });
}

function bindEvents() {
  new ResizeObserver(schedulePdfFit).observe(elements.previewStage);
  elements.pdfViewer.addEventListener("scroll", schedulePdfScrollSync, { passive: true });
  elements.projectPicker.addEventListener("change", () => selectProject(elements.projectPicker.value));
  $("#home-button").addEventListener("click", () => openProjectModal());
  $("#open-project-sort").addEventListener("click", () => openProjectModal(true));
  $("#add-project-folder-top").addEventListener("click", () => { void addProjectFolder().catch((error) => toast(error.message, "error", 7000)); });
  $("#add-project-folder").addEventListener("click", () => { void addProjectFolder().catch((error) => toast(error.message, "error", 7000)); });
  $("#close-project-modal").addEventListener("click", closeProjectModal);
  elements.projectModal.addEventListener("click", (event) => { if (event.target === elements.projectModal) closeProjectModal(); });
  elements.projectFilter.addEventListener("input", () => renderProjectDialog(elements.projectFilter.value));
  elements.projectSort.addEventListener("change", () => {
    state.projectSort = normalizeProjectSort(elements.projectSort.value);
    localStorage.setItem(PROJECT_SORT_STORAGE_KEY, state.projectSort);
    renderProjectPicker();
    renderProjectDialog(elements.projectFilter.value);
  });
  $("#refresh-project").addEventListener("click", async () => {
    await Promise.all([refreshTree(), refreshGitStatus(), refreshPdf(previewSourcePath(), { forceReload: true })]);
    toast("Local project refreshed.");
  });
  $$(".rail-button").forEach((button) => button.addEventListener("click", () => switchLeftPanel(button.dataset.panel)));
  $("#collapse-files").addEventListener("click", () => elements.workspace.classList.toggle("left-hidden"));
  elements.sourceFilesOnly.addEventListener("change", () => setSourceFilesOnly(elements.sourceFilesOnly.checked));
  elements.fileTree.addEventListener("contextmenu", (event) => {
    if (event.target.closest(".tree-row")) return;
    event.preventDefault();
    showTreeContextMenu({ type: "root", path: "", name: state.currentProject?.name || "Project" }, null, event.clientX, event.clientY);
  });
  elements.fileTree.addEventListener("scroll", () => closeTreeContextMenu(), { passive: true });
  elements.fileContextMenu.addEventListener("keydown", (event) => {
    const buttons = [...elements.fileContextMenu.querySelectorAll("[data-tree-action]")];
    const index = buttons.indexOf(document.activeElement);
    let nextIndex = index;
    if (event.key === "ArrowDown") nextIndex = (index + 1) % buttons.length;
    else if (event.key === "ArrowUp") nextIndex = (index - 1 + buttons.length) % buttons.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = buttons.length - 1;
    else if (event.key === "Escape") {
      event.preventDefault();
      closeTreeContextMenu(true);
      return;
    } else return;
    event.preventDefault();
    buttons[nextIndex]?.focus();
  });
  $("#new-file").addEventListener("click", () => createEntry("file"));
  $("#new-folder").addEventListener("click", () => createEntry("directory"));
  $("#undo").addEventListener("click", () => {
    if (!state.editor) return;
    undo(state.editor);
    if (state.htmlMode === "visual") void loadHtmlVisual();
  });
  $("#redo").addEventListener("click", () => {
    if (!state.editor) return;
    redo(state.editor);
    if (state.htmlMode === "visual") void loadHtmlVisual();
  });
  $("#bold").addEventListener("click", () => state.htmlMode === "visual" && isHtmlSource() ? runVisualCommand("bold") : isHtmlSource() || isLayoutSource() ? wrapSelection("<strong>", "</strong>") : wrapSelection("\\textbf{", "}"));
  $("#italic").addEventListener("click", () => state.htmlMode === "visual" && isHtmlSource() ? runVisualCommand("italic") : isHtmlSource() || isLayoutSource() ? wrapSelection("<em>", "</em>") : wrapSelection("\\emph{", "}"));
  $("#underline").addEventListener("click", () => state.htmlMode === "visual" ? runVisualCommand("underline") : wrapSelection("<u>", "</u>"));
  $("#insert-cite").addEventListener("click", () => isHtmlSource() ? runVisualCommand("link") : isLayoutSource() ? toast("Use a semantic <link> or plain citation text in adaptive layouts.") : wrapSelection("\\cite{", "}"));
  elements.htmlModeToggle.querySelectorAll("[data-html-mode]").forEach((button) => button.addEventListener("click", () => { void setHtmlMode(button.dataset.htmlMode); }));
  $("#export-html").addEventListener("click", () => compileProject({ exportTex: true }));
  $("#html-add-boxlet").addEventListener("click", () => { void addVisualBoxlet(); });
  $("#html-delete-object").addEventListener("click", () => { void deleteVisualObject(); });
  $("#html-refit").addEventListener("click", () => { void refitVisualDocument({ announce: true }); });
  $("#html-block-style").addEventListener("change", (event) => event.target.value === "paragraph" ? runVisualCommand("paragraph") : runVisualCommand("heading", event.target.value));
  $("#html-font-size").addEventListener("change", (event) => runVisualCommand("fontSize", event.target.value));
  elements.htmlVisualToolbar.querySelectorAll("[data-html-command]").forEach((button) => button.addEventListener("click", () => runVisualCommand(button.dataset.htmlCommand)));
  elements.htmlVisualToolbar.querySelectorAll("[data-html-align]").forEach((button) => button.addEventListener("click", () => runVisualCommand("align", button.dataset.htmlAlign)));
  $("#html-text-color").addEventListener("input", (event) => runVisualCommand("color", event.target.value));
  $("#search-file").addEventListener("click", () => state.editor && openSearchPanel(state.editor));
  elements.compileButton.addEventListener("click", (event) => { event.preventDefault(); compileProject(); });
  $("#compile-menu").addEventListener("click", (event) => { event.preventDefault(); event.stopPropagation(); showCompileMenu(); });
  $("#auto-compile-interval").addEventListener("change", (event) => setAutoCompile(event.target.value));
  $$("[data-compile-action]").forEach((button) => button.addEventListener("click", () => {
    const action = button.dataset.compileAction;
    showCompileMenu(false);
    if (action === "normal") compileProject();
    else if (action === "clean") compileProject({ clean: true });
    else if (action === "proof") showHtmlProof();
    else if (action === "logs") showLogs(true);
  }));
  $("#toggle-logs").addEventListener("click", () => showLogs());
  elements.downloadAllPdfs.addEventListener("click", downloadAllPdfs);
  $("#close-logs").addEventListener("click", () => showLogs(false));
  $("#reload-pdf").addEventListener("click", () => refreshPdf(previewSourcePath(), { forceReload: true }));
  $("#pdf-previous").addEventListener("click", () => changePdfPage(-1));
  $("#pdf-next").addEventListener("click", () => changePdfPage(1));
  $("#pdf-zoom-out").addEventListener("click", () => zoomPdf(0.82));
  $("#pdf-zoom-in").addEventListener("click", () => zoomPdf(1.22));
  $("#pdf-fit-width").addEventListener("click", fitPdfToWidth);
  $("#hide-preview").addEventListener("click", () => elements.workspace.classList.toggle("preview-hidden"));
  $("#refresh-status").addEventListener("click", refreshGitStatus);
  $("#sync-pull").addEventListener("click", () => syncProject("pull"));
  $("#sync-push").addEventListener("click", () => syncProject("push"));
  $("#github-sync").addEventListener("click", () => syncProject("github"));
  $("#overleaf-sync").addEventListener("click", () => syncProject("overleaf"));
  elements.projectSearch.addEventListener("input", () => {
    clearTimeout(state.searchTimer);
    state.searchTimer = setTimeout(runProjectSearch, 350);
  });
  $("#font-size").addEventListener("input", (event) => document.documentElement.style.setProperty("--editor-font-size", `${event.target.value}px`));
  $("#auto-save").addEventListener("change", (event) => { state.autoSave = event.target.checked; });
  $("#word-wrap").addEventListener("change", (event) => {
    state.wordWrap = event.target.checked;
    if (state.activePath) activateTab(state.activePath);
  });
  $$("[data-menu]").forEach((button) => button.addEventListener("click", () => {
    const action = button.dataset.menu;
    if (action === "file") openProjectModal();
    else if (action === "edit") state.editor && openSearchPanel(state.editor);
    else if (action === "view") elements.workspace.classList.toggle("preview-hidden");
    else if (action === "build") compileProject();
    else toast("UnderTree works entirely on your local project library.");
  }));
  document.addEventListener("click", (event) => {
    if (!event.target.closest(".compile-control")) showCompileMenu(false);
    if (!event.target.closest("#file-context-menu")) closeTreeContextMenu();
  });
  setupResizer($("#left-resizer"), "left");
  setupResizer($("#right-resizer"), "right");
  window.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      saveActiveFile();
    }
    if (event.key === "F5" || ((event.ctrlKey || event.metaKey) && event.key === "Enter")) {
      event.preventDefault();
      compileProject();
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "p") {
      event.preventDefault();
      openProjectModal();
    }
    if (event.key === "Escape" && !elements.fileContextMenu.hidden) closeTreeContextMenu(true);
    else if (event.key === "Escape" && !elements.projectModal.hidden) closeProjectModal();
  });
  window.addEventListener("resize", () => closeTreeContextMenu());
  window.addEventListener("beforeunload", (event) => {
    clearAllSaveTimers();
    clearInterval(state.autoCompileTimer);
    clearTimeout(state.autoCompileChangeTimer);
    clearInterval(state.externalTexScanTimer);
    clearTimeout(state.htmlCompileTimer);
    cancelPdfRenders();
    if ([...state.tabs.values()].some((tab) => tab.dirty)) {
      event.preventDefault();
      event.returnValue = "";
    }
  });
}

async function bootstrap() {
  bindEvents();
  state.sourceFilesOnly = localStorage.getItem("localtex-source-files-only") !== "false";
  elements.sourceFilesOnly.checked = state.sourceFilesOnly;
  const warmPdfRenderer = () => loadPdfjs().catch(() => {});
  if ("requestIdleCallback" in window) window.requestIdleCallback(warmPdfRenderer, { timeout: 1500 });
  else setTimeout(warmPdfRenderer, 500);
  status("Discovering local TeX projects…");
  try {
    const data = await api("/api/projects");
    state.projects = data.projects;
    state.projectSort = normalizeProjectSort(localStorage.getItem(PROJECT_SORT_STORAGE_KEY));
    try {
      const storedActivity = JSON.parse(localStorage.getItem(PROJECT_ACTIVITY_STORAGE_KEY) || "{}");
      state.projectActivity = storedActivity && typeof storedActivity === "object" && !Array.isArray(storedActivity) ? storedActivity : {};
    } catch {
      state.projectActivity = {};
    }
    elements.projectSort.value = state.projectSort;
    renderProjectPicker();
    renderProjectDialog();
    if (!state.projects.length) throw new Error("No local Git/TeX projects were found in the canonical library.");
    const stored = localStorage.getItem("localtex-project");
    const parameters = new URLSearchParams(window.location.search);
    const requested = parameters.get("project");
    const requestedFile = parameters.get("file");
    const preferred = state.projects.find((project) => project.id === requested || project.name === requested)
      || state.projects.find((project) => project.id === stored)
      || state.projects.find((project) => project.name === "pretext-a4-layout-compiler")
      || state.projects[0];
    await selectProject(preferred.id);
    if (requestedFile) {
      try { await openFile(requestedFile); } catch (error) { toast(`Could not open ${requestedFile}: ${error.message}`, "error", 7000); }
    }
  } catch (error) {
    toast(error.message, "error", 9000);
    status("Startup failed");
  }
}

bootstrap();
