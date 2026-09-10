(function installAgentAnnotations(globalScope) {
  const encoder = new TextEncoder();

  function clamp(value, minimum, maximum) {
    const number = Number.isFinite(Number(value)) ? Number(value) : minimum;
    return Math.max(minimum, Math.min(maximum, number));
  }

  function utf16IndexToByteOffset(text, index) {
    const safeIndex = clamp(index, 0, text.length);
    return encoder.encode(text.slice(0, safeIndex)).length;
  }

  function byteOffsetToUtf16Index(text, byteOffset) {
    const target = clamp(byteOffset, 0, encoder.encode(text).length);
    let bytes = 0;
    let index = 0;
    for (const character of text) {
      const width = encoder.encode(character).length;
      if (bytes + width > target) break;
      bytes += width;
      index += character.length;
    }
    return index;
  }

  function selectedOrParagraphRange(text, selectionStart, selectionEnd) {
    let start = clamp(selectionStart, 0, text.length);
    let end = clamp(selectionEnd, start, text.length);
    if (end > start) return { start, end };

    const before = text.slice(0, start);
    const paragraphBreak = Math.max(before.lastIndexOf("\n\n"), before.lastIndexOf("\r\n\r\n"));
    start = paragraphBreak < 0 ? 0 : paragraphBreak + (before.slice(paragraphBreak).startsWith("\r\n") ? 4 : 2);
    const after = text.slice(end);
    const nextUnixBreak = after.indexOf("\n\n");
    const nextWindowsBreak = after.indexOf("\r\n\r\n");
    const candidates = [nextUnixBreak, nextWindowsBreak].filter((value) => value >= 0);
    end = candidates.length ? end + Math.min(...candidates) : text.length;

    while (start < end && /[\r\n]/.test(text[start])) start += 1;
    while (end > start && /[\r\n]/.test(text[end - 1])) end -= 1;
    if (end > start) return { start, end };

    const lineStart = text.lastIndexOf("\n", Math.max(0, selectionStart - 1)) + 1;
    const nextLine = text.indexOf("\n", selectionStart);
    return { start: lineStart, end: nextLine < 0 ? text.length : nextLine };
  }

  function rebaseAnnotations(previous, next, annotations) {
    if (previous === next) return annotations.map((annotation) => ({ ...annotation }));
    let prefix = 0;
    while (prefix < previous.length && prefix < next.length && previous[prefix] === next[prefix]) {
      prefix += 1;
    }
    let previousEnd = previous.length;
    let nextEnd = next.length;
    while (previousEnd > prefix && nextEnd > prefix && previous[previousEnd - 1] === next[nextEnd - 1]) {
      previousEnd -= 1;
      nextEnd -= 1;
    }
    const delta = nextEnd - previousEnd;

    const rebased = [];
    for (const annotation of annotations) {
      if (annotation.stale) {
        rebased.push({ ...annotation });
        continue;
      }
      const oldStart = byteOffsetToUtf16Index(previous, annotation.startByte);
      const oldEnd = byteOffsetToUtf16Index(previous, annotation.endByte);
      let start = oldStart;
      let end = oldEnd;
      if (oldEnd <= prefix) {
        // The edit follows this mark.
      } else if (oldStart >= previousEnd) {
        start += delta;
        end += delta;
      } else {
        start = oldStart < prefix ? oldStart : prefix;
        end = oldEnd > previousEnd ? oldEnd + delta : nextEnd;
      }
      start = clamp(start, 0, next.length);
      end = clamp(end, start, next.length);
      if (end === start) continue;
      rebased.push({
        ...annotation,
        startByte: utf16IndexToByteOffset(next, start),
        endByte: utf16IndexToByteOffset(next, end),
        selectedText: next.slice(start, end),
        stale: false,
      });
    }
    rebased.sort((left, right) => left.startByte - right.startByte || left.endByte - right.endByte);
    for (let index = 1; index < rebased.length; index += 1) {
      if (rebased[index].startByte < rebased[index - 1].endByte) {
        rebased[index - 1].stale = true;
        rebased[index].stale = true;
      }
    }
    return rebased;
  }

  function toAnnotationInput(annotation) {
    return {
      id: annotation.id,
      kind: annotation.kind,
      startByte: annotation.startByte,
      endByte: annotation.endByte,
      note: annotation.note || null,
    };
  }

  const api = {
    byteOffsetToUtf16Index,
    rebaseAnnotations,
    selectedOrParagraphRange,
    toAnnotationInput,
    utf16IndexToByteOffset,
  };
  globalScope.UnderTreeAgentAnnotations = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis === "undefined" ? window : globalThis);
