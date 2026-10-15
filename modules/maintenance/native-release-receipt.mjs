import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const inputs = ['Cargo.lock', 'package-lock.json', 'README.md', 'native/tauri/tauri.conf.json',
  'native/tauri/tauri.installer.conf.json', 'native/tauri/notices/manifest.json',
  'native/tauri/notices/THIRD-PARTY-RUST.md', 'native/tauri/notices/THIRD-PARTY-JAVASCRIPT.md'];
const hash = async path => createHash('sha256').update(await readFile(path)).digest('hex');

export async function validateNativeReleaseReceipt(root, receipt) {
  assert.equal(receipt.schema, 1, 'A completed native build receipt is required.');
  assert.equal(receipt.root, resolve(root), 'The receipt belongs to a different source snapshot.');
  const config = JSON.parse(await readFile(join(root, 'native/tauri/tauri.conf.json'), 'utf8'));
  assert.equal(receipt.version, config.version);
  assert.deepEqual(Object.keys(receipt.inputs).sort(), [...inputs].sort());
  for (const [file, expected] of Object.entries(receipt.inputs))
    assert.equal(await hash(join(root, file)), expected, `Native release input changed: ${file}`);
  for (const name of ['desktop', 'cli'])
    assert.equal(await hash(receipt[name]), receipt.binaries[name], `Native release binary changed: ${name}`);
  assert.ok(receipt.packages.length > 0, 'No completed Debian package was recorded.');
  for (const archive of receipt.packages)
    assert.equal(await hash(archive.path), archive.sha256, 'The recorded Debian package changed.');
  return receipt;
}

export async function readNativeReleaseReceipt(root, file) {
  return validateNativeReleaseReceipt(root, JSON.parse(await readFile(file, 'utf8')));
}

export async function recordNativeRelease(root, pathsFile) {
  root = resolve(root);
  const paths = JSON.parse(await readFile(pathsFile, 'utf8'));
  const config = JSON.parse(await readFile(join(root, 'native/tauri/tauri.conf.json'), 'utf8'));
  const packages = await Promise.all((await readdir(paths.bundleDirectory))
    .filter(name => name.includes(`_${config.version}_`) && name.endsWith('.deb'))
    .sort().map(async name => {
      const path = join(paths.bundleDirectory, name);
      return { path, sha256: await hash(path) };
    }));
  const receipt = { schema: 1, root, version: config.version, completedAt: new Date().toISOString(), ...paths,
    inputs: Object.fromEntries(await Promise.all(inputs.map(async file => [file, await hash(join(root, file))]))),
    binaries: { desktop: await hash(paths.desktop), cli: await hash(paths.cli) }, packages };
  await validateNativeReleaseReceipt(root, receipt);
  const payload = JSON.stringify(receipt, null, 2) + '\n';
  const perBuild = join(dirname(pathsFile), 'release.json');
  const latest = join(root, 'artifacts/native-release/latest.json');
  await mkdir(dirname(latest), { recursive: true });
  await writeFile(perBuild, payload);
  const temporary = `${latest}.${randomUUID()}.tmp`;
  await writeFile(temporary, payload);
  await rename(temporary, latest);
  return perBuild;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.equal(process.argv.length, 3, 'Expected the exact completed build paths.json.');
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  console.log(`Completed native build receipt: ${await recordNativeRelease(root, resolve(process.argv[2]))}`);
}
