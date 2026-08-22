import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertHtmlPrintProfile, patchElementStyle } from "./html-print-profile.js";
import { generateLuaLatex } from "./html-tex-export.js";
import pretextPackage from "@chenglou/pretext/package.json" with { type: "json" };

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function command(program, args, { cwd, signal, timeout = 120000 } = {}) {
  return new Promise((resolveCommand, reject) => {
    const child = spawn(program, args, { cwd, signal, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), timeout);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code, signalName) => {
      clearTimeout(timer);
      resolveCommand({ code: code ?? 1, signal: signalName, stdout, stderr });
    });
  });
}

async function executable(name) {
  const result = process.platform === "win32"
    ? await command("where.exe", [name], { timeout: 5000 })
    : await command("sh", ["-c", `command -v ${name}`], { timeout: 5000 });
  return result.code === 0;
}

function confinedPath(projectRoot, baseDirectory, assetPath) {
  const candidate = resolve(baseDirectory, assetPath);
  const within = relative(projectRoot, candidate);
  if (!within || (!within.startsWith("..") && !isAbsolute(within))) return candidate;
  throw new Error(`Asset leaves the project: ${assetPath}`);
}

async function validateAssets(profile, sourcePath, projectRoot, requireTexFallback) {
  const base = dirname(sourcePath);
  for (const asset of profile.assets) {
    const path = confinedPath(projectRoot, base, asset.path);
    await access(path).catch(() => { throw new Error(`Missing local asset: ${asset.value}`); });
  }
  if (requireTexFallback) {
    for (const asset of profile.assets.filter((item) => item.attribute === "src" && extname(item.path).toLocaleLowerCase() === ".svg")) {
      const fallback = profile.assets.find((item) => item.attribute === "data-ut-tex-src" && item.dataUtId === asset.dataUtId);
      if (!fallback) throw new Error(`SVG ${asset.value} requires data-ut-tex-src for LuaLaTeX export.`);
    }
  }
}

export function applyResolvedFitsToHtml(source, resolvedFits = []) {
  let result = String(source || "");
  for (const fit of resolvedFits) {
    if (!fit?.dataUtId) continue;
    const patch = patchElementStyle(result, fit.dataUtId, {
      "--ut-fit-font-size": `${Number(fit.fontSize).toFixed(2)}px`,
      "--ut-fit-line-height": `${Number(fit.lineHeight).toFixed(2)}px`,
      "--ut-fit-gap": `${Number(fit.gap).toFixed(2)}px`,
    });
    result = patch.source;
  }
  return result;
}

export async function renderHtmlPrint({ sourcePath, projectRoot, pdfPath, manifestPath, texPath = "", signal, persistFits = true } = {}) {
  if (process.platform === "win32") {
    throw new Error("HTML print-profile rendering currently requires the Linux WebKitGTK renderer. LaTeX editing and compilation are supported on Windows.");
  }
  const root = await realpath(projectRoot || dirname(sourcePath));
  const source = await realpath(sourcePath);
  const sourceRelative = relative(root, source);
  if (sourceRelative.startsWith("..") || isAbsolute(sourceRelative)) throw new Error("HTML source must be inside the project root.");
  let html = await readFile(source, "utf8");
  const profile = assertHtmlPrintProfile(html);
  await validateAssets(profile, source, root, Boolean(texPath));
  await mkdir(dirname(pdfPath), { recursive: true });
  const manifest = manifestPath || `${pdfPath}.manifest.json`;
  await mkdir(dirname(manifest), { recursive: true });

  const python = "/usr/bin/python3";
  const renderer = join(APP_ROOT, "native", "html_print_renderer.py");
  const rendererArgs = [renderer, source, "--project-root", root, "--pdf", resolve(pdfPath), "--manifest", resolve(manifest), "--pages", String(profile.pages.length)];
  const needsDisplay = !process.env.DISPLAY && await executable("xvfb-run");
  const result = needsDisplay
    ? await command("xvfb-run", ["-a", python, ...rendererArgs], { cwd: root, signal })
    : await command(python, rendererArgs, { cwd: root, signal });
  if (result.code !== 0) {
    const error = new Error((result.stderr || result.stdout || "WebKit HTML rendering failed.").trim());
    error.name = "HtmlRenderError";
    throw error;
  }
  const browserManifest = JSON.parse(await readFile(manifest, "utf8"));
  if (persistFits && browserManifest.resolvedFits?.length) {
    const fittedHtml = applyResolvedFitsToHtml(html, browserManifest.resolvedFits);
    if (fittedHtml !== html) {
      await writeFile(source, fittedHtml);
      html = fittedHtml;
    }
  }
  const pdfMetadata = await command("pdfinfo", [resolve(pdfPath)], { cwd: root, timeout: 10000 });
  const pageSize = pdfMetadata.stdout.match(/^Page size:\s+([\d.]+) x ([\d.]+) pts/m);
  if (pageSize) browserManifest.pdfPageSizePt = { width: Number(pageSize[1]), height: Number(pageSize[2]) };
  const sourceHash = createHash("sha256").update(html).digest("hex");
  browserManifest.sourceSha256 = sourceHash;
  browserManifest.profileVersion = profile.profileVersion;
  browserManifest.pretextVersion = pretextPackage.version;
  await writeFile(manifest, `${JSON.stringify(browserManifest, null, 2)}\n`);

  let texPdfPath = "";
  let texOutput = "";
  if (texPath) {
    const browserPdfSha256 = createHash("sha256").update(await readFile(pdfPath)).digest("hex");
    const generated = generateLuaLatex(browserManifest, {
      sourceHash,
      profileVersion: profile.profileVersion,
      pretextVersion: pretextPackage.version,
      webkitVersion: browserManifest.webkitVersion,
      sourcePath: sourceRelative,
      browserPdfSha256,
    });
    await writeFile(texPath, generated);
    const renderNamespace = String(process.env.UNDERTREE_RENDER_NAMESPACE || process.pid).replace(/[^A-Za-z0-9._-]/g, "_");
    const outputDirectory = join(root, ".tex-build", "undertree-html", sourceRelative.replace(/[^A-Za-z0-9._-]/g, "_"), renderNamespace);
    await mkdir(outputDirectory, { recursive: true });
    const compiled = await command("latexmk", ["-norc", "-lualatex", "-interaction=nonstopmode", "-file-line-error", "-halt-on-error", `-outdir=${outputDirectory}`, resolve(texPath)], { cwd: dirname(texPath), signal, timeout: 240000 });
    texOutput = `${compiled.stdout}${compiled.stderr}`;
    if (compiled.code !== 0) throw new Error(`Generated LuaLaTeX did not compile.\n${texOutput}`);
    texPdfPath = join(outputDirectory, `${resolve(texPath).split("/").at(-1).replace(/\.tex$/i, "")}.pdf`);
  }
  return {
    code: 0,
    sourcePath: sourceRelative,
    pdfPath: resolve(pdfPath),
    manifestPath: resolve(manifest),
    texPath: texPath ? resolve(texPath) : "",
    texPdfPath,
    texOutput,
    sourceHash,
    profileVersion: profile.profileVersion,
    pretextVersion: pretextPackage.version,
    webkitVersion: browserManifest.webkitVersion,
    resolvedFits: browserManifest.resolvedFits || [],
    diagnostics: browserManifest.diagnostics || [],
    pageCount: browserManifest.pages?.length || 0,
  };
}
