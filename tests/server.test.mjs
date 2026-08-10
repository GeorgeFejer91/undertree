import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const APP_ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

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
    env: { ...process.env, LOCALTEX_PORT: String(port), LOCALTEX_TOKEN: token, LOCALTEX_LIBRARY_ROOT: library, LOCALTEX_GHOSTSCRIPT: previewNormalizer },
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
  await symlink(join(temporaryRoot, "outside.txt"), join(project, "outside-link.txt"));
  const outsideSymlink = await fetch(`${baseUrl}/api/project/${projectId}/file?path=outside-link.txt`, { headers });
  assert.equal(outsideSymlink.status, 403, "outside-project symlinks must be rejected");

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

  const search = await (await fetch(`${baseUrl}/api/project/${projectId}/search?q=verification`, { headers })).json();
  assert.ok(search.results.some((entry) => entry.path === "main.tex"));

  const build = await (await fetch(`${baseUrl}/api/project/${projectId}/build`, { method: "POST", headers: mutationHeaders, body: "{}" })).json();
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
  const supplementPdfInfo = await (await fetch(`${baseUrl}/api/project/${projectId}/pdf-info?sourcePath=supplement.tex`, { headers })).json();
  assert.deepEqual(supplementPdfInfo, { available: true, name: "supplement.pdf", sourcePath: "supplement.tex" });
  const supplementPdf = await fetch(`${baseUrl}/api/project/${projectId}/pdf?sourcePath=supplement.tex&download=1`, { headers });
  assert.equal(supplementPdf.status, 200);
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

  await rm(join(project, "outside-link.txt"));
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
