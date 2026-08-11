import assert from "node:assert/strict";
import test from "node:test";
import { absoluteProjectPath, dirnamePath, pathIsEntry, remapPath } from "../src/file-tree-actions.js";

test("tree entry path matching includes descendants but not similar siblings", () => {
  assert.equal(pathIsEntry("chapters", "chapters"), true);
  assert.equal(pathIsEntry("chapters/method.tex", "chapters"), true);
  assert.equal(pathIsEntry("chapters-old/method.tex", "chapters"), false);
});

test("renaming a folder remaps its open descendant paths", () => {
  assert.equal(remapPath("chapters/method.tex", "chapters", "sections"), "sections/method.tex");
  assert.equal(remapPath("main.tex", "main.tex", "document.tex"), "document.tex");
  assert.equal(dirnamePath("chapters/method.tex"), "chapters");
  assert.equal(dirnamePath("main.tex"), "");
});

test("full paths preserve the host platform's path separator style", () => {
  assert.equal(absoluteProjectPath("/home/user/project/", "chapters/method.tex"), "/home/user/project/chapters/method.tex");
  assert.equal(absoluteProjectPath("C:\\Users\\User\\project\\", "chapters/method.tex"), "C:\\Users\\User\\project\\chapters\\method.tex");
});
