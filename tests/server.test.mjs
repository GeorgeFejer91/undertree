import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { access, chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const APP_ROOT = fileURLToPath(new URL("..", import.meta.url));

async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  server.close();
  await once(server, "close");
  return port;
}

async function run(program, args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(program, args, { cwd });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.on("close", (code) => resolve({ code, output }));
  });
}

async function waitForHealth(baseUrl) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Test server did not become healthy");
}

function storedZipEntries(buffer) {
  const entries = new Map();
  let offset = 0;
  while (buffer.readUInt32LE(offset) === 0x04034b50) {
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    entries.set(buffer.subarray(nameStart, nameStart + nameLength).toString("utf8"), buffer.subarray(dataStart, dataStart + compressedSize));
    offset = dataStart + compressedSize;
  }
  return entries;
}

test("authenticated API safely edits, searches, compiles, and serves a local TeX project", async (context) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "localtex-test-"));
  const library = join(temporaryRoot, "library");
  const project = join(library, "fixture-project");
  await mkdir(join(project, "scripts"), { recursive: true });
  await writeFile(join(project, "main.tex"), String.raw`\documentclass{article}
\begin{document}
Offline fixture text.
\section{Verification}
Local compilation works.
\end{document}
`);
  await writeFile(join(project, "supplement.tex"), String.raw`% !TeX program = lualatex
\documentclass{article}
\usepackage{fontspec}
\begin{document}
Supplementary document.
\end{document}
`);
  await writeFile(join(project, "broken.tex"), String.raw`\documentclass{article}
\begin{document}
This source intentionally does not end.
`);
  await writeFile(join(project, "adaptive.layout.xml"), `<?xml version="1.0"?>
<layout-document version="1" title="Server layout"><page size="A4" margin="10mm"><grid columns="1fr" rows="1fr"><box id="adaptive" min-font-size="8.5pt" max-font-size="14pt"><heading>Adaptive server proof</heading><p>The selected semantic layout compiles through the authenticated local API.</p></box></grid></page></layout-document>`);
  await writeFile(join(project, ".tex-sync.conf"), `[sync]\n\tgithubRemote = origin\n\tgithubBranch = main\n\toverleafProjectUrl = https://www.overleaf.com/project/fixture\n\tmode = direct-git\n\toverleafRemote = overleaf\n[build]\n\troot = main.tex\n\tengine = pdflatex\n\tworkingDirectory = repository-root\n\tshellEscape = false\n`);
  const bridge = `#!/usr/bin/env bash\nset -euo pipefail\nif [[ \"\${1:-}\" == build ]]; then\n  mkdir -p .tex-build\n  latexmk -norc -pdf -interaction=nonstopmode -halt-on-error -outdir=.tex-build main.tex\nelif [[ \"\${1:-}\" == pull || \"\${1:-}\" == push ]]; then\n  echo \"fixture \$1 completed safely\"\nelse\n  echo \"unsupported fixture action\" >&2\n  exit 2\nfi\n`;
  const bridgeWithClean = bridge.replace(
    'elif [[ "${1:-}" == pull',
    'elif [[ "${1:-}" == clean ]]; then\n  latexmk -norc -C -outdir=.tex-build main.tex\nelif [[ "${1:-}" == pull',
  );
  await writeFile(join(project, "scripts", "tex-sync"), bridgeWithClean);
  await chmod(join(project, "scripts", "tex-sync"), 0o755);
  const previewNormalizer = join(temporaryRoot, "preview-normalizer");
  await writeFile(previewNormalizer, `#!/usr/bin/env bash
set -euo pipefail
output=""
input=""
for argument in "$@"; do
  case "$argument" in
    -sOutputFile=*) output="\${argument#*=}" ;;
    *.pdf) input="$argument" ;;
  esac
done
cp "$input" "$output"
printf '\n%%%% LocalTeX preview normalized\n' >> "$output"
`);
  await chmod(previewNormalizer, 0o755);
  const codexInvocation = join(temporaryRoot, "codex-invocation.txt");
  const codexDesktopRequest = join(temporaryRoot, "codex-desktop-request.txt");
  const fakeCodex = join(temporaryRoot, "codex");
  await writeFile(fakeCodex, String.raw`#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' 'unexpected Codex invocation' > "$LOCALTEX_TEST_CODEX_INVOCATION"
exit 2
`);
  await chmod(fakeCodex, 0o755);
  const fakeCodexDesktop = join(temporaryRoot, "codex-desktop");
  await writeFile(fakeCodexDesktop, String.raw`#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$1" > "$LOCALTEX_TEST_CODEX_DESKTOP_REQUEST"
`);
  await chmod(fakeCodexDesktop, 0o755);
  const fileManagerRequest = join(temporaryRoot, "file-manager-request.txt");
  const fakeFileManager = join(temporaryRoot, "file-manager");
  await writeFile(fakeFileManager, `#!/usr/bin/env bash\nset -euo pipefail\nprintf '%s' "$1" > "${fileManagerRequest}"\n`);
  await chmod(fakeFileManager, 0o755);
  await writeFile(join(library, "PROJECTS.tsv"), `type\tname\tlocalPath\trepository\tbranch\troot\tengine\toverleafUrl\nactive-overleaf\tFixture Project\t${project}\texample/fixture\tmain\tmain.tex\tpdflatex\thttps://www.overleaf.com/project/fixture\n`);
  await writeFile(join(library, "PROJECT_DOMAINS.tsv"), `id\ttype\tname\tprojectTitle\tsemanticDomain\tthemes\tdocumentFunction\tprojectFamily\treuseRole\tlocalPath\trepository\troot\tengine\toverleafUrl\nfixture\tactive-overleaf\tFixture Project\tFixture\ttesting\toffline\tverification\tfixture\ttest\t${project}\texample/fixture\tmain.tex\tpdflatex\thttps://www.overleaf.com/project/fixture\n`);

  await run("git", ["init", "-b", "main"], project);
  await run("git", ["config", "user.name", "LocalTeX Test"], project);
  await run("git", ["config", "user.email", "localtex@example.invalid"], project);
  await run("git", ["add", "."], project);
  await run("git", ["commit", "-m", "Fixture"], project);
  const githubRemote = join(temporaryRoot, "github.git");
  const overleafRemote = join(temporaryRoot, "overleaf.git");
  await run("git", ["init", "--bare", githubRemote], temporaryRoot);
  await run("git", ["init", "--bare", overleafRemote], temporaryRoot);
  await run("git", ["remote", "add", "origin", githubRemote], project);
  await run("git", ["remote", "add", "overleaf", overleafRemote], project);
  await run("git", ["push", "-u", "origin", "main"], project);
  await run("git", ["push", "-u", "overleaf", "main"], project);

  const port = await freePort();
  const token = "integration-test-token";
  const server = spawn(process.execPath, [join(APP_ROOT, "server.mjs")], {
    cwd: APP_ROOT,
    env: {
      ...process.env,
      UNDERTREE_PORT: String(port),
      UNDERTREE_TOKEN: token,
      UNDERTREE_LIBRARY_ROOT: library,
      UNDERTREE_GHOSTSCRIPT: previewNormalizer,
      UNDERTREE_CODEX: fakeCodex,
      UNDERTREE_CODEX_DESKTOP: fakeCodexDesktop,
      UNDERTREE_FILE_MANAGER: fakeFileManager,
      UNDERTREE_STATE_ROOT: join(temporaryRoot, "state"),
      LOCALTEX_TEST_CODEX_INVOCATION: codexInvocation,
      LOCALTEX_TEST_CODEX_DESKTOP_REQUEST: codexDesktopRequest,
    },
  });
  let serverOutput = "";
  server.stdout.on("data", (chunk) => { serverOutput += chunk; });
  server.stderr.on("data", (chunk) => { serverOutput += chunk; });
  context.after(async () => {
    server.kill("SIGTERM");
    await Promise.race([once(server, "close"), new Promise((resolve) => setTimeout(resolve, 3000))]);
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForHealth(baseUrl);
  const health = await (await fetch(`${baseUrl}/api/health`)).json();
  assert.equal(health.app, "UnderTree");
  const headers = { Cookie: `localtex_session=${token}` };
  const mutationHeaders = { ...headers, Origin: baseUrl, "Content-Type": "application/json" };

  assert.equal((await fetch(`${baseUrl}/api/projects`)).status, 403, "project inventory must require authentication");
  const bootstrap = await fetch(`${baseUrl}/?token=${token}`, { redirect: "manual" });
  assert.equal(bootstrap.status, 302);
  assert.match(bootstrap.headers.get("set-cookie") || "", /HttpOnly/);
  assert.match(bootstrap.headers.get("set-cookie") || "", /SameSite=Strict/);
  const fileBootstrap = await fetch(`${baseUrl}/?token=${token}&project=fixture-project&file=main.tex`, { redirect: "manual" });
  assert.equal(fileBootstrap.headers.get("location"), "/app?project=fixture-project&file=main.tex");

  const projectData = await (await fetch(`${baseUrl}/api/projects`, { headers })).json();
  assert.equal(projectData.projects.length, 1);
  assert.ok(Number.isFinite(projectData.projects[0].createdAt) && projectData.projects[0].createdAt > 0);
  assert.ok(Number.isFinite(projectData.projects[0].modifiedAt) && projectData.projects[0].modifiedAt > 0);
  const projectId = projectData.projects[0].id;
  const tree = await (await fetch(`${baseUrl}/api/project/${projectId}/tree`, { headers })).json();
  assert.equal(tree.build.rootDocument, "main.tex");
  assert.equal(tree.build.engine, "pdflatex");
  assert.ok(tree.tree.some((entry) => entry.name === "main.tex"));

  const traversal = await fetch(`${baseUrl}/api/project/${projectId}/file?path=..%2Foutside.txt`, { headers });
  assert.equal(traversal.status, 400, "path traversal must be rejected");
  await writeFile(join(temporaryRoot, "outside.txt"), "outside secret");
  let outsideSymlinkCreated = false;
  try {
    await symlink(join(temporaryRoot, "outside.txt"), join(project, "outside-link.txt"));
    outsideSymlinkCreated = true;
    const outsideSymlink = await fetch(`${baseUrl}/api/project/${projectId}/file?path=outside-link.txt`, { headers });
    assert.equal(outsideSymlink.status, 403, "outside-project symlinks must be rejected");
  } catch (error) {
    if (error?.code !== "EPERM" || process.platform !== "win32") throw error;
    context.diagnostic("Windows symlink security assertion skipped because Developer Mode is disabled");
  }

  const missingOrigin = await fetch(`${baseUrl}/api/project/${projectId}/files`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ path: "chapters", type: "directory" }),
  });
  assert.equal(missingOrigin.status, 403, "mutating requests must be same-origin");
  assert.equal((await fetch(`${baseUrl}/api/project/${projectId}/files`, {
    method: "POST",
    headers: mutationHeaders,
    body: JSON.stringify({ path: "chapters", type: "directory" }),
  })).status, 201);
  assert.equal((await fetch(`${baseUrl}/api/project/${projectId}/files`, {
    method: "POST",
    headers: mutationHeaders,
    body: JSON.stringify({ path: "chapters/new.tex", type: "file" }),
  })).status, 201);
  const treeAfterCreate = await (await fetch(`${baseUrl}/api/project/${projectId}/tree`, { headers })).json();
  const chapters = treeAfterCreate.tree.find((entry) => entry.path === "chapters");
  assert.ok(chapters?.children.some((entry) => entry.path === "chapters/new.tex"), "tree cache must invalidate synchronously after file creation");

  await writeFile(join(project, "chapters", "new.tex"), "duplicated source words\n");
  const duplicateResponse = await fetch(`${baseUrl}/api/project/${projectId}/entry/duplicate`, {
    method: "POST",
    headers: mutationHeaders,
    body: JSON.stringify({ path: "chapters/new.tex" }),
  });
  assert.equal(duplicateResponse.status, 201);
  const duplicate = await duplicateResponse.json();
  assert.equal(duplicate.path, "chapters/new copy.tex");
  assert.equal(duplicate.editable, true);
  assert.equal(await readFile(join(project, duplicate.path), "utf8"), "duplicated source words\n");
  const secondDuplicate = await (await fetch(`${baseUrl}/api/project/${projectId}/entry/duplicate`, {
    method: "POST",
    headers: mutationHeaders,
    body: JSON.stringify({ path: "chapters/new.tex" }),
  })).json();
  assert.equal(secondDuplicate.path, "chapters/new copy 2.tex", "duplicate names must advance without overwriting existing copies");

  const folderDuplicate = await (await fetch(`${baseUrl}/api/project/${projectId}/entry/duplicate`, {
    method: "POST",
    headers: mutationHeaders,
    body: JSON.stringify({ path: "chapters" }),
  })).json();
  assert.equal(folderDuplicate.path, "chapters copy");
  assert.equal(await readFile(join(project, "chapters copy", "new.tex"), "utf8"), "duplicated source words\n", "folder duplication must be recursive");

  const renamedResponse = await fetch(`${baseUrl}/api/project/${projectId}/entry`, {
    method: "PATCH",
    headers: mutationHeaders,
    body: JSON.stringify({ path: duplicate.path, newPath: "chapters/renamed.tex" }),
  });
  assert.equal(renamedResponse.status, 200);
  assert.equal(await readFile(join(project, "chapters", "renamed.tex"), "utf8"), "duplicated source words\n");
  assert.equal(await access(join(project, duplicate.path)).then(() => true, () => false), false, "rename must remove the old path");
  const renameConflict = await fetch(`${baseUrl}/api/project/${projectId}/entry`, {
    method: "PATCH",
    headers: mutationHeaders,
    body: JSON.stringify({ path: "main.tex", newPath: "supplement.tex" }),
  });
  assert.equal(renameConflict.status, 409, "rename must not overwrite an existing entry");
  const unsafeDuplicate = await fetch(`${baseUrl}/api/project/${projectId}/entry/duplicate`, {
    method: "POST",
    headers: mutationHeaders,
    body: JSON.stringify({ path: "../outside.txt" }),
  });
  assert.equal(unsafeDuplicate.status, 400, "entry actions must retain project path traversal protection");
  if (outsideSymlinkCreated) {
    const symlinkDelete = await fetch(`${baseUrl}/api/project/${projectId}/entry`, {
      method: "DELETE",
      headers: mutationHeaders,
      body: JSON.stringify({ path: "outside-link.txt" }),
    });
    assert.equal(symlinkDelete.status, 403, "tree actions must never follow and mutate a symbolic-link target");
  }
  assert.equal(await readFile(join(temporaryRoot, "outside.txt"), "utf8"), "outside secret");

  const revealResponse = await fetch(`${baseUrl}/api/project/${projectId}/entry/reveal`, {
    method: "POST",
    headers: mutationHeaders,
    body: JSON.stringify({ path: "main.tex" }),
  });
  assert.equal(revealResponse.status, 200);
  for (let attempt = 0; attempt < 30 && !(await access(fileManagerRequest).then(() => true, () => false)); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(await readFile(fileManagerRequest, "utf8"), join(project, "main.tex"));

  const deleteResponse = await fetch(`${baseUrl}/api/project/${projectId}/entry`, {
    method: "DELETE",
    headers: mutationHeaders,
    body: JSON.stringify({ path: "chapters copy" }),
  });
  assert.equal(deleteResponse.status, 200);
  assert.equal(await access(join(project, "chapters copy")).then(() => true, () => false), false, "folder deletion must remove the selected subtree");
  const treeAfterActions = await (await fetch(`${baseUrl}/api/project/${projectId}/tree`, { headers })).json();
  const chaptersAfterActions = treeAfterActions.tree.find((entry) => entry.path === "chapters");
  assert.ok(chaptersAfterActions?.children.some((entry) => entry.path === "chapters/renamed.tex"), "tree cache must reflect renamed entries immediately");
  assert.equal(treeAfterActions.tree.some((entry) => entry.path === "chapters copy"), false, "tree cache must reflect deleted entries immediately");

  const opened = await (await fetch(`${baseUrl}/api/project/${projectId}/file?path=main.tex`, { headers })).json();
  assert.match(opened.content, /Offline fixture text/);
  const editedContent = opened.content.replace("Offline fixture text.", "Offline fixture text edited safely.");
  const savedResponse = await fetch(`${baseUrl}/api/project/${projectId}/file`, {
    method: "PUT",
    headers: mutationHeaders,
    body: JSON.stringify({ path: "main.tex", content: editedContent, expectedMtimeMs: opened.mtimeMs }),
  });
  assert.equal(savedResponse.status, 200);
  const saved = await savedResponse.json();
  assert.match(await readFile(join(project, "main.tex"), "utf8"), /edited safely/);

  const conflict = await fetch(`${baseUrl}/api/project/${projectId}/file`, {
    method: "PUT",
    headers: mutationHeaders,
    body: JSON.stringify({ path: "main.tex", content: opened.content, expectedMtimeMs: opened.mtimeMs }),
  });
  assert.equal(conflict.status, 409, "stale editor writes must not overwrite newer disk content");

  const currentAfterConflict = await (await fetch(`${baseUrl}/api/project/${projectId}/file?path=main.tex`, { headers })).json();
  const reconciledContent = opened.content.replace("Offline fixture text.", "Current editor text remains authoritative.");
  const reconciledResponse = await fetch(`${baseUrl}/api/project/${projectId}/file`, {
    method: "PUT",
    headers: mutationHeaders,
    body: JSON.stringify({
      path: "main.tex",
      content: reconciledContent,
      expectedMtimeMs: currentAfterConflict.mtimeMs,
      preserveCurrent: true,
    }),
  });
  assert.equal(reconciledResponse.status, 200);
  const reconciled = await reconciledResponse.json();
  assert.equal(reconciled.conflictPreserved, true, "the displaced disk side must remain recoverable");
  assert.equal(await readFile(join(project, "main.tex"), "utf8"), reconciledContent);
  const conflictBackups = await readdir(join(temporaryRoot, "state", "save-conflicts", projectId));
  assert.equal(conflictBackups.length, 1);
  assert.equal(await readFile(join(temporaryRoot, "state", "save-conflicts", projectId, conflictBackups[0]), "utf8"), editedContent);

  const vanishedPath = join(project, "vanished.tex");
  await writeFile(vanishedPath, "editor is the remaining copy\n");
  const vanishedMetadata = await (await fetch(`${baseUrl}/api/project/${projectId}/file?path=vanished.tex`, { headers })).json();
  await rm(vanishedPath);
  const recreatedResponse = await fetch(`${baseUrl}/api/project/${projectId}/file`, {
    method: "PUT",
    headers: mutationHeaders,
    body: JSON.stringify({ path: "vanished.tex", content: vanishedMetadata.content, expectedMtimeMs: vanishedMetadata.mtimeMs }),
  });
  assert.equal(recreatedResponse.status, 200);
  assert.equal((await recreatedResponse.json()).recreated, true, "a deleted open source must be restored from its editor buffer");
  assert.equal(await readFile(vanishedPath, "utf8"), vanishedMetadata.content);
  await rm(vanishedPath);

  const search = await (await fetch(`${baseUrl}/api/project/${projectId}/search?q=verification`, { headers })).json();
  assert.ok(search.results.some((entry) => entry.path === "main.tex"));

  const externalBuildRaceContent = reconciledContent.replace("Current editor text remains authoritative.", "External text that must be preserved before the editor wins.");
  await writeFile(join(project, "main.tex"), externalBuildRaceContent);
  const build = await (await fetch(`${baseUrl}/api/project/${projectId}/build`, {
    method: "POST",
    headers: mutationHeaders,
    body: JSON.stringify({ sourcePath: "main.tex", sourceContent: reconciledContent }),
  })).json();
  assert.equal(await readFile(join(project, "main.tex"), "utf8"), reconciledContent, "the exact editor buffer must be saved before compilation");
  assert.equal(build.sourceSave?.conflictPreserved, true, "a racing disk version must be preserved before the editor buffer is compiled");
  assert.equal(build.pdfAvailable, true, `expected PDF; server output was ${serverOutput}\n${build.output || ""}`);
  const cleanBuild = await (await fetch(`${baseUrl}/api/project/${projectId}/build`, { method: "POST", headers: mutationHeaders, body: JSON.stringify({ clean: true }) })).json();
  assert.equal(cleanBuild.pdfAvailable, true, "clean rebuild must produce a PDF");
  const pdfInfo = await (await fetch(`${baseUrl}/api/project/${projectId}/pdf-info`, { headers })).json();
  assert.equal(pdfInfo.available, true);
  assert.equal(pdfInfo.name, "main.pdf");
  const pdf = await fetch(`${baseUrl}/api/project/${projectId}/pdf`, { headers });
  assert.equal(pdf.status, 200);
  assert.equal(pdf.headers.get("content-type"), "application/pdf");
  const pdfPreviewBuffer = Buffer.from(await pdf.arrayBuffer());
  assert.ok(pdfPreviewBuffer.byteLength > 1000);
  assert.match(pdfPreviewBuffer.subarray(-80).toString("latin1"), /LocalTeX preview normalized/);
  const pdfDownload = await fetch(`${baseUrl}/api/project/${projectId}/pdf?download=1`, { headers });
  assert.match(pdfDownload.headers.get("content-disposition") || "", /filename="main\.pdf"/);
  const pdfDownloadBuffer = Buffer.from(await pdfDownload.arrayBuffer());
  assert.doesNotMatch(pdfDownloadBuffer.subarray(-80).toString("latin1"), /LocalTeX preview normalized/);
  const supplementBuildResponse = await fetch(`${baseUrl}/api/project/${projectId}/build`, {
    method: "POST",
    headers: mutationHeaders,
    body: JSON.stringify({ sourcePath: "supplement.tex" }),
  });
  assert.equal(supplementBuildResponse.status, 200, serverOutput);
  const supplementBuild = await supplementBuildResponse.json();
  assert.equal(supplementBuild.sourcePath, "supplement.tex");
  assert.equal(supplementBuild.pdfAvailable, true, `${serverOutput}\n${supplementBuild.output || ""}`);
  await access(join(project, ".tex-build", "supplement.pdf"));
  const legacyLayoutSource = String.raw`% Generated by UnderTree Layout. Edit the semantic .layout.xml source, not this file.
\documentclass{article}
\usepackage{fontspec}
\begin{document}
Legacy generated layout.
\end{document}
`;
  await writeFile(join(project, "legacy-layout.tex"), legacyLayoutSource);
  const legacyLayoutBuildResponse = await fetch(`${baseUrl}/api/project/${projectId}/build`, {
    method: "POST",
    headers: mutationHeaders,
    body: JSON.stringify({ sourcePath: "legacy-layout.tex" }),
  });
  assert.equal(legacyLayoutBuildResponse.status, 200, serverOutput);
  const legacyLayoutBuild = await legacyLayoutBuildResponse.json();
  assert.equal(legacyLayoutBuild.code, 0, `${serverOutput}\n${legacyLayoutBuild.output || ""}`);
  assert.equal(legacyLayoutBuild.pdfAvailable, true, "legacy generated layouts must compile with inferred LuaLaTeX");
  assert.match(legacyLayoutBuild.output, /LuaHBTeX|This is LuaTeX/, "the pdflatex project fallback must not compile fontspec sources");
  await rm(join(project, "legacy-layout.tex"));
  const supplementPdfInfo = await (await fetch(`${baseUrl}/api/project/${projectId}/pdf-info?sourcePath=supplement.tex`, { headers })).json();
  assert.equal(supplementPdfInfo.available, true);
  assert.equal(supplementPdfInfo.stale, false);
  assert.equal(supplementPdfInfo.name, "supplement.pdf");
  assert.equal(supplementPdfInfo.sourcePath, "supplement.tex");
  assert.match(supplementPdfInfo.fingerprint, /^\d+:\d+$/, "PDF metadata must include a stable cache fingerprint");
  await new Promise((resolve) => setTimeout(resolve, 5));
  await writeFile(join(project, "supplement.tex"), `${await readFile(join(project, "supplement.tex"), "utf8")}\n% source is newer than its PDF\n`);
  const staleSupplementPdfInfo = await (await fetch(`${baseUrl}/api/project/${projectId}/pdf-info?sourcePath=supplement.tex`, { headers })).json();
  assert.equal(staleSupplementPdfInfo.stale, true, "cache-first selection must detect a source newer than its stored PDF");
  const supplementPdf = await fetch(`${baseUrl}/api/project/${projectId}/pdf?sourcePath=supplement.tex&download=1`, { headers });
  assert.equal(supplementPdf.status, 200);
  assert.equal(supplementPdf.headers.get("x-undertree-pdf-fingerprint"), supplementPdfInfo.fingerprint);
  assert.match(supplementPdf.headers.get("content-disposition") || "", /filename="supplement\.pdf"/);
  assert.ok((await supplementPdf.arrayBuffer()).byteLength > 1000);
  const selectedMainPdf = await fetch(`${baseUrl}/api/project/${projectId}/pdf?sourcePath=main.tex&download=1`, { headers });
  assert.match(selectedMainPdf.headers.get("content-disposition") || "", /filename="main\.pdf"/);
  const bundleResponse = await fetch(`${baseUrl}/api/project/${projectId}/pdf-bundle`, { method: "POST", headers: mutationHeaders, body: "{}" });
  assert.equal(bundleResponse.status, 200, serverOutput);
  assert.equal(bundleResponse.headers.get("x-localtex-compiled"), "2", "mixed-engine standalone documents must compile with their own TeX directives");
  assert.equal(bundleResponse.headers.get("x-localtex-failed"), "1");
  assert.equal(decodeURIComponent(bundleResponse.headers.get("x-localtex-failed-sources") || ""), "broken.tex");
  const bundledPdfs = storedZipEntries(Buffer.from(await bundleResponse.arrayBuffer()));
  assert.deepEqual([...bundledPdfs.keys()].sort(), ["main.pdf", "supplement.pdf"]);
  assert.equal(bundledPdfs.get("main.pdf").subarray(0, 4).toString(), "%PDF");

  const failedSource = String.raw`\documentclass{article}
\begin{document}
Failed build source must remain unchanged.
`;
  await writeFile(join(project, "recover.tex"), failedSource);
  const failedBuildResponse = await fetch(`${baseUrl}/api/project/${projectId}/build`, {
    method: "POST",
    headers: mutationHeaders,
    body: JSON.stringify({ sourcePath: "recover.tex", recoverWithCodex: true }),
  });
  assert.equal(failedBuildResponse.status, 200, serverOutput);
  const failedBuild = await failedBuildResponse.json();
  assert.notEqual(failedBuild.code, 0, "a real failed TeX build remains a failed build when recovery is disabled");
  assert.equal(failedBuild.pdfAvailable, false);
  assert.equal(Object.hasOwn(failedBuild, "codexRecovery"), false, "the unsupported recovery flag must not create an agent task");
  assert.equal(await readFile(join(project, "recover.tex"), "utf8"), failedSource, "failed compilation must not rewrite manuscript source");
  await assert.rejects(access(codexInvocation), { code: "ENOENT" }, "disabled recovery must not invoke Codex");
  await assert.rejects(access(codexDesktopRequest), { code: "ENOENT" }, "disabled recovery must not invoke the Codex desktop app");
  await assert.rejects(access(join(temporaryRoot, "state", "codex-recovery")), { code: "ENOENT" }, "disabled recovery must not create task state");
  const recoveryUrl = `${baseUrl}/api/project/${projectId}/codex-recovery?id=${"0".repeat(24)}`;
  assert.equal((await fetch(recoveryUrl)).status, 403, "recovery lookup still requires authentication");
  const unknownRecovery = await fetch(recoveryUrl, { headers });
  assert.equal(unknownRecovery.status, 404);
  assert.equal((await unknownRecovery.json()).error, "Unknown Codex recovery task");
  await rm(join(project, "recover.tex"));

  const adaptiveBuildResponse = await fetch(`${baseUrl}/api/project/${projectId}/build`, {
    method: "POST",
    headers: mutationHeaders,
    body: JSON.stringify({ sourcePath: "adaptive.layout.xml" }),
  });
  assert.equal(adaptiveBuildResponse.status, 200);
  const adaptiveBuild = await adaptiveBuildResponse.json();
  assert.equal(adaptiveBuild.pdfAvailable, true, `${serverOutput}\n${adaptiveBuild.output || ""}`);
  assert.equal(adaptiveBuild.layout.sourcePath, "adaptive.layout.xml");
  const layoutInfo = await (await fetch(`${baseUrl}/api/project/${projectId}/layout-info`, { headers })).json();
  assert.equal(layoutInfo.available, true);
  assert.equal(layoutInfo.sourcePath, "adaptive.layout.xml");
  const htmlProof = await fetch(`${baseUrl}/api/project/${projectId}/layout-html`, { headers });
  assert.equal(htmlProof.status, 200);
  assert.match(await htmlProof.text(), /Adaptive server proof/);
  const adaptivePdf = await fetch(`${baseUrl}/api/project/${projectId}/pdf`, { headers });
  assert.equal(adaptivePdf.status, 200);
  assert.ok((await adaptivePdf.arrayBuffer()).byteLength > 1000);

  for (const action of ["pull", "push"]) {
    const sync = await fetch(`${baseUrl}/api/project/${projectId}/sync`, {
      method: "POST",
      headers: mutationHeaders,
      body: JSON.stringify({ action }),
    });
    assert.equal(sync.status, 200);
    assert.match((await sync.json()).output, new RegExp(`fixture ${action} completed safely`));
  }

  if (outsideSymlinkCreated) await rm(join(project, "outside-link.txt"));
  await run("git", ["add", "."], project);
  await run("git", ["commit", "-m", "Edited fixture"], project);
  for (const action of ["github", "overleaf"]) {
    const sync = await fetch(`${baseUrl}/api/project/${projectId}/sync`, {
      method: "POST",
      headers: mutationHeaders,
      body: JSON.stringify({ action }),
    });
    assert.equal(sync.status, 200);
    assert.match((await sync.json()).output, new RegExp(`${action === "github" ? "GitHub" : "Overleaf"} synchronized`));
  }

  const status = await (await fetch(`${baseUrl}/api/project/${projectId}/status`, { headers })).json();
  assert.equal(status.rootDocument, "main.tex");
  assert.equal(status.engine, "pdflatex");
  assert.equal(status.clean, true);
});
