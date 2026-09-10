const test = require("node:test");
const assert = require("node:assert/strict");
const { applyInline, applyBlockStyle, insertSnippet } = require("./typst-editing.js");

test("inline formatting wraps a selection or provides an editable placeholder", () => {
  assert.deepEqual(applyInline("hello", 0, 5, "*"), {
    source: "*hello*",
    selectionStart: 1,
    selectionEnd: 6,
  });
  assert.equal(applyInline("", 0, 0, "_", "_", "emphasis").source, "_emphasis_");
});

test("block formatting operates on complete selected lines and preserves indentation", () => {
  const result = applyBlockStyle("intro\n  first\n  second\noutro", 8, 22, "bullet");
  assert.equal(result.source, "intro\n  - first\n  - second\noutro");
  assert.equal(applyBlockStyle("== Title", 3, 3, "paragraph").source, "Title");
});

test("element snippets preserve selected text and select generated placeholders", () => {
  const result = insertSnippet("caption", 0, 7, "#figure[{{selection}}]", "content");
  assert.equal(result.source, "#figure[caption]");
  assert.equal(result.source.slice(result.selectionStart, result.selectionEnd), "caption");
});
