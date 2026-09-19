(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.UnderTreeReviewSelection = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const encoder = new TextEncoder();

  function utf8Length(text) {
    return encoder.encode(String(text ?? "")).length;
  }

  function utf16ToUtf8ByteOffset(text, utf16Offset) {
    const value = String(text ?? "");
    const offset = Math.max(0, Math.min(value.length, Number(utf16Offset) || 0));
    return encoder.encode(value.slice(0, offset)).length;
  }

  function utf8ByteToUtf16Offset(text, byteOffset) {
    const value = String(text ?? "");
    const target = Math.max(0, Number(byteOffset) || 0);
    let bytes = 0;
    let utf16 = 0;
    for (const character of value) {
      const next = bytes + encoder.encode(character).length;
      if (next > target) break;
      bytes = next;
      utf16 += character.length;
      if (bytes === target) break;
    }
    return utf16;
  }

  function runData(element) {
    if (!element) return null;
    const start = Number(element.dataset.sourceStartByte);
    const end = Number(element.dataset.sourceEndByte);
    const path = element.dataset.sourcePath || "";
    const text = element.textContent || "";
    if (!path || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) {
      return null;
    }
    if (end - start !== utf8Length(text)) return null;
    return { element, path, start, end, text };
  }

  function containingRun(node) {
    const element = node?.nodeType === 1 ? node : node?.parentElement;
    return element?.closest?.(".preview-text-run") || null;
  }

  function textOffset(container, offset, span) {
    if (container === span) {
      return offset <= 0 ? 0 : (span.textContent || "").length;
    }
    if (container?.nodeType === 3 && container.parentElement === span) {
      return Math.max(0, Math.min(container.data.length, offset));
    }
    const range = span.ownerDocument.createRange();
    range.selectNodeContents(span);
    try {
      range.setEnd(container, offset);
      return range.toString().length;
    } catch {
      return null;
    }
  }

  function mapDomRange(range, rootElement) {
    if (!range || range.collapsed || !rootElement) {
      return { error: "Select text in the PDF preview first." };
    }
    const startElement = containingRun(range.startContainer);
    const endElement = containingRun(range.endContainer);
    if (!startElement || !endElement || !rootElement.contains(startElement) || !rootElement.contains(endElement)) {
      return { error: "The selection is outside the PDF text layer." };
    }
    const all = [...rootElement.querySelectorAll(".preview-text-run")];
    const startIndex = all.indexOf(startElement);
    const endIndex = all.indexOf(endElement);
    if (startIndex < 0 || endIndex < startIndex) {
      return { error: "The PDF selection could not be ordered." };
    }
    const selectedRuns = all.slice(startIndex, endIndex + 1).map(runData);
    if (selectedRuns.some((run) => !run)) {
      return { error: "This rendered selection contains text without a verified source mapping." };
    }
    const path = selectedRuns[0].path;
    if (selectedRuns.some((run) => run.path !== path)) {
      return { error: "A review mark cannot span multiple source documents." };
    }
    for (let index = 1; index < selectedRuns.length; index += 1) {
      if (selectedRuns[index].start < selectedRuns[index - 1].end) {
        return { error: "The rendered selection has overlapping source mappings." };
      }
    }

    const startOffset = textOffset(range.startContainer, range.startOffset, startElement);
    const endOffset = textOffset(range.endContainer, range.endOffset, endElement);
    if (!Number.isInteger(startOffset) || !Number.isInteger(endOffset)) {
      return { error: "The selected text offset could not be resolved." };
    }
    const first = selectedRuns[0];
    const last = selectedRuns.at(-1);
    const startByte = first.start + utf16ToUtf8ByteOffset(first.text, startOffset);
    const endByte = last.start + utf16ToUtf8ByteOffset(last.text, endOffset);
    if (endByte <= startByte) return { error: "Select a non-empty rendered passage." };

    return {
      path,
      startByte,
      endByte,
      visibleText: range.toString(),
      runs: selectedRuns,
    };
  }

  return {
    utf8Length,
    utf16ToUtf8ByteOffset,
    utf8ByteToUtf16Offset,
    runData,
    mapDomRange,
  };
});
