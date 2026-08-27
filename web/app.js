const source = document.querySelector("#source");
const compileButton = document.querySelector("#compile-button");
const openProjectButton = document.querySelector("#open-project");
const saveButton = document.querySelector("#save-button");
const statusText = document.querySelector("#status-text");
const statusDot = document.querySelector("#status-dot");
const statusMessage = document.querySelector("#status-message");
const saveState = document.querySelector("#save-state");
const diagnostics = document.querySelector("#diagnostics");
const preview = document.querySelector("#preview");
const previewMeta = document.querySelector("#preview-meta");
const sourceSize = document.querySelector("#source-size");
const projectName = document.querySelector("#project-name");
const fileList = document.querySelector("#file-list");
const activeTabLabel = document.querySelector("#active-tab-label");

let revision = 0;
let activePath = null;
let activeDigest = "";
let compileTimer = null;
let compileInFlight = false;
let pendingCompile = false;
let saveInFlight = false;
let pendingSave = false;
let navigationRequest = 0;
let previewUrls = [];
let previewZoom = 1;

function nativeInvoke(command, args = {}) {
  const invoke = window.__TAURI__?.core?.invoke;
  if (!invoke) {
    return Promise.reject({
      code: "native_unavailable",
      message: "The native Tauri bridge is unavailable. Launch UnderTree through its Rust application.",
      diagnostics: [],
    });
  }
  return invoke(command, args);
}

function setStatus(state, text) {
  statusDot.dataset.state = state;
  statusText.textContent = text;
  statusMessage.textContent = text;
  saveState.textContent = text;
}

function safeErrorMessage(error, fallback) {
  return error && typeof error === "object" && typeof error.message === "string"
    ? error.message
    : fallback;
}

function renderDiagnostics(items = []) {
  diagnostics.replaceChildren();
  if (!items.length) {
    const empty = document.createElement("p");
    empty.textContent = "No compiler messages.";
    diagnostics.append(empty);
    return;
  }
  for (const item of items) {
    const row = document.createElement("div");
    row.className = `diagnostic ${item.severity || "error"}`;

    const message = document.createElement("strong");
    message.textContent = item.message || "Unknown compiler diagnostic";
    row.append(message);

    for (const hintText of item.hints || []) {
      const hint = document.createElement("span");
      hint.textContent = hintText;
      row.append(hint);
    }
    diagnostics.append(row);
  }
}

function releasePreviewUrls() {
  for (const url of previewUrls) URL.revokeObjectURL(url);
  previewUrls = [];
}

function renderPages(pages) {
  releasePreviewUrls();
  const fragment = document.createDocumentFragment();

  for (const [index, svg] of pages.entries()) {
    const page = document.createElement("figure");
    page.className = "page";
    page.style.width = `min(100%, ${Math.round(820 * previewZoom)}px)`;

    const image = document.createElement("img");
    const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
    previewUrls.push(url);
    image.src = url;
    image.alt = `Typst preview page ${index + 1}`;
    page.append(image);
    fragment.append(page);
  }

  preview.replaceChildren(fragment);
}

function updateSourceMetrics() {
  sourceSize.textContent = `${source.value.length.toLocaleString()} chars`;
}

function markActiveFile() {
  for (const button of fileList.querySelectorAll("[data-path]")) {
    button.classList.toggle("active", button.dataset.path === activePath);
  }
}

function renderFiles(files) {
  const fragment = document.createDocumentFragment();
  for (const path of files) {
    const button = document.createElement("button");
    button.className = "tree-row";
    button.type = "button";
    button.dataset.path = path;

    const caret = document.createElement("span");
    caret.className = "tree-caret";
    const icon = document.createElement("span");
    icon.className = "tree-icon";
    icon.textContent = "T";
    const label = document.createElement("span");
    label.className = "tree-label";
    label.textContent = path;
    button.append(caret, icon, label);
    button.addEventListener("click", () => void openDocument(path));
    fragment.append(button);
  }
  fileList.replaceChildren(fragment);
  markActiveFile();
}

function loadDocument(documentData) {
  activePath = documentData.path;
  activeDigest = documentData.digest;
  source.value = documentData.source;
  activeTabLabel.textContent = documentData.path;
  revision += 1;
  saveButton.disabled = false;
  markActiveFile();
  updateSourceMetrics();
  renderDiagnostics();
  setStatus("ready", "Saved");
  void compileLatest();
}

function insertAroundSelection(before, after = before) {
  const start = source.selectionStart;
  const end = source.selectionEnd;
  const selected = source.value.slice(start, end);
  source.setRangeText(`${before}${selected}${after}`, start, end, "select");
  source.dispatchEvent(new Event("input", { bubbles: true }));
  source.focus();
}

function setPreviewZoom(nextZoom) {
  previewZoom = Math.min(1.8, Math.max(0.55, nextZoom));
  for (const page of preview.querySelectorAll(".page")) {
    page.style.width = `min(100%, ${Math.round(820 * previewZoom)}px)`;
  }
}

function scrollPreviewPage(direction) {
  const pages = [...preview.querySelectorAll(".page")];
  if (!pages.length) return;
  const stageTop = document.querySelector("#preview-stage").getBoundingClientRect().top;
  const current = pages.findIndex((page) => page.getBoundingClientRect().bottom > stageTop + 24);
  const target = Math.min(pages.length - 1, Math.max(0, current + direction));
  pages[target].scrollIntoView({ behavior: "smooth", block: "start" });
}

function bindColumnResizer(handle, onMove) {
  handle.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    handle.classList.add("dragging");
    handle.setPointerCapture(event.pointerId);
    const move = (moveEvent) => onMove(moveEvent.clientX);
    const finish = () => {
      handle.classList.remove("dragging");
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", finish);
      handle.removeEventListener("pointercancel", finish);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", finish);
    handle.addEventListener("pointercancel", finish);
  });
}

async function chooseProject() {
  const requestedNavigation = ++navigationRequest;
  openProjectButton.disabled = true;
  setStatus("busy", "Choosing project…");
  try {
    const project = await nativeInvoke("choose_project");
    if (!project) {
      setStatus("ready", activePath ? "Project unchanged" : "Scratch workspace");
      return;
    }
    if (requestedNavigation !== navigationRequest) return;

    projectName.textContent = project.name;
    renderFiles(project.files);
    loadDocument(project.active);
  } catch (error) {
    renderDiagnostics([
      { severity: "error", message: safeErrorMessage(error, "The project could not be opened."), hints: [] },
    ]);
    setStatus("error", "Open failed");
  } finally {
    openProjectButton.disabled = false;
  }
}

async function openDocument(path) {
  if (path === activePath) return;
  const requestedNavigation = ++navigationRequest;
  setStatus("busy", "Opening…");
  try {
    const documentData = await nativeInvoke("open_document", { path });
    if (requestedNavigation !== navigationRequest) return;
    loadDocument(documentData);
  } catch (error) {
    if (requestedNavigation !== navigationRequest) return;
    renderDiagnostics([
      { severity: "error", message: safeErrorMessage(error, "The document could not be opened."), hints: [] },
    ]);
    setStatus("error", "Open failed");
  }
}

async function saveLatest() {
  if (!activePath) {
    setStatus("warning", "Choose a project before saving");
    return;
  }
  if (saveInFlight) {
    pendingSave = true;
    return;
  }

  saveInFlight = true;
  const requestedRevision = revision;
  const requestedPath = activePath;
  const requestedSource = source.value;
  const requestedDigest = activeDigest;
  saveButton.disabled = true;
  setStatus("busy", "Saving…");
  try {
    const result = await nativeInvoke("save_document", {
      request: {
        path: requestedPath,
        source: requestedSource,
        expectedDigest: requestedDigest,
        revision: requestedRevision,
      },
    });

    if (activePath === requestedPath) {
      activeDigest = result.digest;
      if (result.revision === revision) {
        setStatus(
          result.conflictPath ? "warning" : "ready",
          result.conflictPath ? `Saved · conflict preserved at ${result.conflictPath}` : "Saved",
        );
      } else {
        setStatus("dirty", "Unsaved edit");
      }
    }
  } catch (error) {
    if (activePath === requestedPath) {
      renderDiagnostics([
        { severity: "error", message: safeErrorMessage(error, "The document could not be saved."), hints: [] },
      ]);
      setStatus("error", "Save failed");
    }
  } finally {
    saveInFlight = false;
    saveButton.disabled = !activePath;
    if (pendingSave) {
      pendingSave = false;
      void saveLatest();
    }
  }
}

async function compileLatest() {
  if (compileInFlight) {
    pendingCompile = true;
    return;
  }

  compileInFlight = true;
  compileButton.disabled = true;
  const requestedRevision = revision;
  setStatus("busy", "Compiling…");

  try {
    const result = await nativeInvoke("compile_document", {
      request: {
        source: source.value,
        path: activePath,
        revision: requestedRevision,
      },
    });

    if (result.revision !== revision) {
      pendingCompile = true;
      return;
    }

    renderPages(result.pages);
    renderDiagnostics(result.warnings);
    previewMeta.textContent = `${result.pages.length} page${result.pages.length === 1 ? "" : "s"} · ${result.elapsedMs} ms`;
    setStatus(
      result.warnings.length ? "warning" : "ready",
      result.warnings.length ? "Compiled with warnings" : "Preview current",
    );
  } catch (error) {
    const safeError = error && typeof error === "object" ? error : {};
    renderDiagnostics(
      safeError.diagnostics?.length
        ? safeError.diagnostics
        : [{ severity: "error", message: safeError.message || "Compilation failed.", hints: [] }],
    );
    setStatus("error", "Compile failed");
  } finally {
    compileInFlight = false;
    compileButton.disabled = false;
    if (pendingCompile) {
      pendingCompile = false;
      void compileLatest();
    }
  }
}

function scheduleCompile() {
  window.clearTimeout(compileTimer);
  compileTimer = window.setTimeout(() => void compileLatest(), 280);
}

source.addEventListener("input", () => {
  revision += 1;
  updateSourceMetrics();
  setStatus("dirty", activePath ? "Unsaved edit" : "Scratch edit");
  scheduleCompile();
});

openProjectButton.addEventListener("click", () => void chooseProject());
document.querySelector("#home-button").addEventListener("click", () => void chooseProject());
saveButton.addEventListener("click", () => void saveLatest());
compileButton.addEventListener("click", () => void compileLatest());
document.querySelector("#reload-preview").addEventListener("click", () => void compileLatest());
document.querySelector("#refresh-project").addEventListener("click", () => void compileLatest());
document.querySelector("#undo").addEventListener("click", () => {
  source.focus();
  document.execCommand("undo");
});
document.querySelector("#redo").addEventListener("click", () => {
  source.focus();
  document.execCommand("redo");
});
document.querySelector("#bold").addEventListener("click", () => insertAroundSelection("*"));
document.querySelector("#italic").addEventListener("click", () => insertAroundSelection("_"));
document.querySelector("#insert-cite").addEventListener("click", () => insertAroundSelection("@", ""));
document.querySelector("#zoom-out").addEventListener("click", () => setPreviewZoom(previewZoom - 0.1));
document.querySelector("#zoom-in").addEventListener("click", () => setPreviewZoom(previewZoom + 0.1));
document.querySelector("#fit-width").addEventListener("click", () => setPreviewZoom(1));
document.querySelector("#previous-page").addEventListener("click", () => scrollPreviewPage(-1));
document.querySelector("#next-page").addEventListener("click", () => scrollPreviewPage(1));

for (const button of document.querySelectorAll(".rail-button[data-panel]")) {
  button.addEventListener("click", () => {
    for (const peer of document.querySelectorAll(".rail-button[data-panel]")) {
      peer.classList.toggle("active", peer === button);
    }
    for (const view of document.querySelectorAll(".left-view")) {
      view.classList.toggle("active", view.dataset.view === button.dataset.panel);
    }
  });
}

document.querySelector("#font-size").addEventListener("input", (event) => {
  document.documentElement.style.setProperty("--editor-font-size", `${event.target.value}px`);
});

bindColumnResizer(document.querySelector("#left-resizer"), (clientX) => {
  document.documentElement.style.setProperty("--left-width", `${Math.min(480, Math.max(180, clientX - 40))}px`);
});

bindColumnResizer(document.querySelector("#right-resizer"), (clientX) => {
  const editorLeft = document.querySelector("#editor-pane").getBoundingClientRect().left;
  document.documentElement.style.setProperty(
    "--editor-width",
    `${Math.min(window.innerWidth - editorLeft - 356, Math.max(300, clientX - editorLeft))}px`,
  );
});

window.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
    event.preventDefault();
    void compileLatest();
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
    event.preventDefault();
    void saveLatest();
  }
});

window.addEventListener("beforeunload", releasePreviewUrls);

updateSourceMetrics();
nativeInvoke("compiler_info")
  .then((info) => {
    setStatus("ready", `${info.engine} ${info.engineVersion} · embedded Rust`);
    return compileLatest();
  })
  .catch((error) => {
    renderDiagnostics([
      { severity: "error", message: safeErrorMessage(error, "Native compiler unavailable."), hints: [] },
    ]);
    setStatus("error", "Native compiler unavailable");
  });
