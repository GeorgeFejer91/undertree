import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, relative } from 'node:path';
import test from 'node:test';
import { createZrokFixture } from './zrok-fixture.mjs';

test('synthetic zrok keeps ownership management separate from share process receipts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'undertree-zrok-fixture-contract-'));
  const parentHome = process.env.HOME, parentProfile = process.env.USERPROFILE;
  let child;
  try {
    const target = 'http://127.0.0.1:45678', targetFile = join(root, 'target');
    const fixture = await createZrokFixture(root, targetFile, 'ordinary.example.invalid', { executableName: 'zrok test helper' });
    const environment = { ...process.env, ...fixture.environment };
    const home = fixture.environment[process.platform === 'win32' ? 'USERPROFILE' : 'HOME'];
    const marker = Buffer.from('only disposable activation metadata\n');
    await writeFile(join(home, '.zrok2', 'metadata.json'), marker);
    assert.equal(JSON.parse(await readFile(join(home, '.zrok2', 'environment.json'), 'utf8')).ziti_identity, 'fixture-enrollment');
    const run = args => {
      const result = spawnSync(fixture.executable, args, { env: environment, encoding: 'utf8', windowsHide: true, timeout: 10_000 });
      assert.equal(result.status, 0, result.stderr || result.error?.message);
      return result.stdout;
    };
    const list = () => JSON.parse(run(['list', 'shares', '--json'])).shares;
    const args = ['share', 'public', target, '-n', 'public:fixture', '--headless', '--force-local'];
    const start = () => spawn(fixture.executable, args, { env: environment, windowsHide: true, stdio: 'ignore' });
    const until = async check => {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 25)); }
      assert.fail('The synthetic share did not publish its process receipt.');
    };
    assert.deepEqual(list(), []);
    child = start();
    await until(async () => { try { return Number(await readFile(join(root, 'pid'), 'utf8')) === child.pid; } catch { return false; } });
    assert.equal(await readFile(targetFile, 'utf8'), target);
    assert.deepEqual((await readFile(join(root, 'args'), 'utf8')).split('\n'), args);
    assert.equal(await readFile(join(root, 'child-home'), 'utf8'), home);
    assert.deepEqual(await readFile(join(root, 'child-activation')), marker);
    const share = list()[0];
    assert.equal(list().length, 1);
    assert.equal(share.envZId, 'fixture-enrollment');
    assert.equal(share.target, target);
    assert.deepEqual(share.frontendEndpoints, ['ordinary.example.invalid']);
    const receipts = await Promise.all(['args', 'pid', 'child-home', 'child-activation', 'target'].map(name => readFile(join(root, name))));
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
    assert.deepEqual(list(), [share], 'Hard child death must retain the synthetic controller mapping.');
    run(['delete', 'share', share.shareToken, '--envzid', share.envZId]);
    assert.deepEqual(list(), []);
    assert.deepEqual(await Promise.all(['args', 'pid', 'child-home', 'child-activation', 'target'].map(name => readFile(join(root, name)))), receipts,
      'List/delete must not overwrite share argv, target, PID, home or metadata receipts.');

    await writeFile(join(root, 'mode'), 'startup-failure');
    const failed = spawnSync(fixture.executable, args, { env: environment, windowsHide: true, timeout: 5_000 });
    assert.equal(failed.status, 3);
    assert.deepEqual(list(), [], 'Startup failure occurs before controller share creation.');
    await writeFile(join(root, 'mode'), 'late-failure');
    await writeFile(join(root, 'public-host'), 'imported.example.invalid');
    const started = Date.now(); child = start();
    const lateExit = once(child, 'exit');
    await until(async () => { try { return Number(await readFile(join(root, 'pid'), 'utf8')) === child.pid; } catch { return false; } });
    assert.equal(child.exitCode, null);
    assert.deepEqual(list()[0].frontendEndpoints, ['imported.example.invalid']);
    const [code] = await lateExit;
    assert.equal(code, 7);
    assert.ok(Date.now() - started >= 3_900, 'Late failure must survive the existing two-second startup gate.');
    const late = list()[0];
    run(['delete', 'share', late.shareToken, '--envzid', late.envZId]);
    assert.deepEqual(list(), []);
    assert.equal(process.env.HOME, parentHome);
    assert.equal(process.env.USERPROFILE, parentProfile);
  } finally {
    if (child?.exitCode === null && child.signalCode === null) { const stopped = once(child, 'exit'); child.kill('SIGKILL'); await stopped; }
    const checked = await realpath(root), beneathTemp = relative(await realpath(tmpdir()), checked);
    assert.ok(!beneathTemp.startsWith('..') && basename(checked).startsWith('undertree-zrok-fixture-contract-'));
    await rm(checked, { recursive: true, force: true });
  }
});
