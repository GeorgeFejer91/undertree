import { confirmContextShareUi, readFixtureContext, markFixturePassage } from './context-fixture.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { createZrokFixture } from './zrok-fixture.mjs';

const source = '<p>First saved passage for live review.</p>\n<p>Second saved passage for live review.</p>\n<p>Third saved passage for live review.</p>\n';
const baseline = Buffer.from(source), hash = bytes => createHash('sha256').update(bytes).digest('hex');
const runnerSha256 = hash(await readFile(new URL(import.meta.url)));
const inputBinary = resolve(process.env.UNDERTREE_REVIEW_BINARY || `target/debug/undertree-review${process.platform === 'win32' ? '.exe' : ''}`);
const inputAssets = resolve(process.env.UNDERTREE_REVIEW_ASSETS || 'dist');
const output = resolve(process.env.UNDERTREE_REALTIME_RECEIPT || 'artifacts/review-realtime-smoke.json');
const root = await mkdtemp(join(tmpdir(), 'undertree-review-realtime-')), projectRoot = join(root, 'project'), assets = join(root, 'assets');
const binary = join(root, `undertree-review${process.platform === 'win32' ? '.exe' : ''}`), token = randomBytes(32).toString('hex');
const errors = [], notifications = [], reviewReads = [], submissions = [], arrivals = [], attempts = [], checks = [];
const requestTimes = new WeakMap(), boundMs = 1500;
const observerJobs = new Set();
const performanceViolations = [], functionalWaitMs = 10_000;
const shareSetupAttempts = [];
let service, browser, page, project, base, port, endpoint, documentId, log = '', failure, draft, finalReview, editorOwner, ownerReplaced = false;
let transportBusyResponses = 0, quietReadBusyResponses = 0;
async function until(check, message) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    if (service?.exitCode !== null && service?.exitCode !== undefined) throw Error('The isolated native service exited.');
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw Error(message);
}
async function local(operation) {
  let value;
  await until(async () => {
    value = await fetch(base + '/api/review', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, Connection: 'close' }, body: JSON.stringify(operation), signal: AbortSignal.timeout(10_000) }).then(r => r.json());
    return value.error?.code !== 'busy';
  }, 'The native observation remained busy.');
  assert.equal(value.ok, true, value.error?.message); return value.result;
}
async function rpc(method, params, allowError = false) {
  let reply;
  await until(async () => {
    const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-06-18', Connection: 'close' }, body: JSON.stringify({ jsonrpc: '2.0', id: randomBytes(8).toString('hex'), method, params }), signal: AbortSignal.timeout(15_000) });
    if (response.status === 429) { transportBusyResponses++; await response.arrayBuffer(); return false; }
    assert.equal(response.status, 200); reply = await response.json(); return !['A local document operation is running. Retry this action.', 'A local editor operation is running. Retry this action.'].some(message => JSON.stringify(reply).includes(message));
  }, 'MCP remained explicitly busy.');
  assert.equal(reply.error, undefined); if (!allowError) assert.notEqual(reply.result?.isError, true, JSON.stringify(reply)); return reply.result;
}
const value = reply => reply.structuredContent?.result ?? JSON.parse(reply.content.find(c => c.type === 'text').text);
const saved = () => local({ action: 'review', project: project.id, path: 'realtime.html' });
const editorText = () => page.locator('.cm-content').evaluate(node => [...node.querySelectorAll('.cm-line')].map(line => line.textContent).join('\n'));
async function unchanged() { assert.deepEqual(await readFile(join(projectRoot, 'realtime.html')), baseline, 'Remote arrivals must not change source bytes.'); if (draft !== undefined) assert.equal(await editorText(), draft, 'Metadata refresh must preserve the exact local draft.'); }
async function observe(response) {
  const request = response.request(), action = request.postDataJSON()?.action;
  if (!['review_changes', 'review'].includes(action)) return;
  const nodeObservedAt = Date.now(), timing = request.timing();
  const body = await response.json();
  const entry = { requestAt: timing.startTime, responseAt: timing.startTime + timing.responseStart, nodeRequestObservedAt: requestTimes.get(request), nodeResponseObservedAt: nodeObservedAt, action, ok: body.ok };
  if (action === 'review_changes') notifications.push({ ...entry, after: request.postDataJSON().after, result: body.result, error: body.error });
  else reviewReads.push({ ...entry, error: body.error, suggestionIds: body.result?.review?.suggestions?.map(s => s.id) || [] });
}
async function afterFallback() {
  const response = await page.waitForResponse(async response => {
    if (!response.url().endsWith('/api/review') || response.request().postDataJSON()?.action !== 'review') return false;
    const body = await response.json();
    if (!body.ok) {
      if (body.error?.code === 'busy' && body.error.message === 'A local document operation is running. Retry this action.') { quietReadBusyResponses++; return false; }
      assert.fail(`Quiet metadata observation refused: ${body.error?.code || 'unknown'} ${body.error?.message || ''}`);
    }
    const lastWake = notifications.filter(n => n.result?.changed).at(-1)?.responseAt || 0;
    return Date.now() - lastWake > 1000;
  }, { timeout: 15_000 });
  assert.equal((await response.json()).ok, true);
  return Date.now();
}
async function shareThroughUi() {
  const observedRoot = await saved();
  const sourceBinding = { sourceEpoch: observedRoot.sourceEpoch, expectedRoot: observedRoot.expectedRoot };
  const boundReview = () => local({ action: 'review', project: project.id, path: 'realtime.html', ...sourceBinding });
  const binding = await boundReview(); assert.equal(binding.shared, false); assert.equal(binding.content, source);
  await until(() => !!editorOwner, 'The actual browser editor owner was not registered.');
  const owner = editorOwner;
  for (let attempt = 1; attempt <= 4; attempt++) {
    assert.equal(ownerReplaced, false); assert.equal(editorOwner, owner);
    const sharing = page.waitForResponse(response => response.url().endsWith('/api/review') && response.request().postDataJSON()?.action === 'share');
    await page.locator('#manuscript-share').click(); await confirmContextShareUi(page, ['realtime.html']); const shared = await (await sharing).json();
    if (shared.ok) { assert.equal(shared.result.shared, true); assert.equal(shared.result.documentId, binding.documentId); assert.equal(shared.result.sourceEpoch, binding.sourceEpoch); assert.deepEqual(shared.result.expectedRoot, binding.expectedRoot); assert.equal(ownerReplaced, false); assert.equal(editorOwner, owner); shareSetupAttempts.push({ attempt, shared: true, sameOwner: true, sameBinding: true }); return; }
    if (shared.error?.code !== 'busy' || shared.error.message !== 'A local document operation is running. Retry this action.') assert.fail(`Share setup refused without safe replay permission: ${shared.error?.code || 'unknown'} ${shared.error?.message || ''}`);
    await until(async () => !await page.locator('#manuscript-share').isChecked(), 'The refused Share action did not return to its unshared UI state.');
    const observed = await boundReview();
    assert.equal(observed.shared, false); assert.equal(observed.documentId, binding.documentId); assert.equal(observed.path, binding.path); assert.equal(observed.sourceEpoch, binding.sourceEpoch); assert.deepEqual(observed.expectedRoot, binding.expectedRoot); assert.equal(observed.content, source);
    assert.equal(ownerReplaced, false); assert.equal(editorOwner, owner);
    assert.equal(await page.locator('.file-button[data-path="realtime.html"]').getAttribute('aria-current'), 'true');
    shareSetupAttempts.push({ attempt, refusedPreDispatchBusy: true, stillUnshared: true, sameBinding: true, sameOwner: true });
  }
  assert.fail('Share setup remained explicitly busy after four verified UI attempts.');
}
function proposal(index, revision) {
  const ordinal = ['First', 'Second', 'Third'][index], quote = `${ordinal} saved passage for live review.`;
  return { requestId: `realtime-scripted-${index + 1}`, revision, from: source.indexOf(quote), to: source.indexOf(quote) + quote.length, quote, replacement: `${ordinal} saved passage with a pending remote wording proposal.`, rationale: 'Scripted transport/UI timing fixture; not an editorial model evaluation. Never auto-accept.' };
}
async function submit(item, phase, baselineAt) {
  const context = await readFixtureContext(rpc, documentId); item = { ...item, contextId: context.contextId };
  const startedAt = Date.now(), reply = value(await rpc('tools/call', { name: 'suggest_text', arguments: { documentId, proposal: item } }));
  assert.equal(reply.manuscriptChanged, false); assert.equal(reply.suggestion.status, 'pending');
  const submittedAt = Date.now(), submission = { phase, baselineAt, startedAt, submittedAt, submissionMs: submittedAt - startedAt, proposal: item, id: reply.suggestion.id, status: reply.suggestion.status, manuscriptChanged: reply.manuscriptChanged };
  submissions.push(submission); return submission;
}
async function rendered(arrival) {
  const card = page.locator(`.suggestion-card[data-review-id="${arrival.id}"]`);
  await page.waitForFunction(id => window.__reviewArrivalTimes[id] !== undefined, arrival.id, { timeout: functionalWaitMs });
  const renderedAt = await page.evaluate(id => window.__reviewArrivalTimes[id], arrival.id), observedAt = Date.now(), latencyMs = renderedAt - arrival.startedAt;
  const deliveryLatencyMs = renderedAt - (arrival.metadataReleasedAt || arrival.startedAt);
  const measurement = { ...arrival, renderedAt, observedAt, latencyMs, deliveryLatencyMs, intentionallyHeldDelivery: !!arrival.metadataReleasedAt, responseToRenderMs: renderedAt - arrival.submittedAt };
  arrivals.push(measurement);
  assert.equal(await card.locator('blockquote del').textContent(), arrival.proposal.quote); assert.equal(await card.locator('.replacement').textContent(), arrival.proposal.replacement);
  assert.equal(await card.count(), 1);
  if (deliveryLatencyMs > boundMs) performanceViolations.push({ id: arrival.id, phase: arrival.phase, latencyMs, deliveryLatencyMs, targetMs: boundMs, submissionMs: arrival.submissionMs, responseToRenderMs: measurement.responseToRenderMs });
  await Promise.all([...observerJobs]);
  const wake = notifications.find(n => n.result?.changed && n.responseAt >= (arrival.wakeAfter || arrival.startedAt) && n.responseAt <= renderedAt);
  assert.ok(wake, 'An actual changed:true native notification must precede the rendered arrival.');
  const refresh = reviewReads.find(r => r.ok && (arrival.metadataReleasedAt ? r.responseAt >= wake.responseAt : r.requestAt >= wake.responseAt) && r.requestAt <= renderedAt && r.suggestionIds.includes(arrival.id));
  assert.ok(refresh, 'A metadata read after the native wake (or held in-flight response after it) must return this exact new suggestion.');
  if (!arrival.wakeAfter && !arrival.metadataReleasedAt) assert.ok(arrival.startedAt - arrival.baselineAt < 1000, 'Start each arrival group soon after an observed fallback.');
  Object.assign(measurement, { changedNotification: wake, metadataRead: refresh }); await unchanged();
}
try {
  assert.ok(process.env.UNDERTREE_CHROME, 'Supply an actual Chrome executable.');
  await mkdir(resolve('artifacts'), { recursive: true }); await mkdir(projectRoot); await cp(inputBinary, binary); await cp(inputAssets, assets, { recursive: true }); await writeFile(join(projectRoot, 'realtime.html'), baseline);
  const targetFile = join(root, 'zrok-target'), fixture = await createZrokFixture(root, targetFile, 'realtime-review.example.org');
  service = spawn(binary, [], { windowsHide: true, env: { ...process.env, ...fixture.environment, UNDERTREE_REVIEW_PORT: '0', UNDERTREE_REVIEW_STATE: join(root, 'state'), UNDERTREE_REVIEW_ASSETS: assets, UNDERTREE_REVIEW_TOKEN: token, UNDERTREE_ZROK: fixture.executable }, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [service.stdout, service.stderr]) stream.on('data', bytes => { log = (log + bytes).slice(-10_000); port = Number(log.match(/127\.0\.0\.1:(\d+)/)?.[1]); });
  await until(() => !!port, 'The isolated realtime service did not start.'); base = `http://127.0.0.1:${port}`; project = await local({ action: 'add_project', root: projectRoot });
  const initial = await local({action:'open',project:project.id,path:'realtime.html'});
  for (let index = 0; index < 3; index++) await markFixturePassage(local, project.id, initial, proposal(index, initial.review.revision).quote);
  browser = await chromium.launch({ executablePath: process.env.UNDERTREE_CHROME, headless: true, args: ['--no-sandbox'] }); page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
  page.on('pageerror', e => errors.push(e.message));
  page.on('request', request => {
    if (request.url().endsWith('/api/editor') || request.url().endsWith('/api/review')) requestTimes.set(request, Date.now());
    if (request.url().endsWith('/api/editor')) { const owner = request.headers()['x-undertree-editor']; if (owner) { if (editorOwner && editorOwner !== owner) ownerReplaced = true; editorOwner = owner; } }
  });
  page.on('response', response => {
    if (!response.url().endsWith('/api/editor') && !response.url().endsWith('/api/review')) return;
    const job = observe(response).catch(e => errors.push(`Network observation: ${e.message}`)); observerJobs.add(job); void job.finally(() => observerJobs.delete(job));
  });
  await page.goto(base + `/manuscript.html#session=${token}`); await page.locator('.file-button[data-path="realtime.html"]').click(); await page.locator('.cm-content').waitFor();
  await page.evaluate(() => {
    window.__reviewArrivalTimes = Object.create(null);
    const capture = () => {
      for (const card of document.querySelectorAll('.suggestion-card[data-review-id]')) {
        if (card.querySelector('blockquote del')?.textContent && card.querySelector('.replacement')?.textContent && window.__reviewArrivalTimes[card.dataset.reviewId] === undefined) window.__reviewArrivalTimes[card.dataset.reviewId] = Date.now();
      }
    };
    new MutationObserver(capture).observe(document.querySelector('#review-list'), { childList: true, subtree: true, characterData: true }); capture();
  });
  const tunnel = await local({ action: 'tunnel', enabled: true, reservation: 'realtime-fixture', public_url: 'https://realtime-review.example.org/' }); endpoint = (await readFile(targetFile, 'utf8')).trim() + new URL(tunnel.endpoint).pathname;
  if (await page.locator('#review-toggle').getAttribute('aria-pressed') !== 'true') await page.locator('#review-toggle').click();
  await shareThroughUi();
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'UnderTree realtime UI qualification', version: '1' } });
  assert.deepEqual((await rpc('tools/list', {})).tools.map(t => t.name).sort(), ['highlight_text', 'list_manuscripts', 'read_manuscript', 'suggest_text']);
  const inventory = value(await rpc('tools/call', { name: 'list_manuscripts', arguments: {} })); assert.equal(inventory.length, 1); documentId = inventory[0].documentId;
  const current = value(await rpc('tools/call', { name: 'read_manuscript', arguments: { documentId } })); assert.equal(current.content, source);
  await until(() => notifications.some(n => n.ok && typeof n.result?.instanceId === 'string' && typeof n.result?.sequence === 'string'), 'The real owner-authenticated review_changes channel did not initialize.');
  await page.locator('#review-toggle').click(); assert.equal(await page.locator('#review-toggle').getAttribute('aria-pressed'), 'false');
  const firstBaseline = await afterFallback(), first = await submit(proposal(0, current.review.revision), 'clean', firstBaseline); await rendered(first);
  assert.equal(await page.locator('#review-toggle').getAttribute('aria-pressed'), 'true', 'The actual arrival must reveal Review on this desktop-sized viewport.');
  checks.push('A real MCP proposal renders from a native changed notification without a manual refresh; the separate 1500 ms target is measured for every card.');
  // Create valid proposals against clean complete context, then hold their actual metadata
  // delivery while a draft is typed. No new context/proposal is authorized by that draft.
  const dirtyBaseline = await afterFallback();
  let releaseMetadata; const metadataGate = new Promise(resolve => { releaseMetadata = resolve; });
  const holdMetadata = async route => {
    const operation = route.request().postDataJSON();
    if (operation?.action === 'save') {
      attempts.push({ action: 'save', blocked: true, at: Date.now() });
      return route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({ok:false,error:{code:'busy',message:'The isolated realtime fixture keeps this explicitly typed local draft unsaved.'}})});
    }
    if (operation?.action !== 'review') return route.continue();
    const response = await route.fetch(); await metadataGate; await route.fulfill({response});
  };
  await page.route('**/api/review', holdMetadata);
  const second = await submit(proposal(1, current.review.revision), 'draft-delivery-race', dirtyBaseline);
  const third = await submit(proposal(2, current.review.revision), 'draft-delivery-race', dirtyBaseline); third.wakeAfter = second.startedAt;
  const contextBeforeDraft = await readFixtureContext(rpc, documentId);
  const dirtyRegistered = page.waitForResponse(async response => response.url().endsWith('/api/editor') && response.request().postDataJSON()?.dirty === true && (await response.json()).ok);
  await page.locator('.cm-content').focus(); await page.keyboard.press('Control+End'); await page.keyboard.insertText('<p>Local unsaved draft remains mine.</p>');
  await dirtyRegistered;
  await until(async () => await page.locator('#save-label').textContent() === 'Unsaved changes', 'The local draft did not become dirty.');
  draft = await editorText(); assert.ok(draft.includes('Local unsaved draft remains mine.'));
  second.metadataReleasedAt = third.metadataReleasedAt = Date.now(); releaseMetadata();
  await rendered(second); await rendered(third); checks.push('Two valid clean-context MCP proposals arrive during a local draft without changing any draft or source byte.');
  const deniedRead = await rpc('tools/call', {name:'read_manuscript',arguments:{documentId}}, true);
  assert.equal(deniedRead.isError, true); assert.match(JSON.stringify(deniedRead), /draft|unsaved|saved|buffer/i);
  const deniedProposal = await rpc('tools/call', {name:'suggest_text',arguments:{documentId,proposal:{...proposal(2,current.review.revision),requestId:'new-proposal-while-dirty',contextId:contextBeforeDraft.contextId}}}, true);
  assert.equal(deniedProposal.isError, true); assert.match(JSON.stringify(deniedProposal), /draft|unsaved|saved|buffer/i);
  checks.push('Fresh complete context and new proposals are refused while a registered manuscript draft is dirty; no implicit Save occurs.');
  const replay = value(await rpc('tools/call', { name: 'suggest_text', arguments: { documentId, proposal: second.proposal } })); assert.equal(replay.suggestion.id, second.id);
  await afterFallback(); assert.equal(await page.locator('.suggestion-card').count(), 3);
  const latest = await saved(); assert.equal(latest.review.suggestions.length, 3); assert.ok(latest.review.suggestions.every(s => s.status === 'pending')); await unchanged(); finalReview = latest.review;
  assert.equal(await page.locator('#save-label').textContent(), 'Unsaved changes'); assert.deepEqual(errors, []);
  checks.push('Identical request replay keeps one proposal/card; all three remain pending and no edit is accepted.');
  if (performanceViolations.length) process.exitCode = 1;
  await page.screenshot({ path: resolve('artifacts/review-realtime-smoke.png') }); console.log(`Realtime review: ${arrivals.length} functional arrivals passed; ${performanceViolations.length} exceeded the ${boundMs} ms target; saved source and dirty draft preserved.`);
} catch (error) { failure = error; process.exitCode = 1; await page?.screenshot({ path: resolve('artifacts/review-realtime-failure.png') }).catch(() => {}); console.error(`REALTIME_FAILED ${error.message}`); }
finally {
  const finalSource = await readFile(join(projectRoot, 'realtime.html')).catch(() => null);
  const observedDraft = page ? await editorText().catch(() => null) : null;
  await writeFile(output, JSON.stringify({ result: failure ? 'fail' : performanceViolations.length ? 'partial' : 'pass', error: failure?.message, functionalPassed: !failure, performanceTargetPassed: !failure && performanceViolations.length === 0, synthetic: true, scriptedRemoteProposals: true, actualLLMEditorialTest: false, publicTunnelOrAccountConnection: false, boundMs, functionalWaitMs, performanceViolations, shareSetupAttempts, shareSetupAttemptCount: shareSetupAttempts.length, editorOwnerUnchanged: !ownerReplaced, submissions, arrivals, domArrivalTimes: await page?.evaluate(() => window.__reviewArrivalTimes).catch(() => null), notifications, reviewReads, checks, errors, blockedLocalAutosaveAttempts: attempts, transportBusyResponses, quietReadBusyResponses, source, draft, observedDraft, draftMatches: draft === undefined ? null : observedDraft === draft, finalPendingCount: finalReview?.suggestions.length, allPending: finalReview && finalReview.suggestions.every(s => s.status === 'pending'), sourceUnchanged: finalSource?.equals(baseline), baselineSha256: hash(baseline), observedSourceSha256: finalSource && hash(finalSource), binarySha256: await readFile(binary).then(hash).catch(() => null), frontendHtmlSha256: await readFile(join(assets, 'manuscript.html')).then(hash).catch(() => null), runnerSha256 }, null, 2) + '\n').catch(() => {});
  if (base && service?.exitCode === null) await local({ action: 'tunnel', enabled: false, reservation: '', public_url: '' }).catch(() => {});
  await browser?.close(); service?.kill('SIGINT');
  if (service) { await Promise.race([new Promise(resolve => { if (service.exitCode !== null) resolve(); else service.once('exit', resolve); }), new Promise(resolve => setTimeout(resolve, 3000))]); if (service.exitCode === null) service.kill('SIGKILL'); }
  assert.ok(resolve(root).startsWith(join(resolve(tmpdir()), 'undertree-review-realtime-')), 'Cleanup stays inside this explicitly created temporary fixture.'); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
