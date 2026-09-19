(() => {
  const selectionApi = window.UnderTreeReviewSelection;
  let state = null;
  let pendingSelection = null;
  let busy = false;
  const elements = {};

  function editor() {
    return window.UnderTreeEditorBridge || null;
  }

  function safeMessage(error, fallback) {
    return typeof error?.message === "string" && error.message ? error.message : fallback;
  }

  function showMessage(message, tone = "") {
    elements.message.textContent = message || "";
    elements.message.dataset.tone = tone;
    elements.message.hidden = !message;
  }

  function currentEditorState() {
    return editor()?.getState?.() || null;
  }

  async function loadState() {
    const bridge = editor();
    const current = currentEditorState();
    if (!bridge || !current?.projectRoot || !current?.path || !current.path.toLowerCase().endsWith(".typ")) {
      state = null;
      render();
      return;
    }
    try {
      state = await bridge.invoke("review_state", {
        path: current.path,
        source: current.source,
      });
      render();
    } catch (error) {
      state = null;
      render();
      showMessage(safeMessage(error, "Review metadata could not be loaded."), "error");
    }
  }

  function selectedPreviewRange() {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount !== 1 || selection.isCollapsed) return null;
    return selectionApi?.mapDomRange(selection.getRangeAt(0), elements.preview) || null;
  }

  function updateSelection() {
    if (busy) return;
    const mapped = selectedPreviewRange();
    if (!mapped || mapped.error) {
      if (mapped?.error && window.getSelection()?.toString()?.trim()) {
        showMessage(mapped.error, "warning");
      }
      pendingSelection = null;
      elements.selection.hidden = true;
      return;
    }
    const current = currentEditorState();
    const previewRevision = Number(elements.preview.dataset.sourceRevision);
    if (!current || mapped.path !== current.path || previewRevision !== current.revision) {
      pendingSelection = null;
      elements.selection.hidden = true;
      showMessage("The PDF selection belongs to an older editor revision. Wait for the current preview.", "warning");
      return;
    }
    pendingSelection = Object.assign({}, mapped, { revision: previewRevision });
    elements.selectionText.textContent = mapped.visibleText.replace(/\s+/g, " ").trim();
    elements.selection.hidden = false;
    showMessage("");
  }

  async function ensureSavedSelection() {
    if (!pendingSelection) throw new Error("Select text in the PDF preview first.");
    const before = currentEditorState();
    if (!before || before.revision !== pendingSelection.revision || before.path !== pendingSelection.path) {
      throw new Error("The manuscript changed after this PDF passage was selected.");
    }
    const after = await editor().ensureSaved();
    if (!after || after.revision !== pendingSelection.revision) {
      throw new Error("The manuscript changed while the review selection was being saved.");
    }
    return after;
  }

  async function currentSavedReviewState() {
    const current = await editor().ensureSaved();
    state = await editor().invoke("review_state", {
      path: current.path,
      source: current.source,
    });
    return current;
  }

  async function markSelection(kind) {
    if (busy) return;
    busy = true;
    try {
      const current = await ensureSavedSelection();
      state = await editor().invoke("review_state", {
        path: current.path,
        source: current.source,
      });
      state = await editor().invoke("review_upsert_mark", {
        request: {
          path: current.path,
          source: current.source,
          expectedDigest: current.digest,
          expectedPolicyVersion: state?.policyVersion || 0,
          kind,
          startByte: pendingSelection.startByte,
          endByte: pendingSelection.endByte,
          visibleText: pendingSelection.visibleText,
          note: elements.instruction.value.trim() || null,
        },
      });
      window.getSelection()?.removeAllRanges();
      elements.instruction.value = "";
      elements.selection.hidden = true;
      pendingSelection = null;
      elements.panel.hidden = false;
      elements.toggle.setAttribute("aria-expanded", "true");
      render();
      showMessage("Review mark saved in paper.json.", "success");
    } catch (error) {
      showMessage(safeMessage(error, "The review mark could not be saved."), "error");
      await loadState();
    } finally {
      busy = false;
    }
  }

  function markLabel(kind) {
    return kind === "keep" ? "Keep" : kind === "light-edit" ? "Light edit" : "Rework";
  }

  function proposalLabel(proposal) {
    if (proposal.operation === "delete") return "Delete this passage";
    return proposal.replacement;
  }

  function buildProposal(mark) {
    const shell = document.createElement("div");
    shell.className = "review-propose";
    const textarea = document.createElement("textarea");
    textarea.rows = 3;
    textarea.placeholder = mark.kind === "rework"
      ? "Write a replacement, or leave empty and choose Delete."
      : "Write the alternative wording.";
    textarea.setAttribute("aria-label", "Proposed replacement for " + markLabel(mark.kind) + " passage");
    const rationale = document.createElement("input");
    rationale.type = "text";
    rationale.placeholder = "Why this is better (optional)";
    rationale.maxLength = 4000;
    const actions = document.createElement("div");
    actions.className = "review-card-actions";
    const propose = document.createElement("button");
    propose.type = "button";
    propose.textContent = "Propose";
    propose.dataset.fitText = "";
    propose.addEventListener("click", () => void createProposal(mark, textarea.value, rationale.value, "replace"));
    actions.append(propose);
    if (mark.kind === "rework") {
      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "Propose delete";
      remove.dataset.fitText = "";
      remove.addEventListener("click", () => void createProposal(mark, "", rationale.value, "delete"));
      actions.append(remove);
    }
    shell.append(textarea, rationale, actions);
    return shell;
  }

  async function createProposal(mark, replacement, rationale, operation) {
    if (busy) return;
    busy = true;
    try {
      const current = await currentSavedReviewState();
      state = await editor().invoke("review_create_proposal", {
        actor: "human",
        request: {
          path: current.path,
          source: current.source,
          expectedDigest: current.digest,
          expectedPolicyVersion: state.policyVersion,
          markId: mark.id,
          operation,
          replacement,
          rationale,
        },
      });
      render();
      showMessage("Suggestion added without changing the manuscript.", "success");
    } catch (error) {
      showMessage(safeMessage(error, "The suggestion could not be created."), "error");
      await loadState();
    } finally {
      busy = false;
    }
  }

  async function removeMark(mark) {
    if (busy) return;
    busy = true;
    try {
      const current = await currentSavedReviewState();
      state = await editor().invoke("review_remove_mark", {
        request: {
          path: current.path,
          source: current.source,
          expectedDigest: current.digest,
          expectedPolicyVersion: state.policyVersion,
          id: mark.id,
        },
      });
      render();
    } catch (error) {
      showMessage(safeMessage(error, "The review mark could not be removed."), "error");
      await loadState();
    } finally {
      busy = false;
    }
  }

  async function decide(proposal, decision, feedback = null) {
    if (busy) return;
    busy = true;
    try {
      const current = await currentSavedReviewState();
      const result = await editor().invoke("review_decide", {
        request: {
          path: current.path,
          source: current.source,
          expectedDigest: current.digest,
          expectedPolicyVersion: state.policyVersion,
          proposalId: proposal.id,
          decision,
          feedback: feedback?.trim() || null,
          revision: current.revision,
        },
      });
      state = result.state;
      if (result.changedSource) editor().applyDecision(result);
      render();
      showMessage(
        decision === "accept"
          ? "Suggestion accepted into the manuscript."
          : "Suggestion rejected; feedback remains in paper.json.",
        "success",
      );
    } catch (error) {
      showMessage(safeMessage(error, "The review decision could not be applied."), "error");
      await loadState();
    } finally {
      busy = false;
    }
  }

  async function addComment(mark, input) {
    if (busy || !input.value.trim()) return;
    busy = true;
    try {
      const current = await currentSavedReviewState();
      state = await editor().invoke("review_add_comment", {
        actor: "human",
        request: {
          path: current.path,
          source: current.source,
          expectedDigest: current.digest,
          expectedPolicyVersion: state.policyVersion,
          markId: mark.id,
          proposalId: null,
          body: input.value.trim(),
        },
      });
      input.value = "";
      render();
    } catch (error) {
      showMessage(safeMessage(error, "The review comment could not be saved."), "error");
      await loadState();
    } finally {
      busy = false;
    }
  }

  function renderProposal(proposal) {
    const card = document.createElement("div");
    card.className = "review-proposal " + proposal.status;
    const meta = document.createElement("div");
    meta.className = "review-proposal-meta";
    meta.textContent = (proposal.actor === "ai" ? "AI" : "Human") + " · " + proposal.status;
    const text = document.createElement("div");
    text.className = "review-body-text review-proposal-text";
    text.textContent = proposalLabel(proposal);
    card.append(meta, text);
    if (proposal.rationale) {
      const rationale = document.createElement("p");
      rationale.className = "review-body-text review-rationale";
      rationale.textContent = proposal.rationale;
      card.append(rationale);
    }
    if (proposal.status === "pending") {
      const feedback = document.createElement("textarea");
      feedback.rows = 2;
      feedback.className = "review-feedback";
      feedback.placeholder = "Feedback for another revision (optional)";
      const actions = document.createElement("div");
      actions.className = "review-card-actions";
      const accept = document.createElement("button");
      accept.type = "button";
      accept.textContent = "Accept";
      accept.className = "accept";
      accept.dataset.fitText = "";
      accept.addEventListener("click", () => void decide(proposal, "accept"));
      const reject = document.createElement("button");
      reject.type = "button";
      reject.textContent = "Reject / revise";
      reject.dataset.fitText = "";
      reject.addEventListener("click", () => void decide(proposal, "reject", feedback.value));
      actions.append(accept, reject);
      card.append(feedback, actions);
    }
    return card;
  }

  function renderMark(mark) {
    const card = document.createElement("article");
    card.className = "review-mark-card " + mark.kind + (mark.stale ? " stale" : "");
    const header = document.createElement("header");
    const label = document.createElement("strong");
    label.textContent = markLabel(mark.kind);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "review-icon-button";
    remove.title = "Remove review mark";
    remove.setAttribute("aria-label", "Remove review mark");
    remove.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8m0-8-8 8"/></svg>';
    remove.addEventListener("click", () => void removeMark(mark));
    header.append(label, remove);
    const exact = document.createElement("p");
    exact.className = "review-body-text review-original";
    exact.textContent = mark.anchor.exact;
    card.append(header, exact);
    if (mark.note) {
      const note = document.createElement("p");
      note.className = "review-body-text review-note";
      note.textContent = mark.note;
      card.append(note);
    }
    if (mark.stale) {
      const stale = document.createElement("p");
      stale.className = "review-warning";
      stale.textContent = "This mark no longer maps safely to the saved manuscript.";
      card.append(stale);
    } else if (mark.kind !== "keep") {
      card.append(buildProposal(mark));
    }

    const proposals = (state?.proposals || []).filter((proposal) => proposal.markId === mark.id);
    if (proposals.length) {
      const list = document.createElement("div");
      list.className = "review-proposal-list";
      proposals.slice().reverse().forEach((proposal) => list.append(renderProposal(proposal)));
      card.append(list);
    }

    const commentRow = document.createElement("div");
    commentRow.className = "review-comment-row";
    const comment = document.createElement("input");
    comment.type = "text";
    comment.placeholder = "Add comment";
    comment.maxLength = 2000;
    const add = document.createElement("button");
    add.type = "button";
    add.textContent = "Comment";
    add.dataset.fitText = "";
    add.addEventListener("click", () => void addComment(mark, comment));
    commentRow.append(comment, add);
    card.append(commentRow);
    return card;
  }

  function clearHighlights() {
    elements.preview.querySelectorAll(".review-highlight-layer").forEach((layer) => layer.replaceChildren());
  }

  function rangeRectanglesForMark(mark) {
    const helpers = selectionApi;
    if (!helpers || mark.stale) return [];
    const runs = [...elements.preview.querySelectorAll(".preview-text-run")]
      .map((element) => helpers.runData(element))
      .filter(Boolean)
      .filter((run) => run.path === state.document && run.start < mark.anchor.endByte && run.end > mark.anchor.startByte);
    if (!runs.length) return [];
    const byPage = new Map();
    for (const run of runs) {
      const page = run.element.closest(".page");
      if (!page) continue;
      if (!byPage.has(page)) byPage.set(page, []);
      byPage.get(page).push(run);
    }
    const output = [];
    for (const [page, pageRuns] of byPage) {
      const first = pageRuns[0];
      const last = pageRuns.at(-1);
      const startBytes = Math.max(0, mark.anchor.startByte - first.start);
      const endBytes = Math.max(0, Math.min(last.end, mark.anchor.endByte) - last.start);
      const startOffset = helpers.utf8ByteToUtf16Offset(first.text, startBytes);
      const endOffset = helpers.utf8ByteToUtf16Offset(last.text, endBytes);
      const startNode = first.element.firstChild;
      const endNode = last.element.firstChild;
      if (!startNode || !endNode) continue;
      const range = document.createRange();
      try {
        range.setStart(startNode, startOffset);
        range.setEnd(endNode, endOffset);
      } catch {
        continue;
      }
      const pageRect = page.getBoundingClientRect();
      for (const rect of range.getClientRects()) {
        if (rect.width <= 0 || rect.height <= 0) continue;
        output.push({
          page,
          left: rect.left - pageRect.left,
          top: rect.top - pageRect.top,
          width: rect.width,
          height: rect.height,
          kind: mark.kind,
        });
      }
    }
    return output;
  }

  function renderHighlights() {
    clearHighlights();
    if (!state?.marks?.length) return;
    for (const mark of state.marks) {
      for (const rect of rangeRectanglesForMark(mark)) {
        let layer = rect.page.querySelector(".review-highlight-layer");
        if (!layer) {
          layer = document.createElement("div");
          layer.className = "review-highlight-layer";
          rect.page.append(layer);
        }
        const highlight = document.createElement("div");
        highlight.className = "review-highlight " + rect.kind;
        highlight.style.left = rect.left + "px";
        highlight.style.top = rect.top + "px";
        highlight.style.width = rect.width + "px";
        highlight.style.height = rect.height + "px";
        layer.append(highlight);
      }
    }
  }

  function render() {
    const marks = state?.marks || [];
    const pending = (state?.proposals || []).filter((proposal) => proposal.status === "pending");
    elements.count.textContent = String(marks.length + pending.length);
    elements.list.replaceChildren();
    if (!state) {
      const empty = document.createElement("p");
      empty.className = "review-empty";
      empty.textContent = "Open a saved Typst project to review its generated PDF.";
      elements.list.append(empty);
    } else if (!marks.length) {
      const empty = document.createElement("p");
      empty.className = "review-empty";
      empty.textContent = "Select text in the PDF to mark it Keep, Light edit, or Rework.";
      elements.list.append(empty);
    } else {
      marks.forEach((mark) => elements.list.append(renderMark(mark)));
    }
    elements.version.textContent = state
      ? "Policy v" + state.policyVersion + " · generation " + state.generation
      : "No review metadata";
    renderHighlights();
    window.UnderTreeFit?.scan?.(elements.panel);
  }

  function init() {
    elements.preview = document.querySelector("#preview");
    elements.panel = document.querySelector("#review-panel");
    elements.list = document.querySelector("#review-list");
    elements.count = document.querySelector("#review-count");
    elements.version = document.querySelector("#review-version");
    elements.toggle = document.querySelector("#review-toggle");
    elements.close = document.querySelector("#review-close");
    elements.selection = document.querySelector("#review-selection");
    elements.selectionText = document.querySelector("#review-selection-text");
    elements.instruction = document.querySelector("#review-instruction");
    elements.message = document.querySelector("#review-message");
    if (!selectionApi || Object.values(elements).some((element) => !element)) return;

    elements.toggle.addEventListener("click", () => {
      elements.panel.hidden = !elements.panel.hidden;
      elements.toggle.setAttribute("aria-expanded", String(!elements.panel.hidden));
      if (!elements.panel.hidden) void loadState();
    });
    elements.close.addEventListener("click", () => {
      elements.panel.hidden = true;
      elements.toggle.setAttribute("aria-expanded", "false");
    });
    elements.selection.querySelectorAll("[data-review-kind]").forEach((button) => {
      button.addEventListener("click", () => void markSelection(button.dataset.reviewKind));
    });
    document.addEventListener("selectionchange", () => queueMicrotask(updateSelection));
    window.addEventListener("undertree-document-changed", () => {
      pendingSelection = null;
      elements.selection.hidden = true;
      void loadState();
    });
    window.addEventListener("undertree-source-changed", () => {
      pendingSelection = null;
      elements.selection.hidden = true;
    });
    window.addEventListener("undertree-preview-rendered", renderHighlights);
    window.addEventListener("undertree-preview-resized", () => requestAnimationFrame(renderHighlights));
    window.addEventListener("resize", () => requestAnimationFrame(renderHighlights), { passive: true });
    void loadState();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
