import { consentToFixtureShare } from './context-fixture.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createZrokFixture } from './zrok-fixture.mjs';

const root = await mkdtemp(join(tmpdir(), 'undertree-owned-share-'));
const checks = [], token = randomBytes(32).toString('hex');
const controller = join(root, 'controller.jsonl'), mode = join(root, 'mode');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let service, base, log = '';
async function local(operation, errorCode) {
  if (!errorCode) operation = await consentToFixtureShare(operation, local);
  const response = await fetch(base + '/api/review', { method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(operation), signal: AbortSignal.timeout(45_000) });
  const body = await response.json();
  if (errorCode) { assert.equal(body.ok, false); assert.equal(body.error.code, errorCode); return body.error; }
  assert.equal(body.ok, true, body.error?.message); return body.result;
}
const start = error => local({ action: 'tunnel', enabled: true, reservation: 'owned-name', public_url: 'https://owned-name.shares.zrok.io' }, error);
const stop = error => local({ action: 'tunnel', enabled: false, reservation: '', public_url: '' }, error);
const records = async () => (await readFile(controller, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
const foreign = { shareToken: 'foreign-token', envZId: 'foreign-enrollment', target: 'http://127.0.0.1:1',
  frontendEndpoints: ['foreign-name.shares.zrok.io'], shareMode: 'public', backendMode: 'proxy' };
try {
  const fixture = await createZrokFixture(root, join(root, 'target'));
  await writeFile(controller, JSON.stringify(foreign));
  service = spawn(resolve(process.env.UNDERTREE_REVIEW_BINARY || 'target-owned/debug/undertree-review.exe'), ['serve'], {
    env: { ...process.env, ...fixture.environment, UNDERTREE_REVIEW_STATE: join(root, 'state'), UNDERTREE_REVIEW_PORT: '0',
      UNDERTREE_REVIEW_TOKEN: token, UNDERTREE_ZROK: fixture.executable }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  for (const stream of [service.stdout, service.stderr]) stream.on('data', data => { log = (log + data).slice(-16_000); });
  for (let i = 0; i < 300 && !base; i++) {
    const port = log.match(/127\.0\.0\.1:(\d+)/)?.[1];
    if (port) base = `http://127.0.0.1:${port}`;
    else { assert.equal(service.exitCode, null, log); await pause(50); }
  }
  assert.ok(base, 'Isolated service started');
  const projectRoot = join(root, 'project'); await mkdir(projectRoot);
  await writeFile(join(projectRoot, 'main.html'), '<p>Shared before tunnel start.</p>');
  const project = await local({ action: 'add_project', root: projectRoot });
  await local({ action: 'share', project: project.id, path: 'main.html', enabled: true });
  await start();
  assert.equal((await local({ action: 'connection' })).sharedCount, 1);
  await stop();
  assert.deepEqual(await records(), [foreign]);
  await start(); await stop();
  assert.deepEqual(await records(), [foreign]);
  checks.push('Normal Stop removes only the exact owned share and reconnects using the same name.');
  await writeFile(mode, 'delayed-registration');
  await start(); await stop(); await rm(mode);
  assert.deepEqual(await records(), [foreign]);
  checks.push('An empty controller listing is retried within startup bounds until delayed registration appears.');

  await writeFile(mode, 'share-exits');
  await start('tunnel');
  assert.deepEqual(await records(), [foreign]);
  assert.equal((await local({ action: 'connection' })).running, false);
  await rm(mode); await start();
  checks.push('A child exiting after controller creation rolls back its partial share and can reconnect.');

  await local({ action: 'hub_enable', enabled: true });
  await writeFile(mode, 'delete-no-effect');
  const failure = await stop('tunnel_cleanup');
  assert.match(failure.message, /Retry Stop/);
  assert.equal((await local({ action: 'hub_status' })).enabled, false);
  await start('tunnel_cleanup');
  assert.equal((await records()).length, 2);
  await rm(mode); await stop();
  assert.deepEqual(await records(), [foreign]);
  checks.push('Unverified deletion revokes grants, blocks a new start and preserves a retryable owned cleanup record.');

  await start();
  process.kill(Number(await readFile(join(root, 'pid'), 'utf8')));
  await pause(200);
  const dead = await local({ action: 'connection' });
  assert.equal(dead.running, false); assert.equal(dead.sharedCount, 0);
  assert.match(dead.lastError, /exited/);
  assert.match((await local({ action: 'connection' })).lastError, /exited/);
  assert.deepEqual(await records(), [foreign]);
  await start();
  const before = await records(), owned = before.find(row => row.shareToken !== foreign.shareToken);
  const replacement = { ...owned, shareToken: 'replacement-token', envZId: 'foreign-enrollment' };
  await writeFile(controller, [foreign, replacement].map(JSON.stringify).join('\n'));
  await stop();
  assert.deepEqual(await records(), [foreign, replacement]);
  await start('tunnel');
  assert.deepEqual(await records(), [foreign, replacement]);
  checks.push('Child death cleans up on observation; a different current name owner is never deleted.');
  console.log(JSON.stringify({ result: 'passed', checks, scope: 'Actual Rust API/process supervision with a synthetic controller. No live account, public tunnel, native window or crash-recovery claim.' }, null, 2));
} finally {
  await rm(mode, { force: true }).catch(() => {});
  if (base && service?.exitCode === null) await stop().catch(() => {});
  if (service?.exitCode === null) {
    const closed = new Promise(resolve => service.once('close', resolve));
    service.kill(); await closed;
  }
  await rm(root, { recursive: true, force: true });
}
