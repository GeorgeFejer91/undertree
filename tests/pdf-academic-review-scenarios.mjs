import { readFixtureContext } from './context-fixture.mjs';
import { confirmContextShareUi } from './context-fixture.mjs';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { chromium } from 'playwright-core';
import { createZrokFixture } from './zrok-fixture.mjs';

const scenarios = [
  { id: 'shorten-results', label: 'Shorten numbers and citation', color: '#409b64', shorten: true,
    quote: 'In this synthetic comparison, the intervention group contained 40 participants and the control group contained 40 participants. Their mean scores were 18.2 and 15.7, respectively, a difference of 2.5 points. No significance test was conducted (Example et al., 2024).',
    prompt: 'Shorten this passage. Preserve both group sizes of 40, both means (18.2 and 15.7), their difference of 2.5 points, and the absence of a significance test. Preserve (Example et al., 2024) exactly; it is a fictitious placeholder citation. Do not invent intervals, significance, design details or causal claims.',
    numbers: ['40', '18.2', '15.7', '2.5'], citations: ['(Example et al., 2024)'] },
  { id: 'results-detail', label: 'More detail without new facts', color: '#d3a22d', detail: true,
    quote: 'In this synthetic task, 18 volunteers completed 20 trials. Each trial lasted 4 seconds. We report the number of correct responses.',
    prompt: 'Explain this synthetic task in 55–80 words using only the stated facts: 18 volunteers, 20 trials, 4 seconds per trial, and reporting the number of correct responses. Clarify the reported measure without inventing scores, outcomes, demographics, apparatus, design details, references or significance claims.',
    numbers: ['18', '20', '4'], words: [55, 80] },
  { id: 'causal-restraint', label: 'Correct the causal claim', color: '#5d87b9',
    quote: 'In a synthetic observational sample of 120 participants, sleep duration correlated with attention scores, r = 0.32. This association proves that longer sleep causes better attention.',
    prompt: 'Correct the causal overclaim. Retain the synthetic observational design, sample size 120 and correlation r = 0.32. State an association and that this design does not establish causation. Do not add interventions, confounder adjustment, statistical significance or references.',
    numbers: ['120', '0.32'] },
  { id: 'method-clarity', label: 'Clarify method and scoring', color: '#a77bc3', detail: true,
    quote: 'In the synthetic method, 24 volunteers completed 12 practice trials followed by 48 test trials. Each trial displayed one symbol for 500 ms and then allowed a response for 1500 ms. Accuracy was the proportion of correct test-trial responses.',
    prompt: 'Explain the method clearly using only 24 volunteers, 12 practice trials, 48 test trials, one symbol displayed for 500 ms, and a 1500 ms response interval. Explicitly define accuracy as correct test responses divided by 48 and clarify that practice responses are outside that calculation. Do not invent randomization, demographics, exclusions, apparatus, ethics or references.',
    numbers: ['24', '12', '48', '500', '1500'] },
  { id: 'exact-citations', label: 'Polish with exact citations', color: '#c56f63',
    quote: 'The synthetic demonstration, whose citations are explicitly fictitious placeholders, proposes that careful wording is useful (Example & Sample, 2021) and that traceable revision decisions are also useful (Fiction et al., 2022).',
    prompt: 'Polish concisely. Preserve both citation strings character for character: (Example & Sample, 2021) and (Fiction et al., 2022). Keep each citation with its original claim. Explicitly retain that the citations are fictitious placeholders. Do not add references or treat them as real publications.',
    citations: ['(Example & Sample, 2021)', '(Fiction et al., 2022)'] },
  { id: 'protected-final', label: 'Finalized, no AI changes', color: '#359584', action: 'protect',
    quote: 'This finalized synthetic paragraph must remain unchanged. Its exact wording, punctuation, and fictitious designation are intentional.', prompt: '' },
];
const source = '#set page(width: 620mm, height: 180mm, margin: 12mm)\n#set text(size: 11pt, ligatures: false)\n\nSynthetic academic fixture. All data and citations are fictitious.\n\n' + scenarios.map(s => s.quote + '\n\n').join('');
const baseline = Buffer.from(source), hash = bytes => createHash('sha256').update(bytes).digest('hex');
const inputBinary = resolve(process.env.UNDERTREE_REVIEW_BINARY || `target/debug/undertree-review${process.platform === 'win32' ? '.exe' : ''}`);
const inputAssets = resolve(process.env.UNDERTREE_REVIEW_ASSETS || 'dist');
const output = resolve(process.env.UNDERTREE_PDF_ACADEMIC_RECEIPT || 'artifacts/pdf-academic-review-scenarios.json');
const root = await mkdtemp(join(tmpdir(), 'undertree-pdf-academic-')), projectRoot = join(root, 'project'), assets = join(root, 'assets');
const binary = join(root, `undertree-review${process.platform === 'win32' ? '.exe' : ''}`), descriptor = join(root, 'reviewer-access.json');
const token = randomBytes(32).toString('hex'), errors = [], checks = [], drags = [], probes = [];
let service, browser, page, project, base, port, endpoint, documentId, log = '', failure;
let transportBusyResponses = 0;
const words = text => text.trim().split(/\s+/u).filter(Boolean).length;
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
  }, 'The isolated native operation remained busy.');
  assert.equal(value.ok, true, value.error?.message); return value.result;
}
const saved = () => local({ action: 'review', project: project.id, path: 'academic.typ' });
async function unchanged() { assert.deepEqual(await readFile(join(projectRoot, 'academic.typ')), baseline, 'PDF highlighting and remote proposals must preserve every original source byte.'); }
function result(reply) { return reply.result.structuredContent?.result ?? JSON.parse(reply.result.content.find(c => c.type === 'text').text); }
async function rpc(method, params) {
  if (method === 'tools/call' && params.name === 'suggest_text' && !params.arguments.proposal.contextId) {
    const context = await readFixtureContext(rpc, params.arguments.documentId);
    params = { ...params, arguments: { ...params.arguments, proposal: { ...params.arguments.proposal, contextId: context.contextId } } };
  }
  let reply;
  await until(async () => {
    const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-06-18', Connection: 'close' }, body: JSON.stringify({ jsonrpc: '2.0', id: randomBytes(8).toString('hex'), method, params }), signal: AbortSignal.timeout(15_000) });
    if (response.status === 429) { transportBusyResponses++; await response.arrayBuffer(); return false; }
    assert.equal(response.status, 200); reply = await response.json();
    return !JSON.stringify(reply).includes('A local document operation is running. Retry this action.');
  }, 'The MCP request remained busy.');
  return reply;
}
async function assetsHash(directory, prefix = '') {
  const values = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) Object.assign(values, await assetsHash(join(directory, entry.name), prefix + entry.name + '/'));
    else if (entry.isFile()) values[prefix + entry.name] = hash(await readFile(join(directory, entry.name)));
  }
  return values;
}
async function configure(scenario) {
  await page.locator('[data-color-add]').first().click();
  await page.locator('#color-rule-label').fill(scenario.label);
  await page.locator('#color-rule-color').evaluate((input, color) => { input.value = color; input.dispatchEvent(new Event('input', { bubbles: true })); }, scenario.color);
  await page.locator(`input[name="color-rule-action"][value="${scenario.action || 'prompt'}"]`).check();
  if (!scenario.action) {
    await page.locator('#color-rule-shorten').setChecked(!!scenario.shorten);
    await page.locator('#color-rule-detail').setChecked(!!scenario.detail);
    await page.locator('#color-rule-prompt').fill(scenario.prompt);
  }
  await page.locator('#color-rule-save').click(); await page.locator('#color-rule-dialog').waitFor({ state: 'hidden' });
  const rule = (await saved()).review.rules.find(r => r.label === scenario.label); assert.ok(rule); scenario.ruleId = rule.id;
  assert.equal(rule.color, scenario.color); assert.equal(rule.action, scenario.action || 'prompt');
  await page.locator(`[data-color-rule="${rule.id}"]`).click();
  assert.equal(await page.locator(`[data-color-rule="${rule.id}"]`).getAttribute('aria-pressed'), 'true');
  return rule;
}
// Ranges locate printed glyphs; only the real pointer creates the selection.
async function dragPdf(quote) {
  const geometry = await page.evaluate(quote => {
    for (const layer of document.querySelectorAll('.pdf-text-layer')) {
      const from = layer.textContent.indexOf(quote); if (from < 0) continue;
      const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT), range = document.createRange();
      let offset = 0, start, end;
      while (walker.nextNode()) {
        const node = walker.currentNode, next = offset + node.textContent.length;
        if (!start && from < next) start = { node, offset: from - offset };
        if (from + quote.length <= next) { end = { node, offset: from + quote.length - offset }; break; }
        offset = next;
      }
      if (!start || !end) return null;
      range.setStart(start.node, start.offset); range.setEnd(start.node, start.offset + 1); const a = range.getBoundingClientRect();
      range.setStart(end.node, end.offset - 1); range.setEnd(end.node, end.offset); const b = range.getBoundingClientRect();
      return { page: Number(layer.parentElement.dataset.page), from, to: from + quote.length,
        start: { x: a.left + .2, y: a.top + a.height / 2 }, end: { x: b.right - .2, y: b.top + b.height / 2 } };
    }
    return null;
  }, quote);
  assert.ok(geometry, 'The actual compiled PDF must contain the complete exact source quote.');
  assert.ok(Math.abs(geometry.start.y - geometry.end.y) < 1, 'Each finite fixture passage must occupy one printed line.');
  assert.ok(geometry.start.y > 0 && geometry.end.y < await page.evaluate(() => innerHeight), 'Both drag endpoints must be visible.');
  await page.mouse.move(geometry.start.x, geometry.start.y); await page.mouse.down(); await page.mouse.move(geometry.end.x, geometry.end.y, { steps: 16 });
  const selected = await page.evaluate(() => { const selection = document.getSelection(); return { canonicalRangeText: selection.rangeCount ? selection.getRangeAt(0).toString() : '', nativeSelectionText: selection.toString() }; }); await page.mouse.up();
  drags.push({ geometry, quote, actualSelectionBeforeRelease: selected });
  assert.equal(selected.canonicalRangeText, quote, 'The real mouse drag must select the exact intended PDF quote.'); return geometry;
}
async function mark(scenario) {
  const rule = await configure(scenario), before = await saved();
  const persisted = page.waitForResponse(response => response.url().endsWith('/api/review') && response.request().postDataJSON()?.action === 'pdf_mark');
  const geometry = await dragPdf(scenario.quote);
  const nativeResponse = await (await persisted).json();
  assert.equal(nativeResponse.ok, true, `The real PDF mark must complete before observation: ${nativeResponse.error?.code || ''} ${nativeResponse.error?.message || ''}`);
  const snapshot = await saved(), annotation = snapshot.review.pdfAnnotations.find(a => !before.review.pdfAnnotations?.some(old => old.id === a.id));
  assert.equal(snapshot.review.pdfAnnotations.length, (before.review.pdfAnnotations?.length || 0) + 1);
  assert.ok(annotation); assert.equal(annotation.rule, rule.id); assert.ok(annotation.sourceMarkerId, 'An exact globally unique PDF quote must link to its source marker.');
  assert.deepEqual(annotation.segments, [{ page: geometry.page, from: geometry.from, to: geometry.to, quote: scenario.quote }]);
  const marker = snapshot.review.markers.find(m => m.id === annotation.sourceMarkerId); assert.ok(marker);
  assert.equal(marker.rule, rule.id); assert.equal(marker.anchor.quote, scenario.quote); assert.equal(marker.anchor.from, source.indexOf(scenario.quote)); assert.equal(marker.anchor.to, source.indexOf(scenario.quote) + scenario.quote.length);
  scenario.annotationId = annotation.id; scenario.markerId = marker.id;
  await unchanged();
}
async function securityProbes(current) {
  const protectedCase = scenarios.at(-1), marker = current.review.markers.find(m => m.id === protectedCase.markerId);
  const denied = await rpc('tools/call', { name: 'suggest_text', arguments: { documentId, proposal: { requestId: 'pdf-academic-protection-probe', revision: current.review.revision, from: marker.anchor.from, to: marker.anchor.to, quote: marker.anchor.quote, replacement: 'Forbidden revision.', rationale: 'Synthetic protection refusal probe; never accept.' } } });
  assert.equal(denied.result?.isError, true); assert.match(JSON.stringify(denied), /protect|reject|not allowed|marked against agent changes/i); probes.push({ name: 'protected-proposal', denied: true, response: denied });
  for (const name of ['save', 'write_document', 'edit_text', 'accept_suggestion', 'palette', 'set_policy', 'apply_patch']) {
    const reply = await rpc('tools/call', { name, arguments: { documentId, content: 'Forbidden source replacement.' } });
    assert.ok(reply.error || reply.result?.isError, `${name} must be unavailable through Review MCP.`); probes.push({ name, denied: true });
  }
  const numeric = current.review.markers.find(m => m.id === scenarios[0].markerId);
  const control = await rpc('tools/call', { name: 'suggest_text', arguments: { documentId, proposal: { requestId: 'pdf-academic-NONCOMPLIANT-CONTROL', revision: current.review.revision, from: numeric.anchor.from, to: numeric.anchor.to, quote: numeric.anchor.quote, replacement: numeric.anchor.quote.replace('40 participants', '999 participants'), rationale: 'NONCOMPLIANT NEGATIVE CONTROL: deliberately violates the numeric prompt by changing a group size to 999. This tests the distinction between semantic guidance and native authority. Never accept.' } } });
  assert.equal(control.result?.isError, false, 'A custom prompt is semantic guidance rather than a native numerical-truth validator.');
  probes.push({ name: 'semantic-numeric-negative-control', pendingAllowed: true, response: result(control) }); await unchanged();
}
async function report() {
  await unchanged(); assert.deepEqual(errors, [], 'The real browser must not report unhandled page errors.'); const read = result(await rpc('tools/call', { name: 'read_manuscript', arguments: { documentId } }));
  if (!probes.length) await securityProbes(read);
  const latest = result(await rpc('tools/call', { name: 'read_manuscript', arguments: { documentId } }));
  const native = await saved();
  assert.equal(latest.content, source); assert.equal(latest.review.markers.length, 6); assert.equal(native.review.pdfAnnotations.length, 6); assert.equal(latest.review.pdfAnnotations, undefined, 'Remote Review must retain native PDF annotation redaction.'); assert.ok(latest.review.suggestions.every(s => s.status === 'pending'));
  const outcomes = scenarios.map(scenario => {
    const proposals = latest.review.suggestions.filter(s => s.anchor.quote === scenario.quote && !s.requestId.includes('CONTROL'));
    const measured = proposals.map(p => ({ proposalId: p.id, requestId: p.requestId, originalWords: words(p.anchor.quote), replacementWords: words(p.replacement), lengthFits: !scenario.words || words(p.replacement) >= scenario.words[0] && words(p.replacement) <= scenario.words[1], shorter: !scenario.shorten || words(p.replacement) < words(scenario.quote), requiredNumbersPresent: (scenario.numbers || []).every(n => new RegExp(`(?<![\\d.])${n.replaceAll('.', '\\.')}($|[^\\d.]|\\.(?!\\d))`).test(p.replacement)), exactCitationsPresent: (scenario.citations || []).every(c => p.replacement.includes(c)) }));
    return { ...scenario, activeRule: latest.review.rules.find(r => r.id === scenario.ruleId), proposals, measured, status: scenario.action === 'protect' ? proposals.length === 0 ? 'pass' : 'fail' : proposals.length === 0 ? 'partial' : proposals.length > 1 ? 'fail' : measured.every(m => m.lengthFits && m.shorter && m.requiredNumbersPresent && m.exactCitationsPresent) ? 'mechanical-pass-editorial-review-required' : 'fail' };
  });
  assert.equal(outcomes.at(-1).proposals.length, 0);
  await page.locator('#review-refresh').click(); await page.screenshot({ path: resolve('artifacts/pdf-academic-proposals.png') });
  const receipt = { result: outcomes.some(s => s.status === 'fail') ? 'fail' : 'partial', reason: 'Mechanical checks cannot establish that prose contains no invented facts or fully satisfies editorial instructions; inspect the recorded actual proposals independently.', synthetic: true, actualModelGenerations: 'External reviewer authors proposals after reading this live MCP; this harness contains no replacement prose.', publicTunnelOrAccountConnection: false, finiteLimits: { cases: 6, permittedModelProposals: 5, protectedCases: 1, numericNegativeControls: 1, fixturePdfPages: 1, sourceMapping: 'Exact globally unique literal prose only; no claim for formatted, ambiguous or multi-line source mapping.' }, sourceUnchanged: true, baselineSha256: hash(baseline), observedSourceSha256: hash(await readFile(join(projectRoot, 'academic.typ'))), source, pdfAnnotations: native.review.pdfAnnotations, scenarios: outcomes, probes, pendingCount: latest.review.suggestions.length, allPending: true, checks, drags, errors, transportBusyResponses, binarySha256: hash(await readFile(binary)), frontend: await assetsHash(assets), typstSha256: hash(await readFile(process.env.UNDERTREE_TYPST)), runnerSha256: hash(await readFile(new URL(import.meta.url))) };
  await writeFile(output, JSON.stringify(receipt, null, 2) + '\n'); console.log(`PDF_ACADEMIC_REPORT ${output}`);
}
try {
  assert.ok(process.env.UNDERTREE_TYPST && process.env.UNDERTREE_CHROME, 'Supply actual Typst and Chrome executables.');
  await mkdir(resolve('artifacts'), { recursive: true }); await mkdir(projectRoot); await cp(inputBinary, binary); await cp(inputAssets, assets, { recursive: true }); await writeFile(join(projectRoot, 'academic.typ'), baseline);
  const targetFile = join(root, 'zrok-target'), fixture = await createZrokFixture(root, targetFile, 'pdf-academic.example.org');
  service = spawn(binary, [], { windowsHide: true, env: { ...process.env, ...fixture.environment, UNDERTREE_REVIEW_PORT: '0', UNDERTREE_REVIEW_STATE: join(root, 'state'), UNDERTREE_REVIEW_ASSETS: assets, UNDERTREE_REVIEW_TOKEN: token, UNDERTREE_ZROK: fixture.executable }, stdio: ['ignore', 'pipe', 'pipe'] });
  service.on('error', () => { failure = Error('The isolated native service could not start.'); });
  for (const stream of [service.stdout, service.stderr]) stream.on('data', bytes => { log = (log + bytes).slice(-10_000); port = Number(log.match(/127\.0\.0\.1:(\d+)/)?.[1]); });
  await until(() => !!port, 'The isolated PDF academic service did not start.'); base = `http://127.0.0.1:${port}`;
  project = await local({ action: 'add_project', root: projectRoot });
  const initial = await saved(); await local({ action: 'set_main_document', project: project.id, path: 'academic.typ', sourceEpoch: initial.sourceEpoch, expectedRoot: initial.expectedRoot });
  browser = await chromium.launch({ executablePath: process.env.UNDERTREE_CHROME, headless: true, args: ['--no-sandbox'] }); page = await browser.newPage({ viewport: { width: 2400, height: 1200 } }); page.on('pageerror', e => errors.push(e.message));
  await page.goto(base + `/manuscript.html#session=${token}`); await page.locator('.file-button[data-path="academic.typ"]').click(); await page.locator('.cm-content').waitFor(); await page.locator('#typst-compile').click();
  await until(async () => await page.locator('#typst-preview-status').getAttribute('data-state') === 'current' && await page.locator('.pdf-text-layer span').count() > 0, 'The actual Typst publication/PDF.js text layer did not render.');
  assert.equal(await page.locator('#pdf-page-number').getAttribute('max'), '1');
  for (const scenario of scenarios) await mark(scenario);
  checks.push('Six colors configured in the actual popup, armed before real PDF mouse drags; six exact sourceMarkerId links and original source bytes verified.');
  const tunnel = await local({ action: 'tunnel', enabled: true, reservation: 'pdf-academic-fixture', public_url: 'https://pdf-academic.example.org/' }); endpoint = (await readFile(targetFile, 'utf8')).trim() + new URL(tunnel.endpoint).pathname;
  if (await page.locator('#review-toggle').getAttribute('aria-pressed') !== 'true') await page.locator('#review-toggle').click(); await page.locator('#manuscript-share').click(); await confirmContextShareUi(page);
  await until(async () => (await local({ action: 'connection' })).shared.some(s => s.project === project.id && s.path === 'academic.typ'), 'Explicit UI sharing did not complete.');
  assert.equal((await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'UnderTree PDF academic scenarios', version: '1' } })).error, undefined);
  const tools = await rpc('tools/list', {}); assert.deepEqual(tools.result.tools.map(t => t.name).sort(), ['highlight_text', 'list_manuscripts', 'read_manuscript', 'suggest_text']);
  const inventory = result(await rpc('tools/call', { name: 'list_manuscripts', arguments: {} })); assert.equal(inventory.length, 1); documentId = inventory[0].documentId;
  const remote = result(await rpc('tools/call', { name: 'read_manuscript', arguments: { documentId } }));
  for (const scenario of scenarios) { const marker = remote.review.markers.find(m => m.id === scenario.markerId), rule = remote.review.rules.find(r => r.id === marker?.rule); assert.ok(marker); assert.equal(rule.id, scenario.ruleId); if (scenario.prompt) assert.ok(rule.prompt.includes(scenario.prompt)); }
  checks.push('Real MCP read receives all six PDF-linked source markers and their current custom rule prompts; the closed catalogue has exactly four Review tools.');
  await writeFile(descriptor, JSON.stringify({ endpoint, documentId }), { mode: 0o600 }); await chmod(descriptor, 0o600);
  if (process.platform === 'win32') assert.equal(spawnSync('icacls', [descriptor, '/inheritance:r', '/grant:r', `${process.env.USERDOMAIN}\\${process.env.USERNAME}:(F)`], { encoding: 'utf8', windowsHide: true }).status, 0, 'Restrict private reviewer descriptor ACL.');
  await page.screenshot({ path: resolve('artifacts/pdf-academic-prepared.png') }); await writeFile(output, JSON.stringify({ result: 'prepared-awaiting-actual-model', synthetic: true, source, baselineSha256: hash(baseline), scenarios, checks, drags }, null, 2) + '\n');
  console.log(`PDF_ACADEMIC_READY ${descriptor}`);
  const commands = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const command of commands) { if (command.trim() === 'report') await report(); if (command.trim() === 'stop') { commands.close(); break; } }
} catch (error) {
  failure = error; process.exitCode = 1;
  await page?.screenshot({ path: resolve('artifacts/pdf-academic-failure.png') }).catch(() => {});
  await writeFile(output, JSON.stringify({ result: 'fail', error: error.message, source, scenarios, checks, drags, errors, transportBusyResponses, binarySha256: await readFile(binary).then(hash).catch(() => null), sourceUnchanged: await readFile(join(projectRoot, 'academic.typ')).then(b => b.equals(baseline)).catch(() => null) }, null, 2) + '\n').catch(() => {});
  console.error(`PDF_ACADEMIC_FAILED ${error.message}`);
} finally {
  if (base && service?.exitCode === null) await local({ action: 'tunnel', enabled: false, reservation: '', public_url: '' }).catch(() => {});
  await browser?.close(); service?.kill('SIGINT');
  if (service) { await Promise.race([new Promise(resolve => { if (service.exitCode !== null) resolve(); else service.once('exit', resolve); }), new Promise(resolve => setTimeout(resolve, 3000))]); if (service.exitCode === null) service.kill('SIGKILL'); }
  assert.ok(resolve(root).startsWith(join(resolve(tmpdir()), 'undertree-pdf-academic-')), 'Cleanup must stay inside the explicitly created temporary fixture.');
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
