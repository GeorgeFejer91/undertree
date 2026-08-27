import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

async function texLiveCandidates(root) {
  if (!root || !existsSync(root)) return [];
  const direct = join(root, "bin", "windows", "latexmk.exe");
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  return [direct, ...entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(root, entry.name, "bin", "windows", "latexmk.exe"))];
}

async function rememberLatexmk(toolchainFile, latexmk, source) {
  await mkdir(join(toolchainFile, ".."), { recursive: true });
  await writeFile(toolchainFile, `${JSON.stringify({ latexmk, source, detectedAt: new Date().toISOString() }, null, 2)}\n`, "utf8");
}

export async function resolveLatexmk({ stateRoot, env = process.env, platform = process.platform } = {}) {
  if (!stateRoot) throw new TypeError("stateRoot is required");
  const toolchainFile = join(stateRoot, "tex-toolchain.json");
  const configured = env.UNDERTREE_LATEXMK || env.LOCALTEX_LATEXMK;
  if (configured && existsSync(configured)) {
    await rememberLatexmk(toolchainFile, configured, "environment");
    return configured;
  }
  if (platform !== "win32") return "latexmk";

  const cached = await readFile(toolchainFile, "utf8").then(JSON.parse).catch(() => null);
  if (cached?.latexmk && existsSync(cached.latexmk)) return cached.latexmk;

  const discoveredOnPath = spawnSync("where.exe", ["latexmk.exe"], {
    encoding: "utf8",
    windowsHide: true,
    env,
  });
  const pathCandidate = String(discoveredOnPath.stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((candidate) => existsSync(candidate));
  const home = env.USERPROFILE || homedir();
  const driveRoots = ["C:", "D:", "E:", "F:"].map((drive) => join(drive, "texlive"));
  const candidates = [
    pathCandidate,
    join(env.LOCALAPPDATA || "", "Programs", "MiKTeX", "miktex", "bin", "x64", "latexmk.exe"),
    join(env.ProgramFiles || "", "MiKTeX", "miktex", "bin", "x64", "latexmk.exe"),
    join(env["ProgramFiles(x86)"] || "", "MiKTeX", "miktex", "bin", "x64", "latexmk.exe"),
    ...(await texLiveCandidates(env.TEXLIVE_ROOT)),
    ...(await texLiveCandidates(join(env.SystemDrive || "C:", "texlive"))),
    ...(await texLiveCandidates(join(home, "texlive"))),
    ...(await Promise.all(driveRoots.map(texLiveCandidates))).flat(),
  ];
  const latexmk = candidates.find((candidate) => candidate && existsSync(candidate)) || "latexmk";
  if (latexmk !== "latexmk") await rememberLatexmk(toolchainFile, latexmk, pathCandidate === latexmk ? "PATH" : "filesystem search");
  return latexmk;
}
