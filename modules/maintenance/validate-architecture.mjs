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
    "modules/frontend/README.md", "modules/compiler/README.md", "modules/compiler/server-process.mjs",
    "modules/maintenance/runtime-package-policy.json",
  ]) {
    if (!(await stat(join(root, required)).catch(() => null))) errors.push(`Required architecture asset is missing: ${required}`);
  }

  const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const packagedFiles = packageJson.build?.files || [];
  if (!packagedFiles.includes("modules/compiler/**/*.mjs")) errors.push("The packaged compiler service module is missing from build.files");
  for (const excluded of ["@openai", "@napi-rs", "@codemirror", "@tiptap", "codemirror", "pdfjs-dist"]) {
    if (!packagedFiles.includes(`!node_modules/${excluded}/**/*`)) errors.push(`Runtime package exclusion is missing for ${excluded}`);
  }

  const mainProcess = await readFile(join(root, "native/windows/main.cjs"), "utf8");
  if (!mainProcess.includes("utilityProcess.fork")) errors.push("Windows must host the compiler service in an Electron utility process");
  const frontend = await readFile(join(root, "src/main.js"), "utf8");
  if (!frontend.includes("LatestCompileScheduler")) errors.push("The frontend adapter must use the latest-state compile scheduler");
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
