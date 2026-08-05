#!/usr/bin/env node
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  access,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { basename, dirname, extname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const APP_ROOT = dirname(fileURLToPath(import.meta.url));
const DIST_ROOT = join(APP_ROOT, "dist");
const LIBRARY_ROOT = resolve(
  process.env.LOCALTEX_LIBRARY_ROOT || "/home/George/Documents/Overleaf-projects",
);
const HOST = "127.0.0.1";
const PORT = Number(process.env.LOCALTEX_PORT || process.argv.find((arg) => arg.startsWith("--port="))?.split("=")[1] || 37371);
const ACCESS_TOKEN = process.env.LOCALTEX_TOKEN
  || (process.env.LOCALTEX_TOKEN_FILE ? (await readFile(process.env.LOCALTEX_TOKEN_FILE, "utf8")).trim() : "")
  || randomBytes(24).toString("hex");
const COOKIE_NAME = "localtex_session";
const MAX_BODY = 10 * 1024 * 1024;
const MAX_TEXT_FILE = 8 * 1024 * 1024;
const PROJECT_CACHE_MS = 5000;
const TEXT_EXTENSIONS = new Set([
  ".tex", ".bib", ".sty", ".cls", ".bst", ".bbx", ".cbx", ".ltx",
  ".md", ".txt", ".csv", ".tsv", ".json", ".yaml", ".yml", ".toml",
  ".ini", ".conf", ".svg", ".html", ".css", ".js", ".mjs", ".cjs",
  ".py", ".r", ".rnw", ".sh", ".lua", ".xml",
]);
const IGNORED_DIRECTORIES = new Set([
  ".git", ".tex-build", "node_modules", ".cache", ".idea", ".vscode", "tmp",
]);
const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".woff2": "font/woff2",
  ".pdf": "application/pdf",
};

let projectCache = { at: 0, projects: [] };
const builds = new Map();

function idForPath(localPath) {
  return createHash("sha256").update(localPath).digest("hex").slice(0, 16);
}

function parseTsv(text) {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter(Boolean);
  if (!lines.length) return [];
  const headers = lines[0].split("\t");
  return lines.slice(1).map((line) => {
    const values = line.split("\t");
    return Object.fromEntries(headers.map((header, index) => [header, values[index] || ""]));
  });
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function loadProjects(force = false) {
  if (!force && Date.now() - projectCache.at < PROJECT_CACHE_MS) return projectCache.projects;
  const catalogPath = join(LIBRARY_ROOT, "PROJECTS.tsv");
  const domainsPath = join(LIBRARY_ROOT, "PROJECT_DOMAINS.tsv");
  const iconManifestPath = join(LIBRARY_ROOT, "_icons", "manifest.json");
  let catalog = [];
  let domains = [];
  let iconProjects = [];
  if (await exists(catalogPath)) catalog = parseTsv(await readFile(catalogPath, "utf8"));
  if (await exists(domainsPath)) domains = parseTsv(await readFile(domainsPath, "utf8"));
  if (await exists(iconManifestPath)) {
    try {
      iconProjects = JSON.parse(await readFile(iconManifestPath, "utf8")).projects || [];
    } catch {
      iconProjects = [];
    }
  }
  const catalogPaths = new Set(catalog.map((entry) => resolve(entry.localPath)));
  const entries = await readdir(LIBRARY_ROOT, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith("_")) continue;
    const localPath = join(LIBRARY_ROOT, entry.name);
    if (!catalogPaths.has(resolve(localPath)) && await exists(join(localPath, ".git")) && await exists(join(localPath, ".tex-sync.conf"))) {
      catalog.push({ name: entry.name, localPath, repository: "", branch: "main", root: "", engine: "", overleafUrl: "" });
    }
  }
  const domainByPath = new Map(domains.map((entry) => [entry.localPath, entry]));
  const iconByPath = new Map(iconProjects.map((entry) => [entry.localPath, entry.iconPath]));
  const projects = [];
  for (const entry of catalog) {
    const localPath = resolve(entry.localPath);
    if (!localPath.startsWith(`${LIBRARY_ROOT}${sep}`) || !(await exists(localPath))) continue;
    const domain = domainByPath.get(entry.localPath) || {};
    projects.push({
      id: idForPath(localPath),
      name: entry.name || basename(localPath),
      localPath,
      repository: entry.repository || "",
      branch: entry.branch || "main",
      rootDocument: entry.root || "",
      engine: entry.engine || "",
      overleafUrl: entry.overleafUrl || "",
      semanticDomain: domain.semanticDomain || "",
      themes: domain.themes || "",
      documentFunction: domain.documentFunction || "",
      projectFamily: domain.projectFamily || "",
      iconPath: iconByPath.get(entry.localPath) || "",
    });
  }
  projects.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  projectCache = { at: Date.now(), projects };
  return projects;
}

async function projectById(id) {
  const project = (await loadProjects()).find((entry) => entry.id === id);
  if (!project) throw httpError(404, "Unknown project");
  return project;
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function safeRelativePath(input) {
  if (typeof input !== "string" || !input || input.includes("\0") || isAbsolute(input)) {
    throw httpError(400, "Invalid project-relative path");
  }
  const value = normalize(input).replaceAll("\\", "/");
  if (value === ".." || value.startsWith("../") || value.includes("/../")) {
    throw httpError(400, "Path traversal is not allowed");
  }
  return value.replace(/^\.\//, "");
}

async function resolveExisting(project, input) {
  const relativePath = safeRelativePath(input);
  const candidate = resolve(project.localPath, relativePath);
  const actual = await realpath(candidate).catch(() => {
    throw httpError(404, "File does not exist");
  });
  const projectRoot = await realpath(project.localPath);
  if (actual !== projectRoot && !actual.startsWith(`${projectRoot}${sep}`)) {
    throw httpError(403, "Symlinks outside the project are not accessible");
  }
  return { path: actual, relativePath };
}

async function resolveCreatable(project, input) {
  const relativePath = safeRelativePath(input);
  const candidate = resolve(project.localPath, relativePath);
  const projectRoot = await realpath(project.localPath);
  const parent = await realpath(dirname(candidate)).catch(() => {
    throw httpError(404, "Parent directory does not exist");
  });
  if (parent !== projectRoot && !parent.startsWith(`${projectRoot}${sep}`)) {
    throw httpError(403, "Destination is outside the project");
  }
  return { path: candidate, relativePath };
}

function editableTextPath(path) {
  return TEXT_EXTENSIONS.has(extname(path).toLowerCase()) || ["Makefile", "latexmkrc", ".gitignore", ".tex-sync.conf"].includes(basename(path));
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw httpError(413, "Request body is too large");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw httpError(400, "Malformed JSON request");
  }
}

function json(res, status, body, extraHeaders = {}) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": data.length,
    "Cache-Control": "no-store",
    ...extraHeaders,
  });
  res.end(data);
}

function text(res, status, body) {
  const data = Buffer.from(body);
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", "Content-Length": data.length, "Cache-Control": "no-store" });
  res.end(data);
}

function cookies(req) {
  return Object.fromEntries((req.headers.cookie || "").split(";").map((part) => part.trim().split("=")).filter(([key, value]) => key && value));
}

function authenticated(req) {
  return cookies(req)[COOKIE_NAME] === ACCESS_TOKEN;
}

function validateMutationOrigin(req) {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) return;
  const origin = req.headers.origin || "";
  if (origin !== `http://${HOST}:${PORT}` && origin !== `http://localhost:${PORT}`) {
    throw httpError(403, "Invalid request origin");
  }
  if (!String(req.headers["content-type"] || "").startsWith("application/json")) {
    throw httpError(415, "JSON requests are required");
  }
}

async function treeForProject(project) {
  let count = 0;
  async function walk(directory, prefix = "", depth = 0) {
    if (depth > 14 || count > 6000) return [];
    const entries = await readdir(directory, { withFileTypes: true });
    const result = [];
    for (const entry of entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))) {
      if (entry.name.startsWith(".") && ![".gitignore", ".tex-sync.conf"].includes(entry.name)) continue;
      if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) continue;
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const fullPath = join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      count += 1;
      if (entry.isDirectory()) {
        result.push({ name: entry.name, path: relativePath, type: "directory", children: await walk(fullPath, relativePath, depth + 1) });
      } else if (entry.isFile()) {
        const metadata = await stat(fullPath);
        result.push({ name: entry.name, path: relativePath, type: "file", size: metadata.size, editable: editableTextPath(fullPath) && metadata.size <= MAX_TEXT_FILE });
      }
    }
    return result;
  }
  return walk(project.localPath);
}

function command(program, args, cwd, options = {}) {
  const timeout = options.timeout || 30000;
  const maxOutput = options.maxOutput || 2 * 1024 * 1024;
  return new Promise((resolveCommand) => {
    const child = spawn(program, args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, detached: true });
    let stdout = "";
    let stderr = "";
    let truncated = false;
    const append = (current, chunk) => {
      if (current.length >= maxOutput) {
        truncated = true;
        return current;
      }
      const next = current + chunk.toString("utf8");
      if (next.length > maxOutput) {
        truncated = true;
        return next.slice(0, maxOutput);
      }
      return next;
    };
    child.stdout?.on("data", (chunk) => { stdout = append(stdout, chunk); });
    child.stderr?.on("data", (chunk) => { stderr = append(stderr, chunk); });
    const timer = setTimeout(() => {
      try { process.kill(-child.pid, "SIGTERM"); } catch {}
    }, timeout);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolveCommand({ code: 127, stdout, stderr: `${stderr}${error.message}`, truncated, timedOut: false });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolveCommand({ code: code ?? 1, stdout, stderr, truncated, timedOut: signal === "SIGTERM" });
    });
  });
}

async function configValue(project, section, key, fallback = "") {
  const configPath = join(project.localPath, ".tex-sync.conf");
  if (!(await exists(configPath))) return fallback;
  const result = await command("git", ["config", "--file", configPath, "--get", `${section}.${key}`], project.localPath, { timeout: 5000, maxOutput: 10000 });
  return result.code === 0 ? result.stdout.trim() : fallback;
}

async function buildInfo(project) {
  let rootDocument = await configValue(project, "build", "root", project.rootDocument);
  let engine = await configValue(project, "build", "engine", project.engine || "pdflatex");
  if (!rootDocument) {
    const tree = await treeForProject(project);
    const files = [];
    const collect = (nodes) => nodes.forEach((node) => node.type === "directory" ? collect(node.children) : files.push(node));
    collect(tree);
    rootDocument = files.find((file) => file.path.endsWith(".tex"))?.path || "";
  }
  return { rootDocument, engine };
}

async function locatePdf(project) {
  const { rootDocument } = await buildInfo(project);
  if (!rootDocument) return null;
  const pdfName = `${basename(rootDocument, extname(rootDocument))}.pdf`;
  const candidates = [join(project.localPath, ".tex-build", pdfName), join(project.localPath, dirname(rootDocument), pdfName), join(project.localPath, pdfName)];
  for (const candidate of candidates) {
    if (await exists(candidate)) return candidate;
  }
  const buildDirectory = join(project.localPath, ".tex-build");
  async function findNested(directory, depth = 0) {
    if (depth > 4 || !(await exists(directory))) return null;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const candidate = join(directory, entry.name);
      if (entry.isFile() && entry.name === pdfName) return candidate;
      if (entry.isDirectory()) {
        const nested = await findNested(candidate, depth + 1);
        if (nested) return nested;
      }
    }
    return null;
  }
  const nested = await findNested(buildDirectory);
  if (nested) return nested;
  return null;
}

async function buildProject(project) {
  if (builds.has(project.id)) return builds.get(project.id);
  const buildPromise = (async () => {
    const bridge = join(project.localPath, "scripts", "tex-sync");
    let result;
    if (await exists(bridge)) {
      result = await command("bash", [bridge, "build"], project.localPath, { timeout: 240000, maxOutput: 4 * 1024 * 1024 });
    } else {
      const { rootDocument, engine } = await buildInfo(project);
      if (!rootDocument) throw httpError(400, "No root TeX document is configured");
      const args = ["-norc", "-interaction=nonstopmode", "-file-line-error", "-synctex=1", `-outdir=${join(project.localPath, ".tex-build")}`];
      if (engine === "lualatex") args.push("-lualatex");
      else if (engine === "xelatex") args.push("-xelatex");
      else args.push("-pdf");
      args.push(rootDocument);
      await mkdir(join(project.localPath, ".tex-build"), { recursive: true });
      result = await command("latexmk", args, project.localPath, { timeout: 240000, maxOutput: 4 * 1024 * 1024 });
    }
    const pdf = await locatePdf(project);
    return { ...result, output: `${result.stdout}${result.stderr}`, pdfAvailable: Boolean(pdf), compiledAt: new Date().toISOString() };
  })().finally(() => builds.delete(project.id));
  builds.set(project.id, buildPromise);
  return buildPromise;
}

async function gitStatus(project) {
  const statusResult = await command("git", ["status", "--short", "--branch"], project.localPath, { timeout: 8000, maxOutput: 500000 });
  const headResult = await command("git", ["rev-parse", "HEAD"], project.localPath, { timeout: 5000, maxOutput: 10000 });
  const originResult = await command("git", ["remote", "get-url", "origin"], project.localPath, { timeout: 5000, maxOutput: 10000 });
  const { rootDocument, engine } = await buildInfo(project);
  const overleafUrl = await configValue(project, "sync", "overleafProjectUrl", project.overleafUrl);
  const lines = statusResult.stdout.trimEnd().split(/\r?\n/).filter(Boolean);
  return {
    branchLine: lines[0] || "",
    changes: lines.slice(1),
    clean: lines.length <= 1,
    head: headResult.code === 0 ? headResult.stdout.trim() : "",
    rootDocument,
    engine,
    repository: project.repository || (originResult.code === 0 ? originResult.stdout.trim().replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "") : ""),
    overleafUrl,
  };
}

async function searchProject(project, query) {
  const needle = query.trim().toLocaleLowerCase();
  if (needle.length < 2) return [];
  const tree = await treeForProject(project);
  const files = [];
  const collect = (nodes) => nodes.forEach((node) => node.type === "directory" ? collect(node.children) : node.editable && files.push(node.path));
  collect(tree);
  const results = [];
  for (const relativePath of files) {
    if (results.length >= 250) break;
    const fullPath = join(project.localPath, relativePath);
    const content = await readFile(fullPath, "utf8").catch(() => "");
    content.split(/\r?\n/).forEach((line, index) => {
      if (results.length < 250 && line.toLocaleLowerCase().includes(needle)) {
        results.push({ path: relativePath, line: index + 1, preview: line.trim().slice(0, 240) });
      }
    });
  }
  return results;
}

async function serveFile(res, path, options = {}) {
  const metadata = await stat(path).catch(() => null);
  if (!metadata?.isFile()) throw httpError(404, "File not found");
  const headers = {
    "Content-Type": options.contentType || MIME_TYPES[extname(path).toLowerCase()] || "application/octet-stream",
    "Content-Length": metadata.size,
    "Cache-Control": options.cache || "no-store",
    "X-Content-Type-Options": "nosniff",
  };
  if (options.download) headers["Content-Disposition"] = `attachment; filename="${basename(path).replaceAll('"', '')}"`;
  res.writeHead(200, headers);
  createReadStream(path).pipe(res);
}

async function handleApi(req, res, url) {
  if (!authenticated(req)) throw httpError(403, "Authentication required");
  validateMutationOrigin(req);
  if (url.pathname === "/api/projects" && req.method === "GET") {
    const query = (url.searchParams.get("q") || "").toLocaleLowerCase();
    const projects = (await loadProjects()).filter((project) => !query || [project.name, project.repository, project.semanticDomain, project.themes].join(" ").toLocaleLowerCase().includes(query));
    return json(res, 200, { projects: projects.map(({ iconPath, ...project }) => ({ ...project, hasIcon: Boolean(iconPath) })) });
  }
  const match = url.pathname.match(/^\/api\/project\/([a-f0-9]{16})(?:\/(.+))?$/);
  if (!match) throw httpError(404, "Unknown API endpoint");
  const project = await projectById(match[1]);
  const action = match[2] || "";
  if (action === "tree" && req.method === "GET") return json(res, 200, { tree: await treeForProject(project), build: await buildInfo(project) });
  if (action === "icon" && req.method === "GET") {
    if (!project.iconPath || !(await exists(project.iconPath))) throw httpError(404, "Project icon not found");
    return serveFile(res, project.iconPath, { cache: "private, max-age=3600" });
  }
  if (action === "file" && req.method === "GET") {
    const resolved = await resolveExisting(project, url.searchParams.get("path") || "");
    const metadata = await stat(resolved.path);
    if (!metadata.isFile() || !editableTextPath(resolved.path)) throw httpError(415, "This file is not editable as text");
    if (metadata.size > MAX_TEXT_FILE) throw httpError(413, "Text file is too large for the editor");
    return json(res, 200, { path: resolved.relativePath, content: await readFile(resolved.path, "utf8"), mtimeMs: metadata.mtimeMs, size: metadata.size });
  }
  if (action === "file" && req.method === "PUT") {
    const body = await readJson(req);
    const resolved = await resolveExisting(project, body.path || "");
    if (!editableTextPath(resolved.path) || typeof body.content !== "string") throw httpError(415, "Only supported text files can be saved");
    if (Buffer.byteLength(body.content) > MAX_TEXT_FILE) throw httpError(413, "Text file is too large");
    const metadata = await stat(resolved.path);
    if (Number.isFinite(body.expectedMtimeMs) && Math.abs(metadata.mtimeMs - body.expectedMtimeMs) > 1) {
      throw httpError(409, "The file changed on disk; reload before overwriting it");
    }
    const temporary = `${resolved.path}.localtex-${process.pid}-${Date.now()}`;
    await writeFile(temporary, body.content, { encoding: "utf8", mode: metadata.mode });
    await rename(temporary, resolved.path);
    const saved = await stat(resolved.path);
    return json(res, 200, { path: resolved.relativePath, mtimeMs: saved.mtimeMs, size: saved.size });
  }
  if (action === "files" && req.method === "POST") {
    const body = await readJson(req);
    const resolved = await resolveCreatable(project, body.path || "");
    if (await exists(resolved.path)) throw httpError(409, "A file or folder already exists at that path");
    if (body.type === "directory") await mkdir(resolved.path);
    else if (body.type === "file" && editableTextPath(resolved.path)) await writeFile(resolved.path, "", { flag: "wx" });
    else throw httpError(415, "Unsupported file type");
    return json(res, 201, { path: resolved.relativePath, type: body.type });
  }
  if (action === "status" && req.method === "GET") return json(res, 200, await gitStatus(project));
  if (action === "search" && req.method === "GET") return json(res, 200, { results: await searchProject(project, url.searchParams.get("q") || "") });
  if (action === "build" && req.method === "POST") return json(res, 200, await buildProject(project));
  if (action === "pdf-info" && req.method === "GET") {
    const pdf = await locatePdf(project);
    return json(res, 200, { available: Boolean(pdf), name: pdf ? basename(pdf) : "" });
  }
  if (action === "pdf" && req.method === "GET") {
    const pdf = await locatePdf(project);
    if (!pdf) throw httpError(404, "Compile the project to create a PDF");
    res.setHeader("X-Frame-Options", "SAMEORIGIN");
    res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'self'");
    return serveFile(res, pdf, { contentType: "application/pdf", download: url.searchParams.get("download") === "1" });
  }
  if (action === "sync" && req.method === "POST") {
    const body = await readJson(req);
    if (!(await exists(join(project.localPath, "scripts", "tex-sync")))) throw httpError(400, "This project has no synchronization bridge");
    if (!["pull", "push"].includes(body.action)) throw httpError(400, "Sync action must be pull or push");
    const result = await command("bash", [join(project.localPath, "scripts", "tex-sync"), body.action], project.localPath, { timeout: 240000, maxOutput: 3 * 1024 * 1024 });
    return json(res, result.code === 0 ? 200 : 409, { ...result, output: `${result.stdout}${result.stderr}` });
  }
  if (action === "open-texstudio" && req.method === "POST") {
    const { rootDocument } = await buildInfo(project);
    if (!rootDocument) throw httpError(400, "No root TeX document is configured");
    const launcher = "/home/George/.local/bin/texstudio-overleaf";
    const child = spawn(launcher, [join(project.localPath, rootDocument)], { cwd: project.localPath, detached: true, stdio: "ignore" });
    child.unref();
    return json(res, 202, { opened: true, rootDocument });
  }
  throw httpError(404, "Unknown project action");
}

async function handleStatic(req, res, url) {
  if (url.pathname === "/") {
    if (url.searchParams.get("token") !== ACCESS_TOKEN) throw httpError(403, "Launch LocalTeX Studio from its desktop entry");
    const requestedProject = (url.searchParams.get("project") || "").replace(/[^A-Za-z0-9._-]/g, "");
    res.writeHead(302, {
      Location: requestedProject ? `/app?project=${encodeURIComponent(requestedProject)}` : "/app",
      "Set-Cookie": `${COOKIE_NAME}=${ACCESS_TOKEN}; HttpOnly; SameSite=Strict; Path=/`,
      "Cache-Control": "no-store",
    });
    return res.end();
  }
  if (!authenticated(req)) throw httpError(403, "Authentication required");
  let relativePath = url.pathname === "/app" ? "index.html" : url.pathname.replace(/^\//, "");
  relativePath = normalize(relativePath);
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) throw httpError(403, "Invalid static path");
  const path = resolve(DIST_ROOT, relativePath);
  if (path !== DIST_ROOT && !path.startsWith(`${DIST_ROOT}${sep}`)) throw httpError(403, "Invalid static path");
  return serveFile(res, path, { cache: relativePath.startsWith("assets/") ? "private, max-age=31536000, immutable" : "no-store" });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${HOST}:${PORT}`);
  try {
    res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; frame-src 'self'; connect-src 'self'; object-src 'self'; frame-ancestors 'none'");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    if (url.pathname === "/api/health") return json(res, 200, { ok: true, app: "LocalTeX Studio", version: "0.1.0", libraryRoot: LIBRARY_ROOT });
    if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url);
    return await handleStatic(req, res, url);
  } catch (error) {
    const status = Number(error.status) || 500;
    if (url.pathname.startsWith("/api/")) return json(res, status, { error: error.message || "Internal error" });
    return text(res, status, error.message || "Internal error");
  }
});

server.listen(PORT, HOST, async () => {
  const projects = await loadProjects().catch(() => []);
  process.stdout.write(`${JSON.stringify({ ready: true, host: HOST, port: PORT, token: ACCESS_TOKEN, projects: projects.length })}\n`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
