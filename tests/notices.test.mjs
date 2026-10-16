import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));

test('both platform attribution manifests pin canonical LF license text', async () => {
  for (const directory of ['native/tauri/notices', 'native/tauri/notices-windows']) {
    const manifest = JSON.parse(await readFile(join(root, directory, 'manifest.json'), 'utf8'));
    for (const [file, expected] of Object.entries(manifest.outputs)) {
      const text = (await readFile(join(root, directory, file), 'utf8')).replace(/\r\n/g, '\n');
      assert.equal(createHash('sha256').update(text).digest('hex'), expected, `${directory}/${file}`);
    }
  }
});

test('notice verification needs no build tools and refuses changed payloads or lock inputs', async t => {
  const fixture = await mkdtemp(join(tmpdir(), 'undertree-notices-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const notices = resolve(root, process.env.UNDERTREE_NOTICES_DIR || `native/tauri/notices${process.platform === 'win32' ? '-windows' : ''}`);
  const manifest = JSON.parse(await readFile(join(notices, 'manifest.json'), 'utf8'));
  const paths = new Set([...Object.keys(manifest.inputs), ...manifest.upstreamFiles.map(file => file.path)]);
  for (const path of paths) {
    await mkdir(dirname(join(fixture, path)), { recursive: true });
    await cp(join(root, path), join(fixture, path));
  }
  const fixtureNotices = join(fixture, 'custom-notices');
  await cp(notices, fixtureNotices, { recursive: true });
  const check = () => exec(process.execPath, [join(fixture, 'modules/maintenance/generate-notices.mjs'), '--check'],
    { timeout: 10_000, env: { ...process.env, UNDERTREE_NOTICES_DIR: fixtureNotices } });
  assert.match((await check()).stdout, /Third-party notices verified/);
  const lock = join(fixture, 'Cargo.lock');
  const originalLock = (await readFile(lock, 'utf8')).replace(/\r\n/g, '\n');
  await writeFile(lock, originalLock.replace(/\n/g, '\r\n'));
  assert.match((await check()).stdout, /Third-party notices verified/, 'Windows checkout line endings preserve locked attribution identity.');
  await writeFile(join(fixtureNotices, 'manifest.json'), JSON.stringify({ ...manifest, target: 'wrong-target' }));
  await assert.rejects(check(), error => error.stderr.includes('wrong-target'));
  await writeFile(join(fixtureNotices, 'manifest.json'), JSON.stringify(manifest));
  const rust = join(fixtureNotices, 'THIRD-PARTY-RUST.md');
  const original = await readFile(rust);
  await writeFile(rust, original.toString('utf8').replace(/\r\n/g, '\n').replace(/\n/g, '\r\n'));
  assert.match((await check()).stdout, /Third-party notices verified/, 'Windows checkout line endings preserve notice text.');
  await writeFile(rust, 'Truncated notices');
  await assert.rejects(check(), error => error.stderr.includes('Notice changed: THIRD-PARTY-RUST.md'));
  await writeFile(rust, original);
  await writeFile(lock, `${await readFile(lock, 'utf8')}\n# Changed after attribution\n`);
  await assert.rejects(check(), error => error.stderr.includes('Notice inputs changed'));
  assert.deepEqual(await readFile(rust), original, 'Read-only checks preserve the original notice payload.');
});
