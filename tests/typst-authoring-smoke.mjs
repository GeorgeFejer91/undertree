import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';

assert.ok(process.env.UNDERTREE_REVIEW_BINARY && process.env.UNDERTREE_REVIEW_ASSETS, 'Provide an isolated UNDERTREE_REVIEW_BINARY and UNDERTREE_REVIEW_ASSETS snapshot; this gate never builds or uses shared outputs.');
const binary = resolve(process.env.UNDERTREE_REVIEW_BINARY), assets = resolve(process.env.UNDERTREE_REVIEW_ASSETS);
const compiler = process.env.UNDERTREE_TYPST || 'typst';
const version = execFileSync(compiler, ['--version'], { encoding: 'utf8', timeout: 10000 }).trim();
assert.match(version, /^typst 0\.15\.1\b/);
const digest = value => createHash('sha256').update(value).digest('hex');
const temporary = await mkdtemp(join(tmpdir(), 'undertree-typst-authoring-'));
const projectRoot = join(temporary, 'project'), artifacts = resolve('artifacts/reverse-engineering/typst-authoring');
const token = randomBytes(32).toString('hex'), checks = [], errors = [];
const original = [
  '#set text(font: "New Computer Modern", size: 10pt)', '#set heading(numbering: "1.")',
  '// Syntax comment sentinel.', '= Results <sec-results>', '', 'Unicode sentinel 😀 cafe\u0301.',
  'Inline sentinel. x^2.', 'Display sentinel. a^2 + b^2', 'Citation prose sentinel.',
  'Reference prose sentinel.', 'Link text sentinel.', 'Figure prose sentinel.', 'Table prose sentinel.', '',
  '#bibliography("references.bib", style: "ieee")', '',
].join('\r\n');
const actions = [
  ['inline-math', 'Inline math', 'x^2', 'x^2'], ['display-math', 'Display math', 'a^2 + b^2', 'a^2 + b^2'],
  ['citation', 'Citation', 'Citation prose sentinel.', 'citation-key'], ['reference', 'Cross-reference', 'Reference prose sentinel.', 'label'],
  ['link', 'Link', 'Link text sentinel.', 'https://example.org'], ['figure', 'Figure', 'Figure prose sentinel.', 'image.svg'],
  ['table', 'Table', 'Table prose sentinel.', 'Cell'],
];
let browser, page, child, childError, base, project, activeCheck = 'startup', failure, separateTypingUndo = false;
const receipt = { startedAt: new Date().toISOString(), status: 'FAILED', gate: 'Real Rust/browser Typst Insert authoring and syntax highlighting', compiler: version, checks,
  limitations: ['Chrome browser qualification, not native Tauri/OS IME or complete Overleaf parity.', 'Composition veto dispatches synthetic events; multiple selections use the real CodeMirror selection API.', 'Generated project fixtures and actual Typst output, not arbitrary snippet-context or manuscript fidelity.'] };
const pause = ms => new Promise(done => setTimeout(done, ms));
async function poll(run, message, timeout = 45000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await run(); if (value) return value; await pause(80); }
  throw new Error(message);
}
async function call(operation) {
  const response = await fetch(base + '/api/review', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(operation), signal: AbortSignal.timeout(55000) });
  const value = await response.json(); assert.equal(value.ok, true, value.error?.message); return value.result;
}
async function editor(page) {
  return page.locator('.cm-content').evaluate(source => {
    const view = source.cmTile.root.view, { anchor, head, from, to } = view.state.selection.main;
    return { text: view.state.doc.toString(), selection: { anchor, head, from, to }, ranges: view.state.selection.ranges.length, composing: view.compositionStarted };
  });
}
async function select(page, body, nativeEnd = false) {
  await page.locator('.cm-content').evaluate((source, { body, nativeEnd }) => {
    const view = source.cmTile.root.view, text = view.state.doc.toString(), from = text.indexOf(body);
    if (from < 0) throw new Error('Fixture passage is missing: ' + body);
    const to = nativeEnd ? text.indexOf('\n', from) : from + body.length;
    view.dispatch({ selection: { anchor: from, head: to }, scrollIntoView: true }); view.focus();
  }, { body, nativeEnd });
  return editor(page);
}
async function action(page, command) {
  const menu = await page.locator('#workspace-menu summary').isVisible() ? '#workspace-menu' : '#menu-insert';
  await page.locator(menu + ' summary').click();
  await page.locator(`${menu} [data-command="${command}"]`).click();
}
async function file(page, path) {
  await page.locator(`.file-button[data-path="${path}"]`).click();
  await page.waitForFunction(path => document.querySelector('#manuscript-tabs [aria-selected="true"]')?.textContent.replace(/ •$/, '') === path && document.querySelector('.cm-content'), path);
}
async function check(name, run) { activeCheck = name; const observed = await run(); checks.push({ name, status: 'VERIFIED', ...(observed ? { observed } : {}) }); }

try {
  await mkdir(projectRoot); await mkdir(artifacts, { recursive: true });
  await writeFile(join(projectRoot, 'main.typ'), original);
  await writeFile(join(projectRoot, 'plain.html'), '<p>HTML source stays unchanged.</p>\r\n');
  await writeFile(join(projectRoot, 'references.bib'), '@article{authoring-source, title={Bibliography sentinel}, author={UnderTree, Reviewer}, journal={Authoring fixture}, year={2026}}\n');
  await writeFile(join(projectRoot, 'plot.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 30"><rect width="200" height="30" fill="red"/></svg>');
  receipt.identities = [{ path: binary, sha256: digest(await readFile(binary)) }, { path: join(assets, 'manuscript.html'), sha256: digest(await readFile(join(assets, 'manuscript.html'))) }];
  for (const name of (await readdir(join(assets, 'assets'))).filter(name => name.startsWith('manuscript-'))) receipt.identities.push({ path: join(assets, 'assets', name), sha256: digest(await readFile(join(assets, 'assets', name))) });
  child = spawn(binary, [], { env: { ...process.env, UNDERTREE_REVIEW_PORT: '0', UNDERTREE_REVIEW_STATE: join(temporary, 'state'), UNDERTREE_REVIEW_ASSETS: assets, UNDERTREE_REVIEW_TOKEN: token, UNDERTREE_TYPST: compiler }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.on('error', error => { childError = error; });
  let log = '', port;
  child.stdout.on('data', bytes => { log += bytes; port = Number(log.match(/127\.0\.0\.1:(\d+)/)?.[1]); }); child.stderr.on('data', bytes => { log += bytes; });
  await poll(() => { if (childError) throw childError; assert.equal(child.exitCode, null, log); return port; }, 'Isolated Rust service did not start.', 15000);
  base = `http://127.0.0.1:${port}`; project = await call({ action: 'add_project', root: projectRoot });
  browser = await chromium.launch({ executablePath: process.env.UNDERTREE_CHROME || '/usr/bin/google-chrome', headless: true, args: process.platform === 'linux' ? ['--no-sandbox'] : [] });
  receipt.browser = browser.version();
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  await context.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
  page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  await page.goto(base + `/manuscript.html#session=${token}`); await file(page, 'main.typ');

  await check('Typst syntax styling paints the real source without changing its literal CRLF/Unicode', async () => {
    assert.equal((await editor(page)).text, original);
    await page.waitForFunction(() => [...document.querySelectorAll('.cm-content span[class]')].some(span => span.textContent.includes('Syntax comment sentinel.')));
    const styles = await page.locator('.cm-content').evaluate(source => {
      const spans = [...source.querySelectorAll('span[class]')], style = text => {
        const span = spans.find(span => span.textContent.includes(text));
        if (!span) return null; const value = getComputedStyle(span); return { text: span.textContent, color: value.color, weight: value.fontWeight, classes: span.className };
      };
      return { plain: getComputedStyle(source).color, keyword: style('set'), string: style('New Computer Modern'), comment: style('Syntax comment sentinel.'), heading: style('Results') };
    });
    for (const token of ['keyword', 'string', 'comment']) { assert.ok(styles[token], `${token} is painted as a token`); assert.notEqual(styles[token].color, styles.plain, `${token} has visible syntax color`); }
    assert.ok(Number(styles.heading?.weight) >= 600, 'the Typst heading has visible heading styling');
    assert.equal(await readFile(join(projectRoot, 'main.typ'), 'utf8'), original);
    return styles;
  });

  await check('All seven Insert actions select editable placeholders and preserve individual undo/redo and caret', async () => {
    const observed = [];
    for (const [command, label, body, placeholder] of actions) {
      const before = await select(page, body, ['citation', 'reference', 'figure', 'table'].includes(command));
      await action(page, command); const after = await editor(page);
      assert.equal(after.text.slice(after.selection.from, after.selection.to), placeholder, `${label} selects its source placeholder`);
      assert.ok(after.text.includes(body), `${label} retains the selected source wording`);
      if (!['inline-math', 'display-math', 'link'].includes(command)) assert.equal(after.text.slice(0, before.selection.to - 1), before.text.slice(0, before.selection.to - 1), `${label} preserves the selected paragraph before native End`);
      assert.ok(!after.text.replaceAll('\r\n', '').includes('\r'), `${label} preserves complete CRLF`);
      assert.ok(!after.text.replaceAll('\r\n', '').includes('\n'), `${label} never introduces lone LF`);
      assert.equal(await page.locator('.cm-content').evaluate(source => source === document.activeElement), true, `${label} returns focus to the source`);
      await page.locator('#source-undo').click(); let restored = await editor(page);
      assert.equal(restored.text, before.text); assert.deepEqual(restored.selection, before.selection);
      await page.locator('#source-redo').click(); restored = await editor(page);
      assert.equal(restored.text, after.text);
      assert.ok(restored.selection.from >= before.selection.from && restored.selection.to <= before.selection.to + after.text.length - before.text.length, 'ordinary CodeMirror redo keeps its selection within the restored passage/insertion');
      assert.match(await page.locator('#manuscript-tabs [aria-selected="true"]').textContent(), /^main\.typ(?: •)?$/);
      await page.locator('#source-undo').click(); assert.equal((await editor(page)).text, original);
      observed.push({ command, placeholder, undoSelectionExact: true, redoSelectionWithinAffectedPassage: true });
    }
    return observed;
  });

  await check('Composition and multiple selections veto Insert without changing the manuscript', async () => {
    await select(page, 'x^2');
    await page.locator('.cm-content').evaluate(source => (source.editContext || source).dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })));
    await page.waitForFunction(() => document.querySelector('.cm-content').cmTile.root.view.compositionStarted);
    await action(page, 'inline-math'); assert.equal((await editor(page)).text, original);
    assert.match(await page.locator('#review-status').innerText(), /composition/);
    await page.locator('.cm-content').evaluate(source => (source.editContext || source).dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })));
    await page.locator('.cm-content').evaluate(source => {
      const view = source.cmTile.root.view, Selection = view.state.selection.constructor, text = view.state.doc.toString();
      view.dispatch({ selection: Selection.create([Selection.range(text.indexOf('x^2'), text.indexOf('x^2') + 3), Selection.range(text.indexOf('Citation prose'), text.indexOf('Citation prose') + 3)]) });
    });
    assert.equal((await editor(page)).ranges, 2); await action(page, 'citation');
    assert.equal((await editor(page)).text, original); assert.match(await page.locator('#review-status').innerText(), /single selection/);
    await select(page, 'x^2');
    return { sourcePreserved: true, physicalOsIme: 'NOT RUN' };
  });

  await check('Real typing replaces math/key/URL/image/cell placeholders and preserves literal source', async () => {
    for (const [command, , body] of actions) {
      await select(page, body); await action(page, command); const inserted = await editor(page);
      const replacement = { 'inline-math': 'x^3', 'display-math': 'frac(a, b)', citation: 'authoring-source', reference: 'sec-results', link: 'https://example.org/authoring', figure: 'plot.svg', table: 'Data sentinel' }[command];
      await page.keyboard.insertText(replacement); const typed = await editor(page);
      assert.ok(typed.text.includes(replacement)); assert.equal(typed.selection.from, typed.selection.to, 'typing leaves a normal collapsed caret');
      if (command === 'citation') {
        await page.locator('#source-undo').click(); separateTypingUndo = (await editor(page)).text === inserted.text;
        await page.locator('#source-redo').click(); assert.equal((await editor(page)).text, typed.text);
      }
    }
    const completed = await editor(page);
    for (const [, , body] of actions.slice(2)) assert.ok(completed.text.includes(body), 'prose survives source insertion');
    assert.ok(completed.text.includes('Unicode sentinel 😀 cafe\u0301.'));
    assert.ok(!completed.text.replaceAll('\r\n', '').includes('\n'));
    await page.keyboard.press('Control+s');
    await poll(async () => await readFile(join(projectRoot, 'main.typ'), 'utf8') === completed.text, 'The actual editor save did not preserve its literal source.');
    receipt.savedSourceSha256 = digest(completed.text);
  });

  await check('The completed editor manuscript compiles through Rust into real Typst PDF content', async () => {
    await page.locator('#typst-compile').click();
    const saved = await call({ action: 'open', project: project.id, path: 'main.typ' });
    const preview = await poll(async () => { const value = await call({ action: 'pdf', project: project.id, path: 'main.typ' }); return value.available && value.revision === saved.review.revision && value; }, 'The actual Typst PDF did not reach the saved editor revision.');
    await page.locator('#typst-pages canvas').first().waitFor();
    const { getDocument, OPS } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const bytes = Buffer.from(preview.base64, 'base64'), loading = getDocument({ data: new Uint8Array(bytes), useSystemFonts: false, isEvalSupported: false });
    try {
      const pdf = await loading.promise; assert.ok(pdf.numPages >= 1 && pdf.numPages <= 2);
      const words = [], annotations = [], operators = [], items = [];
      for (let number = 1; number <= pdf.numPages; number++) {
        const page = await pdf.getPage(number), content = await page.getTextContent(), ops = await page.getOperatorList();
        words.push(content.items.map(item => item.str || '').join(' ')); items.push(...content.items); annotations.push(...await page.getAnnotations()); operators.push(...ops.fnArray);
      }
      const text = words.join(' ').replace(/\s+/g, ' ');
      for (const sentinel of ['Inline sentinel.', 'Display sentinel.', 'Citation prose sentinel.', 'Reference prose sentinel.', 'Link text sentinel.', 'Figure prose sentinel.', 'Table prose sentinel.', 'Caption', 'Data sentinel', 'Bibliography sentinel']) assert.ok(text.includes(sentinel), `${sentinel} is in the actual PDF`);
      assert.equal((text.match(/\bCell\b/g) || []).length, 3);
      assert.ok(annotations.some(item => item.url === 'https://example.org/authoring')); assert.ok(annotations.some(item => item.dest));
      assert.ok(operators.includes(OPS.constructPath), 'the local SVG becomes drawing operations');
      assert.ok(items.some(item => item.str === '3' && item.height < 10), 'the edited superscript is typeset');
      return { pages: pdf.numPages, bytes: bytes.length, revision: preview.revision, sha256: digest(bytes), semantics: ['math', 'bibliography', 'reference', 'hyperlink', 'vector figure', 'four table cells'] };
    } finally { await loading.destroy(); }
  });

  await check('HTML disables the seven Typst actions and retains its own editor source', async () => {
    await file(page, 'plain.html'); const before = await editor(page); await page.locator('#menu-insert summary').click();
    for (const [command] of actions) assert.equal(await page.locator(`#menu-insert [data-command="${command}"]`).isDisabled(), true);
    await page.keyboard.press('Escape'); assert.equal((await editor(page)).text, before.text);
    await file(page, 'main.typ');
  });

  await check('320px and 200% text menus expose all seven actions with real Pretext and bounded readable controls', async () => {
    const observed = [];
    for (const size of [14, 28]) {
      await page.setViewportSize({ width: 320, height: 900 }); await page.evaluate(size => document.documentElement.style.fontSize = size + 'px', size);
      await page.getByRole('button', { name: 'Editor', exact: true }).click();
      await page.locator('#workspace-menu summary').focus(); await page.keyboard.press('ArrowDown');
      assert.equal(await page.locator('#workspace-menu').getAttribute('open'), '');
      await page.evaluate(() => document.fonts.ready);
      for (const [command, label] of actions) {
        const button = page.locator(`#workspace-menu [data-command="${command}"]`); await button.scrollIntoViewIfNeeded(); await button.focus();
        assert.equal(await button.getAttribute('data-measure'), ''); assert.equal(await button.innerText(), label);
        await poll(async () => ['fit', 'reflow'].includes(await button.getAttribute('data-text-fit')), `${label} did not receive usable actual Pretext measurement at ${size}px.`, 10000);
        const bounds = await button.evaluate(button => { const b = button.getBoundingClientRect(), menu = button.closest('.workspace-menu-panel').getBoundingClientRect(); return { viewport: b.left >= -1 && b.right <= innerWidth + 1 && b.top >= -1 && b.bottom <= innerHeight + 1, menu: b.left >= menu.left - 1 && b.right <= menu.right + 1 && b.top >= menu.top - 1 && b.bottom <= menu.bottom + 1, text: button.scrollWidth <= button.clientWidth + 1 && button.scrollHeight <= button.clientHeight + 2, measured: button.dataset.textFit }; });
        assert.ok(bounds.viewport && bounds.menu && bounds.text, `${label} remains readable inside the menu/viewport at ${size}px`);
      }
      const pageBounds = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight, viewportWidth: innerWidth, viewportHeight: innerHeight }));
      assert.ok(pageBounds.width <= 321 && pageBounds.height <= 901);
      await page.screenshot({ path: join(artifacts, `menu-320-${size}px.png`), fullPage: true });
      await page.keyboard.press('Escape'); assert.equal(await page.locator('#workspace-menu').getAttribute('open'), null);
      observed.push({ width: 320, height: 900, rootFont: size, actions: 7, pretext: 'fit/reflow', ...pageBounds });
    }
    return observed;
  });
  await check('Placeholder typing and menu insertion remain separate undo steps', async () => {
    assert.equal(separateTypingUndo, true, 'one typing undo must retain the inserted citation');
  });
  assert.deepEqual(errors, []); receipt.status = 'VERIFIED';
} catch (error) {
  failure = error; receipt.failedCheck = activeCheck; receipt.error = error.message;
  await page?.screenshot({ path: join(artifacts, 'failed.png'), fullPage: true }).catch(() => {});
}
finally {
  const cleanupErrors = [];
  async function cleanup(run) {
    try { await run(); }
    catch (error) { failure ||= error; receipt.status = 'FAILED'; cleanupErrors.push(error.message); }
  }
  await cleanup(() => browser?.close());
  await cleanup(async () => {
    if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGTERM');
    try { await poll(() => child.exitCode !== null || child.signalCode !== null, 'Owned Rust service did not stop.', 5000); }
    catch {
      child.kill('SIGKILL');
      await poll(() => child.exitCode !== null || child.signalCode !== null, 'Owned Rust service did not stop after SIGKILL.', 5000);
    }
  });
  await cleanup(() => rm(temporary, { recursive: true, force: true }));
  if (cleanupErrors.length) { receipt.cleanupErrors = cleanupErrors; receipt.failedCheck ||= 'cleanup'; receipt.error ||= failure.message; }
  receipt.finishedAt = new Date().toISOString(); receipt.pageErrors = errors;
  await cleanup(async () => { await mkdir(artifacts, { recursive: true }); await writeFile(join(artifacts, 'evidence.json'), JSON.stringify(receipt, null, 2) + '\n'); });
}
if (failure) throw failure;
console.log(JSON.stringify({ status: receipt.status, checks: checks.length, receipt: join(artifacts, 'evidence.json'), binarySha256: receipt.identities[0].sha256 }));
