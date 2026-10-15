import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));

test('notice verification needs no build tools and refuses changed payloads or lock inputs', async t => {
  const fixture = await mkdtemp(join(tmpdir(), 'undertree-notices-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const manifest = JSON.parse(await readFile(join(root, 'native/tauri/notices/manifest.json'), 'utf8'));
  const paths = new Set([...Object.keys(manifest.inputs), ...manifest.upstreamFiles.map(file => file.path),
    'native/tauri/notices/manifest.json', ...Object.keys(manifest.outputs).map(file => `native/tauri/notices/${file}`)]);
  for (const path of paths) {
    await mkdir(dirname(join(fixture, path)), { recursive: true });
    await cp(join(root, path), join(fixture, path));
  }
  const check = () => exec(process.execPath, [join(fixture, 'modules/maintenance/generate-notices.mjs'), '--check'], { timeout: 10_000 });
  assert.match((await check()).stdout, /Third-party notices verified/);
  const rust = join(fixture, 'native/tauri/notices/THIRD-PARTY-RUST.md');
  const original = await readFile(rust);
  await writeFile(rust, 'Truncated notices');
  await assert.rejects(check(), error => error.stderr.includes('Notice changed: THIRD-PARTY-RUST.md'));
  await writeFile(rust, original);
  const lock = join(fixture, 'Cargo.lock');
  await writeFile(lock, `${await readFile(lock, 'utf8')}\n# Changed after attribution\n`);
  await assert.rejects(check(), error => error.stderr.includes('Notice inputs changed'));
  assert.deepEqual(await readFile(rust), original, 'Read-only checks preserve the original notice payload.');
});
