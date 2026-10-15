import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { readNativeReleaseReceipt, validateNativeReleaseReceipt } from './native-release-receipt.mjs';

const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const hash = async path => createHash('sha256').update(await readFile(path)).digest('hex');
const config = JSON.parse(await readFile(join(root, 'native/tauri/tauri.conf.json'), 'utf8'));
const releaseReceipt = resolve(process.env.UNDERTREE_NATIVE_RELEASE_RECEIPT || join(root, 'artifacts/native-release/latest.json'));
const releaseReceiptSha256 = await hash(releaseReceipt);
const build = await readNativeReleaseReceipt(root, releaseReceipt);
if (!process.argv[2]) assert.equal(build.packages.length, 1, 'Choose an explicit recorded archive when the build contains multiple packages.');
const archive = process.argv[2] ? resolve(process.argv[2]) : build.packages[0].path;
assert.ok(build.packages.some(item => resolve(item.path) === archive), 'The archive must belong to this completed native build.');
const extracted = await mkdtemp(join(tmpdir(), 'undertree-native-package-'));
const artifacts = resolve(process.env.UNDERTREE_NATIVE_PACKAGE_ARTIFACTS || join(root, 'artifacts/native-package'));
const nativeUiRunner = resolve(process.env.UNDERTREE_NATIVE_UI_RUNNER || join(root, 'tests/native-ui-smoke.mjs'));
const nativeAppRunner = resolve(process.env.UNDERTREE_NATIVE_APP_RUNNER || join(root, 'tests/native-app-controls-smoke.mjs'));
const nativePublishingRunner = resolve(process.env.UNDERTREE_NATIVE_PUBLISHING_RUNNER || join(root, 'tests/native-publishing-smoke.mjs'));
const nativeImportRunner = resolve(process.env.UNDERTREE_NATIVE_IMPORT_RUNNER || join(root, 'tests/native-import-smoke.mjs'));
const nativeProjectExportRunner = resolve(process.env.UNDERTREE_NATIVE_PROJECT_EXPORT_RUNNER || join(root, 'tests/native-project-export-smoke.mjs'));
const nativeProjectExportEpochRunner = resolve(process.env.UNDERTREE_NATIVE_PROJECT_EXPORT_EPOCH_RUNNER || join(root, 'tests/native-project-export-epoch-smoke.mjs'));
const nativeCloseRunner = resolve(process.env.UNDERTREE_NATIVE_CLOSE_RUNNER || join(root, 'tests/native-close-ack-smoke.mjs'));
const field = async name => (await exec('dpkg-deb', ['--field', archive, name])).stdout.trim();

try {
  assert.equal(await field('Version'), config.version);
  assert.equal(await field('Maintainer'), 'GeorgeFejer91');
  assert.match(await field('Description'), /Offline Typst manuscript and review workspace/);
  const dependencies = await field('Depends');
  for (const dependency of ['curl', 'libwebkit2gtk-4.1-0', 'libgtk-3-0']) assert.ok(dependencies.split(',').some(value => value.trim().split(' ')[0] === dependency), `Missing runtime dependency: ${dependency}`);
  assert.equal(await field('Recommends'), 'git');
  const inventory = (await exec('dpkg-deb', ['--contents', archive])).stdout;
  assert.doesNotMatch(inventory, /For-AI|node_modules|electron|app\.asar|\/target\/|\/typst(?:\s|$)|latexmk|texlive|miktex/i, 'The desktop package excludes Electron, orchestration, development content and external compiler binaries.');
  await exec('dpkg-deb', ['--extract', archive, extracted]);
  const desktop = join(extracted, 'usr/bin/undertree-desktop');
  const cli = join(extracted, 'usr/bin/undertree-review');
  let desktopTransformation = 'identical';
  for (const [path, name, source] of [[desktop, 'undertree-desktop', build.desktop], [cli, 'undertree-review', build.cli]]) {
    assert.ok((await stat(path)).mode & 0o111, `Packaged ${name} is executable.`);
    const packaged = await readFile(path), built = await readFile(source);
    if (name === 'undertree-desktop' && !packaged.equals(built)) {
      // Tauri patches this one marker per bundle, then restores the build output.
      // https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.12.3/crates/tauri-bundler/src/bundle.rs
      const marker = Buffer.from('__TAURI_BUNDLE_TYPE_VAR_UNK');
      const offset = built.indexOf(marker);
      assert.ok(offset >= 0 && offset === built.lastIndexOf(marker), 'The release binary has exactly one Tauri bundle marker.');
      const expected = Buffer.from(built);
      Buffer.from('__TAURI_BUNDLE_TYPE_VAR_DEB').copy(expected, offset);
      assert.ok(packaged.equals(expected), 'The packaged desktop differs only by the exact Tauri Debian marker.');
      desktopTransformation = '__TAURI_BUNDLE_TYPE_VAR_UNK → __TAURI_BUNDLE_TYPE_VAR_DEB';
    } else assert.ok(packaged.equals(built), `Packaged ${name} is the verified release binary.`);
  }
  const entry = await readFile(join(extracted, 'usr/share/applications/UnderTree.desktop'), 'utf8');
  assert.match(entry, /^Exec=undertree-desktop$/m);
  assert.match(entry, /^Categories=.*Office/m);
  await stat(join(extracted, 'usr/share/icons/hicolor/256x256/apps/undertree-desktop.png'));
  assert.match(await readFile(join(extracted, 'usr/share/doc/under-tree/README.md'), 'utf8'), /Install Typst(?:\s+\d+\.\d+(?:\.\d+)?)?\s+separately/);
  const attribution = JSON.parse(await readFile(join(root, 'native/tauri/notices/manifest.json'), 'utf8'));
  for (const [source, destination] of [
    ['README.md', 'README.md'],
    ['native/tauri/notices/THIRD-PARTY-RUST.md', 'THIRD-PARTY-RUST.md'],
    ['native/tauri/notices/THIRD-PARTY-JAVASCRIPT.md', 'THIRD-PARTY-JAVASCRIPT.md'],
    ['native/tauri/notices/manifest.json', 'notices-manifest.json'],
  ]) {
    assert.equal(await hash(join(extracted, 'usr/share/doc/under-tree', destination)), build.inputs[source], `Packaged attribution/document changed: ${destination}`);
  }
  for (const file of ['THIRD-PARTY-RUST.md', 'THIRD-PARTY-JAVASCRIPT.md'])
    assert.equal(await hash(join(extracted, 'usr/share/doc/under-tree', file)), attribution.outputs[file], `Notice manifest mismatch: ${file}`);
  const offlineEnvironment = { ...process.env, UNDERTREE_REVIEW_STATE: join(extracted, 'no-running-instance') };
  delete offlineEnvironment.UNDERTREE_REVIEW_ENDPOINT;
  delete offlineEnvironment.UNDERTREE_REVIEW_TOKEN;
  const help = await exec(cli, ['--help'], { env: offlineEnvironment, timeout: 5000 });
  assert.ok(help.stdout.includes(config.version), 'The packaged CLI reports the desktop version.');
  assert.match(help.stdout, /capabilities/);
  await assert.rejects(stat(offlineEnvironment.UNDERTREE_REVIEW_STATE), { code: 'ENOENT' }, 'Offline help never starts or creates an authority.');
  const native = await exec(process.execPath, [nativeUiRunner], {
    cwd: root,
    env: { ...process.env, UNDERTREE_DESKTOP: desktop, UNDERTREE_REVIEW_CLI: cli, UNDERTREE_NATIVE_ARTIFACTS: artifacts },
    timeout: 180_000,
    maxBuffer: 1_000_000,
  });
  process.stdout.write(native.stdout);
  process.stderr.write(native.stderr);
  const nativeApp = await exec(process.execPath, [nativeAppRunner], {
    cwd: root,
    env: {
      ...process.env, UNDERTREE_DESKTOP: desktop,
      UNDERTREE_NATIVE_APP_ARTIFACTS: join(artifacts, 'app-controls'),
      UNDERTREE_NATIVE_APP_READ_OVERLAP: '1',
    },
    timeout: 180_000,
    maxBuffer: 1_000_000,
  });
  process.stdout.write(nativeApp.stdout);
  process.stderr.write(nativeApp.stderr);
  for (const [name, runner, extra] of [
    ['publishing', nativePublishingRunner, {}],
    ['import', nativeImportRunner, {}],
    ['project-export', nativeProjectExportRunner, {}],
    ['project-export-epoch', nativeProjectExportEpochRunner, {}],
    ['close-clean', nativeCloseRunner, { UNDERTREE_NATIVE_CLOSE_MODE: 'clean' }],
    ['close-revoke', nativeCloseRunner, { UNDERTREE_NATIVE_CLOSE_MODE: 'revoke' }],
  ]) {
    const checked = await exec(process.execPath, [runner], {
      cwd: root,
      env: { ...process.env, ...extra, UNDERTREE_DESKTOP: desktop, UNDERTREE_NATIVE_APP_ARTIFACTS: join(artifacts, name) },
      timeout: 180_000,
      maxBuffer: 1_000_000,
    });
    process.stdout.write(checked.stdout);
    process.stderr.write(checked.stderr);
  }
  await validateNativeReleaseReceipt(root, build);
  assert.equal(await hash(releaseReceipt), releaseReceiptSha256, 'The selected build receipt changed during qualification.');
  await mkdir(artifacts, { recursive: true });
  await writeFile(join(artifacts, 'package-evidence.json'), JSON.stringify({
    result: 'passed', verifiedAt: new Date().toISOString(), package: archive,
    packageSha256: await hash(archive), version: config.version, dependencies,
    desktopSha256: await hash(desktop), cliSha256: await hash(cli),
    desktopBuildSha256: build.binaries.desktop, desktopTransformation,
    releaseReceipt, releaseReceiptSha256, targetDirectory: build.targetDirectory, host: build.host,
    attribution: { manifestSha256: build.inputs['native/tauri/notices/manifest.json'], outputs: attribution.outputs,
      rustComponents: attribution.rustComponents.length, javascriptComponents: attribution.javascriptComponents.length },
    runners: {
      nativeUi: { path: nativeUiRunner, sha256: await hash(nativeUiRunner) },
      nativeApp: { path: nativeAppRunner, sha256: await hash(nativeAppRunner) },
      nativePublishing: { path: nativePublishingRunner, sha256: await hash(nativePublishingRunner) },
      nativeImport: { path: nativeImportRunner, sha256: await hash(nativeImportRunner) },
      nativeProjectExport: { path: nativeProjectExportRunner, sha256: await hash(nativeProjectExportRunner) },
      nativeProjectExportEpoch: { path: nativeProjectExportEpochRunner, sha256: await hash(nativeProjectExportEpochRunner) },
      nativeClose: { path: nativeCloseRunner, sha256: await hash(nativeCloseRunner) },
    },
    installed: false, qualification: 'Extracted Debian package, offline CLI help, native shared authority, MCP App controls, isolated source/PDF downloads and consent, native file import, saved-project ZIP/retired-page Save and clean/revoked Close acknowledgements.',
    limitations: 'Simulated zrok child; no public ChatGPT route, system installation, upgrade, removal, signing, other Linux distribution, Windows or macOS qualification.',
  }, null, 2));
  console.log(`Extracted Rust/Tauri Debian package passed without installation; evidence in ${artifacts}.`);
} finally {
  await rm(extracted, { recursive: true, force: true });
}
