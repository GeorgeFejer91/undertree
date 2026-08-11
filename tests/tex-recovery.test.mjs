import assert from "node:assert/strict";
import test from "node:test";
import { hasDocumentClass, hasDocumentEnvironment, isSelectedTexPdfTarget } from "../src/tex-recovery.js";

test("document-class detection ignores commented examples", () => {
  assert.equal(hasDocumentClass("% \\documentclass{article}\nA chapter fragment."), false);
  assert.equal(hasDocumentClass("\\documentclass[11pt]{article}\n\\begin{document}"), true);
  assert.equal(hasDocumentEnvironment("% \\begin{document}\nA fragment."), false);
  assert.equal(hasDocumentEnvironment("\\documentclas{article}\n\\begin{document}"), true);
});

test("selection-time PDF builds target every selected TeX source", () => {
  assert.equal(isSelectedTexPdfTarget("main.tex", "temporarily malformed root", "main.tex"), true);
  assert.equal(isSelectedTexPdfTarget("letter.tex", "\\documentclass{letter}", "main.tex"), true);
  assert.equal(isSelectedTexPdfTarget("broken-letter.tex", "\\documentclas{letter}\n\\begin{document}", "main.tex"), true);
  assert.equal(isSelectedTexPdfTarget("chapters/results.tex", "\\section{Results}", "main.tex"), true);
  assert.equal(isSelectedTexPdfTarget("references.bib", "\\documentclass{article}", "main.tex"), false);
});
