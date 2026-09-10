const test = require("node:test");
const assert = require("node:assert/strict");
const {
  byteOffsetToUtf16Index,
  rebaseAnnotations,
  selectedOrParagraphRange,
  utf16IndexToByteOffset,
} = require("./agent-annotations.js");

test("converts editor UTF-16 selections to protocol UTF-8 byte anchors", () => {
  const source = "A🌳B";
  assert.equal(utf16IndexToByteOffset(source, 1), 1);
  assert.equal(utf16IndexToByteOffset(source, 3), 5);
  assert.equal(byteOffsetToUtf16Index(source, 5), 3);
});

test("a collapsed selection marks the surrounding prose paragraph", () => {
  const source = "First paragraph.\n\nSecond paragraph here.\n\nThird.";
  const cursor = source.indexOf("paragraph here");
  const range = selectedOrParagraphRange(source, cursor, cursor);
  assert.equal(source.slice(range.start, range.end), "Second paragraph here.");
});

test("manual edits before a mark shift it without changing its selected text", () => {
  const previous = "Intro.\nProtected paragraph.";
  const selected = "Protected paragraph.";
  const start = previous.indexOf(selected);
  const annotations = [{
    id: "keep-1",
    kind: "keep",
    startByte: utf16IndexToByteOffset(previous, start),
    endByte: utf16IndexToByteOffset(previous, start + selected.length),
    selectedText: selected,
    stale: false,
  }];
  const next = `Longer ${previous}`;
  const [rebased] = rebaseAnnotations(previous, next, annotations);
  const nextStart = byteOffsetToUtf16Index(next, rebased.startByte);
  const nextEnd = byteOffsetToUtf16Index(next, rebased.endByte);
  assert.equal(next.slice(nextStart, nextEnd), selected);
});

test("a human edit inside a marked paragraph keeps the paragraph marked", () => {
  const previous = "Keep this paragraph.";
  const next = "Keep this polished paragraph.";
  const annotations = [{
    id: "keep-1",
    kind: "keep",
    startByte: 0,
    endByte: previous.length,
    selectedText: previous,
    stale: false,
  }];
  const [rebased] = rebaseAnnotations(previous, next, annotations);
  assert.equal(rebased.selectedText, next);
  assert.equal(rebased.startByte, 0);
  assert.equal(rebased.endByte, next.length);
});
