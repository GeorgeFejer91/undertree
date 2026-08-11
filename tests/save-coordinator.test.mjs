import assert from "node:assert/strict";
import test from "node:test";
import { acceptBuildSave, buildTabSnapshot, flushTabSave, markPathEdited, markTabEdited, persistWithConflictRecovery, saveTabSnapshot, tabContent } from "../src/save-coordinator.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test("an editor callback remains bound to its original path after another tab becomes active", () => {
  const first = { path: "first.tex", content: "first", dirty: false, revision: 0 };
  const second = { path: "second.tex", content: "second", dirty: false, revision: 0 };
  const tabs = new Map([[first.path, first], [second.path, second]]);

  markPathEdited(tabs, first.path, "late first-tab update");

  assert.equal(first.content, "late first-tab update");
  assert.equal(first.dirty, true);
  assert.equal(second.content, "second");
  assert.equal(second.dirty, false);
});

test("an edit made during an in-flight save remains dirty until its own snapshot is saved", async () => {
  const tab = { path: "draft.tex", content: "first", dirty: true, revision: 1, mtimeMs: 10 };
  const first = deferred();
  const second = deferred();
  const writes = [];
  const persist = ({ content, expectedMtimeMs }) => {
    writes.push({ content, expectedMtimeMs });
    return writes.length === 1 ? first.promise : second.promise;
  };

  const firstSave = saveTabSnapshot(tab, persist);
  markTabEdited(tab, "second");
  const secondSave = saveTabSnapshot(tab, persist);
  first.resolve({ mtimeMs: 11, size: 5 });
  await firstSave;
  assert.equal(tab.dirty, true, "the newer editor revision must not be marked saved by an older response");
  assert.deepEqual(writes, [
    { content: "first", expectedMtimeMs: 10 },
    { content: "second", expectedMtimeMs: 11 },
  ]);
  second.resolve({ mtimeMs: 12, size: 6 });
  await secondSave;
  assert.equal(tab.dirty, false);
  assert.equal(tab.mtimeMs, 12);
});

test("the compile save barrier persists the newest revision before resolving", async () => {
  const tab = { path: "draft.tex", content: "old", dirty: true, revision: 1, mtimeMs: 20 };
  const first = deferred();
  const writes = [];
  const persist = async ({ content, expectedMtimeMs }) => {
    writes.push({ content, expectedMtimeMs });
    if (writes.length === 1) return first.promise;
    return { mtimeMs: 22, size: content.length };
  };

  const backgroundSave = saveTabSnapshot(tab, persist);
  markTabEdited(tab, "newest editor text");
  const barrier = flushTabSave(tab, persist);
  first.resolve({ mtimeMs: 21, size: 3 });
  await Promise.all([backgroundSave, barrier]);
  assert.deepEqual(writes.map((write) => write.content), ["old", "newest editor text"]);
  assert.equal(tab.dirty, false);
  assert.equal(tab.mtimeMs, 22);
});

test("editor text stays lazy until a save snapshot needs a string", async () => {
  const editorText = { toString: () => "large editor document" };
  const tab = { content: "old", dirty: false, revision: 0, mtimeMs: 1 };
  markTabEdited(tab, editorText);
  assert.equal(tab.content, editorText);
  assert.equal(tabContent(tab), "large editor document");

  let persisted = "";
  await saveTabSnapshot(tab, async ({ content }) => {
    persisted = content;
    return { mtimeMs: 2, size: content.length };
  });
  assert.equal(persisted, "large editor document");
  assert.equal(tab.content, "large editor document");
  assert.equal(tab.dirty, false);
});

test("a build transaction saves its exact editor snapshot without clearing a newer edit", async () => {
  const firstEditorText = { toString: () => "compile this revision" };
  const tab = { content: firstEditorText, dirty: true, revision: 4, mtimeMs: 10 };
  const snapshot = await buildTabSnapshot(tab);

  assert.equal(snapshot.content, "compile this revision");
  assert.equal(snapshot.dirty, true);
  assert.equal(tab.content, firstEditorText, "snapshotting must keep editor text lazy");

  markTabEdited(tab, "newer revision");
  assert.equal(acceptBuildSave(tab, snapshot, { mtimeMs: 11, size: snapshot.content.length }), false);
  assert.equal(tab.content, "newer revision");
  assert.equal(tab.dirty, true);
  assert.equal(tab.mtimeMs, 11, "disk metadata still describes the completed build save");
});

test("a build transaction marks an unchanged source snapshot saved", async () => {
  const editorText = { toString: () => "compiled revision" };
  const tab = { content: editorText, dirty: true, revision: 7, mtimeMs: 10 };
  const snapshot = await buildTabSnapshot(tab);

  assert.equal(acceptBuildSave(tab, snapshot, { mtimeMs: 12, size: snapshot.content.length }), true);
  assert.equal(tab.content, "compiled revision");
  assert.equal(tab.dirty, false);
  assert.equal(tab.mtimeMs, 12);
});

test("a stale-mtime conflict retries the editor snapshot against fresh disk metadata", async () => {
  const writes = [];
  const persist = async (snapshot) => {
    writes.push(snapshot);
    if (writes.length === 1) throw Object.assign(new Error("changed on disk"), { status: 409 });
    return { mtimeMs: 202, size: snapshot.content.length, conflictPreserved: true };
  };

  const result = await persistWithConflictRecovery(
    { content: "new editor words", expectedMtimeMs: 100 },
    persist,
    async () => ({ mtimeMs: 200, content: "older disk words" }),
  );

  assert.equal(writes.length, 2);
  assert.equal(writes[1].content, "new editor words");
  assert.equal(writes[1].expectedMtimeMs, 200);
  assert.equal(writes[1].preserveCurrent, true);
  assert.equal(result.conflictPreserved, true);
});

test("a source deleted during conflict recovery is recreated from the editor snapshot", async () => {
  const writes = [];
  const persist = async (snapshot) => {
    writes.push(snapshot);
    if (writes.length === 1) throw Object.assign(new Error("changed on disk"), { status: 409 });
    return { mtimeMs: 302, size: snapshot.content.length, recreated: true };
  };

  const result = await persistWithConflictRecovery(
    { content: "only remaining editor copy", expectedMtimeMs: 300 },
    persist,
    async () => { throw Object.assign(new Error("missing"), { status: 404 }); },
  );

  assert.equal(writes[1].content, "only remaining editor copy");
  assert.equal(writes[1].expectedMtimeMs, null);
  assert.equal(writes[1].preserveCurrent, false);
  assert.equal(result.recreated, true);
});
