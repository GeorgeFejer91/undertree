import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { recordNativeRelease, readNativeReleaseReceipt } from '../modules/maintenance/native-release-receipt.mjs';

async function fixture(t) {
  const temporary = await mkdtemp(join(tmpdir(), 'undertree-release-receipt-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = join(temporary, 'source'), targetDirectory = join(temporary, 'custom-target');
  const release = join(targetDirectory, 'x86_64-unknown-linux-gnu/release');
  const bundleDirectory = join(release, 'bundle/deb');
  for (const [file, value] of Object.entries({
    'Cargo.lock': 'locked Rust inputs', 'package-lock.json': 'locked frontend inputs', 'README.md': 'product documentation',
    'native/tauri/tauri.conf.json': JSON.stringify({ version: '0.3.0' }),
    'native/tauri/tauri.installer.conf.json': 'explicit installer inputs',
    'native/tauri/notices/manifest.json': 'reviewed notice manifest',
    'native/tauri/notices/THIRD-PARTY-RUST.md': 'full upstream Rust texts',
    'native/tauri/notices/THIRD-PARTY-JAVASCRIPT.md': 'full bundled JavaScript texts',
  })) {
    const path = join(root, file); await mkdir(dirname(path), { recursive: true }); await writeFile(path, value);
  }
  await mkdir(bundleDirectory, { recursive: true });
  const cli = join(release, 'undertree-review'), desktop = join(release, 'undertree-desktop');
  await writeFile(cli, 'actual Cargo CLI'); await writeFile(desktop, 'actual native desktop');
  const archive = join(bundleDirectory, 'UnderTree_0.3.0_amd64.deb'); await writeFile(archive, 'completed archive fixture');
  const paths = join(root, 'artifacts/native-release/build.fixture/paths.json'); await mkdir(dirname(paths), { recursive: true });
  await writeFile(paths, JSON.stringify({ targetDirectory, host: 'x86_64-unknown-linux-gnu', cli, desktop, bundleDirectory }));
  return { root, paths, cli, desktop, archive, latest: join(root, 'artifacts/native-release/latest.json') };
}

test('completed release provenance follows the actual custom target and binds its notices and archive', async t => {
  const f = await fixture(t);
  const stale = join(f.root, 'target/release/undertree-review'); await mkdir(dirname(stale), { recursive: true }); await writeFile(stale, 'stale default CLI');
  const perBuild = await recordNativeRelease(f.root, f.paths);
  assert.deepEqual(await readFile(perBuild), await readFile(f.latest));
  const receipt = await readNativeReleaseReceipt(f.root, f.latest);
  assert.equal(receipt.cli, f.cli); assert.equal(receipt.desktop, f.desktop);
  assert.equal(receipt.packages[0].path, f.archive);
  assert.ok(receipt.inputs['native/tauri/notices/THIRD-PARTY-RUST.md']);
  assert.ok(receipt.inputs['native/tauri/notices/THIRD-PARTY-JAVASCRIPT.md']);
});

test('changed binaries, archives, locks and notice texts reject stale build provenance', async t => {
  for (const key of ['cli', 'archive', 'Cargo.lock', 'native/tauri/notices/THIRD-PARTY-JAVASCRIPT.md']) {
    const f = await fixture(t); await recordNativeRelease(f.root, f.paths);
    await writeFile(f[key] || join(f.root, key), 'changed after the completed build');
    await assert.rejects(readNativeReleaseReceipt(f.root, f.latest), /changed/);
  }
});

test('an incomplete later build cannot replace the last complete build receipt', async t => {
  const f = await fixture(t); await recordNativeRelease(f.root, f.paths);
  const before = await readFile(f.latest);
  await rm(f.cli);
  await assert.rejects(recordNativeRelease(f.root, f.paths), { code: 'ENOENT' });
  assert.deepEqual(await readFile(f.latest), before);
});
