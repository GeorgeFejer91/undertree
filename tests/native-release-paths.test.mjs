import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeReleasePaths } from '../modules/maintenance/native-release-paths.mjs';

const host = 'x86_64-unknown-linux-gnu';
const installer = { bundle: { linux: { deb: { files: {
  '/usr/bin/undertree-review': '../../target/release/undertree-review',
  '/usr/share/doc/under-tree/README.md': '../../README.md',
  '/usr/share/doc/under-tree/THIRD-PARTY-RUST.md': 'notices/THIRD-PARTY-RUST.md',
} } } } };
const artifact = executable => ({ reason: 'compiler-artifact', target: { name: 'undertree-review', kind: ['bin'] }, executable });

test('custom native target directory packages the actual Cargo binary and absolute document paths', () => {
  for (const subdirectory of ['release', `${host}/release`]) {
    const executable = `/private/custom-target/${subdirectory}/undertree-review`;
    const plan = nativeReleasePaths('/source/app', { target_directory: '/private/custom-target' }, [artifact(executable)], host, installer);
    assert.equal(plan.cli, executable);
    assert.equal(plan.overlay.bundle.linux.deb.files['/usr/bin/undertree-review'], executable);
    assert.equal(plan.overlay.bundle.linux.deb.files['/usr/share/doc/under-tree/README.md'], '/source/app/README.md');
    assert.equal(plan.overlay.bundle.linux.deb.files['/usr/share/doc/under-tree/THIRD-PARTY-RUST.md'], '/source/app/native/tauri/notices/THIRD-PARTY-RUST.md');
    assert.equal(plan.bundleDirectory, `/private/custom-target/${subdirectory}/bundle/deb`);
  }
});

test('missing, stale default, cross-target and ambiguous artifacts never select a fallback CLI', () => {
  for (const messages of [[], [artifact('/source/app/target/release/undertree-review')],
    [artifact('/private/custom-target/aarch64-unknown-linux-gnu/release/undertree-review')],
    [artifact('/private/custom-target/release/undertree-review'), artifact(`/private/custom-target/${host}/release/undertree-review`)]]) {
    assert.throws(() => nativeReleasePaths('/source/app', { target_directory: '/private/custom-target' }, messages, host, installer));
  }
});
