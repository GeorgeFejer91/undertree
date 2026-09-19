const assert = require("node:assert/strict");

void import("./review-selection.js").then(() => {
  const {
    utf8Length,
    utf16ToUtf8ByteOffset,
    utf8ByteToUtf16Offset,
  } = globalThis.UnderTreeReviewSelection;

  assert.equal(utf8Length("abc"), 3);
  assert.equal(utf8Length("é"), 2);
  assert.equal(utf8Length("🧠"), 4);
  assert.equal(utf16ToUtf8ByteOffset("a🧠b", 3), 5);
  assert.equal(utf8ByteToUtf16Offset("a🧠b", 5), 3);
  assert.equal(utf8ByteToUtf16Offset("éx", 2), 1);
  console.log("review-selection checks passed");
});
