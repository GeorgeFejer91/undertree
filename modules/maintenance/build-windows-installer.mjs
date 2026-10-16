import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

assert.equal(process.platform, 'win32', 'Build the Windows installer on Windows.');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const native = join(root, 'native/tauri');
const notices = join(native, 'notices-windows');
const record = join(root, 'artifacts/windows-release', new Date().toISOString().replaceAll(/[:.]/g, '-'));
mkdirSync(record, { recursive: true });

function run(program, args, capture = false, cwd = root) {
  const result = spawnSync(program, args, {
    cwd, env: { ...process.env, UNDERTREE_NOTICES_DIR: notices },
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${program} ${args.join(' ')} failed.`);
  return result.stdout;
}

run(process.execPath, ['modules/maintenance/validate-architecture.mjs']);
run(process.execPath, ['modules/maintenance/generate-notices.mjs', '--check']);
const host = run('rustc', ['--version', '--verbose'], true).match(/^host: (.+)$/m)?.[1].trim();
assert.match(host, /^(?:x86_64|aarch64)-pc-windows-msvc$/, 'Use a native Windows MSVC toolchain.');
assert.equal(JSON.parse(readFileSync(join(notices, 'manifest.json'), 'utf8')).target, host,
  'Dependency notices must describe this exact Rust target.');
assert.ok(!process.env.CARGO_BUILD_TARGET || process.env.CARGO_BUILD_TARGET === host, 'Cross-target packaging is not supported.');
const metadata = JSON.parse(run('cargo', ['metadata', '--locked', '--no-deps', '--format-version', '1'], true));
const messages = run('cargo', ['build', '--locked', '--release', '-p', 'undertree-review',
  '-p', 'undertree-desktop', '--bin', 'undertree-review', '--features', 'tauri/custom-protocol',
  '--message-format=json-render-diagnostics'], true);
writeFileSync(join(record, 'cli-artifacts.jsonl'), messages);
const artifacts = messages.trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
assert.equal(artifacts.findLast(message => message.reason === 'build-finished')?.success, true);
const executables = new Set(artifacts.filter(message => message.reason === 'compiler-artifact'
  && message.target?.name === 'undertree-review' && message.target?.kind?.includes('bin')
  && message.executable).map(message => resolve(message.executable)));
assert.equal(executables.size, 1, 'Cargo must report the exact CLI executable.');
const [cli] = executables;
const release = dirname(cli);
assert.ok([join(metadata.target_directory, 'release'), join(metadata.target_directory, host, 'release')].includes(release));
const overlay = JSON.parse(readFileSync(join(native, 'tauri.windows.installer.conf.json'), 'utf8'));
overlay.bundle.resources = { [cli]: 'undertree-review.exe', [join(root, 'README.md')]: 'README.md' };
for (const name of ['THIRD-PARTY-RUST.md', 'THIRD-PARTY-JAVASCRIPT.md', 'manifest.json']) {
  overlay.bundle.resources[join(notices, name)] = `notices/${name}`;
}
for (const path of Object.keys(overlay.bundle.resources)) assert.ok(statSync(path).isFile(), `Missing installer resource: ${path}`);
const config = join(record, 'tauri.windows.json');
writeFileSync(config, JSON.stringify(overlay, null, 2) + '\n');
const started = Date.now();
run(process.execPath, [join(root, 'node_modules/@tauri-apps/cli/tauri.js'), 'build',
  '--config', config, '--bundles', 'nsis', '--ci', '--no-sign', '--', '--locked'], false, native);
const app = JSON.parse(readFileSync(join(native, 'tauri.conf.json'), 'utf8'));
const architecture = host.startsWith('x86_64') ? 'x64' : 'arm64';
const installer = join(release, 'bundle/nsis', `${app.productName}_${app.version}_${architecture}-setup.exe`);
assert.ok(statSync(installer).mtimeMs >= started - 1000, 'The exact current-version installer must have been rebuilt.');
const fingerprint = path => ({ path, bytes: statSync(path).size,
  sha256: createHash('sha256').update(readFileSync(path)).digest('hex') });
writeFileSync(join(record, 'receipt.json'), JSON.stringify({ host, version: app.version,
  builtAt: new Date().toISOString(), signed: false, installer: fingerprint(installer),
  desktop: fingerprint(join(release, 'undertree-desktop.exe')), cli: fingerprint(cli),
  config: fingerprint(config) }, null, 2) + '\n');
console.log(`Windows installer: ${installer}`);
