import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { exportSecretTunnel, importSecretTunnel } from '../modules/maintenance/secret-tunnel-profile.mjs';

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'undertree-connector-')));
  t.after(() => rm(root, { force: true, recursive: true }));
  const settings = join(root, 'settings.json'), zrokHome = join(root, 'source-home');
  const output = join(root, 'package'), state = join(root, 'state');
  await mkdir(join(zrokHome, 'identities'), { recursive: true }); await mkdir(state);
  const token = 'synthetic-private-path-token-12345';
  await writeFile(settings, JSON.stringify({ zrokName: 'existing-connector', publicPathToken: token,
    mcpTransport: 'zrok', github: { token: 'must-not-copy' }, workspacePath: 'private/source/folders' }));
  await writeFile(join(zrokHome, 'environment.json'), '{"zrok_token":"synthetic-account","ziti_identity":"synthetic-environment","api_endpoint":"https://api.invalid"}');
  await writeFile(join(zrokHome, 'metadata.json'), '{"v":"v0.4"}');
  await writeFile(join(zrokHome, 'identities', 'environment.json'), '{"synthetic":"identity"}');
  await writeFile(join(zrokHome, 'identities', 'unrelated-share.json'), 'must-not-copy');
  await writeFile(join(zrokHome, 'agent.socket'), 'not transferable');
  return { root, settings, zrokHome, output, state, token };
}

test('export/import preserves connector identity privately and copies only zrok enrolment', async t => {
  const f = await fixture(t);
  assert.equal((await exportSecretTunnel(f)).files, 3);
  const exported = await readFile(join(f.output, 'settings.json'), 'utf8');
  assert.ok(!exported.includes('must-not-copy')); assert.ok(!exported.includes('workspacePath'));
  assert.deepEqual((await readdir(join(f.output, 'zrok-home'))).sort(), ['environment.json', 'identities', 'metadata.json']);
  assert.deepEqual(await readdir(join(f.output, 'zrok-home', 'identities')), ['environment.json']);
  assert.deepEqual(await importSecretTunnel({ input: f.output, state: f.state }), { files: 3, imported: true, started: false });
  const connector = JSON.parse(await readFile(join(f.state, 'secret-tunnel-connector.json'), 'utf8'));
  assert.equal(connector.publicPathToken, f.token);
  assert.equal(connector.publicUrl, 'https://existing-connector.shares.zrok.io');
  assert.equal(dirname(connector.zrokHome), f.state);
  assert.match(await readFile(join(connector.zrokHome, '.zrok2', 'identities', 'environment.json'), 'utf8'), /identity/);
  assert.ok(!(await readFile(join(f.state, 'connection.json'), 'utf8')).includes(f.token));
  if (process.platform !== 'win32') {
    assert.equal((await lstat(join(f.state, 'secret-tunnel-connector.json'))).mode & 0o777, 0o600);
    assert.equal((await lstat(connector.zrokHome)).mode & 0o777, 0o700);
  } else {
    const run = promisify(execFile);
    const inspect = '$ErrorActionPreference = "Stop"; $path = $env:UNDERTREE_ACL_FIXTURE; '
      + '$acl = if ([System.IO.Directory]::Exists($path)) { [System.IO.Directory]::GetAccessControl($path) } '
      + 'else { [System.IO.File]::GetAccessControl($path) }; '
      + '@{protected=$acl.AreAccessRulesProtected; rules=@($acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]) | '
      + 'ForEach-Object { @{sid=$_.IdentityReference.Value; type=$_.AccessControlType.ToString()} }); '
      + 'user=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value} | ConvertTo-Json -Depth 5 -Compress';
    for (const [path, protectedRoot] of [[f.output, true], [connector.zrokHome, true],
      [join(f.state, 'secret-tunnel-connector.json'), false],
      [join(connector.zrokHome, '.zrok2', 'identities', 'environment.json'), false]]) {
      const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', inspect], {
        env: { ...process.env, UNDERTREE_ACL_FIXTURE: path }, windowsHide: true, timeout: 10_000,
      });
      const acl = JSON.parse(stdout);
      if (protectedRoot) assert.equal(acl.protected, true, JSON.stringify(acl));
      const allowed = new Set([acl.user, 'S-1-5-18', 'S-1-5-32-544']);
      assert.ok(acl.rules.length >= 3);
      assert.ok(acl.rules.every(rule => allowed.has(rule.sid) && rule.type === 'Allow'));
    }
  }
  await assert.rejects(importSecretTunnel({ input: f.output, state: f.state }), /already exists/);
});

test('existing different setup is preserved without installing secret material', async t => {
  const f = await fixture(t); await exportSecretTunnel(f);
  const config = '{"reservation":"other","publicUrl":"https://other.example"}';
  await writeFile(join(f.state, 'connection.json'), config);
  await assert.rejects(importSecretTunnel({ input: f.output, state: f.state }), /setup differs/);
  assert.equal(await readFile(join(f.state, 'connection.json'), 'utf8'), config);
  assert.deepEqual(await readdir(f.state), ['connection.json']);
});

test('a running or unresolved desktop instance prevents profile installation', async t => {
  const f = await fixture(t); await exportSecretTunnel(f);
  await mkdir(join(f.state, 'cli'));
  await writeFile(join(f.state, 'cli', 'instance.json'), '{"private":"instance metadata"}');
  await assert.rejects(importSecretTunnel({ input: f.output, state: f.state }), /Close UnderTree/);
  assert.deepEqual(await readdir(f.state), ['cli']);
});

test('concurrent imports preserve exactly one complete installation', async t => {
  const f = await fixture(t); await exportSecretTunnel(f);
  const results = await Promise.allSettled(Array.from({ length: 4 }, () => importSecretTunnel({ input: f.output, state: f.state })));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const connector = JSON.parse(await readFile(join(f.state, 'secret-tunnel-connector.json'), 'utf8'));
  const config = JSON.parse(await readFile(join(f.state, 'connection.json'), 'utf8'));
  assert.equal(connector.reservation, config.reservation);
  assert.equal(connector.publicUrl, config.publicUrl);
  await lstat(join(connector.zrokHome, '.zrok2', 'metadata.json'));
  assert.ok(!(await readdir(f.state)).includes('.connector-import.lock'));
});

test('an enrolment without its zrok version marker is refused', async t => {
  const f = await fixture(t); await rm(join(f.zrokHome, 'metadata.json'));
  await assert.rejects(exportSecretTunnel(f), /Invalid/);
  await assert.rejects(lstat(f.output), { code: 'ENOENT' });
});

test('the zrok version and environment identity must be usable together', async t => {
  const f = await fixture(t);
  await writeFile(join(f.zrokHome, 'metadata.json'), '{"v":"unsupported"}');
  await assert.rejects(exportSecretTunnel(f), /Invalid/);
  await writeFile(join(f.zrokHome, 'metadata.json'), '{"v":"v0.4"}');
  await rm(join(f.zrokHome, 'identities', 'environment.json'));
  await assert.rejects(exportSecretTunnel(f), /Invalid/);
});

test('symlink enrolment fails before creating the transfer package', async t => {
  const f = await fixture(t);
  const identity = join(f.zrokHome, 'identities', 'environment.json');
  await rm(identity);
  try { await symlink(f.settings, identity); }
  catch (error) {
    if (process.platform === 'win32' && error.code === 'EPERM') {
      t.skip('Windows does not grant this process file-symlink creation privileges.');
      return;
    }
    throw error;
  }
  await assert.rejects(exportSecretTunnel(f), /Invalid/);
  await assert.rejects(lstat(f.output), { code: 'ENOENT' });
});

test('hardlinked enrolment fails before creating the transfer package', async t => {
  const f = await fixture(t);
  const identity = join(f.zrokHome, 'identities', 'environment.json');
  await rm(identity); await link(f.settings, identity);
  await assert.rejects(exportSecretTunnel(f), /Invalid/);
  await assert.rejects(lstat(f.output), { code: 'ENOENT' });
});

test('oversized credentials fail before creating the transfer package', async t => {
  const f = await fixture(t);
  await writeFile(join(f.zrokHome, 'identities', 'environment.json'), Buffer.alloc(1024 * 1024 + 1));
  await assert.rejects(exportSecretTunnel(f), /Invalid/);
  await assert.rejects(lstat(f.output), { code: 'ENOENT' });
});

test('CLI failures never echo settings content or the private token', async t => {
  const f = await fixture(t);
  await writeFile(f.settings, `{"private":"${f.token}", broken`);
  await assert.rejects(promisify(execFile)(process.execPath, [resolve('modules/maintenance/secret-tunnel-profile.mjs'),
    'export', '--settings', f.settings, '--zrok-home', f.zrokHome, '--output', f.output]), error => {
      assert.ok(!error.stdout.includes(f.token)); assert.ok(!error.stderr.includes(f.token));
      assert.match(error.stderr, /Profile operation failed/); return true;
    });
});
