import assert from 'node:assert/strict';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function nativeReleasePaths(root, metadata, messages, host, installer) {
  assert.match(host, /^[A-Za-z0-9_-]+-linux-[A-Za-z0-9_-]+$/, 'A native Linux Rust host is required.');
  const targetDirectory = resolve(metadata.target_directory);
  const paths = new Set(messages.filter(message => message.reason === 'compiler-artifact'
    && message.target?.name === 'undertree-review' && message.target?.kind?.includes('bin')
    && message.executable).map(message => resolve(message.executable)));
  assert.equal(paths.size, 1, 'Cargo must identify exactly one built undertree-review executable.');
  const [cli] = paths;
  const releaseDirectory = dirname(cli);
  assert.ok([join(targetDirectory, 'release'), join(targetDirectory, host, 'release')].includes(releaseDirectory),
    'Only the actual native release target is supported; refusing a stale/default or cross-target CLI.');
  const files = Object.fromEntries(Object.entries(installer.bundle.linux.deb.files).map(([destination, source]) =>
    [destination, destination === '/usr/bin/undertree-review' ? cli : resolve(root, 'native/tauri', source)]));
  return {
    targetDirectory, host, cli, desktop: join(releaseDirectory, 'undertree-desktop'),
    bundleDirectory: join(releaseDirectory, 'bundle/deb'),
    overlay: { ...installer, bundle: { ...installer.bundle, linux: { ...installer.bundle.linux,
      deb: { ...installer.bundle.linux.deb, files } } } },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [metadataPath, messagesPath, host, destination] = process.argv.slice(2);
  assert.ok(metadataPath && messagesPath && host && destination, 'Expected metadata, artifact log, native host and private output directory.');
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
  const messages = (await readFile(messagesPath, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  assert.equal(messages.findLast(message => message.reason === 'build-finished')?.success, true, 'The CLI build must have finished successfully.');
  const installer = JSON.parse(await readFile(join(root, 'native/tauri/tauri.installer.conf.json'), 'utf8'));
  const noticeManifest = JSON.parse(await readFile(join(root, 'native/tauri/notices/manifest.json'), 'utf8'));
  assert.equal(noticeManifest.target, host, 'Generate and review notices for this native host before packaging.');
  const plan = nativeReleasePaths(root, metadata, messages, host, installer);
  for (const source of Object.values(plan.overlay.bundle.linux.deb.files)) assert.ok((await stat(source)).isFile(), `Missing exact package input: ${source}`);
  await writeFile(join(destination, 'tauri.installer.json'), JSON.stringify(plan.overlay, null, 2) + '\n');
  const { overlay, ...receipt } = plan;
  await writeFile(join(destination, 'paths.json'), JSON.stringify(receipt, null, 2) + '\n');
  console.log(`Native package paths recorded in ${join(destination, 'paths.json')}`);
}
