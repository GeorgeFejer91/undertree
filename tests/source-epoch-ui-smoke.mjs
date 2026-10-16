// Real UI + real Rust authority. Epoch replacement is an explicitly stopped-service
// registry fixture; this never calls/invents a public rotation or qualifies native Move.
import assert from 'node:assert/strict';
import { createZrokFixture } from './zrok-fixture.mjs';
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { cp, chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';

assert.equal(process.env.UNDERTREE_EPOCH_LAUNCH, '1', 'Assign coherent binary/assets and an exclusive Chromium slot before launch.');
assert.ok(process.env.UNDERTREE_REVIEW_BINARY && process.env.UNDERTREE_REVIEW_ASSETS, 'Supply matching immutable epoch binary/assets; no default-target fallback.');
assert.ok(process.env.UNDERTREE_TYPST, 'Supply the real Typst compiler for actual main/dependency PDF checks.');
const selectedBinary = resolve(process.env.UNDERTREE_REVIEW_BINARY), selectedAssets = resolve(process.env.UNDERTREE_REVIEW_ASSETS);
const receiptPath = resolve(process.env.UNDERTREE_SOURCE_EPOCH_RECEIPT || 'artifacts/source-epoch-ui-smoke.json');
const temporary = await mkdtemp(join(tmpdir(), 'undertree-source-epoch-ui-'));
const binary = join(temporary, 'undertree-review'), assets = join(temporary, 'assets'), projectRoot = join(temporary, 'project'), state = join(temporary, 'state');
const registryPath = join(state, 'projects.json'), token = randomBytes(32).toString('hex'), project = randomUUID();
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const checks = [], observations = [], traces = [], errors = [], gates = new Set(), processes = [];
const original = '<p>Alpha target.</p>\n', cleanSource = '<p>A clean retained source.</p>\n', firstSource = '<p>First local input.</p>\n';
const sourceFiles = { 'legacy.html': original, 'clean.html': cleanSource, 'first.html': firstSource, 'inactive.html': '<p>Inactive same bytes.</p>\n', 'main.typ': '#include "chapter.typ"\n', 'chapter.typ': '= Epoch publication\n\nSaved chapter prose.\n' };
let zrokFixture, service, browser, port, base, failure, publicTarget, appPath, serviceGeneration = 0;
let serverLog = '';
const redact = text => String(text).replaceAll(token, '[session]');
async function hashes(directory, prefix = '') {
  const result = {};
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name))) {
    const path = join(directory, entry.name), key = join(prefix, entry.name);
    if (entry.isDirectory()) Object.assign(result, await hashes(path, key));
    else { assert.ok(entry.isFile()); result[key] = hash(await readFile(path)); }
  }
  return result;
}
const running = child => child && child.exitCode === null && child.signalCode === null;
const initialBinaryHash = hash(await readFile(selectedBinary)), initialAssets = await hashes(selectedAssets);
async function until(check, message, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    if (service && !running(service)) throw Error('The disposable service exited before this assertion.');
    await delay(80);
  }
  throw Error(message);
}
async function startService(requestedPort = 0) {
  assert.ok(!running(service), 'Fixture may edit registry/start a replacement only after prior Service exits.');
  let output = ''; port = null; serviceGeneration += 1;
  service = spawn(binary, [], { env: { ...process.env, ...zrokFixture.environment, UNDERTREE_REVIEW_PORT: String(requestedPort), UNDERTREE_REVIEW_STATE: state, UNDERTREE_REVIEW_ASSETS: assets, UNDERTREE_REVIEW_TOKEN: token, UNDERTREE_ZROK: zrokFixture.executable, UNDERTREE_TYPST: join(temporary, 'typst-fixture') }, stdio: ['ignore', 'pipe', 'pipe'] });
  processes.push({ generation: serviceGeneration, pid: service.pid });
  for (const stream of [service.stdout, service.stderr]) stream.on('data', bytes => { output += bytes; serverLog = (serverLog + bytes).slice(-32000); port = Number(output.match(/127\.0\.0\.1:(\d+)/)?.[1]); });
  await until(() => !!port, 'The copied Rust service did not start.');
  if (requestedPort) assert.equal(port, requestedPort);
  base = `http://127.0.0.1:${port}`;
}
async function stopService() {
  if (!running(service)) return;
  await local({ action: 'tunnel', enabled: false, reservation: '', public_url: '' });
  const stopped = new Promise(resolve => service.once('exit', resolve)); service.kill('SIGINT');
  await Promise.race([stopped, delay(3000)]);
  if (running(service)) { service.kill('SIGKILL'); await stopped; }
}
async function local(operation, expectedError) {
  const response = await fetch(base + '/api/review', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(operation), signal: AbortSignal.timeout(15000) });
  const envelope = await response.json();
  if (expectedError) { assert.equal(envelope.ok, false); assert.equal(envelope.error?.code, expectedError); return envelope.error; }
  assert.equal(envelope.ok, true, envelope.error?.message); return envelope.result;
}
const sourceText = page => page.locator('.cm-content').evaluate(node => [...node.querySelectorAll('.cm-line')].map(line => line.textContent).join('\n'));
async function waitSource(page, path) { await page.waitForFunction(path => { const selected = document.querySelector('#manuscript-tabs [aria-selected=true]')?.textContent; return (selected === path || selected === path + ' •') && !!document.querySelector('.cm-content'); }, path); }
async function open(page, path) { await page.locator(`.file-button[data-path="${path}"]`).click(); await waitSource(page, path); }
async function menu(page, command) { const target = page.locator(await page.locator('#menu-file-toggle').isVisible() ? '#menu-file' : '#workspace-menu'); if (!(await target.evaluate(node => node.open))) await target.locator(':scope > summary').click(); await target.locator(`[data-command="${command}"]`).click(); }
async function pageFor(label, { pdfProbe = false } = {}) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 }, acceptDownloads: true });
  if (pdfProbe) await page.addInitScript(() => { const ActualWorker = window.Worker; window.__epochPdfWorkers = []; window.Worker = new Proxy(ActualWorker, { construct(target, args) { const worker = Reflect.construct(target, args); window.__epochPdfWorkers.push({ url: String(args[0]), genuine: worker instanceof ActualWorker }); return worker; } }); });
  page.on('pageerror', error => errors.push({ page: label, message: redact(error.message) }));
  page.on('request', request => {
    if (!/\/api\/(review|editor|control)$/.test(new URL(request.url()).pathname)) return;
    const operation = request.postDataJSON();
    traces.push({ page: label, generation: serviceGeneration, action: operation.action, path: operation.path, sourceEpoch: operation.sourceEpoch, revision: operation.revision, contentHash: typeof operation.content === 'string' ? hash(operation.content) : null });
  });
  await page.goto(base + `/manuscript.html#session=${token}`);
  await page.locator('.file-button[data-path="legacy.html"]').waitFor();
  return page;
}
async function holdSave(page, path) {
  const release = deferred(); gates.add(release); let used = false, finished = false, actual, dispatchError;
  const handler = async route => {
    const operation = route.request().postDataJSON();
    if (operation.action !== 'save' || operation.path !== path || used) return route.fallback();
    used = true; await release.promise;
    try {
      const response = await route.fetch({ timeout: 30000 }); actual = await response.json();
      observations.push({ kind: 'held-real-save', path, requestEpoch: operation.sourceEpoch, authorityGeneration: serviceGeneration, ok: actual.ok, responseEpoch: actual.result?.sourceEpoch, errorCode: actual.error?.code, savedContentHash: actual.result?.content ? hash(actual.result.content) : null });
      await route.fulfill({ response });
    } catch (error) { dispatchError = error; await route.abort().catch(() => {}); }
    finally { finished = true; }
  };
  await page.route('**/api/review', handler);
  return { ready: () => until(() => used, 'The preexisting genuine autosave did not reach its held dispatch.'), release: async () => { release.resolve(); await until(() => finished, 'The held real Save did not finish delivery.', 35000); if (dispatchError) throw dispatchError; await page.unroute('**/api/review', handler); gates.delete(release); return actual; } };
}
const sourceWrites = (start = 0) => traces.slice(start).filter(trace => ['save', 'editor_commit', 'mark', 'unmark', 'palette', 'decide', 'reanchor', 'compile', 'import_tex', 'create'].includes(trace.action));
async function appRpc(target, path, method, params = {}) {
  const read = method !== 'tools/call' || ['get_workspace','get_control_result'].includes(params.name);
  let response;
  for (let attempt = 0; attempt < 15; attempt++) {
    response = await fetch(target + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-06-18' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(15000) });
    if (response.status !== 429 || !read) break;
    await delay(100);
  }
  assert.equal(response.status, 200); const result = await response.json(); assert.equal(result.error, undefined); return result.result;
}
const toolValue = reply => { assert.equal(reply.isError, false, JSON.stringify(reply)); return reply.structuredContent.result; };
try {
  await mkdir(projectRoot); await mkdir(state); await cp(selectedAssets, assets, { recursive: true }); await cp(selectedBinary, binary); await chmod(binary, 0o700);
  for (const [path, content] of Object.entries(sourceFiles)) await writeFile(join(projectRoot, path), content);
  const projectRow = { id: project, name: 'Epoch fixture', root: projectRoot, mainDocument: 'main.typ', repository: '', autoSync: false, pending: [], pendingRevisions: {} };
  await writeFile(registryPath, JSON.stringify({ projects: [projectRow], sourceEpochs: { [project]: { 'main.typ': 2, 'chapter.typ': 7, 'inactive.html': 5 } } }));
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  zrokFixture = await createZrokFixture(temporary, join(temporary, 'zrok-target'), 'source-epochs.example.invalid');
  await writeFile(join(temporary, 'typst-fixture'), `#!/bin/sh\nprintf 'compile\\n' >> ${quote(join(temporary, 'compiler-calls'))}\nexec ${quote(process.env.UNDERTREE_TYPST)} "$@"\n`); await chmod(join(temporary, 'typst-fixture'), 0o700);
  await startService();
  const cleanOld = await local({ action: 'open', project, path: 'clean.html' });
  await local({ action: 'mark', project, path: 'clean.html', sourceEpoch: 0, revision: cleanOld.review.revision, from: cleanSource.indexOf('clean'), to: cleanSource.indexOf('clean') + 5, rule: 'protect', prompt: 'Retained old protection.' });
  const legacy = await local({ action: 'open', project, path: 'legacy.html' }); assert.equal(legacy.sourceEpoch, 0);
  await local({ action: 'mark', project, path: 'legacy.html', sourceEpoch: 0, revision: legacy.review.revision, from: original.indexOf('target'), to: original.indexOf('target') + 6, rule: 'protect', prompt: 'Keep this target.' });
  browser = await chromium.launch({ executablePath: process.env.UNDERTREE_CHROME || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
  const mapPage = await pageFor('save-all'); await open(mapPage, 'first.html');
  assert.equal(await mapPage.locator('.file-button[data-path="first.html"]').getAttribute('data-source-epoch'), '0');
  await mapPage.locator('.cm-content').focus(); await mapPage.keyboard.press('Control+End'); await mapPage.keyboard.insertText(' Saved0'); await mapPage.keyboard.press('Control+s');
  await until(async () => (await readFile(join(projectRoot, 'first.html'), 'utf8')) === firstSource + ' Saved0', 'Legacy0 real UI Save did not persist exact bytes.');
  await until(async () => (await mapPage.locator('#save-label').textContent()) === 'Saved locally', 'Legacy0 source did not quiesce.');
  assert.ok(traces.some(trace => trace.page === 'save-all' && trace.action === 'save' && trace.sourceEpoch === 0));
  await delay(850); await until(async () => !(await mapPage.locator('#typst-compile').textContent()).includes('Compiling') && (await mapPage.locator('#typst-preview-status').getAttribute('data-state')) === 'current', 'The earlier independently authorized automatic build did not quiesce.', 60000);
  checks.push('Legacy0 ordinary UI Save and native policy/registration use the compatibility identity without a transport rewrite.');

  await open(mapPage, 'inactive.html');
  await until(() => traces.some(trace => trace.page === 'save-all' && trace.action === 'editor_register' && trace.path === 'inactive.html' && trace.sourceEpoch === 5), 'The original inactive session did not publish its registration.');
  await open(mapPage, 'first.html');
  const mapGate = await holdSave(mapPage, 'first.html'); await mapPage.locator('.cm-content').focus(); await mapPage.keyboard.press('Control+End'); await mapPage.keyboard.insertText(' Held'); await mapGate.ready();
  // Let the genuine700ms automatic compile consume its pending key and enter Save-all.
  // No synthetic timers or second explicit compile create an independently authorized followup.
  await mapPage.waitForFunction(() => document.getElementById('typst-compile').textContent.includes('Compiling'));
  const firstCut = traces.length, registrations = () => traces.filter(trace => trace.page === 'save-all' && trace.action === 'editor_register' && trace.path === 'inactive.html').length;
  const previousRegistrations = registrations();
  await mapPage.getByRole('button', { name: 'Close inactive.html', exact: true }).click();
  const reopening = mapPage.locator('.file-button[data-path="inactive.html"]').click();
  await until(() => registrations() > previousRegistrations, 'Inactive reopened registration did not prove a new real tracked session before releasing Save.');
  const mapResponse = await mapGate.release(); assert.equal(mapResponse.ok, true); await reopening; await waitSource(mapPage, 'inactive.html');
  await mapPage.waitForFunction(() => !document.getElementById('typst-compile').textContent.includes('Compiling'));
  assert.equal(traces.slice(firstCut).some(trace => trace.page === 'save-all' && (trace.action === 'compile' || (trace.action === 'open' && trace.path === 'main.typ') || (trace.action === 'save' && trace.path === 'inactive.html'))), false);
  assert.equal(await readFile(join(projectRoot, 'inactive.html'), 'utf8'), sourceFiles['inactive.html']);
  checks.push('A genuine held Save-all aborts when ordinary UI Close/reopen replaces an inactive same-byte session; it never saves the replacement or sends main Open/Compile.');
  await mapPage.close();

  const compilePage = await pageFor('publication'); await open(compilePage, 'chapter.typ');
  assert.equal(await compilePage.locator('.file-button[data-path="chapter.typ"]').getAttribute('data-source-epoch'), '7');
  const compileStart = traces.length; await compilePage.locator('#typst-compile').click();
  await compilePage.waitForFunction(() => document.getElementById('typst-preview-status').dataset.state === 'current', undefined, { timeout: 60000 });
  const pdf2 = await local({ action: 'pdf', project, path: 'main.typ' }); assert.equal(pdf2.available, true); assert.equal(pdf2.sourceEpoch, 2); assert.equal(pdf2.current, true);
  const mainActions = traces.slice(compileStart).filter(trace => trace.page === 'publication' && ['open', 'compile'].includes(trace.action));
  assert.ok(mainActions.some(trace => trace.action === 'compile')); assert.ok(mainActions.every(trace => trace.path === 'main.typ' && trace.sourceEpoch === 2));
  const savedMain = await local({ action: 'review', project, path: 'main.typ' });
  const beforeDenial = await hashes(projectRoot), compilerBefore = await readFile(join(temporary, 'compiler-calls'));
  for (const operation of [{ action: 'save', revision: savedMain.review.revision, content: 'Forbidden' }, { action: 'compile', revision: savedMain.review.revision }, { action: 'share', enabled: true }]) await local({ ...operation, project, path: 'main.typ', sourceEpoch: 0 }, 'stale_document');
  assert.deepEqual(await hashes(projectRoot), beforeDenial); assert.deepEqual(await readFile(join(temporary, 'compiler-calls')), compilerBefore);
  checks.push('Actual main2/chapter7 Typst publication is current; native stale0 Save/Share-on/Compile denials preserve exact project bytes and never invoke the compiler.');
  const pdf2Hash = hash(Buffer.from(pdf2.base64, 'base64')); await compilePage.close();

  const dirtyPage = await pageFor('retained-dirty'), cleanPage = await pageFor('retained-clean');
  await open(dirtyPage, 'legacy.html'); await open(cleanPage, 'clean.html'); await cleanPage.locator('#review-toggle').click();
  await dirtyPage.locator('#review-toggle').click(); await dirtyPage.locator('#manuscript-share').check();
  await local({ action: 'tunnel', enabled: true, reservation: 'epoch-fixture', public_url: 'https://source-epochs.example.invalid' });
  await dirtyPage.locator('#connection-open').click(); await dirtyPage.locator('#connection-tab-app').click(); await dirtyPage.locator('#connection-app-enabled').check();
  await until(async () => (await local({ action: 'connection' })).appControls.enabled === true, 'The real local App grant did not become enabled.');
  const connection = await local({ action: 'connection' }); appPath = new URL(connection.appControls.endpoint).pathname; publicTarget = await readFile(join(temporary, 'zrok-target'), 'utf8');
  await appRpc(publicTarget, appPath, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'Source epoch gate', version: '1' } });
  await dirtyPage.keyboard.press('Escape');
  const dirtyGate = await holdSave(dirtyPage, 'legacy.html'); await dirtyPage.locator('.cm-content').focus(); await dirtyPage.keyboard.press('Control+Home'); await dirtyPage.keyboard.insertText('X'); await dirtyGate.ready();
  await until(async () => { const reply = await appRpc(publicTarget, appPath, 'tools/call', { name: 'get_workspace', arguments: {} }); return !reply.isError && toolValue(reply).workspace.openDocuments.some(document => document.dirty); }, 'The actual UI dirty state did not reach its current native App grant.');
  const remoteCut = traces.length, beforeRemote = await hashes(projectRoot);
  const remote = await appRpc(publicTarget, appPath, 'tools/call', { name: 'set_window_state', arguments: { state: 'close', requestId: 'dirty-close' } });
  if (remote.isError) {
    const message = remote.content.map(item => item.text || '').join('\n');
    assert.ok(['Save or resolve local buffers before remotely closing UnderTree.', 'Local buffers must be saved and composition/conflicts resolved before this app control.'].includes(message), `Unexpected remote Close refusal: ${message}`);
    observations.push({ kind: 'remote-dirty-close-native-refusal', message });
  }
  else { let terminal; await until(async () => { terminal = toolValue(await appRpc(publicTarget, appPath, 'tools/call', { name: 'get_control_result', arguments: { requestId: 'dirty-close' } })); return !['queued', 'dispatched'].includes(terminal.state); }, 'Remote Close did not reach a terminal denial.'); assert.equal(terminal.state, 'rejected'); assert.equal(terminal.code, 'busy'); }
  assert.deepEqual(sourceWrites(remoteCut), []); assert.deepEqual(await hashes(projectRoot), beforeRemote); assert.equal(dirtyPage.isClosed(), false);
  checks.push('A real current App grant refuses dirty remote Close as busy, without source writes or a browser unsupported-window fallback.');

  // Stop first. Only then edit the disposable registry fixture. This does not
  // model native Move, preserve old owner identity, or mutate running authority.
  await local({ action: 'tunnel', enabled: false, reservation: '', public_url: '' }); const originalPort = port; await stopService();
  assert.equal(running(service), false);
  const registry = JSON.parse(await readFile(registryPath, 'utf8'));
  Object.assign(registry.sourceEpochs[project], { 'legacy.html': 1, 'clean.html': 1, 'main.typ': 3, 'retired-new.html': 1 });
  await writeFile(registryPath, JSON.stringify(registry)); const beforeRestart = await hashes(projectRoot);
  await startService(originalPort); assert.equal(await readFile(join(projectRoot, 'legacy.html'), 'utf8'), original);
  const rejected = await dirtyGate.release(); assert.equal(rejected.ok, false); assert.equal(rejected.error.code, 'stale_document');
  await dirtyPage.locator('#review-policy-problem[data-problem="stale_document"]').waitFor();
  await cleanPage.locator('#review-policy-problem[data-problem="stale_document"]').waitFor({ timeout: 15000 });
  assert.deepEqual(await hashes(projectRoot), beforeRestart);
  assert.match(await dirtyPage.locator('#review-passages').textContent(), /target/); assert.match(await sourceText(dirtyPage), /^X<p>/);
  const staleCut = traces.length;
  const downloading = dirtyPage.waitForEvent('download'); await dirtyPage.locator('#review-policy-problem').getByRole('button', { name: 'Export my buffer', exact: true }).click();
  assert.equal(await readFile(await (await downloading).path(), 'utf8'), 'X' + original);
  await dirtyPage.locator('.cm-content').focus(); await dirtyPage.keyboard.press('Control+z'); assert.equal((await sourceText(dirtyPage)).trimEnd(), original.trimEnd()); await dirtyPage.keyboard.press('Control+Shift+z'); assert.equal((await sourceText(dirtyPage)).trimEnd(), ('X' + original).trimEnd());
  await dirtyPage.keyboard.press('Control+s'); await delay(850); assert.deepEqual(sourceWrites(staleCut), []); assert.deepEqual(await hashes(projectRoot), beforeRestart);
  observations.push({ kind: 'fixture-restart-replacement', serviceGenerations: processes.map(item => item.generation), legacyEpochs: [0, 1], mainEpochs: [2, 3], sourceBytesEqual: true, oldEditorOwnersExpired: true });
  checks.push('Stopped-service same-byte replacement makes genuine old Save0 fail against authority1; draft, protection, buffer export and actual Undo/Redo survive without a fresh save intent.');

  const freshPage = await pageFor('fresh-main', { pdfProbe: true }); let stalePdf;
  await freshPage.route('**/api/review', async route => { const operation = route.request().postDataJSON(); if (operation.action !== 'pdf' || operation.path !== 'main.typ' || stalePdf) return route.continue(); const response = await route.fetch(); stalePdf = await response.json(); assert.equal(stalePdf.ok, true); assert.equal(stalePdf.result.sourceEpoch, 2); assert.equal(stalePdf.result.current, false); assert.equal(hash(Buffer.from(stalePdf.result.base64, 'base64')), pdf2Hash); return route.fulfill({ response }); });
  const workersBefore = await freshPage.evaluate(() => window.__epochPdfWorkers);
  await open(freshPage, 'main.typ'); await until(() => !!stalePdf, 'The actual retained previous-epoch PDF was not observed.');
  await freshPage.waitForFunction(() => /another source identity/.test(document.getElementById('review-status').textContent));
  assert.equal(await freshPage.locator('#typst-pages canvas').count(), 0); assert.equal(await freshPage.locator('#export-pdf').evaluate(node => node.hidden), true); assert.deepEqual(await freshPage.evaluate(() => window.__epochPdfWorkers), workersBefore); assert.equal(await freshPage.locator('#review-policy-problem').count(), 0); assert.equal((await sourceText(freshPage)).trimEnd(), sourceFiles['main.typ'].trimEnd());
  assert.equal(await freshPage.locator('.file-button[data-path="main.typ"]').getAttribute('data-source-epoch'), '3'); await freshPage.close();
  checks.push('Fresh main3 refuses the real stored main2 PDF without new native Worker/canvas/export adoption; artifact age alone does not freeze valid source3.');

  const closeCut = traces.length;
  await cleanPage.getByRole('button', { name: 'Close clean.html', exact: true }).click(); await cleanPage.locator('#manuscript-tabs [role=tab]').waitFor({ state: 'detached' });
  assert.deepEqual(sourceWrites(closeCut), []);
  const cleanObserved = await local({ action: 'review', project, path: 'clean.html' }); assert.equal(cleanObserved.sourceEpoch, 1);
  // Separate startup-retired absent path: never observed by this Service's policy witness.
  // Keep clean.html and its known policy bytes intact; retirement cannot reset policy_missing.
  assert.ok(cleanObserved.review.markers.length > 0);
  const cleanBundle = [await readFile(join(projectRoot, 'clean.html')), await readFile(join(projectRoot, 'clean.html.undertree-review.json'))];
  await menu(cleanPage, 'new-file'); await cleanPage.locator('#new-path').fill('retired-new.html'); await cleanPage.locator('#new-form button[type=submit]').click(); await waitSource(cleanPage, 'retired-new.html');
  const created = await local({ action: 'review', project, path: 'retired-new.html' }); assert.equal(created.sourceEpoch, 2); assert.deepEqual(created.review.markers, []);
  assert.deepEqual([await readFile(join(projectRoot, 'clean.html')), await readFile(join(projectRoot, 'clean.html.undertree-review.json'))], cleanBundle);
  const createdBuffer = await sourceText(cleanPage); await cleanPage.locator('#source-undo').click(); assert.equal(await sourceText(cleanPage), createdBuffer);
  assert.ok(traces.slice(closeCut).some(trace => trace.action === 'create' && trace.path === 'retired-new.html' && trace.sourceEpoch === undefined));
  checks.push('Explicit local clean known-stale Close sends no Save; separate never-witnessed absent retired path receives native Create2 with no epoch input, preserving the old protected bundle. Same-path witness removal is not reset or qualified.');

  await local({ action: 'tunnel', enabled: true, reservation: 'epoch-fixture', public_url: 'https://source-epochs.example.invalid' });
  const newPublicTarget = await readFile(join(temporary, 'zrok-target'), 'utf8');
  const revoked = await fetch(newPublicTarget + appPath, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) }); assert.equal(revoked.status, 401);
  assert.deepEqual(errors, []);
  checks.push('The old App endpoint stays revoked at the replacement instance; this is instance-owner revocation, not same-instance clean-identity remote Close proof.');
} catch (error) {
  failure = error;
  if (browser) for (const [index, context] of browser.contexts().entries()) for (const [pageIndex, page] of context.pages().entries()) await page.screenshot({ path: receiptPath.replace(/\.json$/, `-failure-${index}-${pageIndex}.png`) }).catch(() => {});
  throw error;
} finally {
  // Resolve only owned fixture gates; never perform a fallback save/retry to clean up.
  for (const gate of gates) gate.resolve();
  if (running(service) && base) await local({ action: 'tunnel', enabled: false, reservation: '', public_url: '' }).catch(() => {});
  await browser?.close().catch(() => {}); await stopService();
  try { const pid = Number(await readFile(join(temporary, 'pid'), 'utf8')); if (Number.isInteger(pid) && pid > 1) try { process.kill(pid, 'SIGTERM'); } catch {} } catch {}
  const selectedInputsUnchanged = hash(await readFile(selectedBinary)) === initialBinaryHash && JSON.stringify(await hashes(selectedAssets)) === JSON.stringify(initialAssets);
  const passed = !failure && selectedInputsUnchanged;
  await mkdir(resolve(receiptPath, '..'), { recursive: true });
  await writeFile(receiptPath, JSON.stringify({ result: passed ? 'passed' : 'failed', error: failure ? redact(failure.message) : selectedInputsUnchanged ? null : 'Selected immutable inputs changed.', runnerSha256: hash(await readFile(new URL(import.meta.url))), binarySha256: initialBinaryHash, selectedBinary, selectedAssets, frontend: initialAssets, selectedInputsUnchanged, checks, observations, errors, traces, serviceProcesses: processes, serverLogSha256: hash(serverLog), limits: 'Registry replacement only while stopped; no native Rename/live rotation/same-instance retained-owner proof. Browser Map replacement uses same epoch; changed-epoch and same-object/unknown-Move/held-PDF-parse guards are separately qualified unit cases. Fake zrok only; actual Rust and Typst results unchanged.' }, null, 2) + '\n');
  await rm(temporary, { recursive: true, force: true });
  if (!selectedInputsUnchanged) throw Error('Selected immutable qualification inputs changed.');
}
console.log(`Source epochs: ${checks.length} actual browser/native-boundary checks passed; restart-fixture limits retained.`);
