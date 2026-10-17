import { readFixtureContext } from './context-fixture.mjs';
import { confirmContextShareUi } from './context-fixture.mjs';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { access, chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { chromium } from 'playwright-core';
import { createZrokFixture } from './zrok-fixture.mjs';

const scenarios = [
  { id: 'shorten-results', label: 'Shorten results, preserve numbers', color: '#409b64', shorten: true,
    quote: 'In this synthetic demonstration, we conducted a comparison in which the intervention group contained 40 participants and the control group contained 40 participants. The average task score in the intervention group was 18.2, while the average task score in the control group was 15.7. The difference between those averages was therefore 2.5 points. These values are descriptive; no significance test was conducted.',
    prompt: 'Shorten this synthetic results paragraph. Preserve both group sizes (40 each), both means (18.2 and 15.7), the difference (2.5 points), and the fact that no significance test was conducted. Do not invent uncertainty intervals or significance claims.' },
  { id: 'causal-restraint', label: 'Remove causal overclaim', color: '#d3a22d',
    quote: 'In a synthetic observational sample of 120 participants, sleep duration correlated with attention scores, r = 0.32. This association proves that longer sleep causes better attention.',
    prompt: 'Correct the causal overclaim while retaining the observational design, sample size 120, and correlation r = 0.32. State an association and that this design does not establish causation. Do not infer interventions, confounder adjustment or statistical significance.' },
  { id: 'introduction-focus', label: 'Focus the introduction', color: '#5d87b9',
    quote: 'Memory research is important and interesting. Many things are known about memory, and many questions remain. Our synthetic study concerns whether novice users recall instructions after a fixed laboratory task.',
    prompt: 'Replace the generic opening with one focused paragraph establishing the reader problem and this study focus. Use only the given facts: novice users, recall of instructions, and a fixed laboratory task. Do not claim a literature gap, prevalence, prior findings or practical effects.' },
  { id: 'method-detail', label: 'Explain the given method', color: '#a77bc3', detail: true,
    quote: 'In the synthetic method, 24 volunteers completed 12 practice trials followed by 48 test trials. Each trial displayed one symbol for 500 ms and then allowed a response for 1500 ms. Accuracy was the proportion of correct test-trial responses.',
    prompt: 'Explain this method more clearly and in more detail using only these facts: 24 volunteers; 12 practice trials; 48 test trials; one symbol displayed for 500 ms; a 1500 ms response interval; accuracy is correct test responses divided by 48. Clarify practice versus test scoring. Do not add randomization, demographic, exclusion, apparatus or ethics details.' },
  { id: 'citation-preservation', label: 'Polish and keep citations exact', color: '#c56f63',
    quote: 'The synthetic demonstration, whose citations are explicitly fictitious placeholders, proposes that careful wording is useful (Example & Sample, 2021) and that traceable revision decisions are also useful (Fiction et al., 2022).',
    prompt: 'Polish concisely while preserving both citation strings character for character: (Example & Sample, 2021) and (Fiction et al., 2022). Preserve the explicit statement that these are fictitious placeholder citations. Do not add references or treat these as real publications.' },
  { id: 'protected-final', label: 'Finalized, no AI changes', color: '#359584', action: 'protect',
    quote: 'This finalized synthetic paragraph must remain unchanged. Its exact wording, punctuation, and fictitious designation are intentional.',
    prompt: '' },
];
const original = '<h1>Synthetic academic editing fixture: all data and citations are fictitious.</h1>\n' + scenarios.map(scenario => `<p>${scenario.quote}</p>\n`).join('');
const baseline = Buffer.from(original), hash = bytes => createHash('sha256').update(bytes).digest('hex');
const binary = resolve(process.env.UNDERTREE_REVIEW_BINARY || `target/debug/undertree-review${process.platform === 'win32' ? '.exe' : ''}`);
const inputAssets = resolve(process.env.UNDERTREE_REVIEW_ASSETS || 'dist');
const output = resolve(process.env.UNDERTREE_ACADEMIC_RECEIPT || 'artifacts/academic-review-scenarios.json');
const root = await mkdtemp(join(tmpdir(), 'undertree-academic-review-'));
const projectRoot = join(root, 'project'), assets = join(root, 'assets');
const runningBinary = join(root, `undertree-review${process.platform === 'win32' ? '.exe' : ''}`);
const descriptor = join(root, 'reviewer-access.json');
const token = randomBytes(32).toString('hex');
let service, browser, page, project, base, endpoint, sharedDocumentId, port, log = '', failure;
const pageErrors = [], checks = [];
const ruleChanges = [], phaseReports = [];
let phase = 'shorten';
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
    value = await fetch(base + '/api/review', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(operation), signal: AbortSignal.timeout(10_000) }).then(response => response.json());
    return value.error?.code !== 'busy' || value.error.message !== 'A local document operation is running. Retry this action.';
  }, 'The isolated native document operation remained busy.');
  assert.equal(value.ok, true, value.error?.message); return value.result;
}
const saved = () => local({ action: 'review', project: project.id, path: 'academic.html' });
const unchanged = async () => assert.deepEqual(await readFile(join(projectRoot, 'academic.html')), baseline, 'AI proposals and rule configuration must preserve every original source byte.');
async function chromePath() {
  if (process.env.UNDERTREE_CHROME) return process.env.UNDERTREE_CHROME;
  const candidates = process.platform === 'win32' ? ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'] : ['/usr/bin/google-chrome', '/usr/bin/chromium'];
  for (const candidate of candidates) { try { await access(candidate); return candidate; } catch {} }
  throw Error('Set UNDERTREE_CHROME to an installed browser.');
}
async function configureAndMark(scenario) {
  await page.locator('[data-color-add]').first().click();
  await page.locator('#color-rule-label').fill(scenario.label);
  await page.locator('#color-rule-color').evaluate((input, color) => { input.value = color; input.dispatchEvent(new Event('input', { bubbles: true })); }, scenario.color);
  await page.locator(`input[name="color-rule-action"][value="${scenario.action || 'prompt'}"]`).check();
  if (scenario.action !== 'protect') {
    await page.locator('#color-rule-shorten').setChecked(!!scenario.shorten);
    await page.locator('#color-rule-detail').setChecked(!!scenario.detail);
    await page.locator('#color-rule-prompt').fill(scenario.prompt);
  }
  await page.locator('#color-rule-save').click();
  await page.locator('#color-rule-dialog').waitFor({ state: 'hidden' });
  const rule = (await saved()).review.rules.find(rule => rule.label === scenario.label);
  assert.ok(rule); assert.equal(rule.color, scenario.color); scenario.ruleId = rule.id;
  await page.locator('#editor-search').click();
  const search = page.locator('.cm-search input[name="search"]');
  await search.fill(scenario.quote); await search.press('ArrowRight'); await search.press('Enter');
  await page.locator('.cm-searchMatch').first().waitFor({ state: 'visible' });
  await search.press('Escape');
  let selectedText = await page.evaluate(() => document.getSelection()?.toString() || '');
  if (selectedText !== scenario.quote) {
    await page.locator('.cm-content').focus(); await page.keyboard.press('Control+Home');
    for (let index = 0; index < original.indexOf(scenario.quote); index++) await page.keyboard.press('ArrowRight');
    for (let index = 0; index < scenario.quote.length; index++) await page.keyboard.press('Shift+ArrowRight');
    selectedText = await page.evaluate(() => document.getSelection()?.toString() || '');
  }
  assert.equal(selectedText, scenario.quote, `The actual browser source selection must exactly match ${scenario.id}.`);
  let lastMarkError = '';
  const markResponse = page.waitForResponse(async response => {
    if (!response.url().endsWith('/api/review') || response.request().postDataJSON()?.action !== 'mark') return false;
    const value = await response.json(); lastMarkError = value.error ? `${value.error.code}: ${value.error.message}` : '';
    return value.ok === true || value.error?.code !== 'busy' || value.error.message !== 'A local document operation is running. Retry this action.';
  }, { timeout: 30_000 });
  await page.locator(`[data-color-rule="${rule.id}"]`).focus(); await page.keyboard.press('Enter');
  await page.locator('#menu-format summary').click(); await page.locator('#highlight-selection').click();
  assert.equal(await page.locator('#highlight-quote').textContent(), scenario.quote);
  await page.locator('#highlight-dialog-rule').selectOption(rule.id);
  await page.locator('#highlight-prompt').fill('Apply this passage rule while retaining the stated factual scope.');
  await page.locator('#highlight-form button[type="submit"]').click();
  const response = await markResponse.catch(async () => { throw Error(`No completed mark for ${scenario.id}; last native error: ${lastMarkError}; status: ${await page.locator('#review-status').textContent()}`); });
  const marked = await response.json();
  assert.equal(marked.ok, true, `Native mark ${scenario.id}: ${marked.error?.code || ''} ${marked.error?.message || ''}; status: ${await page.locator('#review-status').textContent()}`);
  await until(async () => (await saved()).review.markers.some(marker => marker.rule === rule.id && marker.anchor.quote === scenario.quote), `The UI did not mark ${scenario.id}.`);
  const marker = (await saved()).review.markers.find(marker => marker.rule === rule.id);
  assert.equal(marker.anchor.from, original.indexOf(scenario.quote)); assert.equal(marker.anchor.to, original.indexOf(scenario.quote) + scenario.quote.length);
  await unchanged();
}
const mcpHeaders = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-06-18' };
async function rpc(method, params) {
  if (method === 'tools/call' && params.name === 'suggest_text' && !params.arguments.proposal.contextId) {
    const context = await readFixtureContext(rpc, params.arguments.documentId);
    params = { ...params, arguments: { ...params.arguments, proposal: { ...params.arguments.proposal, contextId: context.contextId } } };
  }
  const response = await fetch(endpoint, { method: 'POST', headers: mcpHeaders, body: JSON.stringify({ jsonrpc: '2.0', id: randomBytes(8).toString('hex'), method, params }), signal: AbortSignal.timeout(15_000) });
  assert.equal(response.status, 200); return response.json();
}
async function assetHashes(directory, prefix = '') {
  const result = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = prefix + entry.name, path = join(directory, entry.name);
    if (entry.isDirectory()) Object.assign(result, await assetHashes(path, name + '/'));
    else if (entry.isFile()) result[name] = hash(await readFile(path));
  }
  return result;
}
async function variant() {
  assert.equal(phase, 'shorten', 'The controlled UI variant runs once after the shortening trial.');
  const scenario = scenarios[0], before = (await saved()).review.rules.find(rule => rule.id === scenario.ruleId);
  if (!await page.locator(`[data-color-configure="${scenario.ruleId}"]`).count()) {
    await page.locator('#menu-format summary').click(); await page.locator('#highlight-rule').selectOption(scenario.ruleId); await page.locator('#menu-format summary').click();
  }
  await page.locator(`[data-color-configure="${scenario.ruleId}"]`).click();
  await page.locator('#color-rule-shorten').uncheck(); await page.locator('#color-rule-detail').check();
  const prompt = 'Explain these synthetic results in 80–110 words using only the stated facts. Retain both group sizes (40 each), both means (18.2 and 15.7), the difference (2.5 points), and the fact that no significance test was conducted. Clarify the comparison and descriptive limits without inventing intervals, significance, design details or causal claims.';
  await page.locator('#color-rule-prompt').fill(prompt); await page.locator('#color-rule-save').click(); await page.locator('#color-rule-dialog').waitFor({ state: 'hidden' });
  const after = (await saved()).review.rules.find(rule => rule.id === scenario.ruleId);
  assert.notEqual(before.prompt, after.prompt); assert.equal(after.id, before.id); await unchanged();
  ruleChanges.push({ scenario: scenario.id, throughActualUi: true, before, after }); phase = 'more-detail';
  await page.screenshot({ path: resolve('artifacts/academic-review-variant.png') });
  console.log('ACADEMIC_VARIANT_READY');
}
async function report(final = false) {
  await unchanged();
  const current = await saved();
  const listed = await rpc('tools/list', {});
  assert.deepEqual(listed.result.tools.map(tool => tool.name).sort(), ['highlight_text', 'list_manuscripts', 'read_manuscript', 'suggest_text']);
  const protectedScenario = scenarios.at(-1);
  let protectedResult;
  await until(async () => {
    protectedResult = await rpc('tools/call', { name: 'suggest_text', arguments: { documentId: sharedDocumentId, proposal: { requestId: 'academic-protected-proof', revision: current.review.revision, from: original.indexOf(protectedScenario.quote), to: original.indexOf(protectedScenario.quote) + protectedScenario.quote.length, quote: protectedScenario.quote, replacement: 'Forbidden revision.', rationale: 'Protection refusal probe in a synthetic fixture.' } } });
    return !JSON.stringify(protectedResult).includes('A local document operation is running. Retry this action.');
  }, 'The protected proposal proof remained busy.');
  assert.equal(protectedResult.result?.isError, true); assert.match(JSON.stringify(protectedResult), /protect|reject|not allowed|marked against agent changes/i);
  const writeTools = [];
  for (const name of ['save', 'write_document', 'edit_text', 'accept_suggestion', 'palette', 'set_policy', 'apply_patch']) {
    const result = await rpc('tools/call', { name, arguments: { documentId: sharedDocumentId, content: 'Forbidden direct source replacement.' } });
    assert.ok(result.error || result.result?.isError, `The forbidden tool ${name} must fail.`); writeTools.push({ name, denied: true }); await unchanged();
  }
  let negativeControl = null;
  if (final) {
    const scenario = scenarios[0], replacement = scenario.quote.replace('40 participants', '999 participants');
    let result;
    await until(async () => {
      result = await rpc('tools/call', { name: 'suggest_text', arguments: { documentId: sharedDocumentId, proposal: { requestId: 'academic-NONCOMPLIANT-CONTROL', revision: current.review.revision, from: original.indexOf(scenario.quote), to: original.indexOf(scenario.quote) + scenario.quote.length, quote: scenario.quote, replacement, rationale: 'NONCOMPLIANT CONTROL: deliberately changes a reported group size from 40 to 999, violating the custom prompt. This is a semantic safety test, not a model-trial output. Never accept this proposal.' } } });
      return !JSON.stringify(result).includes('A local document operation is running. Retry this action.');
    }, 'The semantic negative control remained busy.');
    assert.equal(result.result?.isError, false, 'Custom wording prompts guide proposals but do not enforce their numerical truth.');
    await unchanged(); negativeControl = { requestId: 'academic-NONCOMPLIANT-CONTROL', replacement, pendingAllowed: true, sourceUnchanged: true, accepted: false };
  }
  const latest = await saved();
  assert.equal(latest.review.markers.length, scenarios.length);
  assert.ok(latest.review.suggestions.every(suggestion => suggestion.status === 'pending'), 'This scenario never accepts an AI edit.');
  const outcomes = scenarios.map(scenario => ({ ...scenario, activeRule: latest.review.rules.find(rule => rule.id === scenario.ruleId), proposals: latest.review.suggestions.filter(suggestion => suggestion.anchor.quote === scenario.quote && suggestion.requestId !== 'academic-NONCOMPLIANT-CONTROL') }));
  const pendingCount = latest.review.suggestions.length;
  const covered = outcomes.slice(0, -1).every(scenario => scenario.proposals.length > 0);
  if (await page.locator('#review-toggle').getAttribute('aria-pressed') !== 'true') await page.locator('#review-toggle').click();
  await page.locator('#review-refresh').click();
  await page.screenshot({ path: resolve('artifacts/academic-review-proposals.png'), fullPage: false });
  phaseReports.push({ phase, final, sourceUnchanged: true, pendingCount, scenarios: outcomes });
  const receipt = { result: covered ? 'proposals-ready-for-semantic-review' : 'prepared-awaiting-proposals', phase, final, synthetic: true, publicTunnelOrGptAccountConnection: false, actualModelReviewer: 'Supplied separately by the parent agent through this closed MCP endpoint.', sourceUnchanged: true, baselineSha256: hash(baseline), observedSourceSha256: hash(await readFile(join(projectRoot, 'academic.html'))), original, pendingCount, protectedDenied: true, forbiddenWriteTools: writeTools, checks, scenarios: outcomes, ruleChanges, phaseReports, negativeControl, pageErrors, binarySha256: hash(await readFile(runningBinary)), frontend: await assetHashes(assets), runnerSha256: hash(await readFile(new URL(import.meta.url))) };
  await writeFile(output, JSON.stringify(receipt, null, 2) + '\n');
  console.log(`ACADEMIC_REPORT ${output}`);
}
try {
  await mkdir(resolve('artifacts'), { recursive: true }); await mkdir(projectRoot); await cp(inputAssets, assets, { recursive: true }); await cp(binary, runningBinary);
  await writeFile(join(projectRoot, 'academic.html'), baseline);
  const targetFile = join(root, 'zrok-target'), fixture = await createZrokFixture(root, targetFile, 'academic-review.example.org');
  service = spawn(runningBinary, [], { windowsHide: true, env: { ...process.env, ...fixture.environment, UNDERTREE_REVIEW_PORT: '0', UNDERTREE_REVIEW_STATE: join(root, 'state'), UNDERTREE_REVIEW_ASSETS: assets, UNDERTREE_REVIEW_TOKEN: token, UNDERTREE_ZROK: fixture.executable }, stdio: ['ignore', 'pipe', 'pipe'] });
  service.on('error', error => { failure = error; });
  for (const stream of [service.stdout, service.stderr]) stream.on('data', bytes => { log = (log + bytes).slice(-10_000); port = Number(log.match(/127\.0\.0\.1:(\d+)/)?.[1]); });
  await until(() => !!port, 'The isolated academic review service did not start.'); base = `http://127.0.0.1:${port}`;
  project = await local({ action: 'add_project', root: projectRoot });
  browser = await chromium.launch({ executablePath: await chromePath(), headless: true, args: ['--no-sandbox'] });
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } }); page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(base + `/manuscript.html#session=${token}`, { waitUntil: 'domcontentloaded' });
  await page.locator('.file-button[data-path="academic.html"]').click(); await page.locator('.cm-content').waitFor();
  for (const scenario of scenarios) await configureAndMark(scenario);
  checks.push('Six synthetic academic prompt/protection rules configured through the real popup and applied through actual source search/selection and keyboard swatch activation; all original bytes preserved.');
  const tunnel = await local({ action: 'tunnel', enabled: true, reservation: 'academic-fixture', public_url: 'https://academic-review.example.org/' });
  endpoint = (await readFile(targetFile, 'utf8')).trim() + new URL(tunnel.endpoint).pathname;
  if (await page.locator('#review-toggle').getAttribute('aria-pressed') !== 'true') await page.locator('#review-toggle').click();
  await page.locator('#manuscript-share').click(); await confirmContextShareUi(page);
  await until(async () => (await local({ action: 'connection' })).shared.some(share => share.project === project.id && share.path === 'academic.html'), 'Explicit local manuscript sharing did not complete.');
  const initialized = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'UnderTree synthetic academic scenarios', version: '1' } });
  assert.equal(initialized.error, undefined);
  const current = await saved();
  const inventory = await rpc('tools/call', { name: 'list_manuscripts', arguments: {} });
  assert.equal(inventory.result?.isError, false, 'The explicit UI share must be visible to MCP.');
  const listed = inventory.result.structuredContent?.result ?? inventory.result.structuredContent ?? JSON.parse(inventory.result.content.find(item => item.type === 'text').text);
  const connection = await local({ action: 'connection' });
  const share = connection.shared.find(share => share.project === project.id && share.path === 'academic.html');
  assert.ok(share); assert.ok(Array.isArray(listed));
  assert.equal(listed.length, 1, 'The isolated MCP inventory must contain only the explicitly shared fixture.');
  assert.equal(listed[0].documentId, share.documentId); sharedDocumentId = listed[0].documentId;
  await writeFile(descriptor, JSON.stringify({ endpoint, documentId: sharedDocumentId }), { mode: 0o600 });
  await chmod(descriptor, 0o600);
  if (process.platform === 'win32') {
    const locked = spawnSync('icacls', [descriptor, '/inheritance:r', '/grant:r', `${process.env.USERDOMAIN}\\${process.env.USERNAME}:(F)`], { encoding: 'utf8', windowsHide: true });
    assert.equal(locked.status, 0, 'The private reviewer descriptor ACL must be restricted to the current user.');
  }
  await page.screenshot({ path: resolve('artifacts/academic-review-prepared.png') });
  await writeFile(output, JSON.stringify({ result: 'prepared-awaiting-model', synthetic: true, original, baselineSha256: hash(baseline), sourceUnchanged: true, checks, scenarios: scenarios.map(scenario => ({ ...scenario, activeRule: current.review.rules.find(rule => rule.id === scenario.ruleId) })), binarySha256: hash(await readFile(runningBinary)), frontend: await assetHashes(assets), runnerSha256: hash(await readFile(new URL(import.meta.url))) }, null, 2) + '\n');
  console.log(`ACADEMIC_READY ${descriptor}`);
  const commands = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const command of commands) {
    if (command.trim() === 'stop') { commands.close(); break; }
    if (command.trim() === 'report') await report();
    if (command.trim() === 'variant') await variant();
    if (command.trim() === 'final-report') await report(true);
  }
} catch (error) {
  failure = error;
  const observed = base ? await saved().catch(() => null) : null;
  await page?.screenshot({ path: resolve('artifacts/academic-review-failure.png') }).catch(() => {});
  await writeFile(output, JSON.stringify({ result: 'failed', error: error.message, checks, pageErrors, original, observedReview: observed?.review, phaseReports, ruleChanges, sourceUnchanged: await readFile(join(projectRoot, 'academic.html')).then(bytes => bytes.equals(baseline)).catch(() => null) }, null, 2) + '\n').catch(() => {});
  console.error(`ACADEMIC_FAILED ${error.message}`);
  process.exitCode = 1;
} finally {
  if (base && service?.exitCode === null) await local({ action: 'tunnel', enabled: false, reservation: '', public_url: '' }).catch(error => pageErrors.push(`Fixture tunnel cleanup: ${error.message}`));
  await browser?.close(); service?.kill('SIGINT');
  if (service) { await Promise.race([new Promise(resolve => { if (service.exitCode !== null) resolve(); else service.once('exit', resolve); }), new Promise(resolve => setTimeout(resolve, 3000))]); if (service.exitCode === null) service.kill('SIGKILL'); }
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
