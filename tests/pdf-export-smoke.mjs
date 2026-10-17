import { consentToFixtureShare } from './context-fixture.mjs';
// Real Typst/PDF + local consent + MCP/HTTP. Requires Typst and pdftotext on PATH.
// zrok is simulated; no public route, ChatGPT client or native OS-window claim.
import assert from 'node:assert/strict';
import { createZrokFixture } from './zrok-fixture.mjs';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { cp, mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const temporary = await mkdtemp(join(tmpdir(), 'undertree-pdf-export-'));
const binary = resolve(process.env.UNDERTREE_REVIEW_BINARY || 'target/debug/undertree-review');
const firstRoot = join(temporary, 'shared-project'), secondRoot = join(temporary, 'later-project'), assets = join(temporary, 'assets'), target = join(temporary, 'target');
const token = randomBytes(32).toString('hex'), sha = bytes => createHash('sha256').update(bytes).digest('hex'), checks = [], errors = [], observed = [];
let service, browser, port, log = '', local, remoteOrigin;
async function until(check, message) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) { if (await check()) return; if (service?.exitCode !== null) throw new Error(log); await new Promise(resolve => setTimeout(resolve, 50)); }
  throw new Error(message);
}
async function textOfPdf(bytes) {
  const process = spawn(globalThis.process.env.UNDERTREE_PDFTOTEXT || 'pdftotext', ['-', '-'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let result = '', error = ''; process.stdout.on('data', bytes => { result += bytes; }); process.stderr.on('data', bytes => { error += bytes; });
  const timeout = setTimeout(() => process.kill('SIGKILL'), 10_000); process.stdin.end(bytes);
  try { const code = await new Promise((resolve, reject) => { process.once('error', reject); process.once('exit', resolve); }); assert.equal(code, 0, error); return result; }
  finally { clearTimeout(timeout); }
}
try {
  await mkdir(firstRoot); await mkdir(secondRoot); await cp(resolve(process.env.UNDERTREE_REVIEW_ASSETS || 'dist'), assets, { recursive: true });
  const main = '= Shared manuscript\n#include "private.typ"\n', privateText = 'A saved unshared section appears in this exported PDF.\n', secondMain = 'Another project needs separate export permission.\n';
  await writeFile(join(firstRoot, 'main.typ'), main); await writeFile(join(firstRoot, 'private.typ'), privateText); await writeFile(join(secondRoot, 'other.typ'), secondMain);
  const zrokFixture = await createZrokFixture(temporary, target, 'pdf-export.example.org');
  service = spawn(binary, [], { env: { ...process.env, ...zrokFixture.environment, UNDERTREE_REVIEW_PORT: '0', UNDERTREE_REVIEW_STATE: join(temporary, 'state'), UNDERTREE_REVIEW_ASSETS: assets, UNDERTREE_REVIEW_TOKEN: token, UNDERTREE_ZROK: zrokFixture.executable }, stdio: ['ignore', 'pipe', 'pipe'] });
  service.stdout.on('data', bytes => { log = (log + bytes).slice(-16_000); port = Number(log.match(/127\.0\.0\.1:(\d+)/)?.[1]); }); service.stderr.on('data', bytes => { log = (log + bytes).slice(-16_000); });
  await until(() => port, 'The native PDF authority did not start.'); const base = `http://127.0.0.1:${port}`;
  local = async operation => {
    operation = await consentToFixtureShare(operation, local);
    const envelope = await fetch(base + '/api/review', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(operation) }).then(response => response.json());
    assert.equal(envelope.ok, true, envelope.error?.message); return envelope.result;
  };
  const first = await local({ action: 'add_project', root: firstRoot }), second = await local({ action: 'add_project', root: secondRoot });
  const snapshots = [];
  for (const [project, path] of [[first, 'main.typ'], [second, 'other.typ']]) {
    const snapshot = await local({ action: 'open', project: project.id, path }); snapshots.push(snapshot);
    await local({ action: 'palette', project: project.id, path, revision: snapshot.review.revision, rules: snapshot.review.rules });
  }
  await local({ action: 'share', project: first.id, path: 'main.typ', enabled: true });
  const paths = [join(firstRoot, 'main.typ'), join(firstRoot, 'private.typ'), join(firstRoot, 'main.typ.undertree-review.json'), join(secondRoot, 'other.typ'), join(secondRoot, 'other.typ.undertree-review.json')];
  const before = await Promise.all(paths.map(path => readFile(path)));
  browser = await chromium.launch({ executablePath: process.env.UNDERTREE_CHROME || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (/\/api\/(review|editor)$/.test(request.url())) observed.push(request.postDataJSON()); });
  const heartbeat = new Set();
  page.on('response', async response => { if (response.url().endsWith('/api/control') && response.request().postDataJSON()?.action === 'control_poll') { const envelope = await response.json().catch(() => null); if (envelope?.ok && envelope.result.enabled) heartbeat.add(envelope.result.generation); } });
  await page.goto(base + `/manuscript.html#session=${token}`); await page.locator('#project-select').selectOption(first.id);
  await page.locator('.file-button[data-path="main.typ"]').click(); await page.locator('.cm-content').waitFor();
  await page.locator('#typst-compile').click();
  let pdf; await until(async () => { pdf = await local({ action: 'pdf', project: first.id, path: 'main.typ' }); return pdf.available && pdf.current; }, 'The real UI Typst compilation did not produce a current saved PDF.');
  await page.locator('#typst-pages canvas').first().waitFor();
  const bytes = Buffer.from(pdf.base64, 'base64'), artifactId = sha(Buffer.from(pdf.base64)), rawSha = sha(bytes);
  assert.equal(bytes.subarray(0, 5).toString(), '%PDF-'); assert.match(await textOfPdf(bytes), /A saved unshared section appears in this exported PDF\./);
  const otherPdf = await local({ action: 'compile', project: second.id, path: 'other.typ', revision: snapshots[1].review.revision });
  assert.equal(otherPdf.available, true); const otherArtifactId = sha(Buffer.from(otherPdf.base64));
  checks.push('real UI Typst compilation includes saved unshared project text without editing its source');
  await local({ action: 'tunnel', enabled: true, reservation: 'pdf-export-fixture', public_url: 'https://pdf-export.example.org' });
  remoteOrigin = await readFile(target, 'utf8');
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-06-18' };
  const routed = url => remoteOrigin + new URL(url).pathname;
  async function rpc(endpoint, method, params = {}) {
    let response;
    for (let attempt = 0; attempt < 10; attempt += 1) { response = await fetch(routed(endpoint), { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }); if (response.status !== 429) break; await new Promise(resolve => setTimeout(resolve, 50)); }
    assert.equal(response.status, 200, `${method} HTTP status`); const result = await response.json(); assert.equal(result.error, undefined); return result.result;
  }
  const initialize = endpoint => rpc(endpoint, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'UnderTree PDF export fixture', version: '1' } });
  const tool = (endpoint, name, args = {}) => rpc(endpoint, 'tools/call', { name, arguments: args });
  const value = reply => { assert.equal(reply.isError, false, reply.content?.find(item => item.type === 'text')?.text); return reply.structuredContent.result; };
  let connection = await local({ action: 'connection' }); const reviewEndpoint = connection.endpoint;
  await initialize(reviewEndpoint); assert.deepEqual((await rpc(reviewEndpoint, 'tools/list')).tools.map(item => item.name), ['list_manuscripts', 'read_manuscript', 'suggest_text', 'highlight_text']);
  const args = { documentId: snapshots[0].documentId, revision: pdf.revision, artifactId };
  assert.equal((await tool(reviewEndpoint, 'get_pdf_download', args)).isError, true);
  await page.locator('#connection-open').click(); await page.locator('#connection-tab-app').click(); await page.locator('#connection-app-enabled').check();
  async function appReady() {
    await until(async () => { connection = await local({ action: 'connection' }); return connection.appControls.enabled && heartbeat.has(connection.appControls.generation); }, 'The native App grant did not receive its UI heartbeat.');
    await initialize(connection.appControls.endpoint); return connection.appControls.endpoint;
  }
  let appEndpoint = await appReady();
  assert.equal((await tool(appEndpoint, 'get_pdf_download', args)).isError, true);
  assert.equal(value(await tool(appEndpoint, 'list_manuscripts'))[0].savedPdf, undefined);
  checks.push('source sharing and App control alone deny PDF export and preserve the closed four-tool Review catalogue');
  const disclosure = page.locator('#connection-pdf-export'), selected = page.locator(`#connection-pdf-export-projects input[value="${first.id}"]`);
  await disclosure.locator(':scope > summary').click();
  async function allow() { await selected.check(); await page.locator('#connection-pdf-export-apply').click(); await until(async () => (await local({ action: 'connection' })).appControls.pdfExport.enabled, 'Explicit local PDF permission did not enable.'); }
  await allow();
  let listed = value(await tool(appEndpoint, 'list_manuscripts'));
  const metadata = listed.find(item => item.documentId === args.documentId).savedPdf;
  assert.deepEqual(metadata, { available: true, revision: args.revision, artifactId, sha256: rawSha, bytes: bytes.length });
  const reply = await tool(appEndpoint, 'get_pdf_download', args), download = value(reply);
  assert.equal(download.documentId, args.documentId); assert.equal(download.revision, args.revision); assert.equal(download.artifactId, artifactId); assert.equal(download.sha256, rawSha); assert.equal(download.bytes, bytes.length); assert.equal(download.mimeType, 'application/pdf'); assert.ok(download.expiresAt > Date.now());
  assert.ok(reply.content.some(item => item.type === 'resource_link' && item.uri === download.downloadUrl && item.mimeType === 'application/pdf' && item.size === bytes.length));
  const url = routed(download.downloadUrl), head = await fetch(url, { method: 'HEAD' });
  assert.equal(head.status, 200); assert.equal(Number(head.headers.get('content-length')), bytes.length); assert.equal((await head.arrayBuffer()).byteLength, 0);
  const get = await fetch(url), received = Buffer.from(await get.arrayBuffer());
  assert.equal(get.status, 200); assert.equal(get.headers.get('content-type'), 'application/pdf'); assert.equal(get.headers.get('cache-control'), 'no-store'); assert.equal(get.headers.get('x-content-type-options'), 'nosniff'); assert.match(get.headers.get('content-disposition'), /^attachment;/); assert.deepEqual(received, bytes); assert.equal(sha(received), rawSha);
  for (const invalid of [{ revision: '0'.repeat(64) }, { artifactId: '0'.repeat(64) }]) assert.equal((await tool(appEndpoint, 'get_pdf_download', { ...args, ...invalid })).isError, true);
  assert.equal(JSON.stringify({ metadata, download: { ...download, downloadUrl: undefined } }).includes(firstRoot), false);
  checks.push('MCP savedPdf and exact download descriptor match immutable raw PDF bytes/SHA/revision/artifact ID through real HEAD and GET');
  await local({ action: 'share', project: second.id, path: 'other.typ', enabled: true }); await page.locator('#connection-refresh').click();
  const secondInput = page.locator(`#connection-pdf-export-projects input[value="${second.id}"]`); await secondInput.waitFor(); assert.equal(await secondInput.isChecked(), false);
  listed = value(await tool(appEndpoint, 'list_manuscripts')); assert.equal(listed.find(item => item.documentId === snapshots[1].documentId).savedPdf, undefined);
  assert.equal((await tool(appEndpoint, 'get_pdf_download', { documentId: snapshots[1].documentId, revision: otherPdf.revision, artifactId: otherArtifactId })).isError, true);
  checks.push('a newly shared project root remains outside the standing permission and exposes no saved PDF metadata');
  await page.locator('#connection-pdf-export-disable').click(); await until(async () => !(await local({ action: 'connection' })).appControls.pdfExport.enabled, 'PDF permission did not revoke.');
  assert.equal((await fetch(url)).status, 404); assert.equal((await fetch(url, { method: 'HEAD' })).status, 404);
  await allow(); const appTicket = value(await tool(appEndpoint, 'get_pdf_download', args));
  await page.locator('#connection-app-enabled').uncheck(); await until(async () => !(await local({ action: 'connection' })).appControls.enabled, 'App permission did not revoke.');
  assert.equal((await fetch(routed(appTicket.downloadUrl))).status, 404);
  await page.locator('#connection-app-enabled').check(); appEndpoint = await appReady();
  assert.equal((await local({ action: 'connection' })).appControls.pdfExport.enabled, false); await allow();
  const shareTicket = value(await tool(appEndpoint, 'get_pdf_download', args));
  await local({ action: 'share', project: first.id, path: 'main.typ', enabled: false });
  assert.equal((await fetch(routed(shareTicket.downloadUrl))).status, 404);
  checks.push('export revocation, App revocation and unsharing each deny previously issued download URLs; replacement App grants start with export off');
  assert.equal(observed.filter(operation => ['save', 'editor_commit'].includes(operation.action)).length, 0);
  for (let index = 0; index < paths.length; index += 1) assert.deepEqual(await readFile(paths[index]), before[index], 'export and compilation preserve source and policy bytes');
  assert.deepEqual(errors, []); await mkdir(resolve('artifacts'), { recursive: true });
  await writeFile(resolve('artifacts/pdf-export-smoke.json'), JSON.stringify({ browser: browser.version(), checks, pdf: { revision: args.revision, artifactId, sha256: rawSha, bytes: bytes.length }, errors, scope: 'real Rust/Typst/UI/MCP/HTTP; fake zrok, no public ChatGPT route claim; capability URLs omitted' }, null, 2) + '\n');
  console.log(`PDF export: ${checks.length} real Typst/UI/MCP/HTTP checks passed.`);
} finally {
  await browser?.close();
  if (service?.exitCode === null) { await local?.({ action: 'tunnel', enabled: false, reservation: '', public_url: '' }).catch(() => {}); service.kill('SIGINT'); await Promise.race([new Promise(resolve => service.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 2000))]); if (service.exitCode === null) service.kill('SIGKILL'); }
  await rm(temporary, { recursive: true, force: true });
}
