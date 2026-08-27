import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveLatexmk } from "../modules/compiler/toolchain.mjs";

test("an explicit verified latexmk path wins and is cached", async () => {
  const root = await mkdtemp(join(tmpdir(), "undertree-toolchain-"));
  try {
    const executable = join(root, "latexmk.exe");
    await writeFile(executable, "fixture");
    assert.equal(await resolveLatexmk({ stateRoot: root, env: { UNDERTREE_LATEXMK: executable }, platform: "win32" }), executable);
    const cache = JSON.parse(await readFile(join(root, "tex-toolchain.json"), "utf8"));
    assert.equal(cache.latexmk, executable);
    assert.equal(cache.source, "environment");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("non-Windows compiler discovery delegates to the system latexmk command", async () => {
  const root = await mkdtemp(join(tmpdir(), "undertree-toolchain-"));
  try {
    assert.equal(await resolveLatexmk({ stateRoot: root, env: {}, platform: "linux" }), "latexmk");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
