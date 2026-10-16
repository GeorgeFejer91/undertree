import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// An isolated process-lifecycle fixture, never an account or public tunnel.
export async function createZrokFixture(root, targetFile, publicHost, { executableName = 'zrok-fixture' } = {}) {
  const home = join(root, 'fixture-home');
  await mkdir(join(home, '.zrok2'), { recursive: true });
  await writeFile(join(home, '.zrok2', 'environment.json'), JSON.stringify({ ziti_identity: 'fixture-enrollment' }));
  const source = join(root, 'zrok-fixture.rs'), executable = join(root, executableName + (process.platform === 'win32' ? '.exe' : ''));
  await copyFile(new URL('./zrok-owned-fixture.rs', import.meta.url), source);
  const compiled = spawnSync('rustc', ['--edition=2021', source, '-o', executable], {
    encoding: 'utf8', windowsHide: true, timeout: 60_000,
  });
  assert.equal(compiled.status, 0, compiled.stderr || compiled.error?.message);
  return { executable, environment: { UNDERTREE_FIXTURE_TARGET: targetFile, ...(publicHost ? { UNDERTREE_FIXTURE_PUBLIC_HOST: publicHost } : {}), [process.platform === 'win32' ? 'USERPROFILE' : 'HOME']: home } };
}
