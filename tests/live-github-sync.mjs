import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium } from 'playwright-core';

// This opt-in gate publishes synthetic files on one disposable branch, then deletes that exact branch conditionally.
assert.equal(process.env.UNDERTREE_LIVE_GITHUB_TEST, '1', 'Set UNDERTREE_LIVE_GITHUB_TEST=1 to authorize the disposable live GitHub fixture.');
const repository = 'GeorgeFejer91/undertree';
const remote = `https://github.com/${repository}.git`;
const nonce = randomBytes(8).toString('hex');
const branch = `codex/qualification/github-sync-${nonce}`;
const ref = `refs/heads/${branch}`;
const filename = `qualification-${nonce}.typ`;
const sidecar = `${filename}.undertree-review.json`;
const root = await mkdtemp(join(tmpdir(), 'undertree-live-github-'));
const projectRoot = join(root, 'project');
const otherRoot = join(root, 'other-editor');
const artifactRoot = resolve(process.env.UNDERTREE_LIVE_GITHUB_ARTIFACTS || 'artifacts');
await mkdir(artifactRoot, { recursive: true });
const receiptPath = join(artifactRoot, `live-github-sync-${nonce}.json`);
const receipt = { repository, branch, files: [filename, sidecar], startedAt: new Date().toISOString(), steps: [], cleanup: { deleted: false }, passed: false };
const runFile = promisify(execFile);
async function run(program, args, cwd = root) {
  const { stdout } = await runFile(program, args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' }, timeout: 90000, maxBuffer: 1024 * 1024 });
  return stdout.trim();
}
async function git(args, cwd = projectRoot) {
  return run('git', ['-c', 'core.hooksPath=', '-c', 'commit.gpgsign=false', '--literal-pathspecs', ...args], cwd);
}
async function configure(cwd) {
  await git(['config', 'user.name', 'UnderTree qualification fixture'], cwd);
  await git(['config', 'user.email', 'undertree-qualification@example.invalid'], cwd);
  // Only the disposable clone is configured; credentials remain owned by the installed GitHub CLI.
  await git(['config', 'credential.https://github.com.helper', ''], cwd);
  await git(['config', '--add', 'credential.https://github.com.helper', '!gh auth git-credential'], cwd);
}
async function remoteHead() {
  const result = await git(['ls-remote', '--heads', remote, ref]);
  return result.split(/\s+/)[0] || null;
}
async function checkCheckpoint(sha, expectedContent) {
  assert.equal(await remoteHead(), sha, 'GitHub remote head matches the native receipt');
  assert.equal(await git(['show', `${sha}:${filename}`]), expectedContent.trimEnd(), 'Git commit stores the expected synthetic source');
  const changed = (await git(['diff-tree', '--no-commit-id', '--name-only', '-r', sha])).split('\n').filter(Boolean).sort();
  assert.deepEqual(changed, [filename, sidecar].sort(), 'checkpoint includes only synthetic manuscript and its sidecar');
  const review = JSON.parse(await git(['show', `${sha}:${sidecar}`]));
  assert.equal(review.revision, createHash('sha256').update(expectedContent).digest('hex'), 'sidecar describes the committed source bytes');
  return { sha, changedFiles: changed, sourceSha256: review.revision, githubCommit: `https://github.com/${repository}/commit/${sha}` };
}
let child;
let browser;
let base;
let token;
let serviceLog = '';
let project;
let expectedCleanupTip;
const browserErrors = [];
async function call(operation, expectError = false) {
  const response = await fetch(`${base}/api/review`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(operation), signal: AbortSignal.timeout(90000) });
  const value = await response.json();
  assert.equal(value.ok, !expectError, value.error?.message);
  return expectError ? value.error : value.result;
}
async function openBrowser() {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  page.on('pageerror', error => browserErrors.push(error.message));
  await page.goto(`${base}/manuscript.html#session=${token}`);
  await page.getByRole('button', { name: filename, exact: true }).click();
  await page.locator('.cm-content').waitFor();
  return page;
}
function nextBrowserSync(page) {
  return page.waitForResponse(response => {
    if (!response.url().endsWith('/api/review') || response.request().method() !== 'POST') return false;
    try { return response.request().postDataJSON().action === 'sync'; } catch { return false; }
  }, { timeout: 60000 });
}
async function replaceText(page, content) {
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+Home');
  await page.keyboard.press('Control+a');
  await page.keyboard.insertText(content);
}
async function otherCommit(content, message) {
  await writeFile(join(otherRoot, filename), content);
  await git(['add', '--', filename], otherRoot);
  await git(['commit', '-m', message], otherRoot);
  const sha = await git(['rev-parse', 'HEAD'], otherRoot);
  await git(['push', '--no-follow-tags', '--recurse-submodules=no', remote, `${sha}:${ref}`], otherRoot);
  expectedCleanupTip = sha;
  assert.equal(await remoteHead(), sha);
  return sha;
}

try {
  const visibility = JSON.parse(await run('gh', ['repo', 'view', repository, '--json', 'isPrivate,defaultBranchRef,nameWithOwner']));
  assert.equal(visibility.isPrivate, false);
  assert.equal(visibility.nameWithOwner, repository);
  assert.equal(await run('gh', ['api', 'user', '--jq', '.login']), 'GeorgeFejer91');
  await run('git', ['clone', '--depth', '1', '--single-branch', '--branch', visibility.defaultBranchRef.name, remote, projectRoot]);
  await configure(projectRoot);
  await git(['switch', '-c', branch]);
  assert.equal(await remoteHead(), null, 'the uniquely named branch does not already exist');
  receipt.baseHead = await git(['rev-parse', 'HEAD']);
  receipt.serviceSha256 = createHash('sha256').update(await readFile(resolve('target/debug/undertree-review'))).digest('hex');
  receipt.frontendHtmlSha256 = createHash('sha256').update(await readFile(resolve('dist/manuscript.html'))).digest('hex');
  token = randomBytes(32).toString('hex');
  child = spawn(resolve('target/debug/undertree-review'), [], { env: { ...process.env, UNDERTREE_REVIEW_PORT: '0', UNDERTREE_REVIEW_STATE: join(root, 'state'), UNDERTREE_REVIEW_TOKEN: token }, stdio: ['ignore', 'pipe', 'pipe'] });
  const collect = bytes => { serviceLog = (serviceLog + bytes.toString()).slice(-65536); };
  child.stdout.on('data', collect); child.stderr.on('data', collect);
  let port;
  for (let attempt = 0; attempt < 100 && !port; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Native service stopped: ${serviceLog}`);
    port = Number(serviceLog.match(/127\.0\.0\.1:(\d+)/)?.[1]);
    if (!port) await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(port, 'native review service starts');
  base = `http://127.0.0.1:${port}`;
  project = await call({ action: 'add_project', root: projectRoot });
  await call({ action: 'create', project: project.id, path: filename });
  await call({ action: 'bind_github', project: project.id, repository, auto_sync: false });
  let snapshot = await call({ action: 'open', project: project.id, path: filename });
  const firstText = '= Synthetic GitHub qualification\n\nNative dispatch checkpoint.\n';
  await call({ action: 'save', project: project.id, path: filename, revision: snapshot.review.revision, content: firstText });
  const first = await call({ action: 'sync', project: project.id });
  expectedCleanupTip = first.head;
  receipt.steps.push({ operation: 'native_authenticated_push', ...await checkCheckpoint(first.head, firstText) });

  browser = await chromium.launch({ ...(process.env.UNDERTREE_CHROME ? { executablePath: process.env.UNDERTREE_CHROME } : { channel: 'chrome' }), headless: true, args: process.platform === 'linux' ? ['--no-sandbox'] : [] });
  let page = await openBrowser();
  await page.locator('#git-open').click();
  await page.locator('#github-repository').fill(repository);
  await page.locator('#github-auto').check();
  await page.getByRole('button', { name: 'Connect repository', exact: true }).click();
  await page.locator('#review-status').filter({ hasText: 'GitHub repository connected.' }).waitFor();
  await page.locator('#git-dialog [data-close]').click();
  const browserText = '= Synthetic GitHub qualification\n\nBrowser autosave publishes this synthetic checkpoint.\n';
  const browserSync = nextBrowserSync(page);
  await replaceText(page, browserText);
  const browserReply = await (await browserSync).json();
  assert.equal(browserReply.ok, true, browserReply.error?.message);
  expectedCleanupTip = browserReply.result.head;
  assert.notEqual(expectedCleanupTip, first.head);
  receipt.steps.push({ operation: 'rendered_browser_autosave_autosync', ...await checkCheckpoint(expectedCleanupTip, browserText) });
  assert.equal(await git(['status', '--porcelain=v1']), '', 'the checkpoint leaves a clean Git index and working tree');
  await page.screenshot({ path: join(artifactRoot, `live-github-autosync-${nonce}.png`), fullPage: true });
  await page.close();

  await run('git', ['clone', '--single-branch', '--branch', branch, remote, otherRoot]);
  await configure(otherRoot);
  const incomingText = '= Synthetic GitHub qualification\n\nIncoming remote edit for a clean fast-forward.\n';
  const incomingHead = await otherCommit(incomingText, 'UnderTree qualification incoming fast-forward');
  const pulled = await call({ action: 'sync', project: project.id });
  assert.equal(pulled.head, incomingHead);
  assert.equal(await git(['rev-parse', 'HEAD']), incomingHead);
  assert.equal(await readFile(join(projectRoot, filename), 'utf8'), incomingText);
  assert.equal(await git(['status', '--porcelain=v1']), '');
  receipt.steps.push({ operation: 'native_clean_fast_forward_pull', sha: incomingHead, sourceSha256: createHash('sha256').update(incomingText).digest('hex') });

  page = await openBrowser();
  const externalText = '= Synthetic GitHub qualification\n\nNewer remote content must remain on GitHub.\n';
  const externalHead = await otherCommit(externalText, 'UnderTree qualification newer remote conflict');
  const localText = '= Synthetic GitHub qualification\n\nLocal unsynchronized content and this buffer must be preserved.\n';
  const conflictResponse = nextBrowserSync(page);
  await replaceText(page, localText);
  const conflict = await (await conflictResponse).json();
  assert.equal(conflict.ok, false);
  assert.equal(conflict.error.code, 'conflict');
  await page.locator('#review-status').filter({ hasText: 'Automatic GitHub sync paused:' }).waitFor();
  assert.equal(await git(['rev-parse', 'HEAD']), incomingHead, 'conflict does not rewrite local history');
  assert.equal(await remoteHead(), externalHead, 'conflict does not rewrite GitHub history');
  assert.equal(await readFile(join(projectRoot, filename), 'utf8'), localText, 'saved local manuscript remains intact');
  const visibleBuffer = await page.locator('.cm-line').evaluateAll(lines => lines.map(line => line.textContent).join('\n'));
  assert.equal(visibleBuffer, localText, 'editor retains the local manuscript buffer');
  const savedReview = JSON.parse(await readFile(join(projectRoot, sidecar), 'utf8'));
  assert.equal(savedReview.revision, createHash('sha256').update(localText).digest('hex'));
  receipt.steps.push({ operation: 'rendered_autosync_conflict_preservation', errorCode: conflict.error.code, localHead: incomingHead, remoteHead: externalHead, localSourceSha256: savedReview.revision, bufferPreserved: true, automaticSyncPaused: true });
  await page.screenshot({ path: join(artifactRoot, `live-github-conflict-${nonce}.png`), fullPage: true });
  await page.close();
  assert.deepEqual(browserErrors, []);
  receipt.passed = true;
} catch (error) {
  receipt.error = { name: error.name, message: error.message };
  process.exitCode = 1;
} finally {
  await browser?.close();
  if (child) {
    child.kill('SIGINT');
    await new Promise(resolve => { if (child.exitCode !== null) resolve(); else { child.once('exit', resolve); setTimeout(resolve, 3000).unref(); } });
  }
  try {
    const tip = await remoteHead();
    receipt.cleanup.observedTip = tip;
    receipt.cleanup.expectedTip = expectedCleanupTip || null;
    if (tip && tip === expectedCleanupTip) {
      // The lease constrains deletion to our receipt's tip; this command never publishes a rewritten history.
      await git([`--no-optional-locks`, 'push', `--force-with-lease=${ref}:${tip}`, '--delete', remote, branch]);
      assert.equal(await remoteHead(), null);
      receipt.cleanup.deleted = true;
    } else if (tip) {
      receipt.cleanup.reason = 'The remote tip differs from the test receipt. The branch was preserved.';
      process.exitCode = 1;
    }
  } catch (error) {
    receipt.cleanup.error = error.message;
    process.exitCode = 1;
  }
  receipt.finishedAt = new Date().toISOString();
  receipt.browserPageErrors = browserErrors;
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(JSON.stringify({ passed: receipt.passed, branch, branchDeleted: receipt.cleanup.deleted, receipt: receiptPath, steps: receipt.steps.map(step => ({ operation: step.operation, sha: step.sha || step.remoteHead })) }));
  await rm(root, { recursive: true, force: true });
}
