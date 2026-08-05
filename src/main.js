import "./styles.css";
import { basicSetup } from "codemirror";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { defaultKeymap, indentWithTab, redo, undo } from "@codemirror/commands";
import { openSearchPanel, searchKeymap } from "@codemirror/search";
import { StreamLanguage } from "@codemirror/language";
import { stex } from "@codemirror/legacy-modes/mode/stex";
import * as pdfjsLib from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const elements = {
  projectPicker: $("#project-picker"),
  projectIcon: $("#project-icon"),
  projectModal: $("#project-modal"),
  projectFilter: $("#project-filter"),
  projectList: $("#project-list"),
  fileTree: $("#file-tree"),
  fileOutline: $("#file-outline"),
  editorHost: $("#editor-host"),
  editorTabs: $("#editor-tabs"),
  saveState: $("#save-state"),
  pdfViewer: $("#pdf-viewer"),
  pdfCanvas: $("#pdf-canvas"),
  previewStage: $("#preview-stage"),
  pdfPlaceholder: $("#pdf-placeholder"),
  downloadPdf: $("#download-pdf"),
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
  workspace: $("#workspace"),
  toastRegion: $("#toast-region"),
};

const state = {
  projects: [],
  currentProject: null,
  tree: [],
  build: null,
  tabs: new Map(),
  activePath: "",
  editor: null,
  replacingEditor: false,
  saveTimer: null,
  searchTimer: null,
  pdfDocument: null,
  pdfPage: 1,
  pdfScale: null,
  pdfCurrentScale: 1,
  pdfRenderTask: null,
  pdfRenderVersion: 0,
  pdfResizeTimer: null,
  autoSave: true,
  wordWrap: true,
};

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
  if (!response.ok) throw new Error(body?.error || body || `${response.status} ${response.statusText}`);
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
  const item = document.createElement("div");
  item.className = `toast ${kind}`;
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

function renderProjectPicker() {
  elements.projectPicker.innerHTML = state.projects.map((project) => `<option value="${project.id}">${escapeHtml(project.name)}</option>`).join("");
  if (state.currentProject) elements.projectPicker.value = state.currentProject.id;
}

function projectMonogram(name) {
  return name.split(/[^A-Za-z0-9ÄÖÜäöüß]+/).filter(Boolean).slice(0, 2).map((word) => word[0]).join("").toUpperCase() || "TX";
}

function renderProjectDialog(filter = "") {
  const needle = filter.trim().toLocaleLowerCase();
  const projects = state.projects.filter((project) => !needle || [project.name, project.repository, project.semanticDomain, project.themes, project.documentFunction].join(" ").toLocaleLowerCase().includes(needle));
  elements.projectList.innerHTML = projects.map((project) => `
    <button class="project-row" data-project="${project.id}">
      ${project.hasIcon ? `<img src="/api/project/${project.id}/icon" alt="" />` : `<span class="project-monogram">${escapeHtml(projectMonogram(project.name))}</span>`}
      <span class="project-details"><strong>${escapeHtml(project.name)}</strong><small>${escapeHtml(project.semanticDomain || project.repository || project.localPath)}</small></span>
      <span class="project-engine">${escapeHtml(project.engine || "TeX")}</span>
    </button>`).join("") || `<p>No local projects match “${escapeHtml(filter)}”.</p>`;
  elements.projectList.querySelectorAll("[data-project]").forEach((button) => button.addEventListener("click", () => {
    closeProjectModal();
    selectProject(button.dataset.project);
  }));
}

function openProjectModal() {
  elements.projectModal.hidden = false;
  elements.projectFilter.value = "";
  renderProjectDialog();
  requestAnimationFrame(() => elements.projectFilter.focus());
}

function closeProjectModal() {
  elements.projectModal.hidden = true;
}

function iconForFile(name) {
  const extension = name.split(".").pop()?.toLowerCase();
  if (extension === "tex") return "T";
  if (["bib", "bst"].includes(extension)) return "⌘";
  if (["png", "jpg", "jpeg", "svg", "pdf"].includes(extension)) return "▧";
  if (["sty", "cls"].includes(extension)) return "⚙";
  return "▱";
}

function renderTree(nodes, depth = 0) {
  const container = document.createDocumentFragment();
  for (const node of nodes) {
    if (node.type === "directory") {
      const directory = document.createElement("div");
      directory.className = "tree-directory";
      const row = document.createElement("button");
      row.className = "tree-row";
      row.style.paddingLeft = `${7 + depth * 14}px`;
      row.innerHTML = `<span class="tree-caret">›</span><span class="tree-icon">▰</span><span class="tree-label">${escapeHtml(node.name)}</span>`;
      row.title = node.path;
      row.addEventListener("click", () => {
        directory.classList.toggle("open");
        row.querySelector(".tree-caret").textContent = directory.classList.contains("open") ? "⌄" : "›";
      });
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
      row.title = `${node.path}${node.editable ? "" : " (preview only)"}`;
      row.innerHTML = `<span class="tree-icon">${iconForFile(node.name)}</span><span class="tree-label">${escapeHtml(node.name)}</span>`;
      row.addEventListener("click", () => node.editable ? openFile(node.path) : toast("This binary or large file is not editable as text.", "error"));
      file.append(row);
      container.append(file);
    }
  }
  return container;
}

function refreshTreeSelection() {
  elements.fileTree.querySelectorAll(".tree-row.active").forEach((row) => row.classList.remove("active"));
  elements.fileTree.querySelectorAll(".tree-row").forEach((row) => {
    if (row.title === state.activePath) row.classList.add("active");
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
    item.querySelector(".editor-tab-label").addEventListener("click", () => activateTab(tab.path));
    item.querySelector(".close-tab").addEventListener("click", () => closeTab(tab.path));
    elements.editorTabs.append(item);
  }
}

function basenamePath(path) {
  return path.split("/").pop() || path;
}

function editorExtensions() {
  const extensions = [
    basicSetup,
    StreamLanguage.define(stex),
    keymap.of([...defaultKeymap, ...searchKeymap, indentWithTab]),
    EditorView.updateListener.of((update) => {
      if (!update.docChanged || state.replacingEditor || !state.activePath) return;
      const tab = state.tabs.get(state.activePath);
      if (!tab) return;
      tab.content = update.state.doc.toString();
      tab.dirty = true;
      setSaveState("Unsaved", "dirty");
      renderTabs();
      renderOutline(tab.content);
      if (state.autoSave) {
        clearTimeout(state.saveTimer);
        state.saveTimer = setTimeout(() => saveActiveFile(), 700);
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

function createEditor(content) {
  state.editor?.destroy();
  elements.editorHost.innerHTML = "";
  state.replacingEditor = true;
  state.editor = new EditorView({
    state: EditorState.create({ doc: content, extensions: editorExtensions() }),
    parent: elements.editorHost,
  });
  state.replacingEditor = false;
  state.editor.focus();
}

async function openFile(path, line = 0) {
  if (!state.currentProject) return;
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
  state.activePath = path;
  createEditor(tab.content);
  renderTabs();
  refreshTreeSelection();
  renderOutline(tab.content);
  setSaveState(tab.dirty ? "Unsaved" : "Saved locally", tab.dirty ? "dirty" : "saved");
  if (line > 0) goToLine(line);
}

async function closeTab(path) {
  const tab = state.tabs.get(path);
  if (!tab) return;
  if (tab.dirty) {
    try { await saveFile(tab); } catch {
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
      elements.editorHost.innerHTML = '<div class="empty-editor"><div class="empty-document-icon">T</div><h1>LocalTeX Studio</h1><p>Choose a source file from the project tree.</p></div>';
      elements.fileOutline.innerHTML = "<p>Open a TeX file to see its structure.</p>";
      setSaveState("No file");
    }
  }
  renderTabs();
  refreshTreeSelection();
}

async function saveFile(tab) {
  if (!tab?.dirty) return tab;
  setSaveState("Saving…");
  try {
    const result = await api(projectApi("file"), {
      method: "PUT",
      body: JSON.stringify({ path: tab.path, content: tab.content, expectedMtimeMs: tab.mtimeMs }),
    });
    tab.mtimeMs = result.mtimeMs;
    tab.size = result.size;
    tab.dirty = false;
    setSaveState("Saved locally", "saved");
    renderTabs();
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
  return saveFile(state.tabs.get(state.activePath));
}

function renderOutline(content) {
  const headings = [];
  const pattern = /^\s*\\(part|chapter|section|subsection|subsubsection|paragraph)\*?\{([^}]*)\}/gm;
  let match;
  while ((match = pattern.exec(content))) {
    const line = content.slice(0, match.index).split("\n").length;
    const level = { part: 1, chapter: 1, section: 1, subsection: 2, subsubsection: 3, paragraph: 3 }[match[1]];
    headings.push({ title: match[2], line, level });
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
  elements.fileTree.innerHTML = "";
  elements.fileTree.append(renderTree(state.tree));
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
  state.currentProject = state.projects.find((project) => project.id === id) || null;
  if (!state.currentProject) return;
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
    await Promise.all([refreshTree(), refreshGitStatus(), refreshPdf()]);
    const opening = firstEditable(state.tree, state.build?.rootDocument || state.currentProject.rootDocument);
    if (opening) await openFile(opening);
    status(`${state.currentProject.name} is ready offline`);
  } catch (error) {
    toast(error.message, "error", 6500);
    status("Project load failed");
  }
}

async function refreshPdf() {
  if (!state.currentProject) return;
  try {
    const info = await api(projectApi("pdf-info"));
    if (!info.available) throw new Error("No PDF available");
    const response = await fetch(`${projectApi("pdf")}?v=${Date.now()}`, { cache: "no-store", credentials: "same-origin" });
    if (!response.ok) throw new Error(`PDF request failed (${response.status})`);
    if (state.pdfDocument) await state.pdfDocument.destroy();
    const loadingTask = pdfjsLib.getDocument({ data: await response.arrayBuffer() });
    state.pdfDocument = await loadingTask.promise;
    state.pdfPage = 1;
    state.pdfScale = null;
    elements.pdfViewer.classList.add("visible");
    elements.pdfPlaceholder.classList.add("hidden");
    elements.downloadPdf.href = `${projectApi("pdf")}?download=1`;
    elements.downloadPdf.classList.remove("disabled");
    elements.downloadPdf.removeAttribute("aria-disabled");
    await renderPdfPage();
  } catch {
    if (state.pdfRenderTask) state.pdfRenderTask.cancel();
    state.pdfRenderTask = null;
    state.pdfDocument = null;
    elements.pdfViewer.classList.remove("visible");
    const context = elements.pdfCanvas.getContext("2d");
    context.clearRect(0, 0, elements.pdfCanvas.width, elements.pdfCanvas.height);
    elements.pdfCanvas.width = 0;
    elements.pdfCanvas.height = 0;
    elements.pdfPlaceholder.classList.remove("hidden");
    elements.downloadPdf.removeAttribute("href");
    elements.downloadPdf.classList.add("disabled");
    elements.downloadPdf.setAttribute("aria-disabled", "true");
    $("#page-status").textContent = "No PDF yet";
  }
}

async function renderPdfPage() {
  if (!state.pdfDocument) return;
  const version = ++state.pdfRenderVersion;
  if (state.pdfRenderTask) state.pdfRenderTask.cancel();
  const page = await state.pdfDocument.getPage(state.pdfPage);
  if (version !== state.pdfRenderVersion) return;
  const natural = page.getViewport({ scale: 1 });
  const fitScale = Math.max(0.2, (elements.previewStage.clientWidth - 34) / natural.width);
  const scale = state.pdfScale || fitScale;
  state.pdfCurrentScale = scale;
  const viewport = page.getViewport({ scale });
  const outputScale = Math.min(window.devicePixelRatio || 1, 2);
  const canvas = elements.pdfCanvas;
  const context = canvas.getContext("2d", { alpha: false });
  canvas.width = Math.max(1, Math.floor(viewport.width * outputScale));
  canvas.height = Math.max(1, Math.floor(viewport.height * outputScale));
  canvas.style.width = `${Math.floor(viewport.width)}px`;
  canvas.style.height = `${Math.floor(viewport.height)}px`;
  const transform = outputScale === 1 ? null : [outputScale, 0, 0, outputScale, 0, 0];
  state.pdfRenderTask = page.render({ canvasContext: context, viewport, transform });
  try {
    await state.pdfRenderTask.promise;
  } catch (error) {
    if (error?.name !== "RenderingCancelledException") throw error;
    return;
  } finally {
    if (version === state.pdfRenderVersion) state.pdfRenderTask = null;
  }
  if (version !== state.pdfRenderVersion) return;
  $("#page-status").textContent = `${state.pdfPage} of ${state.pdfDocument.numPages} · ${Math.round(scale * 100)}%`;
  $("#pdf-previous").disabled = state.pdfPage <= 1;
  $("#pdf-next").disabled = state.pdfPage >= state.pdfDocument.numPages;
}

function schedulePdfFit() {
  clearTimeout(state.pdfResizeTimer);
  if (!state.pdfDocument || state.pdfScale !== null) return;
  state.pdfResizeTimer = setTimeout(() => renderPdfPage().catch((error) => toast(error.message, "error")), 120);
}

function changePdfPage(delta) {
  if (!state.pdfDocument) return;
  state.pdfPage = Math.max(1, Math.min(state.pdfDocument.numPages, state.pdfPage + delta));
  renderPdfPage().catch((error) => toast(error.message, "error"));
}

function zoomPdf(factor) {
  if (!state.pdfDocument) return;
  state.pdfScale = Math.max(0.25, Math.min(4, state.pdfCurrentScale * factor));
  renderPdfPage().catch((error) => toast(error.message, "error"));
}

async function compileProject() {
  if (!state.currentProject) return;
  try {
    await saveActiveFile();
    elements.compileButton.disabled = true;
    elements.compileButton.classList.add("busy");
    elements.compileButton.textContent = "Compiling…";
    status(`Compiling ${state.build?.rootDocument || "project"}…`);
    const result = await api(projectApi("build"), { method: "POST", body: "{}" });
    elements.compileLog.textContent = result.output || "Compilation finished without output.";
    if (!result.pdfAvailable) throw new Error("Compilation did not produce a PDF. Open the log for details.");
    await refreshPdf();
    toast(result.code === 0 ? "PDF compiled successfully." : "PDF produced with warnings; inspect the log.", result.code === 0 ? "success" : "error");
    status(`Compiled at ${new Date(result.compiledAt).toLocaleTimeString()}`);
    if (result.code !== 0) showLogs(true);
  } catch (error) {
    elements.compileLog.textContent += `\n\n${error.message}`;
    showLogs(true);
    toast(error.message, "error", 7000);
    status("Compilation failed");
  } finally {
    elements.compileButton.disabled = false;
    elements.compileButton.classList.remove("busy");
    elements.compileButton.textContent = "Recompile";
  }
}

function showLogs(show = !elements.logsPanel.classList.contains("visible")) {
  elements.logsPanel.classList.toggle("visible", show);
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
  try {
    await saveActiveFile();
    elements.syncLog.textContent = `${action === "pull" ? "Pulling" : "Pushing"} through the direct Git bridge…`;
    const result = await api(projectApi("sync"), { method: "POST", body: JSON.stringify({ action }) });
    elements.syncLog.textContent = result.output || "Synchronization completed.";
    toast(`${action === "pull" ? "Pull" : "Push"} completed.`);
    await Promise.all([refreshTree(), refreshGitStatus()]);
  } catch (error) {
    elements.syncLog.textContent += `\n${error.message}`;
    toast(error.message, "error", 7000);
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

async function createEntry(type) {
  if (!state.currentProject) return;
  const label = type === "file" ? "New project-relative file path (for example chapters/method.tex):" : "New project-relative folder path:";
  const path = prompt(label);
  if (!path) return;
  try {
    await api(projectApi("files"), { method: "POST", body: JSON.stringify({ path, type }) });
    await refreshTree();
    if (type === "file") await openFile(path);
    toast(`${type === "file" ? "File" : "Folder"} created.`);
  } catch (error) {
    toast(error.message, "error");
  }
}

async function openTexstudio() {
  try {
    const result = await api(projectApi("open-texstudio"), { method: "POST", body: "{}" });
    toast(`Opened ${result.rootDocument} in the native TeXstudio profile.`);
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
  elements.projectPicker.addEventListener("change", () => selectProject(elements.projectPicker.value));
  $("#home-button").addEventListener("click", openProjectModal);
  $("#close-project-modal").addEventListener("click", closeProjectModal);
  elements.projectModal.addEventListener("click", (event) => { if (event.target === elements.projectModal) closeProjectModal(); });
  elements.projectFilter.addEventListener("input", () => renderProjectDialog(elements.projectFilter.value));
  $("#refresh-project").addEventListener("click", async () => {
    await Promise.all([refreshTree(), refreshGitStatus(), refreshPdf()]);
    toast("Local project refreshed.");
  });
  $("#open-texstudio").addEventListener("click", openTexstudio);
  $$(".rail-button").forEach((button) => button.addEventListener("click", () => switchLeftPanel(button.dataset.panel)));
  $("#collapse-files").addEventListener("click", () => elements.workspace.classList.toggle("left-hidden"));
  $("#new-file").addEventListener("click", () => createEntry("file"));
  $("#new-folder").addEventListener("click", () => createEntry("directory"));
  $("#undo").addEventListener("click", () => state.editor && undo(state.editor));
  $("#redo").addEventListener("click", () => state.editor && redo(state.editor));
  $("#bold").addEventListener("click", () => wrapSelection("\\textbf{", "}"));
  $("#italic").addEventListener("click", () => wrapSelection("\\emph{", "}"));
  $("#insert-cite").addEventListener("click", () => wrapSelection("\\cite{", "}"));
  $("#search-file").addEventListener("click", () => state.editor && openSearchPanel(state.editor));
  elements.compileButton.addEventListener("click", compileProject);
  $("#compile-menu").addEventListener("click", () => showLogs());
  $("#toggle-logs").addEventListener("click", () => showLogs());
  $("#close-logs").addEventListener("click", () => showLogs(false));
  $("#reload-pdf").addEventListener("click", refreshPdf);
  $("#pdf-previous").addEventListener("click", () => changePdfPage(-1));
  $("#pdf-next").addEventListener("click", () => changePdfPage(1));
  $("#pdf-zoom-out").addEventListener("click", () => zoomPdf(0.82));
  $("#pdf-zoom-in").addEventListener("click", () => zoomPdf(1.22));
  $("#pdf-fit-width").addEventListener("click", () => { state.pdfScale = null; renderPdfPage().catch((error) => toast(error.message, "error")); });
  $("#hide-preview").addEventListener("click", () => elements.workspace.classList.toggle("preview-hidden"));
  $("#refresh-status").addEventListener("click", refreshGitStatus);
  $("#sync-pull").addEventListener("click", () => syncProject("pull"));
  $("#sync-push").addEventListener("click", () => syncProject("push"));
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
    else toast("LocalTeX Studio works entirely on your local project library.");
  }));
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
    if (event.key === "Escape" && !elements.projectModal.hidden) closeProjectModal();
  });
  window.addEventListener("beforeunload", (event) => {
    if ([...state.tabs.values()].some((tab) => tab.dirty)) {
      event.preventDefault();
      event.returnValue = "";
    }
  });
}

async function bootstrap() {
  bindEvents();
  status("Discovering local TeX projects…");
  try {
    const data = await api("/api/projects");
    state.projects = data.projects;
    renderProjectPicker();
    renderProjectDialog();
    if (!state.projects.length) throw new Error("No local Git/TeX projects were found in the canonical library.");
    const stored = localStorage.getItem("localtex-project");
    const requested = new URLSearchParams(window.location.search).get("project");
    const preferred = state.projects.find((project) => project.id === requested || project.name === requested)
      || state.projects.find((project) => project.id === stored)
      || state.projects.find((project) => project.name === "pretext-a4-layout-compiler")
      || state.projects[0];
    await selectProject(preferred.id);
  } catch (error) {
    toast(error.message, "error", 9000);
    status("Startup failed");
  }
}

bootstrap();
