import assert from "node:assert/strict";
import test from "node:test";

import { documentOutline } from "../src/outline.js";

test("TeX outline preserves heading levels and exact source lines", () => {
  const content = [
    "\\documentclass{article}",
    "\\begin{document}",
    "\\section{First}",
    "text",
    "  \\subsection*{Second}",
    "\\paragraph{Third}",
  ].join("\n");
  assert.deepEqual(documentOutline(content), [
    { title: "First", line: 3, level: 1 },
    { title: "Second", line: 5, level: 2 },
    { title: "Third", line: 6, level: 3 },
  ]);
});

test("layout outline strips inline markup and preserves source lines", () => {
  const content = [
    "<layout>",
    "  <box>",
    "    <heading>First <strong>title</strong></heading>",
    "  </box>",
    "  <heading role=\"minor\">Second</heading>",
    "</layout>",
  ].join("\n");
  assert.deepEqual(documentOutline(content, true), [
    { title: "First title", line: 3, level: 1 },
    { title: "Second", line: 5, level: 1 },
  ]);
});
