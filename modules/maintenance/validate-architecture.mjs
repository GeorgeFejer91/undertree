import { readdir, readFile, stat } from "node:fs/promises";
import { resolve, extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("../../", import.meta.url)));

async function filesBelow(root) {
  const files = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) files.push(path);
    }
  }
  await walk(root);
  return files;
}

export async function architectureErrors(root = repositoryRoot) {
  const errors = [];
  for (const path of await filesBelow(join(root, "For-AI"))) {
    if (extname(path).toLowerCase() !== ".md") errors.push(`For-AI must remain Markdown-only: ${relative(root, path)}`);
  }
  for (const required of [
    "AGENTS.md", "For-AI/README.md", "For-AI/constraints.md", "For-AI/module-map.md", "For-AI/workflows.md",
    "For-AI/product-goal.md", "For-AI/skills.md", "For-AI/reference-evidence.md", "For-AI/overleaf-ui-parity.md", "For-AI/ui-layout.md",
    "modules/frontend/README.md", "modules/compiler/README.md", "modules/compiler/server-process.mjs",
    "modules/maintenance/runtime-package-policy.json",
    "Cargo.toml", "modules/review/README.md", "modules/review/Cargo.toml",
    "modules/review/src/document.rs", "modules/review/src/service.rs", "modules/review/src/transport.rs",
    "modules/review/src/publishing.rs", "modules/review/src/tex_import.rs",
    "native/tauri/Cargo.toml", "native/tauri/src/main.rs", "native/tauri/tauri.conf.json",
    "native/tauri/capabilities/main.json", "native/tauri/permissions/review.toml", "manuscript.html",
  ]) {
    if (!(await stat(join(root, required)).catch(() => null))) errors.push(`Required architecture asset is missing: ${required}`);
  }

  const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const packageLock = JSON.parse(await readFile(join(root, "package-lock.json"), "utf8"));
  const dependencies = { ...packageJson.dependencies, ...packageJson.devDependencies, ...packageJson.optionalDependencies };
  if (Object.keys(dependencies).some(name => /^(?:electron(?:-|$)|@electron\/)/.test(name))
    || Object.keys(packageLock.packages || {}).some(path => /(?:^|\/)node_modules\/(?:electron(?:-|$)|@electron\/)/.test(path))
    || packageJson.main?.startsWith("native/windows/")
    || Object.values(packageJson.scripts || {}).some(command => /\belectron(?:-builder)?\b/.test(command))
    || packageJson.build?.appId) {
    errors.push("The product stack is Rust/Tauri/HTML/CSS/Typst; Electron dependencies, entrypoints and packaging are forbidden");
  }
  const runtimePolicy = JSON.parse(await readFile(join(root, "modules/maintenance/runtime-package-policy.json"), "utf8"));
  const portableRuntime = JSON.parse(await readFile(join(root, "packaging/runtime/package.json"), "utf8"));
  if (portableRuntime.version !== packageJson.version || portableRuntime.engines?.node !== packageJson.engines?.node) {
    errors.push("The portable legacy runtime version and Node requirement must match package.json");
  }
  if (Object.keys(portableRuntime.dependencies || {}).sort().join() !== [...runtimePolicy.runtimeNodePackages].sort().join()) {
    errors.push("The portable release dependencies must match the runtime package policy");
  }
  for (const runtimeRoot of runtimePolicy.runtimeRoots) {
    if (relative(join(root, "For-AI"), resolve(root, runtimeRoot)).split(/[\\/]/)[0] !== "..") {
      errors.push(`For-AI cannot be a runtime root: ${runtimeRoot}`);
    }
  }
  const frontend = await readFile(join(root, "src/main.js"), "utf8");
  if (!frontend.includes("LatestCompileScheduler")) errors.push("The frontend adapter must use the latest-state compile scheduler");

  const workspace = await readFile(join(root, "Cargo.toml"), "utf8");
  for (const member of ["modules/review", "native/tauri"]) {
    if (!workspace.includes(`"${member}"`)) errors.push(`The Rust workspace must include ${member}`);
  }
  const native = JSON.parse(await readFile(join(root, "native/tauri/tauri.conf.json"), "utf8"));
  if (native.build?.frontendDist !== "../../dist") errors.push("Tauri must serve the compiled frontend from dist");
  if (!native.app?.windows?.some(window => window.label === "main" && window.url === "manuscript.html")) {
    errors.push("Tauri must launch the bundled manuscript workspace");
  }
  const csp = native.app?.security?.csp || "";
  if (/https?:\/\/|\*/.test(csp.replaceAll("http://ipc.localhost", ""))) {
    errors.push("The Tauri manuscript CSP must not grant remote or wildcard origins");
  }
  const capability = JSON.parse(await readFile(join(root, "native/tauri/capabilities/main.json"), "utf8"));
  if (capability.remote || capability.windows?.join() !== "main") errors.push("Review capabilities must apply only to the local main window");
  const allowedPermissions = ["core:default", "core:window:allow-close", "core:window:allow-minimize", "core:window:allow-start-dragging", "core:window:allow-toggle-maximize", "allow-review-action", "allow-word-count", "allow-editor-operation", "allow-control-operation", "allow-choose-project", "allow-file-import", "allow-project-export", "core:window:allow-maximize", "core:window:allow-unmaximize", "core:window:allow-unminimize", "core:window:allow-set-focus"];
  if (capability.permissions?.some(permission => !allowedPermissions.includes(permission))) {
    errors.push("Tauri must not add generic shell, filesystem or remote review capabilities");
  }

  // Static boundary guards complement the Rust behavior tests; they do not prove authorization semantics.
  const transport = await readFile(join(root, "modules/review/src/transport.rs"), "utf8");
  const catalogue = transport.slice(transport.indexOf("pub fn tool_catalogue"), transport.indexOf("fn same_secret"));
  const tools = [...catalogue.matchAll(/"name"\s*:\s*"([^"]+)"/g)].map(match => match[1]).sort();
  if (tools.join() !== "list_manuscripts,read_manuscript,suggest_text") {
    errors.push("The agent MCP catalogue must contain exactly list/read/suggest tools");
  }
  const reviewPolicy = await readFile(join(root, "modules/review/src/document.rs"), "utf8");
  if (!reviewPolicy.includes("pub fn policy") || [...reviewPolicy.matchAll(/self\.policy\(/g)].length < 2) {
    errors.push("Rust must recheck review policy at proposal submission and acceptance");
  }
  return errors;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const errors = await architectureErrors();
  if (errors.length) {
    for (const error of errors) process.stderr.write(`architecture: ${error}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write("Architecture boundaries verified.\n");
  }
}
