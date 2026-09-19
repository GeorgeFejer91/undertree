const source = document.querySelector("#source");
const sourceModeButton = document.querySelector("#source-mode");
const visualModeButton = document.querySelector("#visual-mode");
const visualEditorShell = document.querySelector("#visual-editor-shell");
const visualEditorPage = document.querySelector("#visual-editor-page");
const editorHost = document.querySelector("#editor-host");
const agentHighlightLayer = document.querySelector("#agent-highlight-layer");
const agentMarkKeepButton = document.querySelector("#agent-mark-keep");
const agentMarkReviseButton = document.querySelector("#agent-mark-revise");
const agentMarkCatalogButton = document.querySelector("#agent-mark-catalog");
const agentMarkCount = document.querySelector("#agent-mark-count");
const agentAnnotationCatalog = document.querySelector("#agent-annotation-catalog");
const agentCatalogCloseButton = document.querySelector("#agent-catalog-close");
const agentAnnotationList = document.querySelector("#agent-annotation-list");
const agentPolicySummary = document.querySelector("#agent-policy-summary");
const agentPolicyVersion = document.querySelector("#agent-policy-version");
const citationPopup = document.querySelector("#citation-popup");
const citationResults = document.querySelector("#citation-results");
const citationSelected = document.querySelector("#citation-selected");
const citationResultCount = document.querySelector("#citation-result-count");
const compileButton = document.querySelector("#compile-button");
const pdfExportButton = document.querySelector("#pdf-export");
const pdfRevealButton = document.querySelector("#pdf-reveal");
const openProjectButton = document.querySelector("#open-project");
const importLatexButton = document.querySelector("#import-latex");
const exportLatexButton = document.querySelector("#export-latex");
const refreshProjectButton = document.querySelector("#refresh-project");
const homeButton = document.querySelector("#home-button");
const projectPicker = document.querySelector("#project-picker");
const newBibliographyButton = document.querySelector("#new-bibliography");
const saveButton = document.querySelector("#save-button");
const statusText = document.querySelector("#status-text");
const statusDot = document.querySelector("#status-dot");
const statusMessage = document.querySelector("#status-message");
const saveState = document.querySelector("#save-state");
const diagnostics = document.querySelector("#diagnostics");
const outlinePanel = document.querySelector("#outline-panel");
const collapseDiagnosticsButton = document.querySelector("#collapse-diagnostics");
const preview = document.querySelector("#preview");
const previewMeta = document.querySelector("#preview-meta");
const sourceSize = document.querySelector("#source-size");
const editorLineNumbers = document.querySelector("#editor-line-numbers");
const editorLineNumberContent = document.querySelector("#editor-line-number-content");
const searchFileButton = document.querySelector("#search-file");
const workspaceFind = document.querySelector("#workspace-find");
const workspaceFindInput = document.querySelector("#workspace-find-input");
const workspaceFindCount = document.querySelector("#workspace-find-count");
const workspaceFindPrevious = document.querySelector("#workspace-find-previous");
const workspaceFindNext = document.querySelector("#workspace-find-next");
const workspaceFindClose = document.querySelector("#workspace-find-close");
const previewFindButton = document.querySelector("#preview-find");
const REMOTE_CONTROL_EVENT = "undertree-remote-control";
const fileList = document.querySelector("#file-list");
const collapseTreeButton = document.querySelector("#collapse-tree");
const showAllFiles = document.querySelector("#show-all-files");
const fileCategoryFilters = [...document.querySelectorAll("[data-file-category]")];
const treeFilterCount = document.querySelector("#tree-filter-count");
const activeTabLabel = document.querySelector("#active-tab-label");
const app = document.querySelector("#app");
const githubButton = document.querySelector("#github-button");
const githubRailButton = document.querySelector("#github-rail-button");
const githubRailStatus = document.querySelector("#github-rail-status");
const githubPanelBadge = document.querySelector("#github-panel-badge");
const githubPanelTitle = document.querySelector("#github-panel-title");
const githubPanelDetail = document.querySelector("#github-panel-detail");
const githubPanelOpen = document.querySelector("#github-panel-open");
const githubPanelProject = document.querySelector("#github-panel-project");
const githubPanelRepository = document.querySelector("#github-panel-repository");
const githubPanelBranch = document.querySelector("#github-panel-branch");
const githubPanelSyncState = document.querySelector("#github-panel-sync-state");
const githubPanelChanges = document.querySelector("#github-panel-changes");
const githubPanelChangeList = document.querySelector("#github-panel-change-list");
const githubFooterState = document.querySelector("#git-state");
const githubModalBackdrop = document.querySelector("#github-modal-backdrop");
const githubDialog = document.querySelector("#github-dialog");
const githubModalClose = document.querySelector("#github-modal-close");
const githubDialogBadge = document.querySelector("#github-dialog-badge");
const githubFeedback = document.querySelector("#github-feedback");
const githubConfigUnavailable = document.querySelector("#github-config-unavailable");
const githubAuthSection = document.querySelector("#github-auth-section");
const githubAccountTitle = document.querySelector("#github-account-title");
const githubAccountDetail = document.querySelector("#github-account-detail");
const githubConnect = document.querySelector("#github-connect");
const githubDeviceCode = document.querySelector("#github-device-code");
const githubUserCode = document.querySelector("#github-user-code");
const githubDeviceCopyState = document.querySelector("#github-device-copy-state");
const githubDeviceInstructions = document.querySelector("#github-device-instructions");
const githubDeviceWait = document.querySelector("#github-device-wait");
const githubRepositorySection = document.querySelector("#github-repository-section");
const githubRepositoryPicker = document.querySelector("#github-repository-picker");
const githubRepositorySort = document.querySelector("#github-repository-sort");
const githubRepositoryVisibility = document.querySelector("#github-repository-visibility");
const githubRepositoryOwnership = document.querySelector("#github-repository-ownership");
const githubRepositoryHelp = document.querySelector("#github-repository-help");
const githubRefreshRepositories = document.querySelector("#github-refresh-repositories");
const githubLinkProject = document.querySelector("#github-link-project");
const githubCloneRepository = document.querySelector("#github-clone-repository");
const githubNewProjectToggle = document.querySelector("#github-new-project-toggle");
const githubNewProjectForm = document.querySelector("#github-new-project-form");
const githubNewProjectName = document.querySelector("#github-new-project-name");
const githubNewProjectDescription = document.querySelector("#github-new-project-description");
const githubNewProjectVisibility = document.querySelector("#github-new-project-visibility");
const githubCreateProject = document.querySelector("#github-create-project");
const githubNewProjectCancel = document.querySelector("#github-new-project-cancel");
const githubProjectSection = document.querySelector("#github-project-section");
const githubProjectRepository = document.querySelector("#github-project-repository");
const githubProjectBranch = document.querySelector("#github-project-branch");
const githubProjectDivergence = document.querySelector("#github-project-divergence");
const githubProjectLastSync = document.querySelector("#github-project-last-sync");
const githubChanges = document.querySelector("#github-changes");
const githubChangeList = document.querySelector("#github-change-list");
const githubCommitMessage = document.querySelector("#github-commit-message");
const githubSyncGuidance = document.querySelector("#github-sync-guidance");
const githubActionButtons = [...document.querySelectorAll("[data-github-action]")];
const githubRulesSection = document.querySelector("#github-rules-section");
const githubSyncInterval = document.querySelector("#github-sync-interval");
const githubAutoCommit = document.querySelector("#github-auto-commit");
const githubSaveRules = document.querySelector("#github-save-rules");
const githubDangerZone = document.querySelector("#github-danger-zone");
const githubUnlinkProject = document.querySelector("#github-unlink-project");
const githubDisconnect = document.querySelector("#github-disconnect");
const githubConfirmBackdrop = document.querySelector("#github-confirm-backdrop");
const githubConfirmDialog = document.querySelector("#github-confirm-dialog");
const githubConfirmTitle = document.querySelector("#github-confirm-title");
const githubConfirmMessage = document.querySelector("#github-confirm-message");
const githubConfirmCancel = document.querySelector("#github-confirm-cancel");
const githubConfirmSecondary = document.querySelector("#github-confirm-secondary");
const githubConfirmAccept = document.querySelector("#github-confirm-accept");
const undoButton = document.querySelector("#undo");
const redoButton = document.querySelector("#redo");
const blockStyle = document.querySelector("#block-style");
const insertElement = document.querySelector("#insert-element");
const typstToolbarControls = ["#bold", "#italic", "#insert-link", "#insert-cite", "#block-style", "#insert-element"].map((selector) =>
  document.querySelector(selector),
);
const typstEditing = window.UnderTreeTypstEditing;
const agentAnnotationEditing = window.UnderTreeAgentAnnotations;

let revision = 0;
let activePath = null;
let activeDigest = "";
let compileTimer = null;
let compileInFlight = false;
let pendingCompile = false;
let compileLoopPromise = null;
let pdfExportInFlight = false;
let lastPdfExport = null;
let saveInFlight = false;
let pendingSave = false;
let saveLoopPromise = null;
let navigationRequest = 0;
let navigationInFlight = false;
let remoteControlBusy = false;
let remoteControlUnlisten = null;
let remoteControlQueue = Promise.resolve();
let remoteControlActivated = false;
let remoteControlBufferedDispatches = [];
let activeProjectRoot = "";
let activeProjectName = "Scratch workspace";
let recentProjects = [];
let previewUrls = [];
let previewZoom = 1;
let editorViewMode = "source";
let visualSelectedLine = null;
let agentPolicy = emptyAgentPolicy();
let agentAnnotationSourceSnapshot = source.value;
let agentAnnotationLoadRequest = 0;
let agentAnnotationPersistTimer = null;
let agentAnnotationPersistQueue = Promise.resolve();
let agentAnnotationMutationSuppressed = false;
let agentAnnotationsDirty = false;
let editorDirty = false;
let editorDirtyBridge = Promise.resolve();
let editorDirtyEnqueued = null;
let editorDirtyBridgeFailed = false;
let editorDirtyRetryTimer = null;
let editorStateHeartbeatTimer = null;
let githubStatusKnown = false;
let githubStatusError = "";
let githubStatusRequest = 0;
let githubProjectGeneration = 0;
let githubRepositoryRequest = 0;
let githubOperationRequest = 0;
let githubUiBusy = false;
let githubRepositories = [];
let githubAuthSession = null;
let githubAuthEpoch = 0;
let githubAuthTimer = null;
let githubAuthPollInFlight = false;
let githubModalReturnFocus = null;
let githubConfirmReturnFocus = null;
let githubConfirmationResolve = null;
let githubConfirmationAcceptValue = true;
let githubConfirmationSecondaryValue = false;
let githubRulesTouched = false;
let githubRulesRepository = "";
let githubSchedulerNotice = null;
let githubSyncUnlisten = null;
let githubCloneUnlisten = null;
let githubUnloading = false;
let conversionDiagnostics = [];
let diagnosticBatchSignature = "";
const dismissedDiagnosticKeys = new Set();
const diagnosticDismissTimers = new Map();
let projectFileEntries = [];
const expandedTreeFolders = new Set();
const fileTreeCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const fittedTextCache = new WeakMap();
const textMeasureCanvas = document.createElement("canvas");
const textMeasureContext = textMeasureCanvas.getContext("2d");
let fittedTextObserver = null;
let editorLineNumberObserver = null;
let editorLineNumberFrame = 0;
let editorLineNumberRenderKey = "";
let workspaceFindReturnFocus = null;
let workspaceFindMatches = [];
let workspaceFindIndex = -1;
let workspaceFindRefreshTimer = null;
let workspaceFindFallbackTarget = null;
const MAX_WORKSPACE_FIND_RESULTS = 2_000;
const MAX_CITATION_RESULTS = 9;
let bibliographyEntries = [];
let bibliographyIssues = [];
let bibliographyRequest = 0;
let citationSession = null;
let currentCitationResults = [];
let suppressCitationTrigger = false;
let githubStatus = {
  authConfigured: false,
  authenticated: false,
  account: null,
  authorizationPending: false,
  projectSelected: false,
  busy: false,
  project: null,
};
const terminalGithubAuthErrors = new Set([
  "authorization_denied",
  "authorization_expired",
  "authorization_failed",
  "authorization_invalid",
  "authorization_missing",
  "device_flow_disabled",
  "github_app_unconfigured",
  "github_scope_denied",
]);

function isTypstDocument(path) {
  return path === null || path.toLowerCase().endsWith(".typ");
}

function isBibliography(path) {
  return typeof path === "string" && path.toLowerCase().endsWith(".bib");
}

function isLatexExportDocument(path) {
  if (typeof path !== "string") return false;
  const name = path.toLowerCase();
  return name.endsWith(".tex") && name.includes(".undertree-export");
}

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
  if (statusMessage.textContent !== text) statusMessage.textContent = text;
  saveState.textContent = text;
}

function safeErrorMessage(error, fallback) {
  return error && typeof error === "object" && typeof error.message === "string"
    ? error.message
    : fallback;
}

function emptyAgentPolicy(path = activePath) {
  return {
    protocolVersion: 1,
    policyVersion: 0,
    path: path || "",
    sourceDigest: "",
    inSync: true,
    scope: "unprotected-text",
    annotations: [],
  };
}

function normalizeAgentPolicy(policy) {
  if (!policy || typeof policy !== "object" || !Array.isArray(policy.annotations)) {
    return emptyAgentPolicy();
  }
  return {
    protocolVersion: Number(policy.protocolVersion) || 1,
    policyVersion: Number(policy.policyVersion) || 0,
    path: typeof policy.path === "string" ? policy.path : (activePath || ""),
    sourceDigest: typeof policy.sourceDigest === "string" ? policy.sourceDigest : "",
    inSync: policy.inSync === true,
    scope: policy.scope === "revise-only" ? "revise-only" : "unprotected-text",
    annotations: policy.annotations
      .filter((annotation) => annotation && typeof annotation.id === "string")
      .map((annotation) => ({
        id: annotation.id,
        kind: annotation.kind === "revise" ? "revise" : "keep",
        startByte: Math.max(0, Number(annotation.startByte) || 0),
        endByte: Math.max(0, Number(annotation.endByte) || 0),
        startLine: Math.max(1, Number(annotation.startLine) || 1),
        endLine: Math.max(1, Number(annotation.endLine) || 1),
        selectedText: typeof annotation.selectedText === "string" ? annotation.selectedText : "",
        note: typeof annotation.note === "string" ? annotation.note : null,
        stale: annotation.stale === true,
      }))
      .sort((left, right) => left.startByte - right.startByte || left.endByte - right.endByte),
  };
}

function updateAgentPolicyScope() {
  agentPolicy.scope = agentPolicy.annotations.some((annotation) => annotation.kind === "revise")
    ? "revise-only"
    : "unprotected-text";
}

function generateAgentAnnotationId(kind) {
  const random = globalThis.crypto?.randomUUID?.().replaceAll("-", "")
    || `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  return `${kind}-${random}`.slice(0, 80);
}

function annotationUtf16Range(annotation, text = source.value) {
  return {
    start: agentAnnotationEditing.byteOffsetToUtf16Index(text, annotation.startByte),
    end: agentAnnotationEditing.byteOffsetToUtf16Index(text, annotation.endByte),
  };
}

function annotationLineRangeFromSource(text, start, end) {
  const startLine = text.slice(0, start).split("\n").length;
  const endLine = text.slice(0, end).split("\n").length;
  return { startLine, endLine };
}

function renderAgentHighlights() {
  if (!agentHighlightLayer) return;
  const text = source.value;
  const computed = window.getComputedStyle(source);
  const lineHeight = editorLineHeight();
  const paddingLeft = Number.parseFloat(computed.paddingLeft) || 0;
  const paddingTop = Number.parseFloat(computed.paddingTop) || 0;
  textMeasureContext.font = computed.font;
  const characterWidth = textMeasureContext.measureText("M").width || 8;
  const fragment = document.createDocumentFragment();

  for (const annotation of agentPolicy.annotations) {
    if (annotation.stale) continue;
    const range = annotationUtf16Range(annotation, text);
    let cursor = range.start;
    while (cursor < range.end) {
      const lineStart = text.lastIndexOf("\n", Math.max(0, cursor - 1)) + 1;
      const lineBreak = text.indexOf("\n", cursor);
      const lineEnd = lineBreak < 0 ? text.length : lineBreak;
      const segmentEnd = Math.min(range.end, lineEnd);
      const row = text.slice(0, lineStart).split("\n").length - 1;
      const before = text.slice(lineStart, cursor).replaceAll("\t", "  ");
      const selected = text.slice(cursor, segmentEnd).replaceAll("\t", "  ");
      const rectangle = document.createElement("span");
      rectangle.className = `agent-highlight-range ${annotation.kind}`;
      rectangle.style.left = `${paddingLeft + before.length * characterWidth - source.scrollLeft}px`;
      rectangle.style.top = `${paddingTop + row * lineHeight - source.scrollTop}px`;
      rectangle.style.width = `${Math.max(3, selected.length * characterWidth)}px`;
      rectangle.style.height = `${lineHeight}px`;
      fragment.append(rectangle);
      if (segmentEnd >= range.end) break;
      cursor = lineBreak + 1;
    }
  }
  agentHighlightLayer.replaceChildren(fragment);
}

function setAgentCatalogOpen(open) {
  const visible = Boolean(open);
  agentAnnotationCatalog.hidden = !visible;
  agentMarkCatalogButton.setAttribute("aria-expanded", String(visible));
  if (visible) renderAgentAnnotationCatalog();
}

function jumpToAgentAnnotation(annotation) {
  if (annotation.stale) return;
  setEditorViewMode("source");
  const range = annotationUtf16Range(annotation);
  source.focus();
  source.setSelectionRange(range.start, range.end);
  const row = source.value.slice(0, range.start).split("\n").length - 1;
  source.scrollTop = Math.max(0, row * editorLineHeight() - source.clientHeight / 3);
  renderEditorLineNumbers();
  renderAgentHighlights();
}

function renderAgentAnnotationCatalog() {
  const annotations = agentPolicy.annotations;
  const keepCount = annotations.filter((annotation) => annotation.kind === "keep").length;
  const reviseCount = annotations.length - keepCount;
  const staleCount = annotations.filter((annotation) => annotation.stale).length;
  agentMarkCount.textContent = String(annotations.length);
  agentMarkCatalogButton.classList.toggle("has-marks", annotations.length > 0);
  agentPolicyVersion.textContent = `Policy v${agentPolicy.policyVersion}`;
  if (staleCount) {
    agentPolicySummary.textContent = `${staleCount} mark${staleCount === 1 ? "" : "s"} need review before an agent can edit.`;
  } else if (reviseCount) {
    agentPolicySummary.textContent = `Agent writes are confined to ${reviseCount} amber revise mark${reviseCount === 1 ? "" : "s"}; ${keepCount} green mark${keepCount === 1 ? " stays" : "s stay"} exact.`;
  } else if (keepCount) {
    agentPolicySummary.textContent = `${keepCount} green keep mark${keepCount === 1 ? " is" : "s are"} immutable; unmarked text may be revised.`;
  } else {
    agentPolicySummary.textContent = "Select prose and mark it Keep or Revise before handing the document to an agent.";
  }

  const fragment = document.createDocumentFragment();
  if (!annotations.length) {
    const empty = document.createElement("p");
    empty.className = "agent-annotation-empty";
    empty.textContent = "No marks yet. A collapsed cursor marks its whole paragraph.";
    fragment.append(empty);
  }
  for (const annotation of annotations) {
    const item = document.createElement("article");
    item.className = `agent-annotation-item ${annotation.kind}${annotation.stale ? " stale" : ""}`;
    item.append(document.createElement("i"));

    const jump = document.createElement("button");
    jump.type = "button";
    jump.className = "annotation-jump";
    jump.disabled = annotation.stale;
    const heading = document.createElement("strong");
    heading.textContent = annotation.stale ? `${annotation.kind} · stale` : `${annotation.kind} · lines ${annotation.startLine}–${annotation.endLine}`;
    const excerpt = document.createElement("small");
    excerpt.textContent = annotation.selectedText.replaceAll(/\s+/g, " ").trim() || "Empty mark";
    excerpt.title = annotation.note || annotation.selectedText;
    jump.append(heading, excerpt);
    jump.addEventListener("click", () => jumpToAgentAnnotation(annotation));
    item.append(jump);

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "annotation-remove";
    remove.textContent = "×";
    remove.title = `Remove ${annotation.kind} mark`;
    remove.setAttribute("aria-label", `Remove ${annotation.kind} mark`);
    remove.addEventListener("click", () => removeAgentAnnotation(annotation.id));
    item.append(remove);
    fragment.append(item);
  }
  agentAnnotationList.replaceChildren(fragment);
}

function renderAgentAnnotations() {
  renderAgentHighlights();
  renderAgentAnnotationCatalog();
  if (editorViewMode === "visual") renderVisualEditor();
}

async function loadAgentAnnotations() {
  const requested = ++agentAnnotationLoadRequest;
  const requestedPath = activePath;
  const requestedSource = source.value;
  agentPolicy = emptyAgentPolicy(requestedPath);
  agentAnnotationSourceSnapshot = requestedSource;
  agentAnnotationsDirty = false;
  renderAgentAnnotations();
  if (!activeProjectRoot || !requestedPath || !isTypstDocument(requestedPath)) return;
  try {
    const policy = await nativeInvoke("agent_annotations", {
      path: requestedPath,
      source: requestedSource,
    });
    if (requested !== agentAnnotationLoadRequest || activePath !== requestedPath || source.value !== requestedSource) return;
    agentPolicy = normalizeAgentPolicy(policy);
    agentAnnotationSourceSnapshot = requestedSource;
    agentAnnotationsDirty = false;
    renderAgentAnnotations();
    if (!agentPolicy.inSync && !agentPolicy.annotations.some((annotation) => annotation.stale)) {
      agentAnnotationsDirty = true;
      await persistAgentAnnotations();
    }
  } catch (error) {
    if (requested !== agentAnnotationLoadRequest || activePath !== requestedPath) return;
    agentPolicy = emptyAgentPolicy(requestedPath);
    renderAgentAnnotations();
    setStatus("warning", safeErrorMessage(error, "AI editing marks unavailable"));
  }
}

function persistAgentAnnotations() {
  window.clearTimeout(agentAnnotationPersistTimer);
  agentAnnotationPersistTimer = null;
  if (!agentAnnotationsDirty) return agentAnnotationPersistQueue.then(() => true);
  agentAnnotationPersistQueue = agentAnnotationPersistQueue
    .catch(() => undefined)
    .then(async () => {
      if (!activeProjectRoot || !activePath || !isTypstDocument(activePath)) return true;
      if (agentPolicy.annotations.some((annotation) => annotation.stale)) {
        throwRemoteFailure(
          "agent_annotation_anchor_stale",
          "Resolve the overlapping or stale AI editing marks before continuing.",
        );
      }
      const requestedPath = activePath;
      const requestedSource = source.value;
      const inputs = agentPolicy.annotations.map(agentAnnotationEditing.toAnnotationInput);
      const expectedPolicyVersion = agentPolicy.policyVersion;
      const policy = await nativeInvoke("set_agent_annotations", {
        request: {
          path: requestedPath,
          source: requestedSource,
          expectedPolicyVersion,
          annotations: inputs,
        },
      });
      if (activePath !== requestedPath) return true;
      const normalized = normalizeAgentPolicy(policy);
      if (source.value === requestedSource) {
        agentPolicy = normalized;
        agentAnnotationsDirty = false;
      } else {
        agentPolicy.policyVersion = normalized.policyVersion;
        agentPolicy.inSync = false;
        agentAnnotationsDirty = true;
        scheduleAgentAnnotationPersistence(0);
      }
      renderAgentAnnotations();
      return source.value === requestedSource;
    })
    .catch((error) => {
      setStatus("warning", safeErrorMessage(error, "AI editing marks were not saved"));
      return false;
    });
  return agentAnnotationPersistQueue;
}

function scheduleAgentAnnotationPersistence(delay = 420) {
  window.clearTimeout(agentAnnotationPersistTimer);
  agentAnnotationPersistTimer = window.setTimeout(() => void persistAgentAnnotations(), delay);
}

async function flushAgentAnnotations() {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const synchronized = await persistAgentAnnotations();
    if (synchronized) return true;
  }
  return false;
}

function markAgentSelection(kind) {
  if (!activeProjectRoot || !activePath || !isTypstDocument(activePath) || source.readOnly) {
    setStatus("warning", "Open an editable Typst project document to add an AI mark");
    return;
  }
  let range;
  if (editorViewMode === "visual" && visualSelectedLine) {
    range = {
      start: Number(visualSelectedLine.dataset.sourceStart) || 0,
      end: Number(visualSelectedLine.dataset.sourceEnd) || 0,
    };
  } else {
    range = agentAnnotationEditing.selectedOrParagraphRange(
      source.value,
      source.selectionStart,
      source.selectionEnd,
    );
  }
  if (range.end <= range.start) {
    setStatus("warning", "Select text or place the cursor inside a paragraph first");
    return;
  }
  const startByte = agentAnnotationEditing.utf16IndexToByteOffset(source.value, range.start);
  const endByte = agentAnnotationEditing.utf16IndexToByteOffset(source.value, range.end);
  const overlapping = agentPolicy.annotations.find(
    (annotation) => annotation.startByte < endByte && startByte < annotation.endByte,
  );
  if (overlapping) {
    if (overlapping.startByte === startByte && overlapping.endByte === endByte) {
      overlapping.kind = kind;
      overlapping.stale = false;
      updateAgentPolicyScope();
      agentAnnotationsDirty = true;
      renderAgentAnnotations();
      void persistAgentAnnotations();
      return;
    }
    setStatus("warning", "AI editing marks cannot overlap; remove or split the existing mark first");
    setAgentCatalogOpen(true);
    return;
  }
  const lines = annotationLineRangeFromSource(source.value, range.start, range.end);
  agentPolicy.annotations.push({
    id: generateAgentAnnotationId(kind),
    kind,
    startByte,
    endByte,
    startLine: lines.startLine,
    endLine: lines.endLine,
    selectedText: source.value.slice(range.start, range.end),
    note: null,
    stale: false,
  });
  agentPolicy.annotations.sort((left, right) => left.startByte - right.startByte);
  updateAgentPolicyScope();
  agentAnnotationsDirty = true;
  renderAgentAnnotations();
  setStatus("ready", kind === "keep" ? "Marked Keep · agents cannot rewrite it" : "Marked Revise · agent target added");
  void persistAgentAnnotations();
}

function removeAgentAnnotation(id) {
  agentPolicy.annotations = agentPolicy.annotations.filter((annotation) => annotation.id !== id);
  updateAgentPolicyScope();
  agentAnnotationsDirty = true;
  renderAgentAnnotations();
  void persistAgentAnnotations();
}

function rebaseAgentAnnotationsAfterHumanEdit(previous, next) {
  if (agentAnnotationMutationSuppressed || !agentPolicy.annotations.length) return;
  agentPolicy.annotations = agentAnnotationEditing.rebaseAnnotations(
    previous,
    next,
    agentPolicy.annotations,
  );
  updateAgentPolicyScope();
  agentPolicy.inSync = false;
  agentAnnotationsDirty = true;
  renderAgentAnnotations();
  scheduleAgentAnnotationPersistence();
}

function renderVisualEditor() {
  if (!visualEditorPage) return;
  visualSelectedLine = null;
  const fragment = document.createDocumentFragment();
  let hiddenDirectiveDepth = 0;
  let sourceCursor = 0;
  let byteCursor = 0;
  for (const [index, rawLine] of source.value.split("\n").entries()) {
    const line = document.createElement("div");
    const trimmed = rawLine.trim();
    const lineStart = sourceCursor;
    const lineEnd = lineStart + rawLine.length;
    const lineStartByte = byteCursor;
    const lineEndByte = lineStartByte + agentAnnotationEditing.utf16IndexToByteOffset(rawLine, rawLine.length);
    line.className = "visual-editor-line";
    line.dataset.line = String(index);
    line.dataset.sourceStart = String(lineStart);
    line.dataset.sourceEnd = String(lineEnd);
    const opensDirective = /^#(?:set|let|show)\b/.test(trimmed);
    const opensWrapper = /^#(?:align|block)\([^)]*\)\[$/.test(trimmed);
    if (hiddenDirectiveDepth > 0) {
      line.classList.add("visual-hidden-syntax");
      hiddenDirectiveDepth += (rawLine.match(/\(/g) || []).length;
      hiddenDirectiveDepth -= (rawLine.match(/\)/g) || []).length;
      if (hiddenDirectiveDepth <= 0) hiddenDirectiveDepth = 0;
      line.textContent = " ";
    } else if (opensDirective) {
      line.classList.add("visual-hidden-syntax");
      hiddenDirectiveDepth = Math.max(0,
        (rawLine.match(/\(/g) || []).length - (rawLine.match(/\)/g) || []).length,
      );
      line.textContent = " ";
    } else if (opensWrapper || !trimmed || trimmed === "]" || trimmed === ")") {
      line.classList.add("visual-editor-blank");
      line.textContent = " ";
    } else if (/^=+\s/.test(trimmed)) {
      const depth = Math.min(3, trimmed.match(/^=+/)[0].length);
      line.classList.add(`visual-heading-${depth}`);
      line.textContent = trimmed.replace(/^=+\s*/, "");
    } else if (/^\/\//.test(trimmed)) {
      line.classList.add("visual-comment");
      line.textContent = trimmed.replace(/^\/\/\s?/, "");
    } else {
      const surface = trimmed
        .replace(/^#(?:align|block|text|emph|strong)\([^)]*\)\[/, "")
        .replace(/^#link\([^)]*\)\[/, "")
        .replace(/\]$/, "")
        .replace(/^#(?:v|pagebreak)\([^)]*\)$/, "")
        .replace(/^#(?:set|let|show)\b/, "")
        .replace(/\*([^*\n]+)\*/g, "$1")
        .replace(/_([^_\n]+)_/g, "$1");
      line.textContent = surface || " ";
      if (/\$.*\$/.test(surface)) line.classList.add("visual-math");
    }
    const lineAnnotations = agentPolicy.annotations.filter((annotation) => (
      annotation.stale
        ? annotation.startLine <= index + 1 && annotation.endLine >= index + 1
        : annotation.startByte < Math.max(lineStartByte + 1, lineEndByte)
          && lineStartByte < annotation.endByte
    ));
    if (lineAnnotations.some((annotation) => annotation.stale)) {
      line.classList.add("agent-stale");
      line.title = "This AI editing mark needs review";
    } else if (lineAnnotations.some((annotation) => annotation.kind === "revise")) {
      line.classList.add("agent-revise");
      line.title = "Revise · agent writable";
    } else if (lineAnnotations.some((annotation) => annotation.kind === "keep")) {
      line.classList.add("agent-keep");
      line.title = "Keep · protected from agent edits";
    }
    fragment.append(line);
    sourceCursor = lineEnd + 1;
    byteCursor = lineEndByte + 1;
  }
  visualEditorPage.replaceChildren(fragment);
}

function setEditorViewMode(mode) {
  editorViewMode = mode === "visual" ? "visual" : "source";
  const visual = editorViewMode === "visual";
  editorHost.classList.toggle("visual-mode", visual);
  visualEditorShell.hidden = !visual;
  sourceModeButton.classList.toggle("active", !visual);
  visualModeButton.classList.toggle("active", visual);
  sourceModeButton.setAttribute("aria-pressed", String(!visual));
  visualModeButton.setAttribute("aria-pressed", String(visual));
  if (visual) renderVisualEditor();
  else renderAgentHighlights();
}

function applyVisualCommand(command) {
  const line = visualSelectedLine || visualEditorPage?.querySelector(".visual-editor-line");
  if (!line) return;
  if (command === "undo" || command === "redo") return;
  if (command === "clear") {
    line.className = "visual-editor-line";
    return;
  }
  if (command.startsWith("align-")) {
    line.classList.remove("visual-align-left", "visual-align-center", "visual-align-right");
    line.classList.add(`visual-${command}`);
    return;
  }
  line.classList.toggle(`visual-${command}`);
}

function truncateUtf8(value, maximumBytes) {
  const encoder = new TextEncoder();
  let bytes = 0;
  let result = "";
  for (const character of value) {
    const characterBytes = encoder.encode(character).length;
    if (bytes + characterBytes > maximumBytes) break;
    result += character;
    bytes += characterBytes;
  }
  return result;
}

function normalizeRemoteFailure(error, fallbackCode = "remote_action_failed", fallbackMessage = "UnderTree could not complete the remote request.") {
  const codePattern = /^[a-z0-9_]{1,64}$/;
  const candidateCode = error && typeof error === "object" && typeof error.code === "string"
    ? error.code.trim()
    : "";
  const safeFallbackCode = codePattern.test(fallbackCode) ? fallbackCode : "remote_action_failed";
  const code = codePattern.test(candidateCode) ? candidateCode : safeFallbackCode;
  const candidateMessage = safeErrorMessage(error, fallbackMessage).replaceAll("\0", "").trim();
  return {
    code,
    message: truncateUtf8(candidateMessage || fallbackMessage, 1_000),
  };
}

function throwRemoteFailure(code, message) {
  throw { code, message };
}

function createSvgIcon(className, pathData, viewBox = "0 0 16 16") {
  const svg = document.createElementNS(SVG_NAMESPACE, "svg");
  svg.setAttribute("viewBox", viewBox);
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add(className);
  const path = document.createElementNS(SVG_NAMESPACE, "path");
  path.setAttribute("d", pathData);
  svg.append(path);
  return svg;
}

function createChevronIcon(direction = "right") {
  const wrapper = document.createElement("span");
  wrapper.className = `ui-chevron ${direction}`;
  wrapper.setAttribute("aria-hidden", "true");
  wrapper.append(createSvgIcon("ui-chevron-svg", "m6 3 5 5-5 5"));
  return wrapper;
}

function createFolderIcon() {
  return createSvgIcon(
    "tree-folder-icon",
    "M2.25 4.75V3.5h5.1l1.55 1.25h8.85v9.5H2.25z",
    "0 0 20 18",
  );
}

function editorLineHeight() {
  const computed = window.getComputedStyle(source);
  const lineHeight = Number.parseFloat(computed.lineHeight);
  return Number.isFinite(lineHeight) && lineHeight > 0
    ? lineHeight
    : (Number.parseFloat(computed.fontSize) || 14) * 1.45;
}

function editorCurrentLine() {
  const end = Math.min(source.selectionStart || 0, source.value.length);
  let line = 0;
  for (let index = 0; index < end; index += 1) {
    if (source.value.charCodeAt(index) === 10) line += 1;
  }
  return line;
}

function paintEditorLineNumbers() {
  editorLineNumberFrame = 0;
  const totalLines = Math.max(1, (source.value.match(/\n/g)?.length || 0) + 1);
  const computed = window.getComputedStyle(source);
  const fontSize = Number.parseFloat(computed.fontSize) || 14;
  const gutterWidth = Math.max(44, Math.ceil(22 + String(totalLines).length * fontSize * 0.62));
  document.documentElement.style.setProperty("--editor-line-gutter", `${gutterWidth}px`);

  const lineHeight = editorLineHeight();
  const paddingTop = Number.parseFloat(computed.paddingTop) || 0;
  const first = Math.max(0, Math.floor((source.scrollTop - paddingTop) / lineHeight) - 3);
  const visibleCount = Math.ceil(source.clientHeight / lineHeight) + 7;
  const last = Math.min(totalLines, first + visibleCount);
  const current = editorCurrentLine();
  const renderKey = `${totalLines}:${first}:${last}:${current}:${lineHeight}`;
  if (renderKey !== editorLineNumberRenderKey) {
    const fragment = document.createDocumentFragment();
    for (let line = first; line < last; line += 1) {
      const number = document.createElement("span");
      number.className = `editor-line-number${line === current ? " current" : ""}`;
      number.textContent = String(line + 1);
      number.style.height = `${lineHeight}px`;
      number.style.lineHeight = `${lineHeight}px`;
      fragment.append(number);
    }
    editorLineNumberContent.replaceChildren(fragment);
    editorLineNumberRenderKey = renderKey;
  }
  editorLineNumberContent.style.transform = `translate3d(0, ${paddingTop + first * lineHeight - source.scrollTop}px, 0)`;
}

function renderEditorLineNumbers() {
  if (editorLineNumberFrame) return;
  editorLineNumberFrame = window.requestAnimationFrame(paintEditorLineNumbers);
}

function workspaceFindHighlightSupported() {
  return Boolean(window.CSS?.highlights && typeof window.Highlight === "function");
}

function clearWorkspaceFindHighlights() {
  if (workspaceFindHighlightSupported()) {
    window.CSS.highlights.delete("undertree-find");
    window.CSS.highlights.delete("undertree-find-current");
  }
  workspaceFindFallbackTarget?.classList.remove("workspace-find-target");
  workspaceFindFallbackTarget = null;
}

function isWorkspaceFindTextVisible(node) {
  const element = node.parentElement;
  if (!element || !node.nodeValue?.trim()) return false;
  if (element.closest("#workspace-find, #source, .editor-line-numbers, script, style, option, [hidden], [aria-hidden='true']")) {
    return false;
  }
  const style = window.getComputedStyle(element);
  return style.display !== "none" && style.visibility !== "hidden" && element.getClientRects().length > 0;
}

function addWorkspaceTextMatches(node, query, matches) {
  const text = node.nodeValue || "";
  const normalized = text.toLocaleLowerCase();
  let offset = 0;
  while (matches.length < MAX_WORKSPACE_FIND_RESULTS) {
    const index = normalized.indexOf(query, offset);
    if (index < 0) break;
    const range = document.createRange();
    range.setStart(node, index);
    range.setEnd(node, index + query.length);
    matches.push({ kind: "range", range, element: node.parentElement });
    offset = index + Math.max(1, query.length);
  }
}

function collectWorkspaceFindMatches(query) {
  const matches = [];
  const sourceText = source.value.toLocaleLowerCase();
  let sourceOffset = 0;
  while (matches.length < MAX_WORKSPACE_FIND_RESULTS) {
    const index = sourceText.indexOf(query, sourceOffset);
    if (index < 0) break;
    matches.push({ kind: "source", start: index, end: index + query.length, element: source });
    sourceOffset = index + Math.max(1, query.length);
  }

  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => isWorkspaceFindTextVisible(node)
      ? NodeFilter.FILTER_ACCEPT
      : NodeFilter.FILTER_REJECT,
  });
  while (matches.length < MAX_WORKSPACE_FIND_RESULTS) {
    const node = walker.nextNode();
    if (!node) break;
    addWorkspaceTextMatches(node, query, matches);
  }
  return matches;
}

function scrollSourceMatchIntoView(match) {
  const before = source.value.slice(0, match.start);
  const line = (before.match(/\n/g)?.length || 0);
  const lineHeight = editorLineHeight();
  source.scrollTop = Math.max(0, line * lineHeight - source.clientHeight * 0.35);
  source.setSelectionRange(match.start, match.end);
  renderEditorLineNumbers();
}

function showWorkspaceFindMatch(index) {
  clearWorkspaceFindHighlights();
  if (!workspaceFindMatches.length) {
    workspaceFindIndex = -1;
    workspaceFindCount.textContent = workspaceFindInput.value
      ? "0 results"
      : "Type to find";
    workspaceFindPrevious.disabled = true;
    workspaceFindNext.disabled = true;
    return;
  }

  workspaceFindIndex = (index + workspaceFindMatches.length) % workspaceFindMatches.length;
  const current = workspaceFindMatches[workspaceFindIndex];
  workspaceFindCount.textContent = `${workspaceFindIndex + 1} / ${workspaceFindMatches.length}${workspaceFindMatches.length === MAX_WORKSPACE_FIND_RESULTS ? "+" : ""}`;
  workspaceFindPrevious.disabled = false;
  workspaceFindNext.disabled = false;

  const ranges = workspaceFindMatches
    .filter((match) => match.kind === "range")
    .map((match) => match.range);
  if (workspaceFindHighlightSupported() && ranges.length) {
    window.CSS.highlights.set("undertree-find", new window.Highlight(...ranges));
    if (current.kind === "range") {
      window.CSS.highlights.set("undertree-find-current", new window.Highlight(current.range));
    }
  } else if (current.element instanceof HTMLElement) {
    current.element.classList.add("workspace-find-target");
    workspaceFindFallbackTarget = current.element;
  }

  if (current.kind === "source") {
    scrollSourceMatchIntoView(current);
  } else {
    current.element?.scrollIntoView({ block: "center", inline: "nearest" });
  }
  workspaceFindInput.focus({ preventScroll: true });
}

function refreshWorkspaceFind({ preserveIndex = false } = {}) {
  window.clearTimeout(workspaceFindRefreshTimer);
  if (workspaceFind.hidden) return;
  const query = workspaceFindInput.value.trim().toLocaleLowerCase();
  clearWorkspaceFindHighlights();
  if (!query) {
    workspaceFindMatches = [];
    showWorkspaceFindMatch(-1);
    return;
  }
  const previousIndex = workspaceFindIndex;
  workspaceFindMatches = collectWorkspaceFindMatches(query);
  showWorkspaceFindMatch(preserveIndex ? Math.min(previousIndex, workspaceFindMatches.length - 1) : 0);
}

function scheduleWorkspaceFindRefresh() {
  if (workspaceFind.hidden) return;
  window.clearTimeout(workspaceFindRefreshTimer);
  workspaceFindRefreshTimer = window.setTimeout(() => refreshWorkspaceFind({ preserveIndex: true }), 60);
}

function openWorkspaceFind() {
  if (workspaceFind.hidden) {
    workspaceFindReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : source;
    workspaceFind.hidden = false;
    const selected = document.activeElement === source
      ? source.value.slice(source.selectionStart, source.selectionEnd)
      : window.getSelection()?.toString() || "";
    const usefulSelection = selected.trim().replace(/\s+/g, " ");
    if (usefulSelection && usefulSelection.length <= 160) workspaceFindInput.value = usefulSelection;
    refreshWorkspaceFind();
  }
  workspaceFindInput.focus({ preventScroll: true });
  workspaceFindInput.select();
}

function closeWorkspaceFind() {
  if (workspaceFind.hidden) return;
  workspaceFind.hidden = true;
  window.clearTimeout(workspaceFindRefreshTimer);
  clearWorkspaceFindHighlights();
  workspaceFindMatches = [];
  workspaceFindIndex = -1;
  const returnFocus = workspaceFindReturnFocus;
  workspaceFindReturnFocus = null;
  if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
}

// Pretext-inspired prepare/layout split: cache font measurements once, then fit
// from container widths without repeatedly measuring rendered DOM text.
// Reference: https://github.com/chenglou/pretext
function prepareFittedText(element) {
  if (!textMeasureContext) return null;
  const style = window.getComputedStyle(element);
  const maxSize = Number(element.dataset.fitMax) || Number.parseFloat(style.fontSize) || 12;
  const minSize = Math.min(maxSize, Number(element.dataset.fitMin) || 9);
  const label = element.dataset.fitLabel || element.textContent.trim();
  textMeasureContext.font = `${style.fontStyle} ${style.fontWeight} ${maxSize}px ${style.fontFamily}`;
  const prepared = {
    maxSize,
    minSize,
    reserve: Math.max(0, Number(element.dataset.fitReserve) || 0),
    widthAtMax: Math.max(1, textMeasureContext.measureText(label).width),
  };
  fittedTextCache.set(element, prepared);
  return prepared;
}

function layoutFittedText(element, inlineSize) {
  const prepared = fittedTextCache.get(element) || prepareFittedText(element);
  if (!prepared || !Number.isFinite(inlineSize)) return;
  const available = Math.max(1, inlineSize - prepared.reserve);
  const nextSize = Math.max(
    prepared.minSize,
    Math.min(prepared.maxSize, prepared.maxSize * (available / prepared.widthAtMax)),
  );
  element.style.setProperty("--fit-font-size", `${nextSize.toFixed(2)}px`);
}

function initializeFittedText() {
  const targets = [...document.querySelectorAll("[data-fit-text]")];
  for (const element of targets) prepareFittedText(element);
  if (!("ResizeObserver" in window)) return;
  fittedTextObserver = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const box = Array.isArray(entry.contentBoxSize) ? entry.contentBoxSize[0] : entry.contentBoxSize;
      layoutFittedText(entry.target, box?.inlineSize ?? entry.contentRect.width);
    }
  });
  for (const element of targets) fittedTextObserver.observe(element);
}

function normalizeGithubStatus(raw) {
  const projectValue = raw && typeof raw.project === "object" && raw.project ? raw.project : null;
  const changes = Array.isArray(projectValue?.changes)
    ? projectValue.changes
        .filter((change) => change && typeof change.path === "string")
        .map((change) => ({
          path: change.path,
          status: typeof change.status === "string" ? change.status : "changed",
        }))
    : [];
  const project = projectValue
    ? {
        repository: typeof projectValue.repository === "string" ? projectValue.repository : "",
        branch: typeof projectValue.branch === "string" ? projectValue.branch : "",
        canPush: projectValue.canPush === true,
        intervalMinutes: Number.isFinite(Number(projectValue.intervalMinutes))
          ? Number(projectValue.intervalMinutes)
          : 0,
        autoCommit: Boolean(projectValue.autoCommit),
        lastSyncAt:
          typeof projectValue.lastSyncAt === "string" || typeof projectValue.lastSyncAt === "number"
            ? projectValue.lastSyncAt
            : null,
        ahead: Math.max(0, Number(projectValue.ahead) || 0),
        behind: Math.max(0, Number(projectValue.behind) || 0),
        dirty: Boolean(projectValue.dirty),
        changes,
        error: typeof projectValue.error === "string" ? projectValue.error : "",
      }
    : null;
  const accountValue = raw && typeof raw.account === "object" && raw.account ? raw.account : null;
  const account = accountValue && typeof accountValue.login === "string"
    ? {
        login: accountValue.login,
        name: typeof accountValue.name === "string" ? accountValue.name : "",
      }
    : null;

  return {
    authConfigured: raw?.authConfigured === true,
    authenticated: raw?.authenticated === true,
    account,
    authorizationPending: raw?.authorizationPending === true,
    projectSelected: raw?.projectSelected === true && Boolean(project),
    busy: raw?.busy === true,
    project,
  };
}

function isGithubBusy() {
  return githubUiBusy || githubStatus.busy || remoteControlBusy;
}

function formatGithubLastSync(value) {
  if (!value) return "Not synchronized yet";
  const parsed = new Date(typeof value === "number" ? value * 1000 : value);
  if (Number.isNaN(parsed.getTime())) return `Last sync ${value}`;
  return `Last sync ${parsed.toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}`;
}

function githubDivergenceText(project) {
  const parts = [];
  if (project.ahead) parts.push(`${project.ahead} ahead`);
  if (project.behind) parts.push(`${project.behind} behind`);
  if (!parts.length) parts.push("Up to date");
  if (project.dirty || editorDirty || project.changes.length) {
    const count = Math.max(project.changes.length, 1);
    parts.push(`${count} local change${count === 1 ? "" : "s"}`);
  }
  return parts.join(" · ");
}

function githubSummary() {
  if (githubStatusError) {
    return { state: "error", short: "GitHub · unavailable", title: "GitHub unavailable", detail: githubStatusError };
  }
  if (editorDirtyBridgeFailed) {
    return {
      state: "error",
      short: "GitHub · editor safety check unavailable",
      title: "GitHub synchronization paused",
      detail: "UnderTree could not confirm the editor state with its native service and is retrying.",
    };
  }
  if (!githubStatusKnown) {
    return { state: "checking", short: "GitHub · checking…", title: "Checking GitHub…", detail: "Reading the native connection state." };
  }
  if (!githubStatus.authConfigured) {
    return {
      state: "error",
      short: "GitHub · unavailable",
      title: "GitHub unavailable",
      detail: "This UnderTree build is missing its built-in GitHub identity. Install an official build or contact its distributor.",
    };
  }
  if (isGithubBusy()) {
    return { state: "busy", short: "GitHub · working…", title: "GitHub is working…", detail: "A native GitHub operation is in progress." };
  }
  if (!githubStatus.authenticated) {
    return {
      state: githubAuthSession || githubStatus.authorizationPending ? "attention" : "checking",
      short: githubAuthSession || githubStatus.authorizationPending ? "GitHub · authorization pending" : "GitHub · disconnected",
      title: githubAuthSession || githubStatus.authorizationPending ? "Authorization pending" : "Connect GitHub",
      detail: githubAuthSession
        ? "Finish the secure device authorization in your browser."
        : "Connect GitHub to choose a repository for this project.",
    };
  }

  const accountLabel = githubStatus.account?.login ? `@${githubStatus.account.login}` : "GitHub account";
  if (!githubStatus.projectSelected || !githubStatus.project) {
    return {
      state: "attention",
      short: `GitHub · ${accountLabel} · project not linked`,
      title: accountLabel,
      detail: activePath
        ? "Connected. Link the current local project to its matching repository, or clone a separate local copy."
        : "Connected. Choose an accessible repository to clone, or create a new GitHub and local project.",
    };
  }

  const project = githubStatus.project;
  if (githubSchedulerNotice && !githubSchedulerNotice.ok) {
    return {
      state: "error",
      short: "GitHub · scheduled sync needs attention",
      title: project.repository,
      detail: githubSchedulerNotice.message,
    };
  }
  if (project.error) {
    return { state: "error", short: "GitHub · attention required", title: project.repository, detail: project.error };
  }
  const divergence = githubDivergenceText(project);
  const hasAttention = project.behind > 0 || project.dirty || editorDirty || project.changes.length > 0;
  return {
    state: hasAttention ? "attention" : "connected",
    short: `GitHub · ${project.repository} · ${divergence}`,
    title: project.repository,
    detail: `${project.branch || "default branch"} · ${divergence}`,
  };
}

function renderGithubChangeList(target, changes, limit = changes.length) {
  const codes = { conflict: "!", deleted: "D", renamed: "R", new: "N", "type changed": "T", modified: "M" };
  const fragment = document.createDocumentFragment();
  for (const change of changes.slice(0, limit)) {
    const item = document.createElement("li");
    const status = document.createElement("span");
    status.className = "github-change-status";
    status.textContent = codes[change.status] || change.status.slice(0, 2).toUpperCase();
    status.title = change.status;
    const path = document.createElement("code");
    path.textContent = change.path;
    item.append(status, path);
    fragment.append(item);
  }
  if (changes.length > limit) {
    const item = document.createElement("li");
    const spacer = document.createElement("span");
    const remainder = document.createElement("code");
    remainder.textContent = `and ${changes.length - limit} more…`;
    item.append(spacer, remainder);
    fragment.append(item);
  }
  target.replaceChildren(fragment);
}

function renderGithubChrome() {
  const summary = githubSummary();
  const accountLabel = githubStatus.account?.login ? `@${githubStatus.account.login}` : "Connected";
  const statusUsable = githubStatusKnown && !githubStatusError && !editorDirtyBridgeFailed;

  githubButton.dataset.state = summary.state;
  githubButton.title = summary.detail;
  githubButton.setAttribute("aria-label", `Open GitHub connection. Status: ${summary.title}. ${summary.detail}`);
  githubRailButton.title = summary.detail;
  githubRailButton.setAttribute("aria-label", `GitHub status: ${summary.title}. ${summary.detail}`);
  githubRailStatus.dataset.state = summary.state;
  githubPanelBadge.textContent = statusUsable && githubStatus.authenticated
    ? accountLabel
    : !githubStatusKnown ? "Checking…" : !githubStatus.authConfigured ? "Unavailable"
      : githubAuthSession || githubStatus.authorizationPending ? "Pending" : "Disconnected";
  githubPanelTitle.textContent = summary.title;
  githubPanelDetail.textContent = summary.detail;
  githubFooterState.dataset.state = summary.state;
  if (githubFooterState.textContent !== summary.short) githubFooterState.textContent = summary.short;
  githubFooterState.title = summary.detail;
  githubFooterState.setAttribute("aria-label", `GitHub status: ${summary.title}. ${summary.detail}`);

  const project = statusUsable && githubStatus.projectSelected ? githubStatus.project : null;
  githubPanelProject.hidden = !project;
  githubPanelChanges.hidden = !project?.changes.length;
  if (project) {
    githubPanelRepository.textContent = project.repository;
    githubPanelBranch.textContent = project.branch || "Default branch";
    githubPanelSyncState.textContent = `${githubDivergenceText(project)} · ${formatGithubLastSync(project.lastSyncAt)}`;
    renderGithubChangeList(githubPanelChangeList, project.changes, 8);
  } else {
    githubPanelChangeList.replaceChildren();
  }
}

function renderGithubRepositoryPicker() {
  const currentValue = githubRepositoryPicker.value;
  const visibleRepositories = filteredGithubRepositories();
  const fragment = document.createDocumentFragment();
  if (!githubRepositories.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "No repositories available to this account";
    fragment.append(option);
  } else if (!visibleRepositories.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "No repositories match these filters";
    fragment.append(option);
  } else {
    const prompt = document.createElement("option");
    prompt.value = "";
    prompt.textContent = "Choose a repository";
    fragment.append(prompt);
    for (const repository of visibleRepositories) {
      const option = document.createElement("option");
      option.value = repository.fullName;
      const created = formatGithubRepositoryCreated(repository.createdAt);
      option.textContent = `${repository.fullName} · ${repository.private ? "private" : "public"}${repository.ownedByUser ? "" : " · shared"}${repository.canPush ? "" : " · read-only"}${created ? ` · ${created}` : ""}`;
      fragment.append(option);
    }
  }
  githubRepositoryPicker.replaceChildren(fragment);
  if (visibleRepositories.some((repository) => repository.fullName === currentValue)) {
    githubRepositoryPicker.value = currentValue;
  }
  updateGithubLinkAvailability();
}

function filteredGithubRepositories() {
  const visibility = githubRepositoryVisibility.value;
  const ownership = githubRepositoryOwnership.value;
  const repositories = githubRepositories.filter((repository) => {
    if (visibility === "public" && repository.private) return false;
    if (visibility === "private" && !repository.private) return false;
    if (ownership === "owned" && !repository.ownedByUser) return false;
    if (ownership === "shared" && repository.ownedByUser) return false;
    return true;
  });
  const nameCompare = (left, right) => left.fullName.localeCompare(right.fullName, undefined, { sensitivity: "base" });
  const createdTime = (repository) => {
    const timestamp = Date.parse(repository.createdAt);
    return Number.isFinite(timestamp) ? timestamp : 0;
  };
  repositories.sort((left, right) => {
    switch (githubRepositorySort.value) {
      case "name-desc": return nameCompare(right, left);
      case "created-desc": return createdTime(right) - createdTime(left) || nameCompare(left, right);
      case "created-asc": return createdTime(left) - createdTime(right) || nameCompare(left, right);
      default: return nameCompare(left, right);
    }
  });
  return repositories;
}

function formatGithubRepositoryCreated(value) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "";
  const date = new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric" }).format(timestamp);
  return `created ${date}`;
}

function updateGithubLinkAvailability() {
  const statusUsable = githubStatusKnown && !githubStatusError && !editorDirtyBridgeFailed;
  const selected = githubRepositories.find((repository) => repository.fullName === githubRepositoryPicker.value);
  const scratch = !activePath;
  githubLinkProject.disabled = !statusUsable || isGithubBusy() || scratch || !selected;
  githubCloneRepository.disabled = !statusUsable || isGithubBusy() || !selected;
  if (scratch) {
    githubRepositoryHelp.textContent = "Choose an accessible repository to clone, or create a new GitHub and local project above.";
  } else if (!githubRepositories.length) {
    githubRepositoryHelp.textContent = "No repositories are available to this account yet. Create one above or check organization OAuth restrictions.";
  } else if (!filteredGithubRepositories().length) {
    githubRepositoryHelp.textContent = "No repositories match the selected visibility and ownership filters.";
  } else if (selected && !selected.canPush) {
    githubRepositoryHelp.textContent = "This repository is read-only for the authorized account. UnderTree can clone and pull it, but GitHub will not allow pushes.";
  } else {
    githubRepositoryHelp.textContent = "Repositories this GitHub account can access are listed.";
  }
}

function renderGithubModal() {
  const statusUsable = githubStatusKnown && !githubStatusError && !editorDirtyBridgeFailed;
  const unavailable = statusUsable && !githubStatus.authConfigured;
  const busy = !statusUsable || isGithubBusy();
  const authenticated = statusUsable && githubStatus.authenticated;
  const linked = authenticated && githubStatus.projectSelected && Boolean(githubStatus.project);
  const account = githubStatus.account;
  githubDialog.setAttribute("aria-busy", String(busy));

  githubDialogBadge.textContent = authenticated
    ? account?.login ? `@${account.login}` : "Connected"
    : unavailable ? "Unavailable"
      : githubAuthSession || githubStatus.authorizationPending ? "Authorization pending" : "Not connected";
  githubConfigUnavailable.hidden = !unavailable;
  githubAuthSection.hidden = unavailable;
  githubConnect.hidden = authenticated || unavailable;
  githubConnect.disabled = busy || githubAuthPollInFlight || githubStatus.authConfigured !== true;
  githubConnect.textContent = githubAuthSession || githubStatus.authorizationPending
    ? "Restart authorization"
    : "Connect GitHub";
  githubAccountTitle.textContent = authenticated
    ? account?.name || account?.login || "GitHub connected"
    : githubAuthSession || githubStatus.authorizationPending ? "Finish GitHub authorization" : "Connect GitHub";
  githubAccountDetail.textContent = authenticated
    ? `${account?.login ? `Signed in as @${account.login}. ` : ""}Credentials stay in native secure storage and are never exposed to this WebView.`
    : "UnderTree opens GitHub's secure device authorization flow and requests repository access. Your password and tokens never enter this window.";

  githubDeviceCode.hidden = !githubAuthSession;
  if (githubAuthSession) {
    githubUserCode.textContent = githubAuthSession.userCode;
    githubDeviceCopyState.textContent = githubAuthSession.copyMessage || "Preparing secure code…";
    githubDeviceInstructions.textContent = githubAuthSession.browserOpened
      ? "GitHub is open. Paste the copied code there, authorize UnderTree, then return here."
      : githubAuthSession.openFailed
        ? `Open ${githubAuthSession.verificationUri || "https://github.com/login/device"} manually, paste the code, then return here.`
        : "UnderTree will copy this code, confirm it here, and only then open GitHub.";
    githubDeviceWait.textContent = githubAuthSession.waitMessage || "Waiting for GitHub authorization…";
  }

  githubRepositorySection.hidden = !authenticated || linked;
  githubProjectSection.hidden = !linked;
  githubRulesSection.hidden = !linked;
  githubDangerZone.hidden = !authenticated;
  githubUnlinkProject.hidden = !linked;
  githubDisconnect.disabled = busy;
  githubUnlinkProject.disabled = busy;
  githubNewProjectToggle.disabled = busy || !authenticated;
  githubCreateProject.disabled = busy || !authenticated;
  githubNewProjectCancel.disabled = busy;
  githubNewProjectName.disabled = busy;
  githubNewProjectDescription.disabled = busy;
  githubNewProjectVisibility.disabled = busy;
  githubRefreshRepositories.disabled = busy;
  githubRepositorySort.disabled = busy || !authenticated;
  githubRepositoryVisibility.disabled = busy || !authenticated;
  githubRepositoryOwnership.disabled = busy || !authenticated;
  githubRepositoryPicker.disabled = busy || !filteredGithubRepositories().length;

  if (linked) {
    const project = githubStatus.project;
    githubProjectRepository.textContent = project.repository;
    githubProjectBranch.textContent = project.branch || "Default branch";
    githubProjectDivergence.textContent = githubDivergenceText(project);
    githubProjectLastSync.textContent = formatGithubLastSync(project.lastSyncAt);
    githubChanges.hidden = !project.changes.length;
    renderGithubChangeList(githubChangeList, project.changes);
    const localChangeCount = project.changes.length;
    githubSyncGuidance.hidden = !project.dirty;
    githubSyncGuidance.textContent = project.dirty
      ? `${localChangeCount || "Local"} uncommitted change${localChangeCount === 1 ? "" : "s"} cannot be pushed by Sync commits. Enter a message and use Commit & Sync.`
      : "";
    const changedRepository = githubRulesRepository !== project.repository;
    if (changedRepository || !githubRulesTouched) {
      const interval = [0, 5, 15, 30, 60].includes(project.intervalMinutes) ? project.intervalMinutes : 0;
      githubSyncInterval.value = String(interval);
      githubAutoCommit.checked = project.autoCommit;
      githubRulesTouched = false;
      githubRulesRepository = project.repository;
    }
  } else {
    githubChangeList.replaceChildren();
    githubSyncGuidance.hidden = true;
    githubSyncGuidance.textContent = "";
    githubRulesRepository = "";
  }

  for (const button of githubActionButtons) {
    const requiresPush = ["push", "commitAndSync"].includes(button.dataset.githubAction);
    const requiresCleanTree = button.dataset.githubAction === "sync";
    button.disabled = busy
      || !linked
      || (requiresPush && !githubStatus.project?.canPush)
      || (requiresCleanTree && githubStatus.project?.dirty);
  }
  githubCommitMessage.disabled = busy || !linked || !githubStatus.project?.canPush;
  githubSyncInterval.disabled = busy || !linked;
  githubAutoCommit.disabled = busy || !linked || !githubStatus.project?.canPush;
  githubSaveRules.disabled = busy || !linked;
  updateGithubLinkAvailability();
}

function renderGithubSurfaces() {
  renderGithubChrome();
  renderGithubModal();
}

function setGithubFeedback(message = "", kind = "success") {
  githubFeedback.hidden = !message;
  githubFeedback.dataset.kind = kind;
  githubFeedback.setAttribute("role", kind === "error" ? "alert" : "status");
  githubFeedback.setAttribute("aria-live", kind === "error" ? "assertive" : "polite");
  githubFeedback.textContent = message;
}

function setGithubUiBusy(busy) {
  githubUiBusy = Boolean(busy);
  updateEditorInterlocks();
  renderGithubSurfaces();
  if (!githubUiBusy && !navigationInFlight && pendingCompile && !compileInFlight) {
    pendingCompile = false;
    void compileLatest();
  }
}

function setEditorDirty(dirty) {
  const requestedDirty = Boolean(dirty);
  editorDirty = requestedDirty;
  renderGithubChrome();
  if (editorDirtyEnqueued === requestedDirty) return editorDirtyBridge;
  window.clearTimeout(editorDirtyRetryTimer);
  editorDirtyEnqueued = requestedDirty;
  editorDirtyBridge = editorDirtyBridge
    .catch(() => undefined)
    .then(() => nativeInvoke("github_set_editor_dirty", { dirty: requestedDirty }))
    .then(() => {
      if (editorDirty !== requestedDirty) return true;
      editorDirtyEnqueued = null;
      const recovered = editorDirtyBridgeFailed;
      editorDirtyBridgeFailed = false;
      if (recovered) renderGithubSurfaces();
      return true;
    })
    .catch(() => {
      if (editorDirty !== requestedDirty) return false;
      editorDirtyEnqueued = null;
      editorDirtyBridgeFailed = true;
      renderGithubSurfaces();
      editorDirtyRetryTimer = window.setTimeout(() => void setEditorDirty(editorDirty), 1000);
      return false;
    });
  return editorDirtyBridge;
}

async function refreshGithubStatus({ loadRepositories = false } = {}) {
  const requested = ++githubStatusRequest;
  const projectGeneration = githubProjectGeneration;
  try {
    const status = await nativeInvoke("github_status");
    if (requested !== githubStatusRequest || projectGeneration !== githubProjectGeneration) return false;
    githubStatus = normalizeGithubStatus(status);
    githubStatusKnown = true;
    githubStatusError = "";
    renderGithubSurfaces();
    if (githubStatus.authenticated && !githubStatus.projectSelected && (loadRepositories || !githubModalBackdrop.hidden)) {
      void loadGithubRepositories();
    }
    return true;
  } catch (error) {
    if (requested !== githubStatusRequest || projectGeneration !== githubProjectGeneration) return false;
    githubStatusError = safeErrorMessage(error, "The native GitHub service is unavailable.");
    if (!githubModalBackdrop.hidden) setGithubFeedback(githubStatusError, "error");
    renderGithubSurfaces();
    return false;
  }
}

async function loadGithubRepositories() {
  if (!githubStatus.authenticated) return;
  const requested = ++githubRepositoryRequest;
  githubRepositoryPicker.replaceChildren();
  const loading = document.createElement("option");
  loading.value = "";
  loading.textContent = "Loading repositories…";
  githubRepositoryPicker.append(loading);
  githubRepositoryPicker.disabled = true;
  githubLinkProject.disabled = true;
  githubCloneRepository.disabled = true;
  try {
    const repositories = await nativeInvoke("github_list_repositories");
    if (requested !== githubRepositoryRequest || !githubStatus.authenticated) return;
    githubRepositories = (Array.isArray(repositories) ? repositories : [])
      .filter((repository) => repository && typeof repository.fullName === "string")
      .map((repository) => ({
        fullName: repository.fullName,
        private: Boolean(repository.private),
        defaultBranch: typeof repository.defaultBranch === "string" ? repository.defaultBranch : "",
        canPush: Boolean(repository.canPush),
        createdAt: typeof repository.createdAt === "string" ? repository.createdAt : "",
        ownedByUser: Boolean(repository.ownedByUser),
      }))
      .sort((left, right) => left.fullName.localeCompare(right.fullName));
    renderGithubRepositoryPicker();
  } catch (error) {
    if (requested !== githubRepositoryRequest) return;
    githubRepositories = [];
    renderGithubRepositoryPicker();
    setGithubFeedback(safeErrorMessage(error, "GitHub repositories could not be loaded."), "error");
  } finally {
    if (requested === githubRepositoryRequest) renderGithubModal();
  }
}

function scheduleGithubAuthPoll(epoch, seconds) {
  window.clearTimeout(githubAuthTimer);
  if (epoch !== githubAuthEpoch || !githubAuthSession) return;
  const delaySeconds = Math.max(1, Number(seconds) || githubAuthSession.intervalSeconds || 5);
  githubAuthTimer = window.setTimeout(() => void pollGithubAuth(epoch), delaySeconds * 1000);
}

async function beginGithubAuth() {
  if (githubAuthPollInFlight) {
    setGithubFeedback("Wait for the current GitHub authorization check to finish before restarting sign-in.", "warning");
    return;
  }
  const epoch = ++githubAuthEpoch;
  window.clearTimeout(githubAuthTimer);
  githubAuthSession = null;
  setGithubFeedback("Requesting a secure one-time authorization code…", "warning");
  setGithubUiBusy(true);
  try {
    const response = await nativeInvoke("github_begin_auth");
    if (epoch !== githubAuthEpoch) return;
    if (!response || typeof response.userCode !== "string" || !response.userCode.trim()) {
      throw new Error("GitHub did not return a usable device authorization code.");
    }
    const attemptId = Number(response.attemptId);
    if (!Number.isSafeInteger(attemptId) || attemptId <= 0) {
      throw new Error("GitHub authorization did not return a valid native attempt identifier.");
    }
    const intervalSeconds = Math.max(1, Number(response.intervalSeconds) || 5);
    const expiresInSeconds = Math.max(intervalSeconds, Number(response.expiresInSeconds) || 900);
    githubAuthSession = {
      userCode: response.userCode,
      attemptId,
      verificationUri: typeof response.verificationUri === "string" ? response.verificationUri : "",
      intervalSeconds,
      expiresAt: Date.now() + expiresInSeconds * 1000,
      copyMessage: "Code is ready",
      browserOpened: false,
      openFailed: false,
      waitMessage: "Copying code to the clipboard…",
    };
    githubStatus.authorizationPending = true;
    renderGithubSurfaces();
    await new Promise((resolve) => window.requestAnimationFrame(() => window.requestAnimationFrame(resolve)));
    try {
      await nativeInvoke("github_copy_device_code", { attemptId });
      if (epoch !== githubAuthEpoch || !githubAuthSession) return;
      githubAuthSession.copyMessage = "Copied to clipboard";
      githubAuthSession.waitMessage = "Code copied. Opening GitHub…";
      setGithubFeedback("One-time code copied to the clipboard. Opening GitHub…");
    } catch (error) {
      if (epoch !== githubAuthEpoch || !githubAuthSession) return;
      githubAuthSession.copyMessage = "Copy manually if needed";
      githubAuthSession.waitMessage = "Automatic copy failed. Opening GitHub with the code still visible…";
      setGithubFeedback(safeErrorMessage(error, "Select and copy the visible code manually."), "warning");
    }
    renderGithubSurfaces();
    await new Promise((resolve) => window.requestAnimationFrame(() => window.requestAnimationFrame(resolve)));
    try {
      await nativeInvoke("github_open_auth_page", { attemptId });
      if (epoch !== githubAuthEpoch || !githubAuthSession) return;
      githubAuthSession.browserOpened = true;
      githubAuthSession.waitMessage = "Waiting for GitHub authorization…";
      renderGithubSurfaces();
    } catch (error) {
      if (epoch !== githubAuthEpoch || !githubAuthSession) return;
      githubAuthSession.openFailed = true;
      githubAuthSession.waitMessage = "Browser launch failed. Authorization will continue after you open GitHub manually.";
      setGithubFeedback(safeErrorMessage(error, "Open https://github.com/login/device manually."), "error");
      renderGithubSurfaces();
    }
    scheduleGithubAuthPoll(epoch, intervalSeconds);
  } catch (error) {
    if (epoch !== githubAuthEpoch) return;
    githubStatus.authorizationPending = false;
    setGithubFeedback(safeErrorMessage(error, "GitHub authorization could not be started."), "error");
  } finally {
    if (epoch === githubAuthEpoch) setGithubUiBusy(false);
  }
}

async function pollGithubAuth(epoch) {
  if (epoch !== githubAuthEpoch || !githubAuthSession || githubAuthPollInFlight) return;
  githubAuthPollInFlight = true;
  let restoreFocus = false;
  if (Date.now() >= githubAuthSession.expiresAt) {
    githubAuthSession.waitMessage = "Confirming that the one-time code expired…";
  }
  renderGithubModal();

  try {
    const response = await nativeInvoke("github_poll_auth", { attemptId: githubAuthSession.attemptId });
    if (epoch !== githubAuthEpoch || !githubAuthSession) return;
    if (response?.status === "complete") {
      restoreFocus = document.activeElement === githubConnect || githubDeviceCode.contains(document.activeElement);
      githubAuthSession = null;
      githubStatus.authorizationPending = false;
      if (response.account && typeof response.account.login === "string") {
        githubStatus.account = {
          login: response.account.login,
          name: typeof response.account.name === "string" ? response.account.name : "",
        };
      }
      setGithubFeedback("GitHub authorization completed. Choose, clone, or create a repository.");
      await refreshGithubStatus({ loadRepositories: true });
      if (restoreFocus && !githubModalBackdrop.hidden) {
        const target = !githubRepositorySection.hidden && !githubRepositoryPicker.disabled
          ? githubRepositoryPicker
          : githubModalClose;
        target.focus();
      }
      return;
    }
    const retryAfterSeconds = Math.max(
      githubAuthSession.intervalSeconds,
      Number(response?.retryAfterSeconds) || githubAuthSession.intervalSeconds,
    );
    githubAuthSession.intervalSeconds = retryAfterSeconds;
    githubAuthSession.waitMessage = "Waiting for GitHub authorization…";
    scheduleGithubAuthPoll(epoch, retryAfterSeconds);
  } catch (error) {
    if (epoch !== githubAuthEpoch || !githubAuthSession) return;
    const code = error && typeof error === "object" && typeof error.code === "string" ? error.code : "";
    if (code !== "github_network_error") {
      restoreFocus = githubDeviceCode.contains(document.activeElement);
      window.clearTimeout(githubAuthTimer);
      githubAuthSession = null;
      githubStatus.authorizationPending = false;
      setGithubFeedback(
        safeErrorMessage(error, "GitHub authorization ended. Start sign-in again to retry."),
        terminalGithubAuthErrors.has(code) && (code === "authorization_denied" || code === "authorization_expired")
          ? "warning"
          : "error",
      );
    } else {
      githubAuthSession.waitMessage = safeErrorMessage(error, "GitHub is temporarily unavailable. Retrying…");
      scheduleGithubAuthPoll(epoch, githubAuthSession.intervalSeconds);
    }
  } finally {
    githubAuthPollInFlight = false;
    if (epoch === githubAuthEpoch) {
      renderGithubSurfaces();
      if (restoreFocus && !githubModalBackdrop.hidden && githubDeviceCode.hidden) {
        (githubStatus.authenticated && !githubRepositoryPicker.disabled
          ? githubRepositoryPicker
          : githubConnect.hidden || githubConnect.disabled ? githubModalClose : githubConnect).focus();
      }
    }
  }
}

function focusableElements(container) {
  return [...container.querySelectorAll("button, input, select, textarea, [tabindex]:not([tabindex='-1'])")]
    .filter((element) => !element.disabled && !element.hidden && element.getClientRects().length > 0);
}

function trapGithubFocus(event, container) {
  const elements = focusableElements(container);
  if (!elements.length) {
    event.preventDefault();
    container.focus();
    return;
  }
  const first = elements[0];
  const last = elements[elements.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function openGithubModal() {
  if (!githubModalBackdrop.hidden) return;
  githubModalReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : githubButton;
  app.inert = true;
  githubModalBackdrop.hidden = false;
  const projectError = githubStatus.project?.error || "";
  setGithubFeedback(
    githubSchedulerNotice?.message || projectError,
    githubSchedulerNotice?.ok === false || projectError ? "error" : "success",
  );
  renderGithubSurfaces();
  window.requestAnimationFrame(() => {
    if (githubModalBackdrop.hidden) return;
    const preferred = githubStatus.authenticated
      ? githubModalClose
      : githubStatus.authConfigured ? githubConnect : githubModalClose;
    (preferred.disabled || preferred.hidden ? githubModalClose : preferred).focus();
  });
  void refreshGithubStatus({ loadRepositories: true });
}

function closeGithubModal() {
  if (githubModalBackdrop.hidden || !githubConfirmBackdrop.hidden) return;
  githubModalBackdrop.hidden = true;
  app.inert = false;
  const returnFocus = githubModalReturnFocus;
  githubModalReturnFocus = null;
  if (returnFocus?.isConnected) returnFocus.focus();
}

function resolveGithubConfirmation(result) {
  if (githubConfirmBackdrop.hidden) return;
  githubConfirmBackdrop.hidden = true;
  githubDialog.inert = false;
  if (githubModalBackdrop.hidden) app.inert = false;
  const resolve = githubConfirmationResolve;
  const returnFocus = githubConfirmReturnFocus;
  githubConfirmationResolve = null;
  githubConfirmReturnFocus = null;
  if (returnFocus?.isConnected) returnFocus.focus();
  resolve?.(result);
}

function showGithubConfirmation({
  title,
  message,
  confirmLabel,
  acceptValue = true,
  secondaryLabel = "",
  secondaryValue = false,
  destructive = true,
}) {
  if (githubConfirmationResolve) resolveGithubConfirmation(null);
  githubConfirmReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : githubModalClose;
  githubConfirmTitle.textContent = title;
  githubConfirmMessage.textContent = message;
  githubConfirmAccept.textContent = confirmLabel;
  githubConfirmAccept.classList.toggle("danger", destructive);
  githubConfirmAccept.classList.toggle("primary", !destructive);
  githubConfirmSecondary.hidden = !secondaryLabel;
  githubConfirmSecondary.textContent = secondaryLabel;
  githubConfirmationAcceptValue = acceptValue;
  githubConfirmationSecondaryValue = secondaryValue;
  githubDialog.inert = !githubModalBackdrop.hidden;
  app.inert = true;
  githubConfirmBackdrop.hidden = false;
  window.requestAnimationFrame(() => {
    if (!githubConfirmBackdrop.hidden) githubConfirmCancel.focus();
  });
  return new Promise((resolve) => {
    githubConfirmationResolve = resolve;
  });
}

function confirmGithubAction({ title, message, confirmLabel }) {
  return showGithubConfirmation({ title, message, confirmLabel });
}

function confirmUnsavedNavigation() {
  if (!activePath) {
    return showGithubConfirmation({
      title: "Discard scratch changes?",
      message: "The scratch document cannot be saved until a project is selected. Its unsaved changes will be lost.",
      confirmLabel: "Discard & continue",
      acceptValue: "discard",
    });
  }
  return showGithubConfirmation({
    title: "Unsaved document changes",
    message: "Save the current document before navigating, discard its changes, or cancel and continue editing.",
    confirmLabel: "Save & continue",
    acceptValue: "save",
    secondaryLabel: "Discard changes",
    secondaryValue: "discard",
    destructive: false,
  });
}

function handleGithubModalKeydown(event) {
  if (!githubConfirmBackdrop.hidden) {
    if (event.key === "Escape") {
      event.preventDefault();
      resolveGithubConfirmation(null);
    } else if (event.key === "Tab") {
      trapGithubFocus(event, githubConfirmDialog);
    }
    return true;
  }
  if (!githubModalBackdrop.hidden) {
    if (event.key === "Escape") {
      event.preventDefault();
      closeGithubModal();
    } else if (event.key === "Tab") {
      trapGithubFocus(event, githubDialog);
    }
    return true;
  }
  return false;
}

async function reloadActiveDocumentAfterGithub(expectedPath, expectedRevision, expectedOperation = null) {
  if (!expectedPath || activePath !== expectedPath || revision !== expectedRevision || editorDirty) return;
  try {
    const project = await nativeInvoke("refresh_project", { preferredPath: expectedPath });
    if (
      activePath !== expectedPath
      || revision !== expectedRevision
      || editorDirty
      || (expectedOperation !== null && expectedOperation !== githubOperationRequest)
    ) {
      return;
    }
    applyProjectSnapshot(project, { projectChanged: false });
  } catch (error) {
    if (!githubModalBackdrop.hidden) {
      const message = safeErrorMessage(error, "The local project could not be refreshed after synchronization.");
      setGithubFeedback(`${message} Use Refresh project from disk before continuing to edit.`, "warning");
    }
  }
}

async function handleGithubSyncEvent(event) {
  const payload = event && typeof event.payload === "object" && event.payload ? event.payload : {};
  const projectRoot = typeof payload.projectRoot === "string" ? payload.projectRoot : "";
  if (!projectRoot || projectRoot !== activeProjectRoot) return;
  const ok = payload.ok === true;
  const message = typeof payload.message === "string" && payload.message.trim()
    ? payload.message.trim().slice(0, 500)
    : ok ? "Scheduled GitHub synchronization completed." : "Scheduled GitHub synchronization failed.";
  githubSchedulerNotice = { ok, message };
  const expectedPath = activePath;
  const expectedRevision = revision;
  if (!githubModalBackdrop.hidden) setGithubFeedback(message, ok ? "success" : "error");
  renderGithubChrome();
  await refreshGithubStatus();
  await reloadActiveDocumentAfterGithub(expectedPath, expectedRevision);
}

async function bindGithubSyncEvents() {
  const listen = window.__TAURI__?.event?.listen;
  if (typeof listen !== "function") return;
  try {
    const unlisten = await listen("github-sync-state", (event) => void handleGithubSyncEvent(event));
    if (githubUnloading) {
      unlisten();
    } else {
      githubSyncUnlisten = unlisten;
    }
  } catch {
    githubSyncUnlisten = null;
  }
  try {
    const unlisten = await listen("github-clone-state", (event) => {
      const message = typeof event?.payload === "string" ? event.payload.trim().slice(0, 500) : "";
      if (message && !githubModalBackdrop.hidden) setGithubFeedback(message, "warning");
    });
    if (githubUnloading) {
      unlisten();
    } else {
      githubCloneUnlisten = unlisten;
    }
  } catch {
    githubCloneUnlisten = null;
  }
}

function remoteEditorState() {
  return {
    project: activeProjectRoot || null,
    projectName: activeProjectName || "Scratch workspace",
    path: activePath,
    revision,
    digest: activeDigest || "",
    dirty: editorDirty,
    busy: Boolean(
      remoteControlBusy
      || navigationInFlight
      || saveInFlight
      || saveLoopPromise
      || compileInFlight
      || compileLoopPromise
      || pdfExportInFlight
      || githubUiBusy
      || githubStatus.busy
    ),
  };
}

function remoteApplicationResult() {
  return {
    kind: "application",
    state: remoteEditorState(),
  };
}

function remoteDocumentResult() {
  return {
    kind: "document",
    state: remoteEditorState(),
    source: source.value,
  };
}

function ensureRemoteEditorIdle() {
  if (
    remoteControlBusy
    || navigationInFlight
    || saveInFlight
    || saveLoopPromise
    || compileInFlight
    || compileLoopPromise
    || pdfExportInFlight
    || githubUiBusy
    || githubStatus.busy
    || githubConfirmationResolve
  ) {
    throwRemoteFailure("editor_busy", "The editor is busy with another operation.");
  }
}

function ensureRemoteNavigationAllowed(request) {
  ensureRemoteEditorIdle();
  if (editorDirty && request?.discardUnsaved !== true) {
    throwRemoteFailure(
      "unsaved_editor",
      "The active document has unsaved changes. Save it or explicitly allow those changes to be discarded.",
    );
  }
}

async function withRemoteEditorLock(operation) {
  ensureRemoteEditorIdle();
  setRemoteControlBusy(true);
  try {
    return await operation();
  } finally {
    setRemoteControlBusy(false);
  }
}

async function withRemoteNavigation(request, status, operation) {
  ensureRemoteNavigationAllowed(request);
  const requestedNavigation = ++navigationRequest;
  setRemoteControlBusy(true);
  setNavigationInFlight(true);
  setStatus("busy", status);
  try {
    const result = await operation();
    if (requestedNavigation !== navigationRequest) {
      throwRemoteFailure(
        "remote_request_superseded",
        "Another navigation request superseded the remote request.",
      );
    }
    return result;
  } finally {
    if (requestedNavigation === navigationRequest) setNavigationInFlight(false);
    setRemoteControlBusy(false);
  }
}

async function executeRemoteControlRequest(requestId, request) {
  const action = request?.action;
  if (!request || typeof request !== "object" || typeof action !== "string") {
    throwRemoteFailure("invalid_remote_request", "The remote request is malformed.");
  }

  switch (action) {
    case "status":
      return remoteApplicationResult();
    case "focus":
      window.focus();
      return { kind: "acknowledged", action };
    case "project-open": {
      await withRemoteNavigation(request, "Opening remote project…", async () => {
        const project = await nativeInvoke("remote_control_open_project", { requestId });
        applyProjectSnapshot(project);
        void refreshGithubStatus({ loadRepositories: !githubModalBackdrop.hidden });
      });
      return remoteApplicationResult();
    }
    case "project-refresh": {
      const preferredPath = activePath;
      await withRemoteNavigation(request, "Refreshing project from disk…", async () => {
        const project = await nativeInvoke("refresh_project", { preferredPath });
        applyProjectSnapshot(project, { projectChanged: false });
        setStatus("ready", "Refreshed from disk");
        void refreshGithubStatus({ loadRepositories: !githubModalBackdrop.hidden });
      });
      return remoteApplicationResult();
    }
    case "document-open": {
      if (typeof request.path !== "string") {
        throwRemoteFailure("invalid_remote_request", "A document path is required.");
      }
      await withRemoteNavigation(request, "Opening remote document…", async () => {
        const documentData = await nativeInvoke("open_document", { path: request.path });
        loadDocument(documentData);
      });
      return remoteDocumentResult();
    }
    case "document-read":
      return remoteDocumentResult();
    case "agent-context": {
      if (!activeProjectRoot || !activePath || !isTypstDocument(activePath)) {
        throwRemoteFailure(
          "typst_document_required",
          "Open a saved Typst project document before requesting agent context.",
        );
      }
      const policy = await withRemoteEditorLock(async () => {
        if (!(await flushAgentAnnotations())) {
          throwRemoteFailure(
            "agent_annotations_unsaved",
            "The AI editing marks could not be synchronized before the agent run.",
          );
        }
        return nativeInvoke("agent_annotations", { path: activePath, source: source.value });
      });
      agentPolicy = normalizeAgentPolicy(policy);
      agentAnnotationsDirty = false;
      renderAgentAnnotations();
      if (!agentPolicy.inSync || agentPolicy.annotations.some((annotation) => annotation.stale)) {
        throwRemoteFailure(
          "agent_annotations_stale",
          "Review the stale AI editing marks before an agent edits this document.",
        );
      }
      return {
        kind: "agent-document",
        state: remoteEditorState(),
        source: source.value,
        policy: agentPolicy,
      };
    }
    case "review-context": {
      if (!activeProjectRoot || !activePath || !isTypstDocument(activePath)) {
        throwRemoteFailure(
          "typst_document_required",
          "Open a saved Typst project document before requesting review context.",
        );
      }
      return withRemoteEditorLock(async () => {
        const outcome = await saveLatestResult();
        if (!outcome.saved) {
          throw outcome.error || {
            code: "save_failed",
            message: "The manuscript could not be saved before review context was read.",
          };
        }
        const review = await nativeInvoke("review_state", {
          path: activePath,
          source: source.value,
        });
        if (!review.inSync) {
          throwRemoteFailure(
            "review_state_stale",
            "The portable review state is not synchronized with the saved manuscript.",
          );
        }
        return {
          kind: "review-document",
          state: remoteEditorState(),
          source: source.value,
          review,
        };
      });
    }
    case "review-propose": {
      if (!activeProjectRoot || !activePath || !isTypstDocument(activePath)) {
        throwRemoteFailure(
          "typst_document_required",
          "Open a saved Typst project document before proposing a review change.",
        );
      }
      return withRemoteEditorLock(async () => {
        const outcome = await saveLatestResult();
        if (!outcome.saved) {
          throw outcome.error || {
            code: "save_failed",
            message: "The manuscript could not be saved before the proposal was submitted.",
          };
        }
        const review = await nativeInvoke("review_create_proposal", {
          actor: "ai",
          request: {
            path: activePath,
            source: source.value,
            expectedDigest: activeDigest,
            expectedPolicyVersion: request.expectedPolicyVersion,
            id: request.id || null,
            markId: request.markId,
            operation: request.operation,
            replacement: request.replacement,
            rationale: request.rationale,
          },
        });
        return {
          kind: "review-updated",
          state: remoteEditorState(),
          review,
        };
      });
    }
    case "review-comment": {
      if (!activeProjectRoot || !activePath || !isTypstDocument(activePath)) {
        throwRemoteFailure(
          "typst_document_required",
          "Open a saved Typst project document before adding a review comment.",
        );
      }
      return withRemoteEditorLock(async () => {
        const outcome = await saveLatestResult();
        if (!outcome.saved) {
          throw outcome.error || {
            code: "save_failed",
            message: "The manuscript could not be saved before the comment was submitted.",
          };
        }
        const review = await nativeInvoke("review_add_comment", {
          actor: "ai",
          request: {
            path: activePath,
            source: source.value,
            expectedDigest: activeDigest,
            expectedPolicyVersion: request.expectedPolicyVersion,
            id: request.id || null,
            markId: request.markId,
            proposalId: request.proposalId || null,
            body: request.body,
          },
        });
        return {
          kind: "review-updated",
          state: remoteEditorState(),
          review,
        };
      });
    }
    case "document-replace": {
      if (!Number.isSafeInteger(request.expectedRevision) || request.expectedRevision !== revision) {
        throwRemoteFailure(
          "stale_editor_revision",
          `The expected editor revision does not match revision ${revision}.`,
        );
      }
      if (typeof request.source !== "string") {
        throwRemoteFailure("invalid_remote_request", "Document source must be text.");
      }
      await withRemoteEditorLock(async () => {
        let preparedPolicy = null;
        if (activeProjectRoot && activePath && isTypstDocument(activePath)) {
          if (!(await flushAgentAnnotations())) {
            throwRemoteFailure(
              "agent_annotations_unsaved",
              "The AI editing marks could not be synchronized before replacing source.",
            );
          }
          preparedPolicy = await nativeInvoke("remote_control_prepare_agent_replace", {
            requestId,
            path: activePath,
            currentSource: source.value,
          });
        }
        if (preparedPolicy) agentPolicy = normalizeAgentPolicy(preparedPolicy);
        agentAnnotationsDirty = false;
        agentAnnotationMutationSuppressed = true;
        try {
          source.value = request.source;
          source.dispatchEvent(new Event("input", { bubbles: true }));
        } finally {
          agentAnnotationMutationSuppressed = false;
          agentAnnotationSourceSnapshot = source.value;
        }
        renderAgentAnnotations();
      });
      return remoteDocumentResult();
    }
    case "agent-replace": {
      throwRemoteFailure(
        "agent_direct_edit_disabled",
        "Direct AI manuscript replacement is disabled. Use the review proposal API so a human can accept or reject the change.",
      );
    }
    case "document-save": {
      const outcome = await withRemoteEditorLock(() => saveLatestResult());
      if (!outcome.saved) {
        throw outcome.error || {
          code: "save_failed",
          message: "The document could not be saved.",
        };
      }
      return {
        kind: "saved",
        state: remoteEditorState(),
        conflictPath: outcome.conflictPath || null,
      };
    }
    case "bibliography-create": {
      if (typeof request.path !== "string") {
        throwRemoteFailure("invalid_remote_request", "A bibliography path is required.");
      }
      await withRemoteNavigation(request, "Creating remote bibliography…", async () => {
        const result = await nativeInvoke("create_bibliography", { path: request.path });
        renderFiles(result.allFiles || result.files);
        loadDocument(result.document);
      });
      return remoteDocumentResult();
    }
    case "compile": {
      if (!isTypstDocument(activePath)) {
        throwRemoteFailure("typst_document_required", "Open a Typst document before compiling.");
      }
      const outcome = await withRemoteEditorLock(() => compileLatest());
      if (!outcome?.compiled) {
        throw outcome?.error || {
          code: "compile_failed",
          message: "The current document could not be compiled.",
        };
      }
      return {
        kind: "compiled",
        state: remoteEditorState(),
        pages: outcome.pages,
        warnings: outcome.warnings,
        elapsedMs: outcome.elapsedMs,
      };
    }
    case "pdf-export": {
      if (!isTypstDocument(activePath)) {
        throwRemoteFailure("typst_document_required", "Open a Typst document before exporting a PDF.");
      }
      const requestedPath = activePath;
      const requestedRevision = revision;
      let result;
      try {
        result = await withRemoteEditorLock(async () => {
          pdfExportInFlight = true;
          updateEditorInterlocks();
          setStatus("busy", "Creating CLI-requested PDF…");
          try {
            return await nativeInvoke("remote_control_export_pdf", {
              requestId,
              request: {
                source: source.value,
                path: requestedPath,
                revision: requestedRevision,
              },
            });
          } finally {
            pdfExportInFlight = false;
            updateEditorInterlocks();
            if (pendingCompile && !compileInFlight && !navigationInFlight && !githubUiBusy) {
              void compileLatest();
            }
          }
        });
      } catch (error) {
        if (activePath === requestedPath && revision === requestedRevision) {
          const safeError = error && typeof error === "object" ? error : {};
          renderDiagnostics(
            Array.isArray(safeError.diagnostics) && safeError.diagnostics.length
              ? safeError.diagnostics
              : [{ severity: "error", message: safeErrorMessage(error, "The PDF could not be saved."), hints: [] }],
          );
          setStatus("error", "CLI PDF export failed");
        }
        throw error;
      }
      lastPdfExport = {
        documentPath: requestedPath,
        revision: result.revision,
        fileName: result.fileName,
      };
      if (
        activePath !== requestedPath
        || revision !== requestedRevision
        || result.revision !== requestedRevision
      ) {
        throwRemoteFailure(
          "stale_editor_revision",
          `The PDF was saved as ${result.fileName}, but the editor changed before the export completed.`,
        );
      }
      renderDiagnostics(result.warnings);
      setStatus(
        result.warnings.length ? "warning" : "ready",
        `PDF saved · ${result.fileName}`,
      );
      return {
        kind: "pdf-exported",
        state: remoteEditorState(),
        fileName: result.fileName,
        pages: result.pages,
        warnings: result.warnings.length,
        elapsedMs: result.elapsedMs,
      };
    }
    case "pdf-reveal": {
      const exported = lastPdfExport;
      if (!exportedPdfMatchesEditor(exported)) {
        throwRemoteFailure(
          "pdf_export_missing",
          "The current editor revision has no remembered PDF export.",
        );
      }
      await withRemoteEditorLock(() => nativeInvoke("remote_control_reveal_pdf", {
        requestId,
        request: {
          documentPath: exported.documentPath,
          revision: exported.revision,
        },
      }));
      if (exportedPdfMatchesEditor(exported)) {
        setStatus("ready", `Showing ${exported.fileName} in its folder`);
      }
      return { kind: "acknowledged", action };
    }
    case "convert-typst-to-latex": {
      const outcome = await withRemoteEditorLock(() => exportTypstToLatex());
      if (!outcome?.converted) {
        throw outcome?.error || {
          code: "conversion_failed",
          message: "The Typst document could not be exported to LaTeX.",
        };
      }
      return {
        kind: "converted",
        state: remoteEditorState(),
        source: outcome.report.source,
        output: outcome.report.latex,
        warnings: outcome.report.warningCount,
      };
    }
    case "quit":
      ensureRemoteEditorIdle();
      if (editorDirty && request.discardUnsaved !== true) {
        throwRemoteFailure(
          "unsaved_editor",
          "The active document has unsaved changes. Save it or explicitly allow those changes to be discarded.",
        );
      }
      return { kind: "acknowledged", action };
    default:
      throwRemoteFailure("invalid_remote_request", "The remote action is not supported.");
  }
}

async function completeRemoteControlDispatch(dispatch) {
  let request;
  try {
    request = await nativeInvoke("remote_control_claim", { requestId: dispatch.requestId });
  } catch {
    return;
  }
  let result = null;
  let error = null;
  try {
    result = await executeRemoteControlRequest(dispatch.requestId, request);
  } catch (caught) {
    error = normalizeRemoteFailure(caught);
  }
  await nativeInvoke("remote_control_complete", {
    completion: {
      requestId: dispatch.requestId,
      result,
      error,
    },
  });
}

function enqueueRemoteControlDispatch(dispatch) {
  const requestId = dispatch?.requestId;
  if (!Number.isSafeInteger(requestId) || requestId < 1) return;
  remoteControlQueue = remoteControlQueue
    .catch(() => undefined)
    .then(() => completeRemoteControlDispatch(dispatch))
    .catch(() => undefined);
}

async function bindRemoteControlEvents() {
  const listen = window.__TAURI__?.event?.listen;
  if (typeof listen !== "function") {
    throwRemoteFailure("native_unavailable", "The native event bridge is unavailable.");
  }
  const unlisten = await listen(REMOTE_CONTROL_EVENT, (event) => {
    if (remoteControlActivated) {
      enqueueRemoteControlDispatch(event?.payload);
    } else {
      remoteControlBufferedDispatches.push(event?.payload);
    }
  });
  if (githubUnloading) {
    unlisten();
  } else {
    remoteControlUnlisten = unlisten;
  }
}

async function activateRemoteControl(listenerPromise, bootstrapPromise) {
  try {
    await listenerPromise;
    await bootstrapPromise;
    const pending = await nativeInvoke("remote_control_ready");
    if (!Array.isArray(pending)) {
      throwRemoteFailure("invalid_remote_dispatch", "The native remote-control queue is malformed.");
    }
    const dispatches = [...pending, ...remoteControlBufferedDispatches];
    remoteControlBufferedDispatches = [];
    remoteControlActivated = true;
    for (const dispatch of dispatches) enqueueRemoteControlDispatch(dispatch);
  } catch {
    // Native requests fail closed and time out if the editor bridge cannot become ready.
  }
}

function setGithubNewProjectForm(open) {
  const shown = Boolean(open);
  githubNewProjectForm.hidden = !shown;
  githubNewProjectToggle.setAttribute("aria-expanded", String(shown));
  githubNewProjectToggle.textContent = shown ? "Close new project" : "New GitHub project…";
  if (shown) window.requestAnimationFrame(() => githubNewProjectName.focus());
}

async function createGithubProject() {
  const name = githubNewProjectName.value.trim();
  const description = githubNewProjectDescription.value.trim();
  const isPrivate = githubNewProjectVisibility.value !== "public";
  if (!/^(?!\.{1,2}$)(?!.*\.git$)[A-Za-z0-9._-]{1,100}$/i.test(name)) {
    setGithubFeedback("Use 1–100 letters, numbers, periods, hyphens, or underscores for the repository name; do not end it with .git.", "warning");
    githubNewProjectName.focus();
    return;
  }
  if ([...description].length > 350 || /[\r\n\u0000-\u001f\u007f]/.test(description)) {
    setGithubFeedback("Keep the description to 350 characters without line breaks or control characters.", "warning");
    githubNewProjectDescription.focus();
    return;
  }
  if (!(await prepareEditorNavigation())) return;

  const owner = githubStatus.account?.login || "the connected account";
  const accepted = await showGithubConfirmation({
    title: `Create ${owner}/${name}?`,
    message: `UnderTree will create a ${isPrivate ? "private" : "public"} GitHub repository, ask for a parent folder, create a new “${name}” local child folder with paper.typ, paper.bib, and paper.json, make the initial commit, and push it to GitHub. The local folder becomes the source of truth.`,
    confirmLabel: "Choose parent folder",
    destructive: false,
  });
  if (!accepted) return;

  const requested = ++githubOperationRequest;
  const requestedNavigation = ++navigationRequest;
  setGithubFeedback(`Choose a parent folder for the new “${name}” project.`, "warning");
  setGithubUiBusy(true);
  try {
    const project = await nativeInvoke("github_create_repository", {
      request: { name, description, private: isPrivate },
    });
    if (requested !== githubOperationRequest || requestedNavigation !== navigationRequest) return;
    if (!project) {
      setGithubFeedback("Project creation cancelled. No GitHub repository was created.", "warning");
      return;
    }
    applyProjectSnapshot(project);
    githubNewProjectName.value = "";
    githubNewProjectDescription.value = "";
    setGithubNewProjectForm(false);
    githubSchedulerNotice = null;
    const statusRefreshed = await refreshGithubStatus();
    if (requested !== githubOperationRequest || requestedNavigation !== navigationRequest) return;
    setGithubFeedback(
      statusRefreshed
        ? `Created ${owner}/${name}, pushed the three-file writing project, and selected its local source-of-truth folder.`
        : `Created ${owner}/${name} and its local project. GitHub status will refresh when the native service is available.`,
      statusRefreshed ? "success" : "warning",
    );
  } catch (error) {
    if (requested !== githubOperationRequest || requestedNavigation !== navigationRequest) return;
    setGithubFeedback(safeErrorMessage(error, "The GitHub project could not be created."), "error");
  } finally {
    if (requested === githubOperationRequest) setGithubUiBusy(false);
  }
}

async function linkGithubProject() {
  if (!activePath) {
    setGithubFeedback("Choose a local UnderTree project before linking a GitHub repository.", "error");
    return;
  }
  const repository = githubRepositories.find((item) => item.fullName === githubRepositoryPicker.value);
  if (!repository) {
    setGithubFeedback("Choose a repository available to this account.", "error");
    return;
  }

  const accepted = await showGithubConfirmation({
    title: `Link the open folder to ${repository.fullName}?`,
    message: "The open folder will remain the source of truth. UnderTree will reuse or initialize its local Git repository and bind origin only if no different origin is already configured. Use Clone instead when the GitHub repository already contains the project and this folder is not its existing checkout.",
    confirmLabel: "Link local project",
    destructive: false,
  });
  if (!accepted) return;

  const requested = ++githubOperationRequest;
  setGithubFeedback(`Linking this project to ${repository.fullName}…`, "warning");
  setGithubUiBusy(true);
  try {
    await nativeInvoke("github_link_project", {
      request: { repository: repository.fullName, defaultBranch: repository.defaultBranch },
    });
    if (requested !== githubOperationRequest) return;
    githubSchedulerNotice = null;
    setGithubFeedback(`Linked this UnderTree project to ${repository.fullName}.`);
    await refreshGithubStatus();
  } catch (error) {
    if (requested !== githubOperationRequest) return;
    setGithubFeedback(safeErrorMessage(error, "The project could not be linked to GitHub."), "error");
  } finally {
    if (requested === githubOperationRequest) setGithubUiBusy(false);
  }
}

async function cloneGithubRepository() {
  const repository = githubRepositories.find((item) => item.fullName === githubRepositoryPicker.value);
  if (!repository) {
    setGithubFeedback("Choose a repository available to this account.", "error");
    return;
  }
  if (!(await prepareEditorNavigation())) return;

  const repositoryName = repository.fullName.split("/").filter(Boolean).pop() || "repository";
  const requested = ++githubOperationRequest;
  const requestedNavigation = ++navigationRequest;
  setGithubFeedback(`Choose a parent folder for the new “${repositoryName}” folder.`, "warning");
  setGithubUiBusy(true);
  try {
    const project = await nativeInvoke("github_clone_repository", {
      request: { repository: repository.fullName, defaultBranch: repository.defaultBranch },
    });
    if (requested !== githubOperationRequest || requestedNavigation !== navigationRequest) return;
    if (!project) {
      setGithubFeedback("Clone cancelled. The current local project is unchanged.", "warning");
      return;
    }

    applyProjectSnapshot(project);
    githubSchedulerNotice = null;
    if (githubModalBackdrop.hidden) openGithubModal();
    const statusRefreshed = await refreshGithubStatus();
    if (requested !== githubOperationRequest || requestedNavigation !== navigationRequest) return;
    setGithubFeedback(
      statusRefreshed
        ? `Local copy of ${repository.fullName} is ready. This cloned folder is now the local source of truth.`
        : `Local copy of ${repository.fullName} is ready. GitHub status will refresh when the native service is available.`,
      statusRefreshed ? "success" : "warning",
    );
  } catch (error) {
    if (requested !== githubOperationRequest || requestedNavigation !== navigationRequest) return;
    setGithubFeedback(safeErrorMessage(error, "The repository could not be cloned."), "error");
  } finally {
    if (requested === githubOperationRequest) setGithubUiBusy(false);
  }
}

async function saveGithubRules() {
  const intervalMinutes = Number(githubSyncInterval.value);
  if (![0, 5, 15, 30, 60].includes(intervalMinutes)) {
    setGithubFeedback("Choose a supported synchronization interval.", "error");
    return;
  }
  const requested = ++githubOperationRequest;
  setGithubFeedback("Saving native synchronization rules…", "warning");
  setGithubUiBusy(true);
  try {
    await nativeInvoke("github_save_rules", {
      request: { intervalMinutes, autoCommit: githubAutoCommit.checked },
    });
    if (requested !== githubOperationRequest) return;
    githubRulesTouched = false;
    setGithubFeedback(intervalMinutes ? `Automatic sync set to every ${intervalMinutes} minutes.` : "Automatic sync is off.");
    await refreshGithubStatus();
  } catch (error) {
    if (requested !== githubOperationRequest) return;
    setGithubFeedback(safeErrorMessage(error, "Synchronization rules could not be saved."), "error");
  } finally {
    if (requested === githubOperationRequest) setGithubUiBusy(false);
  }
}

async function ensureProjectSavedForGithub() {
  if (!activePath) {
    setGithubFeedback("Scratch documents cannot be synchronized. Choose a local project first.", "error");
    return false;
  }
  if (editorDirty) {
    setGithubFeedback("Saving the current document before GitHub synchronization…", "warning");
    const saved = await saveLatest();
    if (!saved || editorDirty) {
      setGithubFeedback("The current document could not be saved, so GitHub synchronization was not started.", "error");
      return false;
    }
  }
  await setEditorDirty(editorDirty);
  if (editorDirty || editorDirtyBridgeFailed) {
    setGithubFeedback(
      editorDirtyBridgeFailed
        ? "The native editor safety check is unavailable. UnderTree is retrying; synchronization was not started."
        : "The editor changed while preparing synchronization. Save the document and try again.",
      "warning",
    );
    return false;
  }
  return true;
}

async function runGithubAction(action) {
  const labels = {
    pull: "Pulling from GitHub",
    push: "Pushing to GitHub",
    sync: "Synchronizing with GitHub",
    commitAndSync: "Committing and synchronizing",
  };
  if (!Object.hasOwn(labels, action)) return;
  const commitMessage = githubCommitMessage.value.trim();
  if (action === "commitAndSync" && !commitMessage) {
    setGithubFeedback("Enter a commit message before using Commit & Sync.", "warning");
    githubCommitMessage.focus();
    return;
  }
  if (!(await ensureProjectSavedForGithub())) return;

  const expectedPath = activePath;
  const expectedRevision = revision;
  const requested = ++githubOperationRequest;
  setGithubFeedback(`${labels[action]}…`, "warning");
  setGithubUiBusy(true);
  try {
    const result = await nativeInvoke("github_sync_project", {
      request: { action, commitMessage },
    });
    if (requested !== githubOperationRequest) return;
    githubSchedulerNotice = null;
    if (action === "commitAndSync") githubCommitMessage.value = "";
    const message = typeof result?.summary === "string"
      ? result.summary
      : typeof result?.status === "string" ? result.status : "GitHub operation completed.";
    setGithubFeedback(message);
    await refreshGithubStatus();
    if (action !== "push") {
      await reloadActiveDocumentAfterGithub(expectedPath, expectedRevision, requested);
    }
  } catch (error) {
    if (requested !== githubOperationRequest) return;
    setGithubFeedback(safeErrorMessage(error, "The GitHub operation failed."), "error");
    if (action !== "push") {
      await refreshGithubStatus();
      await reloadActiveDocumentAfterGithub(expectedPath, expectedRevision, requested);
    }
  } finally {
    if (requested === githubOperationRequest) setGithubUiBusy(false);
  }
}

async function unlinkGithubProject() {
  const accepted = await confirmGithubAction({
    title: "Unlink this project?",
    message: "UnderTree will stop synchronizing this local project. The local files and GitHub repository will not be deleted.",
    confirmLabel: "Unlink project",
  });
  if (!accepted) return;
  const requested = ++githubOperationRequest;
  setGithubFeedback("Unlinking this project…", "warning");
  setGithubUiBusy(true);
  try {
    await nativeInvoke("github_unlink_project");
    if (requested !== githubOperationRequest) return;
    githubSchedulerNotice = null;
    setGithubFeedback("This local project is no longer linked to a GitHub repository.");
    await refreshGithubStatus({ loadRepositories: true });
  } catch (error) {
    if (requested !== githubOperationRequest) return;
    setGithubFeedback(safeErrorMessage(error, "The project could not be unlinked."), "error");
  } finally {
    if (requested === githubOperationRequest) setGithubUiBusy(false);
  }
}

async function disconnectGithub() {
  const accepted = await confirmGithubAction({
    title: "Disconnect GitHub?",
    message: "UnderTree will remove its stored GitHub authorization and stop automatic synchronization. Local and remote repository data will remain intact.",
    confirmLabel: "Disconnect",
  });
  if (!accepted) return;

  const requested = ++githubOperationRequest;
  githubAuthEpoch += 1;
  window.clearTimeout(githubAuthTimer);
  githubAuthSession = null;
  githubRepositoryRequest += 1;
  setGithubFeedback("Disconnecting GitHub…", "warning");
  setGithubUiBusy(true);
  try {
    await nativeInvoke("github_disconnect");
    if (requested !== githubOperationRequest) return;
    githubRepositories = [];
    githubSchedulerNotice = null;
    setGithubFeedback("GitHub is disconnected. Native credentials were removed.");
    await refreshGithubStatus();
  } catch (error) {
    if (requested !== githubOperationRequest) return;
    setGithubFeedback(safeErrorMessage(error, "GitHub could not be disconnected."), "error");
  } finally {
    if (requested === githubOperationRequest) setGithubUiBusy(false);
  }
}

function diagnosticKey(item) {
  return [item.severity || "error", item.message || "", ...(item.hints || [])].join("\u0000");
}

function clearDiagnosticDismissTimers() {
  for (const timer of diagnosticDismissTimers.values()) window.clearTimeout(timer);
  diagnosticDismissTimers.clear();
}

function showEmptyDiagnostics() {
  if (diagnostics.querySelector(".diagnostic")) return;
  diagnostics.replaceChildren();
  const empty = document.createElement("p");
  empty.className = "diagnostics-empty";
  empty.textContent = "No current messages.";
  diagnostics.append(empty);
}

function dismissDiagnostic(key, row) {
  dismissedDiagnosticKeys.add(key);
  window.clearTimeout(diagnosticDismissTimers.get(key));
  diagnosticDismissTimers.delete(key);
  row.classList.add("dismissing");
  window.setTimeout(() => {
    row.remove();
    showEmptyDiagnostics();
    scheduleWorkspaceFindRefresh();
  }, 160);
}

function renderDiagnostics(items = []) {
  const visibleItems = [...conversionDiagnostics, ...items];
  const batchSignature = visibleItems.map((item, index) => `${diagnosticKey(item)}\u0000${index}`).join("\u0001");
  if (batchSignature !== diagnosticBatchSignature) {
    diagnosticBatchSignature = batchSignature;
    dismissedDiagnosticKeys.clear();
  }
  clearDiagnosticDismissTimers();
  diagnostics.replaceChildren();
  if (!visibleItems.length) {
    showEmptyDiagnostics();
    return;
  }
  for (const [index, item] of visibleItems.entries()) {
    const key = `${diagnosticKey(item)}\u0000${index}`;
    if (dismissedDiagnosticKeys.has(key)) continue;
    const row = document.createElement("div");
    row.className = `diagnostic ${item.severity || "error"}`;
    row.dataset.diagnosticKey = key;

    const heading = document.createElement("div");
    heading.className = "diagnostic-heading";

    const message = document.createElement("strong");
    message.textContent = item.message || "Unknown compiler diagnostic";
    const dismiss = document.createElement("button");
    dismiss.type = "button";
    dismiss.className = "diagnostic-dismiss";
    dismiss.title = "Dismiss message";
    dismiss.setAttribute("aria-label", "Dismiss compiler message");
    dismiss.append(createSvgIcon("diagnostic-dismiss-icon", "M4 4l8 8m0-8-8 8"));
    dismiss.addEventListener("click", () => dismissDiagnostic(key, row));
    heading.append(message, dismiss);
    row.append(heading);

    for (const hintText of item.hints || []) {
      const hint = document.createElement("span");
      hint.textContent = hintText;
      row.append(hint);
    }
    diagnostics.append(row);

    const dismissAfter = item.severity === "info" ? 12000 : item.severity === "warning" ? 24000 : 0;
    if (dismissAfter) {
      diagnosticDismissTimers.set(
        key,
        window.setTimeout(() => dismissDiagnostic(key, row), dismissAfter),
      );
    }
  }
  showEmptyDiagnostics();
  scheduleWorkspaceFindRefresh();
}

function diagnosticsFromConversion(report) {
  if (!report || typeof report !== "object") return [];
  const converted = Array.isArray(report.converted) ? report.converted : [];
  const skipped = Array.isArray(report.skipped) ? report.skipped : [];
  const warnings = Array.isArray(report.warnings) ? report.warnings : [];
  const summary = converted.length
    ? `${converted.length} LaTeX document${converted.length === 1 ? "" : "s"} converted locally; every original and asset was preserved.`
    : skipped.length
      ? "No LaTeX originals were changed; existing Typst siblings were kept."
      : "The imported project was preserved, but no high-confidence LaTeX document root was converted.";
  const result = [{
    severity: report.needsReview ? "warning" : "info",
    message: summary,
    hints: [
      `${report.engine || "LaTeX converter"} · generated files are conversion drafts`,
      report.compileSucceeded === true
        ? "Every generated document passed UnderTree’s embedded Typst compile check."
        : report.compileSucceeded === false
          ? "At least one generated draft needs repair before it compiles; details are listed below."
          : "UnderTree will compile-check the opened draft now.",
      report.primaryTypst ? `Opened ${report.primaryTypst}` : "Choose a specific .tex file if the project has several possible roots.",
    ],
  }];
  for (const warning of warnings) {
    const context = [warning.source, warning.location].filter(Boolean).join(" · ");
    result.push({
      severity: "warning",
      message: warning.message || "Conversion needs review.",
      hints: context ? [context] : [],
    });
  }
  if (Number(report.warningCount) > warnings.length) {
    result.push({
      severity: "warning",
      message: `${Number(report.warningCount) - warnings.length} additional conversion warnings were omitted from the bounded report.`,
      hints: [],
    });
  }
  return result;
}

function diagnosticsFromTypstToLatex(report) {
  if (!report || typeof report !== "object") return [];
  const warnings = Array.isArray(report.warnings) ? report.warnings : [];
  const result = [{
    severity: "warning",
    message: `Created ${report.latex || "a new LaTeX export draft"}; the Typst original was preserved.`,
    hints: [
      `${report.engine || "Typst-to-LaTeX converter"} · complete article-class draft`,
      report.sourceCompiled
        ? "The source passed UnderTree’s embedded Typst compile check before conversion."
        : "The source compile status could not be confirmed.",
      "Apply the journal’s official class/template and compile the exported .tex with its required TeX toolchain before submission.",
    ],
  }];
  for (const warning of warnings) {
    const context = [warning.source, warning.location].filter(Boolean).join(" · ");
    result.push({
      severity: "warning",
      message: warning.message || "The LaTeX export needs review.",
      hints: context ? [context] : [],
    });
  }
  if (Number(report.warningCount) > warnings.length) {
    result.push({
      severity: "warning",
      message: `${Number(report.warningCount) - warnings.length} additional export warnings were omitted from the bounded report.`,
      hints: [],
    });
  }
  return result;
}

function releasePreviewUrls() {
  for (const url of previewUrls) URL.revokeObjectURL(url);
  previewUrls = [];
}

function renderPages(pages, textPages = []) {
  releasePreviewUrls();
  const fragment = document.createDocumentFragment();

  for (const [index, pageData] of pages.entries()) {
    const page = document.createElement("figure");
    page.className = "page";
    page.dataset.pageNumber = String(index + 1);
    page.style.width = "min(100%, " + Math.round(820 * previewZoom) + "px)";

    const image = document.createElement("img");
    if (typeof pageData === "string" && pageData.startsWith("data:image/")) {
      image.src = pageData;
    } else {
      const url = URL.createObjectURL(new Blob([pageData], { type: "image/svg+xml" }));
      previewUrls.push(url);
      image.src = url;
    }
    image.alt = "Typst generated PDF page " + (index + 1);
    page.append(image);

    const highlightLayer = document.createElement("div");
    highlightLayer.className = "review-highlight-layer";
    highlightLayer.setAttribute("aria-hidden", "true");
    page.append(highlightLayer);

    const textPage = textPages[index];
    if (textPage && Number(textPage.width) > 0 && Number(textPage.height) > 0) {
      const textLayer = document.createElement("div");
      textLayer.className = "preview-text-layer";
      textLayer.setAttribute("role", "document");
      textLayer.setAttribute("aria-label", "Selectable text for generated PDF page " + (index + 1));
      for (const run of Array.isArray(textPage.runs) ? textPage.runs : []) {
        if (!run || typeof run.text !== "string" || !run.text) continue;
        const textRun = document.createElement("span");
        textRun.className = "preview-text-run";
        textRun.textContent = run.text;
        textRun.style.left = (Math.max(0, Number(run.x)) / Number(textPage.width) * 100) + "%";
        textRun.style.top = (Math.max(0, Number(run.y)) / Number(textPage.height) * 100) + "%";
        textRun.style.width = (Math.max(0, Number(run.width)) / Number(textPage.width) * 100) + "%";
        textRun.style.height = (Math.max(0, Number(run.height)) / Number(textPage.height) * 100) + "%";
        textRun.style.fontSize = Math.max(0.1, Number(run.height) / 1.2 / Number(textPage.width) * 100) + "cqw";
        if (
          typeof run.sourcePath === "string" &&
          Number.isSafeInteger(run.sourceStartByte) &&
          Number.isSafeInteger(run.sourceEndByte)
        ) {
          textRun.dataset.sourcePath = run.sourcePath;
          textRun.dataset.sourceStartByte = String(run.sourceStartByte);
          textRun.dataset.sourceEndByte = String(run.sourceEndByte);
        }
        textLayer.append(textRun);
      }
      page.append(textLayer);
    }
    fragment.append(page);
  }

  preview.replaceChildren(fragment);
  preview.dataset.sourceRevision = String(revision);
  scheduleWorkspaceFindRefresh();
  window.dispatchEvent(new CustomEvent("undertree-preview-rendered"));
}

function updateSourceMetrics() {
  sourceSize.textContent = `${source.value.length.toLocaleString()} chars`;
  renderEditorLineNumbers();
}

function markActiveFile() {
  for (const button of fileList.querySelectorAll("[data-path]")) {
    const active = button.dataset.path === activePath;
    button.classList.toggle("active", active);
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  }
  const normalizedActivePath = normalizeTreePath(activePath || "");
  for (const button of fileList.querySelectorAll("[data-folder-path]")) {
    const folderPath = button.dataset.folderPath;
    button.classList.toggle(
      "contains-active",
      Boolean(normalizedActivePath && folderPath && normalizedActivePath.startsWith(`${folderPath}/`)),
    );
  }
}

function renderFiles(files) {
  projectFileEntries = (Array.isArray(files) ? files : [])
    .map(normalizeProjectFileEntry)
    .filter(Boolean);
  renderFilteredFiles();
}

function normalizeProjectFileEntry(entry) {
  if (typeof entry === "string") {
    const category = isBibliography(entry)
      ? "bibliography"
      : isLatexExportDocument(entry)
        ? "generated-latex"
        : "typst";
    return { path: entry, category, editable: true, defaultVisible: true };
  }
  if (!entry || typeof entry.path !== "string" || typeof entry.category !== "string") return null;
  return {
    path: entry.path,
    category: entry.category,
    editable: entry.editable === true,
    defaultVisible: entry.defaultVisible === true,
  };
}

function fileCategoryIcon(category) {
  return {
    typst: "T",
    "generated-latex": "L",
    latex: "L",
    bibliography: "B",
    pdf: "P",
    image: "I",
    review: "R",
    other: "·",
  }[category] || "·";
}

function normalizeTreePath(path) {
  return typeof path === "string"
    ? path.replaceAll("\\", "/").split("/").filter(Boolean).join("/")
    : "";
}

function createTreeBranch(name = "", path = "") {
  return { name, path, folders: new Map(), files: [], fileCount: 0 };
}

function buildVisibleFileTree(entries) {
  const root = createTreeBranch();
  for (const entry of entries) {
    const parts = normalizeTreePath(entry.path).split("/").filter(Boolean);
    if (!parts.length) continue;
    const fileName = parts.pop();
    let branch = root;
    branch.fileCount += 1;
    let folderPath = "";
    for (const folderName of parts) {
      folderPath = folderPath ? `${folderPath}/${folderName}` : folderName;
      if (!branch.folders.has(folderName)) {
        branch.folders.set(folderName, createTreeBranch(folderName, folderPath));
      }
      branch = branch.folders.get(folderName);
      branch.fileCount += 1;
    }
    branch.files.push({ ...entry, name: fileName });
  }
  return root;
}

function sortedTreeFolders(branch) {
  return [...branch.folders.values()].sort((left, right) =>
    fileTreeCollator.compare(left.name, right.name));
}

function sortedTreeFiles(branch) {
  return [...branch.files].sort((left, right) => fileTreeCollator.compare(left.name, right.name));
}

function setTreeDepth(element, depth) {
  element.style.setProperty("--tree-indent", `${7 + depth * 15}px`);
}

function treeRowByFolderPath(path) {
  return [...fileList.querySelectorAll("[data-folder-path]")]
    .find((button) => button.dataset.folderPath === path) || null;
}

function treeRowByFilePath(path) {
  return [...fileList.querySelectorAll("[data-path]")]
    .find((button) => button.dataset.path === path) || null;
}

function focusTreeRowAfterRender({ folderPath = null, filePath = null } = {}) {
  window.requestAnimationFrame(() => {
    const row = folderPath ? treeRowByFolderPath(folderPath) : treeRowByFilePath(filePath);
    row?.focus({ preventScroll: true });
    row?.scrollIntoView({ block: "nearest" });
  });
}

function toggleTreeFolder(path, forceOpen = null) {
  const open = expandedTreeFolders.has(path);
  const nextOpen = forceOpen === null ? !open : Boolean(forceOpen);
  if (nextOpen) expandedTreeFolders.add(path);
  else expandedTreeFolders.delete(path);
  renderFilteredFiles();
  focusTreeRowAfterRender({ folderPath: path });
}

function parentTreeFolder(path) {
  const parts = normalizeTreePath(path).split("/").filter(Boolean);
  parts.pop();
  return parts.join("/");
}

function handleTreeRowKeydown(event) {
  const current = event.currentTarget;
  const rows = [...fileList.querySelectorAll(".tree-row")]
    .filter((row) => !row.disabled && row.offsetParent !== null);
  const index = rows.indexOf(current);
  if (event.key === "ArrowDown" && index < rows.length - 1) {
    event.preventDefault();
    rows[index + 1].focus();
  } else if (event.key === "ArrowUp" && index > 0) {
    event.preventDefault();
    rows[index - 1].focus();
  } else if (event.key === "Home" && rows.length) {
    event.preventDefault();
    rows[0].focus();
  } else if (event.key === "End" && rows.length) {
    event.preventDefault();
    rows.at(-1).focus();
  } else if (event.key === "ArrowRight" && current.dataset.folderPath) {
    event.preventDefault();
    const folderPath = current.dataset.folderPath;
    if (!expandedTreeFolders.has(folderPath)) toggleTreeFolder(folderPath, true);
    else rows[index + 1]?.focus();
  } else if (event.key === "ArrowLeft") {
    const folderPath = current.dataset.folderPath;
    if (folderPath && expandedTreeFolders.has(folderPath)) {
      event.preventDefault();
      toggleTreeFolder(folderPath, false);
      return;
    }
    const parentPath = parentTreeFolder(folderPath || current.dataset.path || "");
    const parent = treeRowByFolderPath(parentPath);
    if (parent) {
      event.preventDefault();
      parent.focus();
    }
  }
}

function createFolderTreeRow(folder, depth) {
  const open = expandedTreeFolders.has(folder.path);
  const button = document.createElement("button");
  button.className = "tree-row tree-folder-row";
  button.type = "button";
  button.dataset.folderPath = folder.path;
  button.setAttribute("role", "treeitem");
  button.setAttribute("aria-level", String(depth + 1));
  button.setAttribute("aria-expanded", String(open));
  button.title = `${folder.path} · ${folder.fileCount} visible file${folder.fileCount === 1 ? "" : "s"}`;
  setTreeDepth(button, depth);

  const caret = createChevronIcon(open ? "down" : "right");
  caret.classList.add("tree-caret");
  const icon = createFolderIcon();
  const label = document.createElement("span");
  label.className = "tree-label";
  label.textContent = folder.name;
  const count = document.createElement("span");
  count.className = "tree-folder-count";
  count.textContent = folder.fileCount.toLocaleString();
  count.setAttribute("aria-label", `${folder.fileCount} visible files`);
  button.append(caret, icon, label, count);
  button.addEventListener("click", () => toggleTreeFolder(folder.path));
  button.addEventListener("keydown", handleTreeRowKeydown);
  return button;
}

function createFileTreeRow(entry, depth) {
  const button = document.createElement("button");
  button.className = "tree-row tree-file-row";
  button.type = "button";
  button.dataset.path = entry.path;
  button.dataset.editable = String(entry.editable);
  button.dataset.category = entry.category;
  button.setAttribute("role", "treeitem");
  button.setAttribute("aria-level", String(depth + 1));
  if (!entry.editable) button.classList.add("read-only-asset");
  setTreeDepth(button, depth);

  const caret = document.createElement("span");
  caret.className = "tree-caret tree-caret-placeholder";
  const icon = document.createElement("span");
  icon.className = "tree-icon";
  icon.textContent = fileCategoryIcon(entry.category);
  icon.setAttribute("aria-hidden", "true");
  const label = document.createElement("span");
  label.className = "tree-label";
  label.textContent = entry.name;
  button.append(caret, icon, label);
  button.addEventListener("keydown", handleTreeRowKeydown);
  if (entry.editable) {
    button.title = `Open ${entry.path}`;
    button.addEventListener("click", () => void openDocument(entry.path));
  } else {
    button.title = `${entry.path} · visible project asset (not editable in UnderTree)`;
    button.addEventListener("click", () => {
      setStatus("ready", `${entry.path} · visible read-only asset`);
    });
  }
  return button;
}

function renderTreeBranch(branch, parent, depth = 0) {
  for (const folder of sortedTreeFolders(branch)) {
    const wrapper = document.createElement("div");
    wrapper.className = "tree-directory";
    wrapper.dataset.branchPath = folder.path;
    parent.append(wrapper);
    wrapper.append(createFolderTreeRow(folder, depth));
    if (expandedTreeFolders.has(folder.path)) {
      wrapper.classList.add("open");
      const children = document.createElement("div");
      children.className = "tree-children";
      children.setAttribute("role", "group");
      children.style.setProperty("--tree-guide", `${14 + depth * 15}px`);
      wrapper.append(children);
      renderTreeBranch(folder, children, depth + 1);
    }
  }
  for (const entry of sortedTreeFiles(branch)) parent.append(createFileTreeRow(entry, depth));
}

function expandTreeToFile(path) {
  const parts = normalizeTreePath(path).split("/").filter(Boolean);
  parts.pop();
  let folderPath = "";
  let changed = false;
  for (const part of parts) {
    folderPath = folderPath ? `${folderPath}/${part}` : part;
    if (!expandedTreeFolders.has(folderPath)) {
      expandedTreeFolders.add(folderPath);
      changed = true;
    }
  }
  if (changed) renderFilteredFiles();
  else markActiveFile();
  focusTreeRowAfterRender({ filePath: path });
}

function renderFilteredFiles() {
  const enabledCategories = new Set(
    fileCategoryFilters.filter((control) => control.checked).map((control) => control.dataset.fileCategory),
  );
  const showEverything = showAllFiles.checked;
  const visible = projectFileEntries.filter(
    (entry) => showEverything || enabledCategories.has(entry.category),
  );
  const previousScroll = fileList.scrollTop;
  const fragment = document.createDocumentFragment();
  const tree = buildVisibleFileTree(visible);
  renderTreeBranch(tree, fragment);
  if (!visible.length) {
    const empty = document.createElement("p");
    empty.className = "tree-empty";
    empty.textContent = projectFileEntries.length
      ? "No files match the current visibility filters."
      : "This project has no visible files.";
    fragment.append(empty);
  }
  fileList.replaceChildren(fragment);
  fileList.scrollTop = previousScroll;
  const hidden = Math.max(0, projectFileEntries.length - visible.length);
  treeFilterCount.textContent = showEverything
    ? `${visible.length} file${visible.length === 1 ? "" : "s"}`
    : hidden
      ? `${visible.length} shown · ${hidden} hidden`
      : `${visible.length} shown`;
  for (const control of fileCategoryFilters) control.disabled = showEverything;
  collapseTreeButton.disabled = tree.folders.size === 0;
  markActiveFile();
  scheduleWorkspaceFindRefresh();
}

function loadDocument(documentData) {
  closeCitationSession({ compile: false });
  activePath = documentData.path;
  activeDigest = documentData.digest;
  source.value = documentData.source;
  agentPolicy = emptyAgentPolicy(activePath);
  agentAnnotationSourceSnapshot = source.value;
  agentAnnotationsDirty = false;
  renderVisualEditor();
  activeTabLabel.textContent = documentData.path;
  revision += 1;
  updateEditorInterlocks();
  const typstDocument = isTypstDocument(activePath);
  compileButton.disabled = !typstDocument;
  for (const control of typstToolbarControls) control.disabled = githubUiBusy || !typstDocument;
  expandTreeToFile(activePath);
  updateSourceMetrics();
  renderDiagnostics();
  void setEditorDirty(false);
  updateGithubLinkAvailability();
  void loadAgentAnnotations();
  setStatus("ready", "Saved");
  window.dispatchEvent(new CustomEvent("undertree-document-changed"));
  if (typstDocument) {
    void compileLatest();
  } else {
    previewMeta.textContent = isLatexExportDocument(activePath)
      ? "Generated LaTeX draft · Typst preview unchanged"
      : "Bibliography editor · Typst preview unchanged";
  }
}

function applyTypstEdit(edit) {
  if (source.readOnly || !isTypstDocument(activePath) || !edit) return;
  const previous = source.value;
  let prefix = 0;
  while (prefix < previous.length && prefix < edit.source.length && previous[prefix] === edit.source[prefix]) {
    prefix += 1;
  }
  let previousEnd = previous.length;
  let nextEnd = edit.source.length;
  while (previousEnd > prefix && nextEnd > prefix && previous[previousEnd - 1] === edit.source[nextEnd - 1]) {
    previousEnd -= 1;
    nextEnd -= 1;
  }
  source.setRangeText(edit.source.slice(prefix, nextEnd), prefix, previousEnd, "start");
  source.setSelectionRange(edit.selectionStart, edit.selectionEnd);
  source.dispatchEvent(new Event("input", { bubbles: true }));
  source.focus();
}

function insertAroundSelection(before, after = before, placeholder = "text") {
  applyTypstEdit(typstEditing.applyInline(
    source.value,
    source.selectionStart,
    source.selectionEnd,
    before,
    after,
    placeholder,
  ));
}

function applySelectedBlockStyle(style) {
  if (!style) return;
  applyTypstEdit(typstEditing.applyBlockStyle(
    source.value,
    source.selectionStart,
    source.selectionEnd,
    style,
  ));
}

function insertLink() {
  const edit = typstEditing.insertSnippet(
    source.value,
    source.selectionStart,
    source.selectionEnd,
    '#link("https://example.com")[{{selection}}]',
    "link text",
  );
  const urlStart = edit.source.indexOf("https://example.com", Math.max(0, source.selectionStart - 1));
  if (urlStart >= 0) {
    edit.selectionStart = urlStart;
    edit.selectionEnd = urlStart + "https://example.com".length;
  }
  applyTypstEdit(edit);
}

const ELEMENT_SNIPPETS = {
  "page-break": { template: "\n#pagebreak()\n", placeholder: "" },
  figure: {
    template: '\n#figure(\n  {{selection}},\n  caption: [Describe this figure],\n)\n',
    placeholder: 'image("image.png")',
  },
  table: {
    template: "\n#table(\n  columns: 2,\n  [{{selection}}], [Value],\n  [Row 2], [Value],\n)\n",
    placeholder: "Heading",
  },
  note: {
    template: "\n#block(fill: rgb(\"eef4f8\"), inset: 10pt, radius: 4pt)[\n  *Note:* {{selection}}\n]\n",
    placeholder: "Write your note here.",
  },
  code: { template: "\n```\n{{selection}}\n```\n", placeholder: "code" },
};

function insertSelectedElement(kind) {
  const snippet = ELEMENT_SNIPPETS[kind];
  if (!snippet) return;
  applyTypstEdit(typstEditing.insertSnippet(
    source.value,
    source.selectionStart,
    source.selectionEnd,
    snippet.template,
    snippet.placeholder,
  ));
}

async function refreshBibliographyIndex() {
  const requestedRoot = activeProjectRoot;
  const request = ++bibliographyRequest;
  bibliographyEntries = [];
  bibliographyIssues = [];
  if (!requestedRoot) {
    if (citationSession) renderCitationPopup();
    return;
  }

  try {
    const result = await nativeInvoke("bibliography_entries");
    if (request !== bibliographyRequest || requestedRoot !== activeProjectRoot) return;
    const prepareEntry = window.UnderTreeCitationSearch?.prepareEntry;
    bibliographyEntries = typeof prepareEntry === "function"
      ? (Array.isArray(result?.entries) ? result.entries : [])
        .filter((entry) => typeof entry?.key === "string" && entry.key.length > 0)
        .map(prepareEntry)
      : [];
    bibliographyIssues = Array.isArray(result?.issues) ? result.issues : [];
  } catch (error) {
    if (request !== bibliographyRequest || requestedRoot !== activeProjectRoot) return;
    bibliographyIssues = [{
      sourcePath: "",
      message: safeErrorMessage(error, "Citation recommendations could not read this project's bibliographies."),
    }];
  }
  if (citationSession) renderCitationPopup();
}

function citationQuery() {
  if (!citationSession) return "";
  return source.value.slice(citationSession.start + 1, source.selectionStart);
}

function citationSessionIsValid() {
  if (!citationSession || !isTypstDocument(activePath)) return false;
  const caret = source.selectionStart;
  if (caret !== source.selectionEnd || caret <= citationSession.start) return false;
  if (source.value[citationSession.start] !== "@") return false;
  const query = source.value.slice(citationSession.start + 1, caret);
  return query.length <= 240 && !/[\r\n@]/.test(query);
}

function isCitationTriggerBoundary(character) {
  return !character || !/[\p{L}\p{N}_@]/u.test(character);
}

function maybeStartCitationSession() {
  if (citationSession || suppressCitationTrigger || !isTypstDocument(activePath)) return;
  const caret = source.selectionStart;
  if (caret !== source.selectionEnd || caret < 1 || source.value[caret - 1] !== "@") return;
  if (!isCitationTriggerBoundary(source.value[caret - 2])) return;
  openCitationSession(caret - 1);
}

function openCitationSession(start) {
  if (!isTypstDocument(activePath) || source.readOnly) return;
  window.clearTimeout(compileTimer);
  citationSession = { start, selected: [], highlighted: 0, lastQuery: null };
  source.setAttribute("aria-autocomplete", "list");
  source.setAttribute("aria-controls", "citation-popup");
  source.setAttribute("aria-expanded", "true");
  renderCitationPopup();
}

function closeCitationSession({ compile = true } = {}) {
  if (!citationSession && citationPopup.hidden) return;
  citationSession = null;
  currentCitationResults = [];
  citationPopup.hidden = true;
  source.removeAttribute("aria-activedescendant");
  source.removeAttribute("aria-autocomplete");
  source.removeAttribute("aria-controls");
  source.setAttribute("aria-expanded", "false");
  if (compile && isTypstDocument(activePath)) scheduleCompile();
}

function synchronizeCitationSession() {
  if (!citationSession) {
    maybeStartCitationSession();
    return;
  }
  if (!citationSessionIsValid()) {
    closeCitationSession();
    return;
  }
  renderCitationPopup();
}

function positionCitationPopup() {
  if (!citationSession || citationPopup.hidden) return;
  const style = window.getComputedStyle(source);
  const fontSize = Number.parseFloat(style.fontSize) || 13;
  const lineHeight = Number.parseFloat(style.lineHeight) || fontSize * 1.45;
  const paddingLeft = Number.parseFloat(style.paddingLeft) || 64;
  const paddingTop = Number.parseFloat(style.paddingTop) || 12;
  const beforeCaret = source.value.slice(0, source.selectionStart);
  const lineStart = beforeCaret.lastIndexOf("\n") + 1;
  const line = beforeCaret.slice(lineStart).replace(/\t/g, "  ");
  const lineIndex = beforeCaret.slice(0, lineStart).split("\n").length - 1;
  if (textMeasureContext) textMeasureContext.font = style.font;
  const lineWidth = textMeasureContext
    ? textMeasureContext.measureText(line).width
    : line.length * fontSize * 0.61;
  const popupWidth = Math.max(260, Math.min(520, editorHost.clientWidth - 24));
  citationPopup.style.width = `${popupWidth}px`;
  const left = Math.min(
    Math.max(8, paddingLeft + lineWidth - source.scrollLeft),
    Math.max(8, editorHost.clientWidth - popupWidth - 8),
  );
  const below = paddingTop + (lineIndex + 1) * lineHeight - source.scrollTop + 6;
  const popupHeight = citationPopup.offsetHeight;
  const preferredTop = below + popupHeight > editorHost.clientHeight - 8
    ? below - lineHeight - popupHeight - 12
    : below;
  const top = Math.min(
    Math.max(8, preferredTop),
    Math.max(8, editorHost.clientHeight - popupHeight - 8),
  );
  citationPopup.style.left = `${left}px`;
  citationPopup.style.top = `${top}px`;
}

function renderCitationPopup() {
  if (!citationSession || !citationSessionIsValid()) return;
  const query = citationQuery();
  if (query !== citationSession.lastQuery) {
    citationSession.lastQuery = query;
    citationSession.highlighted = 0;
  }
  const excludedKeys = new Set(citationSession.selected.map((entry) => entry.key));
  currentCitationResults = window.UnderTreeCitationSearch?.rankEntries?.(
    bibliographyEntries,
    query,
    excludedKeys,
    MAX_CITATION_RESULTS,
  ) || [];
  citationSession.highlighted = Math.min(
    citationSession.highlighted,
    Math.max(0, currentCitationResults.length - 1),
  );

  citationSelected.hidden = citationSession.selected.length === 0;
  citationSelected.replaceChildren(...citationSession.selected.map((entry) => {
    const chip = document.createElement("span");
    chip.className = "citation-chip";
    chip.textContent = `@${entry.key}`;
    chip.title = entry.title || entry.key;
    return chip;
  }));

  const fragment = document.createDocumentFragment();
  currentCitationResults.forEach((entry, index) => {
    const option = document.createElement("div");
    option.id = `citation-option-${index}`;
    option.className = `citation-option${index === citationSession.highlighted ? " active" : ""}`;
    option.setAttribute("role", "option");
    option.setAttribute("aria-selected", String(index === citationSession.highlighted));

    const handle = document.createElement("span");
    handle.className = "citation-option-handle";
    handle.textContent = `@${entry.key}`;
    const year = document.createElement("span");
    year.className = "citation-option-year";
    year.textContent = entry.year || "";
    const title = document.createElement("span");
    title.className = "citation-option-title";
    title.textContent = entry.title || "Untitled reference";
    const meta = document.createElement("span");
    meta.className = "citation-option-meta";
    meta.textContent = [entry.authors, entry.venue, entry.sourcePath].filter(Boolean).join(" · ");
    option.append(handle, year, title, meta);
    option.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      citationSession.highlighted = index;
      commitCitationSession();
    });
    fragment.append(option);
  });

  if (!currentCitationResults.length) {
    const empty = document.createElement("div");
    empty.className = "citation-empty";
    const issue = bibliographyIssues[0]?.message;
    empty.textContent = issue || (bibliographyEntries.length
      ? "No citation matches all of those terms. Keep editing the text after @ or press Esc."
      : "No citations are available yet. Add entries to a project .bib file, save it, and type @ again.");
    fragment.append(empty);
  }
  citationResults.replaceChildren(fragment);
  citationResultCount.textContent = currentCitationResults.length
    ? `${currentCitationResults.length} best match${currentCitationResults.length === 1 ? "" : "es"}`
    : "No match";
  citationPopup.hidden = false;
  if (currentCitationResults.length) {
    source.setAttribute("aria-activedescendant", `citation-option-${citationSession.highlighted}`);
  } else {
    source.removeAttribute("aria-activedescendant");
  }
  window.requestAnimationFrame(positionCitationPopup);
}

function citationMarkup(key) {
  return /^[\p{L}\p{N}_][\p{L}\p{N}_.:-]*$/u.test(key)
    ? `@${key}`
    : `#cite(label(${JSON.stringify(key)}))`;
}

function replaceCitationQuery(replacement, { keepSession = false } = {}) {
  const session = citationSession;
  if (!session) return;
  const end = source.selectionStart;
  if (!keepSession) {
    citationSession = null;
    currentCitationResults = [];
    citationPopup.hidden = true;
    source.removeAttribute("aria-activedescendant");
    source.removeAttribute("aria-autocomplete");
    source.removeAttribute("aria-controls");
    source.setAttribute("aria-expanded", "false");
  }
  suppressCitationTrigger = true;
  source.setRangeText(replacement, session.start, end, "end");
  source.dispatchEvent(new Event("input", { bubbles: true }));
  suppressCitationTrigger = false;
  source.focus();
}

function stageCitation() {
  if (!citationSession || !currentCitationResults.length) return false;
  const entry = currentCitationResults[citationSession.highlighted];
  if (!citationSession.selected.some((selected) => selected.key === entry.key)) {
    citationSession.selected.push(entry);
  }
  citationSession.highlighted = 0;
  citationSession.lastQuery = "";
  replaceCitationQuery("@", { keepSession: true });
  renderCitationPopup();
  return true;
}

function commitCitationSession() {
  if (!citationSession) return false;
  const selected = [...citationSession.selected];
  const query = citationQuery().trim();
  if ((!selected.length || query) && currentCitationResults.length) {
    const current = currentCitationResults[citationSession.highlighted];
    if (!selected.some((entry) => entry.key === current.key)) selected.push(current);
  }
  if (!selected.length) return false;
  replaceCitationQuery(`${selected.map((entry) => citationMarkup(entry.key)).join(" ")} `);
  return true;
}

function handleCitationKeydown(event) {
  if (!citationSession || event.isComposing) return;
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    if (!currentCitationResults.length) return;
    const direction = event.key === "ArrowDown" ? 1 : -1;
    citationSession.highlighted = (
      citationSession.highlighted + direction + currentCitationResults.length
    ) % currentCitationResults.length;
    renderCitationPopup();
    return;
  }
  if (event.key === "Enter") {
    event.preventDefault();
    if (event.shiftKey) stageCitation();
    else commitCitationSession();
    return;
  }
  if (event.key === "Escape") {
    event.preventDefault();
    closeCitationSession();
  }
}

function beginCitationFromToolbar() {
  if (source.readOnly || !isTypstDocument(activePath)) return;
  const start = source.selectionStart;
  const selected = source.value.slice(start, source.selectionEnd);
  const query = /[\r\n@]/.test(selected) ? "" : selected;
  source.setRangeText(`@${query}`, start, source.selectionEnd, "end");
  openCitationSession(start);
  source.dispatchEvent(new Event("input", { bubbles: true }));
  source.focus();
}

function setPreviewZoom(nextZoom) {
  previewZoom = Math.min(1.8, Math.max(0.55, nextZoom));
  for (const page of preview.querySelectorAll(".page")) {
    page.style.width = "min(100%, " + Math.round(820 * previewZoom) + "px)";
  }
  window.dispatchEvent(new CustomEvent("undertree-preview-resized"));
}

function exportedPdfMatchesEditor(exported = lastPdfExport) {
  return Boolean(
    exported
    && exported.documentPath === activePath
    && exported.revision === revision,
  );
}

function updatePdfActions() {
  const canReveal = exportedPdfMatchesEditor();
  pdfRevealButton.hidden = !canReveal;
  if (canReveal) {
    const revealLabel = `Show ${lastPdfExport.fileName} in its folder`;
    pdfRevealButton.title = revealLabel;
    pdfRevealButton.setAttribute("aria-label", revealLabel);
  }
  pdfExportButton.setAttribute("aria-busy", String(pdfExportInFlight));
  pdfRevealButton.setAttribute("aria-busy", String(pdfExportInFlight));
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

function updateEditorInterlocks() {
  const disabled = saveInFlight || githubUiBusy || navigationInFlight || remoteControlBusy;
  source.readOnly = githubUiBusy || navigationInFlight || remoteControlBusy;
  homeButton.disabled = disabled;
  openProjectButton.disabled = disabled;
  importLatexButton.disabled = disabled;
  exportLatexButton.disabled = disabled || !activeProjectRoot || !isTypstDocument(activePath);
  projectPicker.disabled = disabled;
  newBibliographyButton.disabled = disabled || activePath === null;
  saveButton.disabled = disabled || !activePath;
  refreshProjectButton.disabled = disabled;
  undoButton.disabled = disabled;
  redoButton.disabled = disabled;
  const typstDocument = isTypstDocument(activePath);
  const canReveal = exportedPdfMatchesEditor();
  compileButton.disabled = disabled || compileInFlight || pdfExportInFlight || !typstDocument;
  pdfExportButton.disabled = disabled || compileInFlight || pdfExportInFlight || !typstDocument;
  pdfRevealButton.disabled = disabled || compileInFlight || pdfExportInFlight || !canReveal;
  updatePdfActions();
  for (const control of typstToolbarControls) control.disabled = disabled || !typstDocument;
  const annotationDisabled = disabled || !typstDocument || !activeProjectRoot || !activePath;
  agentMarkKeepButton.disabled = annotationDisabled;
  agentMarkReviseButton.disabled = annotationDisabled;
  agentMarkCatalogButton.disabled = !typstDocument || !activePath;
  for (const button of fileList.querySelectorAll("[data-path]")) button.disabled = disabled;
}

function setNavigationInFlight(busy) {
  navigationInFlight = Boolean(busy);
  updateEditorInterlocks();
  if (!navigationInFlight && pendingCompile && !compileInFlight) {
    pendingCompile = false;
    void compileLatest();
  }
}

function setRemoteControlBusy(busy) {
  remoteControlBusy = Boolean(busy);
  updateEditorInterlocks();
  renderGithubSurfaces();
}

async function prepareEditorNavigation() {
  if (githubUiBusy || saveInFlight || navigationInFlight || remoteControlBusy) return false;
  if (!editorDirty) return true;
  const choice = await confirmUnsavedNavigation();
  if (choice === "discard") return true;
  if (choice !== "save") return false;
  const saved = await saveLatest();
  return saved && !editorDirty;
}

function applyProjectSnapshot(project, { projectChanged = true } = {}) {
  if (projectChanged) {
    expandedTreeFolders.clear();
    githubProjectGeneration += 1;
    githubStatusRequest += 1;
    githubRepositoryRequest += 1;
    githubStatusKnown = false;
    githubStatusError = "";
    githubRepositories = [];
    githubSchedulerNotice = null;
    githubRulesTouched = false;
    githubRulesRepository = "";
    renderGithubSurfaces();
  }
  if (project?.conversion) {
    conversionDiagnostics = diagnosticsFromConversion(project.conversion);
  } else if (projectChanged) {
    conversionDiagnostics = [];
  }
  activeProjectName = project.name;
  activeProjectRoot = typeof project.root === "string" ? project.root : "";
  renderProjectPicker();
  void refreshRecentProjects();
  renderFiles(project.allFiles || project.files);
  newBibliographyButton.disabled = false;
  loadDocument(project.active);
  void refreshBibliographyIndex();
}

function renderProjectPicker() {
  const fragment = document.createDocumentFragment();
  const knownRoots = new Set(recentProjects.map((project) => project.root));
  if (activeProjectRoot && !knownRoots.has(activeProjectRoot)) {
    recentProjects = [{ name: activeProjectName, root: activeProjectRoot, parent: "" }, ...recentProjects];
  }
  if (!activeProjectRoot) {
    const scratch = document.createElement("option");
    scratch.value = "";
    scratch.textContent = "Scratch workspace";
    fragment.append(scratch);
  }
  for (const project of recentProjects) {
    const option = document.createElement("option");
    option.value = project.root;
    option.textContent = project.parent ? `${project.name} — ${project.parent}` : project.name;
    option.title = project.root;
    option.selected = project.root === activeProjectRoot;
    fragment.append(option);
  }
  projectPicker.replaceChildren(fragment);
}

async function refreshRecentProjects() {
  try {
    const projects = await nativeInvoke("recent_projects");
    recentProjects = Array.isArray(projects) ? projects : [];
    renderProjectPicker();
  } catch {
    renderProjectPicker();
  }
}

async function openRememberedProject(root) {
  if (!root || root === activeProjectRoot) {
    renderProjectPicker();
    return;
  }
  if (!(await prepareEditorNavigation())) {
    renderProjectPicker();
    return;
  }
  const requestedNavigation = ++navigationRequest;
  setNavigationInFlight(true);
  setStatus("busy", "Reopening project…");
  try {
    const project = await nativeInvoke("open_recent_project", { root });
    if (requestedNavigation !== navigationRequest) return;
    applyProjectSnapshot(project);
    void refreshGithubStatus({ loadRepositories: !githubModalBackdrop.hidden });
  } catch (error) {
    if (requestedNavigation !== navigationRequest) return;
    renderProjectPicker();
    renderDiagnostics([
      { severity: "error", message: safeErrorMessage(error, "The remembered project could not be reopened."), hints: [] },
    ]);
    setStatus("error", "Reopen failed");
  } finally {
    if (requestedNavigation === navigationRequest) setNavigationInFlight(false);
  }
}

async function importLatexProject() {
  if (!(await prepareEditorNavigation())) return;
  const requestedNavigation = ++navigationRequest;
  setNavigationInFlight(true);
  setStatus("busy", "Importing LaTeX project…");
  try {
    const result = await nativeInvoke("import_latex_project");
    if (!result) {
      setStatus(editorDirty ? "dirty" : "ready", editorDirty ? "Unsaved edit" : activePath ? "Project unchanged" : "Scratch workspace");
      return;
    }
    if (requestedNavigation !== navigationRequest) return;
    conversionDiagnostics = diagnosticsFromConversion(result.report);
    applyProjectSnapshot(result.project);
    void refreshGithubStatus({ loadRepositories: !githubModalBackdrop.hidden });
  } catch (error) {
    if (requestedNavigation !== navigationRequest) return;
    conversionDiagnostics = [];
    renderDiagnostics([
      { severity: "error", message: safeErrorMessage(error, "The LaTeX project could not be imported."), hints: [] },
    ]);
    setStatus("error", "LaTeX import failed");
  } finally {
    if (requestedNavigation === navigationRequest) setNavigationInFlight(false);
  }
}

async function exportTypstToLatex() {
  if (!activeProjectRoot || !activePath || !isTypstDocument(activePath)) {
    const error = {
      code: "typst_document_required",
      message: "Open a saved .typ document inside a project before exporting it to LaTeX.",
    };
    renderDiagnostics([{
      severity: "warning",
      message: error.message,
      hints: [],
    }]);
    setStatus("warning", "Typst document required");
    return { converted: false, error };
  }
  if (editorDirty) {
    const save = await saveLatestResult();
    if (!save.saved) {
      return {
        converted: false,
        error: save.error || {
          code: "save_failed",
          message: "The Typst document could not be saved before conversion.",
        },
      };
    }
  }

  const sourcePath = activePath;
  const requestedNavigation = ++navigationRequest;
  setNavigationInFlight(true);
  setStatus("busy", "Converting Typst to LaTeX…");
  try {
    const result = await nativeInvoke("export_typst_to_latex", { path: sourcePath });
    if (requestedNavigation !== navigationRequest) {
      return {
        converted: false,
        error: {
          code: "remote_request_superseded",
          message: "Another navigation request superseded the conversion.",
        },
      };
    }
    conversionDiagnostics = diagnosticsFromTypstToLatex(result.report);
    applyProjectSnapshot(result.project, { projectChanged: false });
    setStatus("warning", "LaTeX draft created · review before submission");
    return {
      converted: true,
      report: result.report,
      error: null,
    };
  } catch (error) {
    if (requestedNavigation !== navigationRequest) {
      return {
        converted: false,
        error: {
          code: "remote_request_superseded",
          message: "Another navigation request superseded the conversion.",
        },
      };
    }
    conversionDiagnostics = [];
    const safeError = error && typeof error === "object" ? error : {};
    renderDiagnostics(
      Array.isArray(safeError.diagnostics) && safeError.diagnostics.length
        ? safeError.diagnostics
        : [{ severity: "error", message: safeErrorMessage(error, "The Typst document could not be exported to LaTeX."), hints: [] }],
    );
    setStatus("error", "Typst-to-LaTeX export failed");
    return {
      converted: false,
      error: normalizeRemoteFailure(
        error,
        "conversion_failed",
        "The Typst document could not be exported to LaTeX.",
      ),
    };
  } finally {
    if (requestedNavigation === navigationRequest) setNavigationInFlight(false);
  }
}

async function refreshProjectFromDisk() {
  if (!activePath) {
    await compileLatest();
    return;
  }
  if (!(await prepareEditorNavigation())) return;
  const requestedNavigation = ++navigationRequest;
  const preferredPath = activePath;
  setNavigationInFlight(true);
  setStatus("busy", "Refreshing project from disk…");
  try {
    const project = await nativeInvoke("refresh_project", { preferredPath });
    if (requestedNavigation !== navigationRequest) return;
    applyProjectSnapshot(project, { projectChanged: false });
    setStatus("ready", "Refreshed from disk");
    void refreshGithubStatus({ loadRepositories: !githubModalBackdrop.hidden });
  } catch (error) {
    if (requestedNavigation !== navigationRequest) return;
    renderDiagnostics([
      { severity: "error", message: safeErrorMessage(error, "The local project could not be refreshed."), hints: [] },
    ]);
    setStatus("error", "Refresh failed");
  } finally {
    if (requestedNavigation === navigationRequest) setNavigationInFlight(false);
  }
}

async function chooseProject() {
  if (!(await prepareEditorNavigation())) return;
  const requestedNavigation = ++navigationRequest;
  setNavigationInFlight(true);
  setStatus("busy", "Choosing project…");
  try {
    const project = await nativeInvoke("choose_project");
    if (!project) {
      setStatus(editorDirty ? "dirty" : "ready", editorDirty ? "Unsaved edit" : activePath ? "Project unchanged" : "Scratch workspace");
      return;
    }
    if (requestedNavigation !== navigationRequest) return;

    applyProjectSnapshot(project);
    void refreshGithubStatus({ loadRepositories: !githubModalBackdrop.hidden });
  } catch (error) {
    if (requestedNavigation !== navigationRequest) return;
    renderDiagnostics([
      { severity: "error", message: safeErrorMessage(error, "The project could not be opened."), hints: [] },
    ]);
    setStatus("error", "Open failed");
  } finally {
    if (requestedNavigation === navigationRequest) setNavigationInFlight(false);
  }
}

async function createBibliography() {
  if (!(await prepareEditorNavigation())) return;
  const requested = window.prompt("Bibliography path inside this project", "references.bib");
  if (requested === null) return;

  let path = requested.trim();
  if (!path) {
    setStatus("warning", "Enter a bibliography file name");
    return;
  }
  if (!path.toLowerCase().endsWith(".bib")) path += ".bib";

  const requestedNavigation = ++navigationRequest;
  setNavigationInFlight(true);
  setStatus("busy", "Creating bibliography…");
  try {
    const result = await nativeInvoke("create_bibliography", { path });
    if (requestedNavigation !== navigationRequest) return;
    renderFiles(result.allFiles || result.files);
    loadDocument(result.document);
  } catch (error) {
    if (requestedNavigation !== navigationRequest) return;
    renderDiagnostics([
      { severity: "error", message: safeErrorMessage(error, "The bibliography could not be created."), hints: [] },
    ]);
    setStatus("error", "Create failed");
  } finally {
    if (requestedNavigation === navigationRequest) setNavigationInFlight(false);
  }
}

async function openDocument(path) {
  if (path === activePath) return;
  if (!(await prepareEditorNavigation())) return;
  const requestedNavigation = ++navigationRequest;
  setNavigationInFlight(true);
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
  } finally {
    if (requestedNavigation === navigationRequest) setNavigationInFlight(false);
  }
}

async function saveDocumentOnce() {
  saveInFlight = true;
  updateEditorInterlocks();
  const requestedRevision = revision;
  const requestedPath = activePath;
  const requestedSource = source.value;
  const requestedDigest = activeDigest;
  saveButton.disabled = true;
  setStatus("busy", "Saving…");
  const outcome = {
    saved: false,
    conflictPath: null,
    error: null,
  };
  try {
    const result = await nativeInvoke("save_document", {
      request: {
        path: requestedPath,
        source: requestedSource,
        expectedDigest: requestedDigest,
        revision: requestedRevision,
      },
    });

    if (isBibliography(requestedPath)) void refreshBibliographyIndex();

    if (activePath === requestedPath) {
      activeDigest = result.digest;
      if (result.revision === revision) {
        void setEditorDirty(false);
        outcome.saved = true;
        outcome.conflictPath = result.conflictPath || null;
        setStatus(
          result.conflictPath ? "warning" : "ready",
          result.conflictPath ? `Saved · conflict preserved at ${result.conflictPath}` : "Saved",
        );
      } else {
        void setEditorDirty(true);
        outcome.error = {
          code: "stale_editor_revision",
          message: "The editor changed before the save completed. Save the current revision and try again.",
        };
        setStatus("dirty", "Unsaved edit");
      }
    }
  } catch (error) {
    outcome.error = normalizeRemoteFailure(
      error,
      "save_failed",
      "The document could not be saved.",
    );
    if (activePath === requestedPath) {
      renderDiagnostics([
        { severity: "error", message: safeErrorMessage(error, "The document could not be saved."), hints: [] },
      ]);
      void setEditorDirty(true);
      setStatus("error", "Save failed");
    }
  } finally {
    saveInFlight = false;
    updateEditorInterlocks();
  }
  return outcome;
}

async function saveLatestResult() {
  if (githubUiBusy || navigationInFlight) {
    setStatus("busy", githubUiBusy ? "GitHub operation in progress" : "Project navigation in progress");
    return {
      saved: false,
      conflictPath: null,
      error: {
        code: "editor_busy",
        message: "The editor is busy with another operation.",
      },
    };
  }
  if (!activePath) {
    setStatus("warning", "Choose a project before saving");
    return {
      saved: false,
      conflictPath: null,
      error: {
        code: "document_required",
        message: "Open a project document before saving.",
      },
    };
  }

  if (isTypstDocument(activePath) && !(await flushAgentAnnotations())) {
    return {
      saved: false,
      conflictPath: null,
      error: {
        code: "agent_annotations_unsaved",
        message: "The AI editing marks could not be synchronized before saving.",
      },
    };
  }

  pendingSave = true;
  if (saveLoopPromise) return saveLoopPromise;
  saveLoopPromise = (async () => {
    let outcome = {
      saved: false,
      conflictPath: null,
      error: null,
    };
    while (pendingSave) {
      pendingSave = false;
      outcome = await saveDocumentOnce();
    }
    if (outcome.saved && editorDirty) {
      return {
        ...outcome,
        saved: false,
        error: {
          code: "stale_editor_revision",
          message: "The editor changed before the save completed. Save the current revision and try again.",
        },
      };
    }
    return outcome;
  })();

  try {
    return await saveLoopPromise;
  } finally {
    saveLoopPromise = null;
  }
}

async function saveLatest() {
  const outcome = await saveLatestResult();
  return outcome.saved;
}

window.UnderTreeEditorBridge = {
  getState() {
    return {
      projectRoot: activeProjectRoot,
      path: activePath,
      source: source.value,
      digest: activeDigest,
      revision,
      dirty: editorDirty,
    };
  },
  async ensureSaved() {
    if (editorDirty) {
      const outcome = await saveLatestResult();
      if (!outcome.saved || editorDirty) {
        throw outcome.error || { code: "save_failed", message: "The manuscript could not be saved." };
      }
    }
    return this.getState();
  },
  invoke(command, args = {}) {
    return nativeInvoke(command, args);
  },
  applyDecision(result) {
    if (!result?.changedSource || typeof result.source !== "string" || typeof result.digest !== "string" || !activePath) return;
    loadDocument({ path: activePath, source: result.source, digest: result.digest });
  },
};

async function exportCurrentPdf() {
  if (pdfExportInFlight || compileInFlight || !isTypstDocument(activePath)) return;
  const requestedPath = activePath;
  const requestedRevision = revision;
  const previousStatus = {
    state: statusDot.dataset.state || "ready",
    text: statusText.textContent,
  };
  pdfExportInFlight = true;
  updateEditorInterlocks();
  setStatus("busy", "Creating PDF…");

  try {
    const result = await nativeInvoke("export_pdf", {
      request: {
        source: source.value,
        path: requestedPath,
        revision: requestedRevision,
      },
    });
    if (!result) {
      if (activePath === requestedPath && revision === requestedRevision) {
        setStatus(previousStatus.state, previousStatus.text);
      }
      return;
    }

    lastPdfExport = {
      documentPath: requestedPath,
      revision: result.revision,
      fileName: result.fileName,
    };
    if (activePath !== requestedPath || result.revision !== revision) return;

    renderDiagnostics(result.warnings);
    setStatus(
      result.warnings.length ? "warning" : "ready",
      `PDF saved · ${result.fileName}`,
    );
  } catch (error) {
    if (activePath === requestedPath && revision === requestedRevision) {
      const safeError = error && typeof error === "object" ? error : {};
      renderDiagnostics(
        Array.isArray(safeError.diagnostics) && safeError.diagnostics.length
          ? safeError.diagnostics
          : [{ severity: "error", message: safeErrorMessage(error, "The PDF could not be saved."), hints: [] }],
      );
      setStatus("error", "PDF export failed");
    }
  } finally {
    pdfExportInFlight = false;
    updateEditorInterlocks();
    if (pendingCompile && !compileInFlight && !navigationInFlight && !githubUiBusy) {
      void compileLatest();
    }
  }
}

async function revealCurrentPdf() {
  const exported = lastPdfExport;
  if (pdfExportInFlight || !exportedPdfMatchesEditor(exported)) {
    await exportCurrentPdf();
    return;
  }

  pdfExportInFlight = true;
  updateEditorInterlocks();
  try {
    await nativeInvoke("reveal_exported_pdf", {
      request: {
        documentPath: exported.documentPath,
        revision: exported.revision,
      },
    });
    if (exportedPdfMatchesEditor(exported)) {
      setStatus("ready", `Showing ${exported.fileName} in its folder`);
    }
  } catch (error) {
    if (error?.code === "pdf_export_missing" && lastPdfExport === exported) lastPdfExport = null;
    if (exportedPdfMatchesEditor(exported)) {
      renderDiagnostics([
        { severity: "error", message: safeErrorMessage(error, "The exported PDF location could not be opened."), hints: [] },
      ]);
      setStatus("error", "PDF location unavailable");
    }
  } finally {
    pdfExportInFlight = false;
    updateEditorInterlocks();
  }
}

async function compileDocumentOnce() {
  compileInFlight = true;
  compileButton.disabled = true;
  const requestedPath = activePath;
  const requestedRevision = revision;
  setStatus("busy", "Compiling…");

  try {
    const result = await nativeInvoke("compile_document", {
      request: {
        source: source.value,
        path: requestedPath,
        revision: requestedRevision,
      },
    });

    if (activePath !== requestedPath || result.revision !== revision) {
      pendingCompile = isTypstDocument(activePath);
      return {
        compiled: false,
        error: {
          code: "stale_editor_revision",
          message: "The editor changed before compilation completed.",
        },
      };
    }

    renderPages(result.pages, result.textPages);
    renderDiagnostics(result.warnings);
    previewMeta.textContent = `${result.pages.length} page${result.pages.length === 1 ? "" : "s"} · ${result.elapsedMs} ms`;
    setStatus(
      result.warnings.length ? "warning" : "ready",
      result.warnings.length ? "Compiled with warnings" : "Preview current",
    );
    return {
      compiled: true,
      pages: result.pages.length,
      warnings: result.warnings.length,
      elapsedMs: result.elapsedMs,
      error: null,
    };
  } catch (error) {
    if (activePath !== requestedPath || revision !== requestedRevision) {
      pendingCompile = isTypstDocument(activePath);
      return {
        compiled: false,
        error: {
          code: "stale_editor_revision",
          message: "The editor changed before compilation completed.",
        },
      };
    }
    const safeError = error && typeof error === "object" ? error : {};
    renderDiagnostics(
      safeError.diagnostics?.length
        ? safeError.diagnostics
        : [{ severity: "error", message: safeError.message || "Compilation failed.", hints: [] }],
    );
    setStatus("error", "Compile failed");
    return {
      compiled: false,
      error: normalizeRemoteFailure(error, "compile_failed", "Compilation failed."),
    };
  } finally {
    compileInFlight = false;
    updateEditorInterlocks();
  }
}

async function compileLatest() {
  if (navigationInFlight || githubUiBusy || pdfExportInFlight) {
    pendingCompile = true;
    return {
      compiled: false,
      error: {
        code: "editor_busy",
        message: "The editor is busy with another operation.",
      },
    };
  }
  if (!isTypstDocument(activePath)) {
    pendingCompile = false;
    compileButton.disabled = true;
    return {
      compiled: false,
      error: {
        code: "typst_document_required",
        message: "Open a Typst document before compiling.",
      },
    };
  }

  pendingCompile = true;
  if (compileLoopPromise) return compileLoopPromise;
  compileLoopPromise = (async () => {
    let outcome = null;
    while (pendingCompile && !navigationInFlight && !githubUiBusy && isTypstDocument(activePath)) {
      pendingCompile = false;
      outcome = await compileDocumentOnce();
    }
    return outcome;
  })();

  try {
    return await compileLoopPromise;
  } finally {
    compileLoopPromise = null;
    if (pendingCompile && !navigationInFlight && !githubUiBusy && !compileInFlight) {
      void compileLatest();
    }
  }
}

function scheduleCompile() {
  if (!isTypstDocument(activePath) || citationSession) return;
  window.clearTimeout(compileTimer);
  compileTimer = window.setTimeout(() => void compileLatest(), 280);
}

source.addEventListener("beforeinput", () => void setEditorDirty(true));
source.addEventListener("input", () => {
  const previousAgentSource = agentAnnotationSourceSnapshot;
  const nextAgentSource = source.value;
  rebaseAgentAnnotationsAfterHumanEdit(previousAgentSource, nextAgentSource);
  agentAnnotationSourceSnapshot = nextAgentSource;
  revision += 1;
  window.dispatchEvent(new CustomEvent("undertree-source-changed"));
  updatePdfActions();
  updateSourceMetrics();
  scheduleWorkspaceFindRefresh();
  void setEditorDirty(true);
  setStatus("dirty", activePath ? "Unsaved edit" : "Scratch edit");
  synchronizeCitationSession();
  if (editorViewMode === "visual") renderVisualEditor();
  if (!citationSession) scheduleCompile();
});
source.addEventListener("keydown", handleCitationKeydown);

sourceModeButton.addEventListener("click", () => setEditorViewMode("source"));
visualModeButton.addEventListener("click", () => setEditorViewMode("visual"));
agentMarkKeepButton.addEventListener("click", () => markAgentSelection("keep"));
agentMarkReviseButton.addEventListener("click", () => markAgentSelection("revise"));
agentMarkCatalogButton.addEventListener("click", () => setAgentCatalogOpen(agentAnnotationCatalog.hidden));
agentCatalogCloseButton.addEventListener("click", () => setAgentCatalogOpen(false));
visualEditorPage.addEventListener("click", (event) => {
  visualSelectedLine = event.target.closest(".visual-editor-line");
});
visualEditorPage.addEventListener("dblclick", (event) => {
  visualSelectedLine = event.target.closest(".visual-editor-line");
  visualSelectedLine?.classList.add("visual-selected");
});
visualEditorPage.addEventListener("copy", (event) => {
  event.preventDefault();
  event.clipboardData?.setData("text/plain", source.value);
});
for (const button of visualEditorShell.querySelectorAll("[data-visual-command]")) {
  button.addEventListener("click", () => applyVisualCommand(button.dataset.visualCommand));
}
document.querySelector("#visual-style").addEventListener("change", (event) => {
  const line = visualSelectedLine || visualEditorPage.querySelector(".visual-editor-line");
  if (!line) return;
  line.classList.remove("visual-style-title", "visual-style-heading", "visual-style-quote");
  if (event.target.value !== "body") line.classList.add(`visual-style-${event.target.value}`);
});
document.querySelector("#visual-size").addEventListener("change", (event) => {
  const line = visualSelectedLine || visualEditorPage.querySelector(".visual-editor-line");
  if (!line) return;
  line.classList.remove("visual-size-small", "visual-size-large");
  if (event.target.value !== "normal") line.classList.add(`visual-size-${event.target.value}`);
});
source.addEventListener("scroll", () => {
  renderEditorLineNumbers();
  renderAgentHighlights();
  positionCitationPopup();
}, { passive: true });
for (const eventName of ["click", "keyup", "select"]) {
  source.addEventListener(eventName, () => {
    renderEditorLineNumbers();
    if (citationSession) synchronizeCitationSession();
  });
}

openProjectButton.addEventListener("click", () => void chooseProject());
projectPicker.addEventListener("change", () => void openRememberedProject(projectPicker.value));
importLatexButton.addEventListener("click", () => void importLatexProject());
exportLatexButton.addEventListener("click", () => void exportTypstToLatex());
document.querySelector("#home-button").addEventListener("click", () => void chooseProject());
newBibliographyButton.addEventListener("click", () => void createBibliography());
saveButton.addEventListener("click", () => void saveLatest());
compileButton.addEventListener("click", () => void compileLatest());
pdfExportButton.addEventListener("click", () => void exportCurrentPdf());
pdfRevealButton.addEventListener("click", () => void revealCurrentPdf());
searchFileButton.addEventListener("click", openWorkspaceFind);
previewFindButton.addEventListener("click", openWorkspaceFind);
workspaceFindInput.addEventListener("input", () => refreshWorkspaceFind());
workspaceFindInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    showWorkspaceFindMatch(workspaceFindIndex + (event.shiftKey ? -1 : 1));
  } else if (event.key === "Escape") {
    event.preventDefault();
    closeWorkspaceFind();
  }
});
workspaceFindPrevious.addEventListener("click", () => showWorkspaceFindMatch(workspaceFindIndex - 1));
workspaceFindNext.addEventListener("click", () => showWorkspaceFindMatch(workspaceFindIndex + 1));
workspaceFindClose.addEventListener("click", closeWorkspaceFind);
document.querySelector("#reload-preview").addEventListener("click", () => void compileLatest());
refreshProjectButton.addEventListener("click", () => void refreshProjectFromDisk());
showAllFiles.addEventListener("change", renderFilteredFiles);
for (const control of fileCategoryFilters) control.addEventListener("change", renderFilteredFiles);
collapseTreeButton.addEventListener("click", () => {
  expandedTreeFolders.clear();
  renderFilteredFiles();
  fileList.querySelector(".tree-row")?.focus();
});
collapseDiagnosticsButton.addEventListener("click", () => {
  const expanded = collapseDiagnosticsButton.getAttribute("aria-expanded") === "true";
  collapseDiagnosticsButton.setAttribute("aria-expanded", String(!expanded));
  collapseDiagnosticsButton.querySelector(".ui-chevron")?.classList.toggle("down", expanded === false);
  collapseDiagnosticsButton.querySelector(".ui-chevron")?.classList.toggle("right", expanded);
  outlinePanel.classList.toggle("collapsed", expanded);
});
undoButton.addEventListener("click", () => {
  if (source.readOnly) return;
  source.focus();
  document.execCommand("undo");
});
redoButton.addEventListener("click", () => {
  if (source.readOnly) return;
  source.focus();
  document.execCommand("redo");
});
document.querySelector("#bold").addEventListener("click", () => insertAroundSelection("*", "*", "bold text"));
document.querySelector("#italic").addEventListener("click", () => insertAroundSelection("_", "_", "emphasis"));
document.querySelector("#insert-link").addEventListener("click", insertLink);
document.querySelector("#insert-cite").addEventListener("click", beginCitationFromToolbar);
blockStyle.addEventListener("change", () => {
  applySelectedBlockStyle(blockStyle.value);
  blockStyle.value = "";
});
insertElement.addEventListener("change", () => {
  insertSelectedElement(insertElement.value);
  insertElement.value = "";
});
document.querySelector("#zoom-out").addEventListener("click", () => setPreviewZoom(previewZoom - 0.1));
document.querySelector("#zoom-in").addEventListener("click", () => setPreviewZoom(previewZoom + 0.1));
document.querySelector("#fit-width").addEventListener("click", () => setPreviewZoom(1));
document.querySelector("#previous-page").addEventListener("click", () => scrollPreviewPage(-1));
document.querySelector("#next-page").addEventListener("click", () => scrollPreviewPage(1));
githubButton.addEventListener("click", openGithubModal);
githubPanelOpen.addEventListener("click", openGithubModal);
githubFooterState.addEventListener("click", openGithubModal);
githubModalClose.addEventListener("click", closeGithubModal);
githubConnect.addEventListener("click", () => void beginGithubAuth());
githubNewProjectToggle.addEventListener("click", () => setGithubNewProjectForm(githubNewProjectForm.hidden));
githubNewProjectCancel.addEventListener("click", () => setGithubNewProjectForm(false));
githubCreateProject.addEventListener("click", () => void createGithubProject());
githubRefreshRepositories.addEventListener("click", () => void loadGithubRepositories());
githubRepositoryPicker.addEventListener("change", updateGithubLinkAvailability);
for (const control of [githubRepositorySort, githubRepositoryVisibility, githubRepositoryOwnership]) {
  control.addEventListener("change", renderGithubRepositoryPicker);
}
githubLinkProject.addEventListener("click", () => void linkGithubProject());
githubCloneRepository.addEventListener("click", () => void cloneGithubRepository());
githubSaveRules.addEventListener("click", () => void saveGithubRules());
githubSyncInterval.addEventListener("change", () => {
  githubRulesTouched = true;
});
githubAutoCommit.addEventListener("change", () => {
  githubRulesTouched = true;
});
githubUnlinkProject.addEventListener("click", () => void unlinkGithubProject());
githubDisconnect.addEventListener("click", () => void disconnectGithub());
for (const button of githubActionButtons) {
  button.addEventListener("click", () => void runGithubAction(button.dataset.githubAction));
}
githubUserCode.addEventListener("click", () => {
  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(githubUserCode);
  selection.removeAllRanges();
  selection.addRange(range);
  setGithubFeedback("One-time code selected. Press Ctrl+C to copy it.");
});
githubModalBackdrop.addEventListener("click", (event) => {
  if (event.target === githubModalBackdrop) closeGithubModal();
});
githubConfirmBackdrop.addEventListener("click", (event) => {
  if (event.target === githubConfirmBackdrop) resolveGithubConfirmation(null);
});
githubConfirmCancel.addEventListener("click", () => resolveGithubConfirmation(null));
githubConfirmSecondary.addEventListener("click", () => resolveGithubConfirmation(githubConfirmationSecondaryValue));
githubConfirmAccept.addEventListener("click", () => resolveGithubConfirmation(githubConfirmationAcceptValue));

for (const button of document.querySelectorAll(".rail-button[data-panel]")) {
  button.addEventListener("click", () => {
    for (const peer of document.querySelectorAll(".rail-button[data-panel]")) {
      peer.classList.toggle("active", peer === button);
    }
    for (const view of document.querySelectorAll(".left-view")) {
      view.classList.toggle("active", view.dataset.view === button.dataset.panel);
    }
    if (button.dataset.panel === "git") void refreshGithubStatus();
  });
}

document.querySelector("#font-size").addEventListener("input", (event) => {
  document.documentElement.style.setProperty("--editor-font-size", `${event.target.value}px`);
  window.requestAnimationFrame(() => {
    renderEditorLineNumbers();
    renderAgentHighlights();
  });
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
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
    event.preventDefault();
    openWorkspaceFind();
    return;
  }
  if (!workspaceFind.hidden && event.key === "Escape") {
    event.preventDefault();
    closeWorkspaceFind();
    return;
  }
  if (event.key === "F3" && workspaceFindMatches.length) {
    event.preventDefault();
    showWorkspaceFindMatch(workspaceFindIndex + (event.shiftKey ? -1 : 1));
    return;
  }
  if (handleGithubModalKeydown(event)) return;
  if ((event.ctrlKey || event.metaKey) && source === document.activeElement && isTypstDocument(activePath)) {
    const key = event.key.toLowerCase();
    if (key === "b") {
      event.preventDefault();
      insertAroundSelection("*", "*", "bold text");
      return;
    }
    if (key === "i") {
      event.preventDefault();
      insertAroundSelection("_", "_", "emphasis");
      return;
    }
  }
  if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
    event.preventDefault();
    void compileLatest();
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
    event.preventDefault();
    void saveLatest();
  }
});
window.addEventListener("resize", () => {
  positionCitationPopup();
  renderAgentHighlights();
}, { passive: true });

window.addEventListener("beforeunload", () => {
  githubUnloading = true;
  remoteControlActivated = false;
  remoteControlBufferedDispatches = [];
  window.clearTimeout(githubAuthTimer);
  window.clearTimeout(editorDirtyRetryTimer);
  window.clearTimeout(agentAnnotationPersistTimer);
  window.clearInterval(editorStateHeartbeatTimer);
  githubSyncUnlisten?.();
  githubSyncUnlisten = null;
  githubCloneUnlisten?.();
  githubCloneUnlisten = null;
  remoteControlUnlisten?.();
  remoteControlUnlisten = null;
  clearDiagnosticDismissTimers();
  window.clearTimeout(compileTimer);
  window.clearTimeout(workspaceFindRefreshTimer);
  window.cancelAnimationFrame(editorLineNumberFrame);
  editorLineNumberFrame = 0;
  editorLineNumberObserver?.disconnect();
  editorLineNumberObserver = null;
  fittedTextObserver?.disconnect();
  fittedTextObserver = null;
  releasePreviewUrls();
});

updateSourceMetrics();
renderAgentAnnotations();
editorLineNumberObserver = new ResizeObserver(() => {
  renderEditorLineNumbers();
  renderAgentHighlights();
});
editorLineNumberObserver.observe(document.querySelector("#editor-host"));
renderFiles(["main.typ"]);
renderGithubSurfaces();
void setEditorDirty(false);
editorStateHeartbeatTimer = window.setInterval(() => void setEditorDirty(editorDirty), 3000);
void refreshGithubStatus();
void bindGithubSyncEvents();
async function bootstrapNativeApplication() {
  try {
    const info = await nativeInvoke("compiler_info");
    setStatus("ready", `${info.engine} ${info.engineVersion} · embedded Rust`);
    const project = await nativeInvoke("current_project");
    if (project) {
      applyProjectSnapshot(project);
      await refreshGithubStatus();
    }
    await refreshRecentProjects();
    await compileLatest();
  } catch (error) {
    renderDiagnostics([
      { severity: "error", message: safeErrorMessage(error, "Native compiler unavailable."), hints: [] },
    ]);
    setStatus("error", "Native compiler unavailable");
  }
}

const remoteControlListenerPromise = bindRemoteControlEvents();
const bootstrapPromise = bootstrapNativeApplication();
void activateRemoteControl(remoteControlListenerPromise, bootstrapPromise);
