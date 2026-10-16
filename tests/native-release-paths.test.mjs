import test from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { nativeReleasePaths } from '../modules/maintenance/native-release-paths.mjs';

const host = 'x86_64-unknown-linux-gnu';
const root = resolve('/source/app'), targetDirectory = resolve('/private/custom-target');
const installer = { bundle: { linux: { deb: { files: {
  '/usr/bin/undertree-review': '../../target/release/undertree-review',
  '/usr/share/doc/under-tree/README.md': '../../README.md',
  '/usr/share/doc/under-tree/THIRD-PARTY-RUST.md': 'notices/THIRD-PARTY-RUST.md',
} } } } };
const artifact = executable => ({ reason: 'compiler-artifact', target: { name: 'undertree-review', kind: ['bin'] }, executable });

test('custom native target directory packages the actual Cargo binary and absolute document paths', () => {
  for (const subdirectory of ['release', `${host}/release`]) {
    const executable = join(targetDirectory, subdirectory, 'undertree-review');
    const plan = nativeReleasePaths(root, { target_directory: targetDirectory }, [artifact(executable)], host, installer);
    assert.equal(plan.cli, executable);
    assert.equal(plan.overlay.bundle.linux.deb.files['/usr/bin/undertree-review'], executable);
    assert.equal(plan.overlay.bundle.linux.deb.files['/usr/share/doc/under-tree/README.md'], join(root, 'README.md'));
    assert.equal(plan.overlay.bundle.linux.deb.files['/usr/share/doc/under-tree/THIRD-PARTY-RUST.md'], join(root, 'native/tauri/notices/THIRD-PARTY-RUST.md'));
    assert.equal(plan.bundleDirectory, join(targetDirectory, subdirectory, 'bundle/deb'));
  }
});

test('missing, stale default, cross-target and ambiguous artifacts never select a fallback CLI', () => {
  for (const messages of [[], [artifact(join(root, 'target/release/undertree-review'))],
    [artifact(join(targetDirectory, 'aarch64-unknown-linux-gnu/release/undertree-review'))],
    [artifact(join(targetDirectory, 'release/undertree-review')), artifact(join(targetDirectory, host, 'release/undertree-review'))]]) {
    assert.throws(() => nativeReleasePaths(root, { target_directory: targetDirectory }, messages, host, installer));
  }
});
