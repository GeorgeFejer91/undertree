#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import process from "node:process";
import packageMetadata from "./package.json" with { type: "json" };

const PORT = Number(process.env.UNDERTREE_PORT || 37371);
const ORIGIN = process.env.UNDERTREE_ORIGIN || `http://127.0.0.1:${PORT}`;
const argv = process.argv.slice(2);
const flags = new Map();
const positional = [];
for (let index = 0; index < argv.length; index += 1) {
  const arg = argv[index];
  if (!arg.startsWith("--")) { positional.push(arg); continue; }
  const [name, inline] = arg.slice(2).split(/=(.*)/s, 2);
  if (inline !== undefined) flags.set(name, inline);
  else if (argv[index + 1] && !argv[index + 1].startsWith("--")) flags.set(name, argv[++index]);
  else flags.set(name, true);
}

const command = positional.shift() || "help";
const pretty = flags.has("pretty");

function print(value) {
  if (typeof value === "string") process.stdout.write(`${value}\n`);
  else process.stdout.write(`${JSON.stringify(value, null, pretty ? 2 : 0)}\n`);
}

function stateRoot() {
  if (process.env.UNDERTREE_USER_DATA) return resolve(process.env.UNDERTREE_USER_DATA);
  if (process.platform === "win32") return join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "undertree");
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "undertree");
}

async function token() {
  if (process.env.UNDERTREE_TOKEN) return process.env.UNDERTREE_TOKEN.trim();
  return (await readFile(join(stateRoot(), "config", "token"), "utf8")).trim();
}

function appExecutable() {
  const candidates = process.platform === "win32"
    ? [
      process.execPath.toLowerCase().endsWith("undertree.exe") ? process.execPath : "",
      join(process.env.LOCALAPPDATA || "", "Programs", "UnderTree", "UnderTree.exe"),
    ]
    : ["undertree"];
  return candidates.find((candidate) => candidate && (process.platform !== "win32" || existsSync(candidate))) || "";
}

async function health() {
  const response = await fetch(`${ORIGIN}/api/health`, { signal: AbortSignal.timeout(1500) });
  if (!response.ok) throw new Error(`UnderTree health check failed (${response.status})`);
  return response.json();
}

async function ensureServer() {
  try { return await health(); } catch (initialError) {
    if (flags.has("no-start")) throw initialError;
    const executable = appExecutable();
    if (!executable) throw new Error("UnderTree is not running and its desktop executable could not be found.");
    const environment = { ...process.env };
    delete environment.ELECTRON_RUN_AS_NODE;
    const child = spawn(executable, [], { detached: true, stdio: "ignore", env: environment, windowsHide: true });
    child.unref();
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 250));
      try { return await health(); } catch {}
    }
    throw new Error("UnderTree was launched, but its automation service did not become ready within 15 seconds.");
  }
}

class ApiError extends Error {
  constructor(status, message, details = null) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

async function api(method, path, body, { binary = false } = {}) {
  await ensureServer();
  const accessToken = await token();
  const response = await fetch(`${ORIGIN}${path}`, {
    method,
    headers: {
      Cookie: `localtex_session=${accessToken}`,
      Origin: ORIGIN,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text();
    let details = null;
    try { details = JSON.parse(text); } catch {}
    throw new ApiError(response.status, details?.error || text || `API request failed (${response.status})`, details);
  }
  if (binary) return { data: Buffer.from(await response.arrayBuffer()), headers: Object.fromEntries(response.headers.entries()) };
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

async function projects() {
  return (await api("GET", "/api/projects")).projects;
}

async function resolveProject(reference) {
  if (!reference) throw new Error("A project id, name, or local path is required.");
  const available = await projects();
  const normalized = resolve(reference).toLowerCase();
  const matches = available.filter((project) => project.id === reference
    || project.name.toLowerCase() === reference.toLowerCase()
    || project.localPath.toLowerCase() === reference.toLowerCase()
    || project.localPath.toLowerCase() === normalized);
  if (matches.length !== 1) throw new Error(matches.length ? `Project reference is ambiguous: ${reference}` : `Unknown project: ${reference}`);
  return matches[0];
}

function projectPath(id, action, query = {}) {
  const suffix = action ? `/${action}` : "";
  const params = new URLSearchParams(Object.entries(query).filter(([, value]) => value !== undefined && value !== ""));
  return `/api/project/${id}${suffix}${params.size ? `?${params}` : ""}`;
}

async function stdinText() {
  if (process.stdin.isTTY) return "";
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

const COMMANDS = {
  health: "Show service and version information",
  "render-html": "Render a local HTML print profile: render-html <source.html> --pdf FILE [--tex FILE]",
  projects: "List remembered projects",
  "project-add": "Add a folder: project-add <folder> [--name NAME]",
  tree: "Read project tree and build settings: tree <project>",
  status: "Read Git/build status: status <project>",
  search: "Search files: search <project> <query>",
  read: "Read a project file: read <project> <path>",
  write: "Write a project file: write <project> <path> [--content TEXT|stdin]",
  create: "Create file/folder: create <project> <path> [--type file|directory]",
  rename: "Rename/move entry: rename <project> <path> <new-path>",
  duplicate: "Duplicate entry with an automatic copy name: duplicate <project> <path>",
  delete: "Delete an entry: delete <project> <path>",
  reveal: "Reveal an entry in the OS file manager: reveal <project> <path>",
  build: "Compile one source: build <project> [source.tex] [--clean]",
  "build-all": "Compile every standalone TeX source into .tex-build: build-all <project>",
  "pdf-info": "Inspect cached PDF: pdf-info <project> [source.tex]",
  "pdf-save": "Save cached PDF: pdf-save <project> <source.tex> --output FILE",
  "pdf-bundle": "Compile/cache all PDFs and save ZIP: pdf-bundle <project> --output FILE",
  sync: "Synchronize: sync <project> github|overleaf",
  api: "Raw local API request: api METHOD /api/path [--data JSON] [--output FILE]",
};

async function main() {
  if (["help", "commands"].includes(command)) {
    print({ executable: "undertree", version: packageMetadata.version, output: "JSON on stdout; errors as JSON on stderr", commands: COMMANDS });
    return;
  }
  if (!Object.hasOwn(COMMANDS, command)) throw new Error(`Unknown command: ${command}. Run undertree help.`);
  if (command === "render-html") {
    const source = positional[0];
    const pdf = flags.get("pdf");
    const tex = flags.get("tex");
    if (positional.length !== 1 || !source || typeof pdf !== "string" || !pdf.trim()
      || (flags.has("tex") && (typeof tex !== "string" || !tex.trim()))) {
      throw new Error("Usage: undertree render-html <source.html> --pdf FILE [--tex FILE]");
    }
    const sourcePath = resolve(source);
    const pdfPath = resolve(pdf);
    const texPath = tex ? resolve(tex) : "";
    if (pdfPath === sourcePath || texPath === sourcePath || pdfPath === texPath) {
      throw new Error("Render outputs must be different from the source and each other.");
    }
    if (texPath) await mkdir(dirname(texPath), { recursive: true });
    const { renderHtmlPrint } = await import("./src/html-renderer.mjs");
    return print(await renderHtmlPrint({ sourcePath, projectRoot: dirname(sourcePath), pdfPath, texPath, persistFits: false }));
  }
  if (command === "health") return print(await ensureServer());
  if (command === "projects") return print({ projects: await projects() });
  if (command === "project-add") {
    const folder = positional[0];
    if (!folder) throw new Error("Usage: undertree project-add <folder> [--name NAME]");
    return print(await api("POST", "/api/projects/bridge", { localPath: resolve(folder), name: flags.get("name") || basename(resolve(folder)) }));
  }
  if (command === "api") {
    const method = String(positional[0] || "GET").toUpperCase();
    const path = positional[1];
    if (!path?.startsWith("/api/")) throw new Error("Raw API paths must start with /api/.");
    const data = flags.has("data") ? JSON.parse(String(flags.get("data"))) : undefined;
    if (flags.has("output")) {
      const result = await api(method, path, data, { binary: true });
      const output = resolve(String(flags.get("output")));
      await mkdir(dirname(output), { recursive: true });
      await writeFile(output, result.data);
      return print({ ok: true, output, bytes: result.data.length, headers: result.headers });
    }
    return print(await api(method, path, data));
  }

  const project = await resolveProject(positional.shift());
  if (command === "tree") return print(await api("GET", projectPath(project.id, "tree")));
  if (command === "status") return print(await api("GET", projectPath(project.id, "status")));
  if (command === "search") return print(await api("GET", projectPath(project.id, "search", { q: positional.join(" ") })));
  if (command === "read") return print(await api("GET", projectPath(project.id, "file", { path: positional[0] })));
  if (command === "write") {
    const path = positional[0];
    const content = flags.has("content") ? String(flags.get("content")) : await stdinText();
    return print(await api("PUT", projectPath(project.id, "file"), { path, content }));
  }
  if (command === "create") return print(await api("POST", projectPath(project.id, "files"), { path: positional[0], type: flags.get("type") || "file" }));
  if (command === "rename") return print(await api("PATCH", projectPath(project.id, "entry"), { path: positional[0], newPath: positional[1] }));
  if (command === "duplicate") return print(await api("POST", projectPath(project.id, "entry/duplicate"), { path: positional[0] }));
  if (command === "delete") return print(await api("DELETE", projectPath(project.id, "entry"), { path: positional[0] }));
  if (command === "reveal") return print(await api("POST", projectPath(project.id, "entry/reveal"), { path: positional[0] }));
  if (command === "build") {
    const result = await api("POST", projectPath(project.id, "build"), { sourcePath: positional[0] || "", clean: flags.has("clean") });
    print(result);
    if (result.code !== 0 || !result.pdfAvailable) process.exitCode = result.code || 2;
    return;
  }
  if (command === "build-all") {
    const result = await api("POST", projectPath(project.id, "build-all"), {});
    print(result);
    if (result.failed) process.exitCode = 2;
    return;
  }
  if (command === "pdf-info") return print(await api("GET", projectPath(project.id, "pdf-info", { sourcePath: positional[0] || "" })));
  if (["pdf-save", "pdf-bundle"].includes(command)) {
    const outputFlag = flags.get("output");
    if (!outputFlag) throw new Error(`Usage: undertree ${command} <project>${command === "pdf-save" ? " <source.tex>" : ""} --output FILE`);
    const endpoint = command === "pdf-save"
      ? projectPath(project.id, "pdf", { sourcePath: positional[0] || "", download: "1" })
      : projectPath(project.id, "pdf-bundle");
    const result = await api(command === "pdf-save" ? "GET" : "POST", endpoint, command === "pdf-save" ? undefined : {}, { binary: true });
    const output = resolve(String(outputFlag));
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, result.data);
    return print({ ok: true, output, bytes: result.data.length, headers: result.headers });
  }
  if (command === "sync") {
    const target = positional[0];
    if (!["github", "overleaf"].includes(target)) throw new Error("Sync target must be github or overleaf.");
    const result = await api("POST", projectPath(project.id, "sync"), { action: target });
    print(result);
    if (result.code !== 0) process.exitCode = result.code || 2;
    return;
  }
}

main().catch((error) => {
  const payload = { ok: false, error: error.message, status: error.status || null, details: error.details || null };
  process.stderr.write(`${JSON.stringify(payload, null, pretty ? 2 : 0)}\n`);
  process.exitCode = error.status && error.status < 500 ? 2 : 1;
});
