// Real Typst line numbers, PDF.js selection/copy, literal formatting and byte preservation.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';

assert.ok(process.env.UNDERTREE_TYPST && process.env.UNDERTREE_CHROME, 'Supply real UNDERTREE_TYPST and UNDERTREE_CHROME executables.');
const binary = resolve(process.env.UNDERTREE_REVIEW_BINARY || `target/debug/undertree-review${process.platform === 'win32' ? '.exe' : ''}`), inputAssets = resolve(process.env.UNDERTREE_REVIEW_ASSETS || 'dist');
const root = await mkdtemp(join(tmpdir(), 'undertree-pdf-prose-')), projectRoot = join(root, 'project'), assets = join(root, 'assets'), runningBinary = join(root, `undertree-review${process.platform === 'win32' ? '.exe' : ''}`);
const token = randomBytes(32).toString('hex'), checks = [], errors = [], observations = [], traffic = [];
const prose = 'The 40 participants completed a documented task in 2026. Their mean score was 18.2. These descriptive values are retained during review. The bold phrase and italic phrase distinguish typography from the underlying words. Longer explanatory text ensures that this numbered paragraph wraps across several visible lines while every stated number remains part of the actual prose.';
const markedUp = prose.replace('bold phrase', '*bold phrase*').replace('italic phrase', '_italic phrase_');
const source = '#set page(width: 150mm, height: 150mm, margin: 20mm)\n#set text(size: 12pt)\n#set par.line(numbering: "1")\n\n' + markedUp + '\n';
const bytes = Buffer.from(source), hash = value => createHash('sha256').update(value).digest('hex');
const output = resolve(process.env.UNDERTREE_PDF_PROSE_RECEIPT || 'artifacts/pdf-prose-selection-smoke.json');
let service, browser, page, base, port, project, log = '', failure;
async function until(check, message) { const deadline = Date.now() + 25_000; while (Date.now() < deadline) { if (await check()) return; if (service?.exitCode !== null && service?.exitCode !== undefined) throw Error(log); await new Promise(resolve => setTimeout(resolve, 25)); } throw Error(message); }
async function local(operation) {
  let value;
  await until(async () => { value = await fetch(base + '/api/review', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(operation) }).then(response => response.json()); return value.error?.code !== 'busy'; }, 'Native operation remained busy.');
  assert.equal(value.ok, true, value.error?.message); return value.result;
}
const saved = () => local({ action: 'review', project: project.id, path: 'main.typ' });
const unchanged = async () => assert.deepEqual(await readFile(join(projectRoot, 'main.typ')), bytes, 'Selection, copying and annotations must preserve every source byte and formatting delimiter.');
async function selectPdf(text = null) {
  return page.locator('.pdf-text-layer').first().evaluate((layer, text) => {
    const selected = document.getSelection(); selected.removeAllRanges();
    const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT), nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    const body = nodes.filter(node => !node.parentElement.closest('[data-pdf-line-number]') && node.textContent.trim());
    const range = document.createRange();
    if (text) {
      const node = body.find(node => node.textContent.includes(text)); if (!node) return { found: false, body: body.map(node => node.textContent) };
      const index = node.textContent.indexOf(text); range.setStart(node, index); range.setEnd(node, index + text.length);
    } else { range.setStart(body[0], 0); range.setEnd(body.at(-1), body.at(-1).textContent.length); }
    selected.addRange(range); return { found: true, nativeText: selected.toString(), rects: range.getClientRects().length };
  }, text);
}
async function copyPdf() { await page.keyboard.press('Control+c'); return page.evaluate(() => navigator.clipboard.readText()); }

try {
  await mkdir(resolve('artifacts'), { recursive: true }); await mkdir(projectRoot); await cp(inputAssets, assets, { recursive: true }); await cp(binary, runningBinary); await writeFile(join(projectRoot, 'main.typ'), bytes);
  service = spawn(runningBinary, [], { windowsHide: true, env: { ...process.env, UNDERTREE_REVIEW_PORT: '0', UNDERTREE_REVIEW_STATE: join(root, 'state'), UNDERTREE_REVIEW_ASSETS: assets, UNDERTREE_REVIEW_TOKEN: token }, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [service.stdout, service.stderr]) stream.on('data', value => { log = (log + value).slice(-16_000); port = Number(log.match(/127\.0\.0\.1:(\d+)/)?.[1]); });
  await until(() => !!port, 'The prose selection service did not start.'); base = `http://127.0.0.1:${port}`; project = await local({ action: 'add_project', root: projectRoot });
  browser = await chromium.launch({ executablePath: process.env.UNDERTREE_CHROME, headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1600, height: 950 }, permissions: ['clipboard-read', 'clipboard-write'] }); page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (/\/api\/(review|editor)$/.test(request.url())) traffic.push({ event: 'start', time: Date.now(), action: request.postDataJSON()?.action }); });
  page.on('response', async response => { if (/\/api\/(review|editor)$/.test(response.url())) { const value = await response.json().catch(() => null); traffic.push({ event: 'end', time: Date.now(), action: response.request().postDataJSON()?.action, ok: value?.ok, error: value?.error }); } });
  await page.goto(base + `/manuscript.html#session=${token}`);
  const registered = page.waitForResponse(async response => /\/api\/editor$/.test(response.url()) && response.request().postDataJSON()?.action === 'editor_register' && (await response.json()).ok === true);
  await page.locator('.file-button[data-path="main.typ"]').click(); await page.locator('.cm-content').waitFor(); await registered;
  await page.locator('#typst-compile').click();
  await until(async () => await page.locator('#typst-preview-status').getAttribute('data-state') === 'current' && await page.locator('.pdf-text-layer span').count() > 0, 'The line-numbered PDF did not render.');
  const geometry = await page.locator('.pdf-text-layer').first().evaluate(layer => [...layer.querySelectorAll('span')].map(span => { const rect = span.getBoundingClientRect(); return { text: span.textContent, x: rect.x, y: rect.y, width: rect.width, height: rect.height, number: span.hasAttribute('data-pdf-line-number') }; }));
  await writeFile(resolve('artifacts/pdf-prose-geometry.json'), JSON.stringify(geometry, null, 2) + '\n'); observations.push({ geometry });
  if (process.env.UNDERTREE_PROSE_CAPTURE_ONLY === '1') { checks.push('Captured actual compiled Typst/PDF.js geometry only; behavior qualification not requested for this run.'); }
  else {
    const excludedNumbers = Number(await page.locator('.pdf-text-layer').first().getAttribute('data-pdf-line-numbers'));
    assert.equal(excludedNumbers, 7, 'The seven actual Typst artifact gutter numbers must be excluded from the selectable overlay.');
    assert.equal(await page.locator('.pdf-text-layer span').evaluateAll(spans => spans.some(span => /^[1-7]$/.test(span.textContent.trim()))), false, 'Verified gutter digits must not contaminate native Range/copy text nodes.');
    const selection = await selectPdf(); assert.equal(selection.found, true); assert.ok(selection.rects > 2); observations.push({ selection });
    const copied = await copyPdf(); observations.push({ copied });
    assert.equal(copied.replace(/\s+/g, ' ').trim(), prose, 'Copying actual PDF prose excludes only the numbered gutter and retains all inline data and formatted words.');
    for (const value of ['40', '18.2', '2026']) assert.ok(copied.includes(value));
    assert.ok(copied.includes('bold phrase') && copied.includes('italic phrase')); await unchanged();
    checks.push('Real numbered PDF selection/copy excludes the verified gutter, preserves inline 40/18.2/2026 and includes bold/italic words across wrapped lines.');
    const rule = (await saved()).review.rules.find(rule => rule.action === 'prompt');
    // Printed prose can be annotated without inventing a range across source markup.
    await page.locator(`[data-color-rule="${rule.id}"]`).click();
    const fullMark = page.waitForResponse(async response => response.url().endsWith('/api/review') && response.request().postDataJSON()?.action === 'pdf_mark' && (await response.json()).ok);
    await page.locator('#pdf-highlight-selection').click(); await fullMark;
    const annotated = (await saved()).review;
    assert.equal(annotated.markers.length, 0); assert.equal(annotated.pdfAnnotations.length, 1); assert.equal(annotated.pdfAnnotations[0].sourceMarkerId, undefined);
    assert.ok(annotated.pdfAnnotations[0].segments[0].quote.includes('bold phrase')); assert.ok(!annotated.pdfAnnotations[0].segments[0].quote.includes('*')); await unchanged();
    checks.push('A selection crossing formatting delimiters persists as positional PDF metadata without guessed source ranges or source edits.');
    const bold = await selectPdf('bold phrase'); assert.equal(bold.found, true, JSON.stringify(bold)); assert.equal((await copyPdf()).trim(), 'bold phrase');
    const markResponse = page.waitForResponse(async response => { if (!response.url().endsWith('/api/review') || response.request().postDataJSON()?.action !== 'pdf_mark') return false; const value = await response.json(); return !(value.error?.code === 'busy' && value.error.message === 'A local document operation is running. Retry this action.'); });
    await page.locator('#pdf-highlight-selection').click(); assert.equal((await (await markResponse).json()).ok, true);
    const marker = (await saved()).review.markers[0]; assert.equal(marker.anchor.quote, 'bold phrase'); assert.equal(marker.anchor.from, source.indexOf('bold phrase')); assert.equal(marker.anchor.to, source.indexOf('bold phrase') + 'bold phrase'.length); await unchanged();
    assert.equal((await saved()).review.pdfAnnotations.at(-1).sourceMarkerId, marker.id);
    checks.push('Literal words within bold prose can be marked exactly, preserving the surrounding Typst formatting delimiters.');
    await page.evaluate(() => document.getSelection().removeAllRanges());
    await page.locator('.cm-content').focus(); await page.keyboard.press('Control+Home');
    for (let index = 0; index < source.indexOf('bold phrase'); index++) await page.keyboard.press('ArrowRight');
    for (let index = 0; index < 'bold phrase'.length; index++) await page.keyboard.press('Shift+ArrowRight');
    assert.equal(await page.evaluate(() => document.getSelection().toString()), 'bold phrase'); await page.keyboard.press('Control+c'); assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'bold phrase'); await unchanged();
    checks.push('The actual source selection and copied text exclude CodeMirror line numbers and unselected formatting characters.');
    await page.screenshot({ path: resolve('artifacts/pdf-prose-selection.png') }); assert.deepEqual(errors, []);
  }
  console.log(`PDF prose: ${checks.length} ${process.env.UNDERTREE_PROSE_CAPTURE_ONLY === '1' ? 'geometry capture' : 'real selection/copy'} checks passed.`);
} catch (error) { failure = error; if (page) { errors.push(await page.locator('#review-status').textContent({ timeout: 1000 }).catch(() => 'Status unavailable')); await page.screenshot({ path: resolve('artifacts/pdf-prose-selection-failure.png') }).catch(() => {}); } throw error; }
finally {
  await browser?.close(); service?.kill('SIGINT'); if (service) { await Promise.race([new Promise(resolve => { if (service.exitCode !== null) resolve(); else service.once('exit', resolve); }), new Promise(resolve => setTimeout(resolve, 3000))]); if (service.exitCode === null) service.kill('SIGKILL'); }
  await writeFile(output, JSON.stringify({ result: failure ? 'failed' : process.env.UNDERTREE_PROSE_CAPTURE_ONLY === '1' ? 'geometry-only' : 'passed', error: failure?.message, checks, observations, errors, traffic, sourceSha256: hash(bytes), binarySha256: await readFile(runningBinary).then(hash).catch(() => null), runnerSha256: hash(await readFile(new URL(import.meta.url))) }, null, 2) + '\n'); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
