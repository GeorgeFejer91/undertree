import test from "node:test";
import assert from "node:assert/strict";
import { normalizeProjectSort, sortProjects } from "../src/project-sorting.js";

const projects = [
  { id: "z", name: "Zebra", createdAt: 100, modifiedAt: 400 },
  { id: "a", name: "alpha 10", createdAt: 300, modifiedAt: 200 },
  { id: "b", name: "Alpha 2", createdAt: 200, modifiedAt: 300 },
];

test("project name sorting is case-insensitive, numeric, and reversible", () => {
  assert.deepEqual(sortProjects(projects, "name-asc").map(({ id }) => id), ["b", "a", "z"]);
  assert.deepEqual(sortProjects(projects, "name-desc").map(({ id }) => id), ["z", "a", "b"]);
});

test("recent activity uses app opens and edits ahead of server modification dates", () => {
  const activity = { a: { openedAt: 900 }, b: { editedAt: 800 } };
  assert.deepEqual(sortProjects(projects, "activity", activity).map(({ id }) => id), ["a", "b", "z"]);
  assert.deepEqual(projects.map(({ id }) => id), ["z", "a", "b"], "sorting must not mutate the API inventory");
});

test("creation date sorting supports newest and oldest first", () => {
  assert.deepEqual(sortProjects(projects, "created-desc").map(({ id }) => id), ["a", "b", "z"]);
  assert.deepEqual(sortProjects(projects, "created-asc").map(({ id }) => id), ["z", "b", "a"]);
});

test("unknown sort values fall back to recent activity", () => {
  assert.equal(normalizeProjectSort("not-a-sort"), "activity");
  assert.deepEqual(sortProjects(projects, "not-a-sort").map(({ id }) => id), ["z", "b", "a"]);
});
