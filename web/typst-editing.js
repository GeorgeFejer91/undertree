(function installTypstEditing(globalScope) {
  const BLOCK_PREFIXES = {
    paragraph: "",
    "heading-1": "= ",
    "heading-2": "== ",
    "heading-3": "=== ",
    bullet: "- ",
    numbered: "+ ",
    quote: "> ",
  };

  function clampSelection(text, start, end) {
    const safeStart = Math.max(0, Math.min(Number(start) || 0, text.length));
    const safeEnd = Math.max(safeStart, Math.min(Number(end) || safeStart, text.length));
    return [safeStart, safeEnd];
  }

  function applyInline(text, start, end, before, after = before, placeholder = "text") {
    const [safeStart, safeEnd] = clampSelection(text, start, end);
    const selected = text.slice(safeStart, safeEnd) || placeholder;
    const replacement = `${before}${selected}${after}`;
    return {
      source: `${text.slice(0, safeStart)}${replacement}${text.slice(safeEnd)}`,
      selectionStart: safeStart + before.length,
      selectionEnd: safeStart + before.length + selected.length,
    };
  }

  function applyBlockStyle(text, start, end, style) {
    const prefix = BLOCK_PREFIXES[style];
    if (prefix === undefined) return { source: text, selectionStart: start, selectionEnd: end };
    const [safeStart, safeEnd] = clampSelection(text, start, end);
    const lineStart = text.lastIndexOf("\n", Math.max(0, safeStart - 1)) + 1;
    const selectionEndsAtLineStart = safeEnd > lineStart && text[safeEnd - 1] === "\n";
    const contentEnd = selectionEndsAtLineStart ? safeEnd - 1 : safeEnd;
    const nextBreak = text.indexOf("\n", contentEnd);
    const lineEnd = nextBreak === -1 ? text.length : nextBreak;
    const selectedLines = text.slice(lineStart, lineEnd).split("\n");
    const replacement = selectedLines
      .map((line) => {
        const indent = line.match(/^\s*/)?.[0] || "";
        const content = line.slice(indent.length).replace(/^(?:={1,6}|[-+>])\s+/, "");
        if (!content && prefix) return line;
        return `${indent}${prefix}${content}`;
      })
      .join("\n");
    return {
      source: `${text.slice(0, lineStart)}${replacement}${text.slice(lineEnd)}`,
      selectionStart: lineStart,
      selectionEnd: lineStart + replacement.length,
    };
  }

  function insertSnippet(text, start, end, template, placeholder) {
    const [safeStart, safeEnd] = clampSelection(text, start, end);
    const selected = text.slice(safeStart, safeEnd);
    const replacement = template.replace("{{selection}}", selected || placeholder);
    const selectionValue = selected || placeholder;
    const selectionOffset = replacement.indexOf(selectionValue);
    return {
      source: `${text.slice(0, safeStart)}${replacement}${text.slice(safeEnd)}`,
      selectionStart: safeStart + Math.max(0, selectionOffset),
      selectionEnd: safeStart + Math.max(0, selectionOffset) + selectionValue.length,
    };
  }

  const api = { applyInline, applyBlockStyle, insertSnippet };
  globalScope.UnderTreeTypstEditing = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis === "undefined" ? window : globalThis);
