import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// An isolated process-lifecycle fixture, never an account or public tunnel.
export async function createZrokFixture(root, targetFile) {
  if (process.platform !== 'win32') {
    const executable = join(root, 'zrok-fixture');
    const quoted = targetFile.replaceAll("'", "'\\''");
    await writeFile(executable, `#!/bin/sh\nprintf '%s' "$3" > '${quoted}'\nexec sleep 600\n`);
    await chmod(executable, 0o700);
    return { executable, environment: {} };
  }
  const source = join(root, 'zrok-fixture.rs'), executable = join(root, 'zrok-fixture.exe');
  await writeFile(source, `fn main() {
    let target = std::env::var_os("UNDERTREE_FIXTURE_TARGET").expect("fixture target");
    let url = std::env::args().nth(3).expect("fixture forwarding target");
    std::fs::write(target, url).expect("fixture receipt");
    std::thread::sleep(std::time::Duration::from_secs(600));
  }\n`);
  const compiled = spawnSync('rustc', ['--edition=2021', source, '-o', executable], {
    encoding: 'utf8', windowsHide: true, timeout: 60_000,
  });
  assert.equal(compiled.status, 0, compiled.stderr || compiled.error?.message);
  return { executable, environment: { UNDERTREE_FIXTURE_TARGET: targetFile } };
}
