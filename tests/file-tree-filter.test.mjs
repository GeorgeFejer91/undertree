import assert from "node:assert/strict";
import test from "node:test";

import { isPdfSourceFile, pdfSourceTree } from "../src/file-tree-filter.js";

test("PDF source files are TeX and Bib files, case-insensitively", () => {
  assert.equal(isPdfSourceFile("main.tex"), true);
  assert.equal(isPdfSourceFile("references/library.BIB"), true);
  assert.equal(isPdfSourceFile("main.pdf"), false);
  assert.equal(isPdfSourceFile("formatting/article.cls"), false);
  assert.equal(isPdfSourceFile("notes.tex.backup"), false);
});

test("source-only trees retain matching files and their parent folders", () => {
  const tree = [
    { name: "main.tex", path: "main.tex", type: "file", editable: true },
    { name: "main.pdf", path: "main.pdf", type: "file", editable: false },
    {
      name: "chapters",
      path: "chapters",
      type: "directory",
      children: [
        { name: "intro.tex", path: "chapters/intro.tex", type: "file", editable: true },
        { name: "diagram.svg", path: "chapters/diagram.svg", type: "file", editable: true },
      ],
    },
    {
      name: "scripts",
      path: "scripts",
      type: "directory",
      children: [{ name: "build.sh", path: "scripts/build.sh", type: "file", editable: true }],
    },
  ];

  assert.deepEqual(pdfSourceTree(tree), [
    tree[0],
    { ...tree[2], children: [tree[2].children[0]] },
  ]);
  assert.equal(tree[2].children.length, 2, "filtering must not mutate the API tree");
});
