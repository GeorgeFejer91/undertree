import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { architectureErrors } from '../modules/maintenance/validate-architecture.mjs';

test('architecture rejects Electron dependencies, commands, entrypoints, packaging and obsolete assets', async t => {
  const repository = fileURLToPath(new URL('../', import.meta.url));
  const root = await mkdtemp(join(tmpdir(), 'undertree-stack-policy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const path of ['For-AI', 'modules', 'native/tauri', 'packaging/runtime', 'src/main.js',
    'AGENTS.md', 'Cargo.toml', 'package.json', 'package-lock.json', 'manuscript.html']) {
    const destination = join(root, path);
    await mkdir(join(destination, '..'), { recursive: true });
    await cp(join(repository, path), destination, { recursive: true,
      filter: source => !source.split(/[\\/]/).some(part => ['gen', 'node_modules', 'target'].includes(part)) });
  }
  assert.deepEqual(await architectureErrors(root), [], 'the actual Rust/Tauri configuration passes');
  const original = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
  const cases = [
    { devDependencies: { ...original.devDependencies, electron: '37.0.0' } },
    { dependencies: { ...original.dependencies, '@electron/remote': '2.1.0' } },
    { scripts: { ...original.scripts, 'build:windows': 'electron-builder --win nsis' } },
    { main: 'native/windows/main.cjs' },
    { build: { appId: 'io.github.georgefejer91.UnderTree' } },
  ];
  for (const change of cases) {
    await writeFile(join(root, 'package.json'), JSON.stringify({ ...original, ...change }));
    assert.ok((await architectureErrors(root)).some(error => error.includes('Electron dependencies, entrypoints and packaging are forbidden')), JSON.stringify(change));
  }
  await writeFile(join(root, 'package.json'), JSON.stringify(original));
  await writeFile(join(root, 'package-lock.json'), JSON.stringify({ ...lock,
    packages: { ...lock.packages, 'node_modules/electron': { version: '37.0.0' } } }));
  assert.ok((await architectureErrors(root)).some(error => error.includes('Electron dependencies, entrypoints and packaging are forbidden')), 'a transitive lockfile entry is rejected');
  await writeFile(join(root, 'package-lock.json'), JSON.stringify(lock));
  for (const [asset, path] of [['native/windows', 'native/windows/main.cjs'],
    ['modules/compiler/server-process.mjs', 'modules/compiler/server-process.mjs']]) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), '');
    assert.ok((await architectureErrors(root)).includes(`Obsolete Electron asset is forbidden: ${asset}`), path);
    await rm(join(root, asset), { recursive: true, force: true });
  }
  assert.deepEqual(await architectureErrors(root), [], 'removing obsolete assets restores the valid stack');
});
