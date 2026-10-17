import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import packageMetadata from "../package.json" with { type: "json" };

const exec = promisify(execFile);
const cli = fileURLToPath(new URL("../cli.mjs", import.meta.url));
const localOnly = { ...process.env, UNDERTREE_ORIGIN: "http://127.0.0.1:1" };

test("CLI discovery uses package identity and rejects unknown or incomplete commands before service access", async () => {
  const { stdout } = await exec(process.execPath, [cli, "help"], { env: localOnly });
  const help = JSON.parse(stdout);
  assert.equal(help.version, packageMetadata.version);
  assert.ok(help.commands["render-html"]);
  for (const [args, message] of [
    [["unknown-command"], /Unknown command/],
    [["render-html", "input.html"], /Usage:/],
    [["render-html", "input.html", "--pdf"], /Usage:/],
    [["render-html", "input.html", "--pdf", "input.html"], /different from the source/],
  ]) {
    await assert.rejects(exec(process.execPath, [cli, ...args], { env: localOnly, timeout: 5000 }), error => {
      assert.match(JSON.parse(error.stderr).error, message);
      return true;
    });
  }
});

test(process.platform === "win32"
  ? "render-html CLI truthfully refuses unsupported Windows rendering without changing source or outputs"
  : "render-html CLI produces a real PDF offline while preserving its source", { timeout: 90000 }, async context => {
  const directory = await mkdtemp(join(tmpdir(), "undertree-cli-render-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const source = fileURLToPath(new URL("../examples/html-print-profile.html", import.meta.url));
  const digest = async () => createHash("sha256").update(await readFile(source)).digest("hex");
  const original = await digest();
  const pdf = join(directory, "nested", "print.pdf");
  if (process.platform === "win32") {
    await assert.rejects(exec(process.execPath, [cli, "render-html", source, "--pdf", pdf], { env: localOnly, timeout: 85000 }), error => {
      assert.equal(error.code, 1);
      assert.match(JSON.parse(error.stderr).error, /requires the Linux WebKitGTK renderer/);
      return true;
    });
    assert.equal(await digest(), original);
    await assert.rejects(readFile(pdf), { code: "ENOENT" });
    await assert.rejects(readFile(`${pdf}.manifest.json`), { code: "ENOENT" });
    return;
  }
  const { stdout } = await exec(process.execPath, [cli, "render-html", source, "--pdf", pdf], { env: localOnly, timeout: 85000 });
  const result = JSON.parse(stdout);
  assert.equal(result.code, 0);
  assert.equal(result.pageCount, 1);
  assert.equal(result.pdfPath, pdf);
  assert.equal((await readFile(pdf)).subarray(0, 5).toString(), "%PDF-");
  assert.equal(await digest(), original);
});
