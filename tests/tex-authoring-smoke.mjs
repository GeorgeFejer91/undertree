import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

assert.equal(process.env.UNDERTREE_TEX_UI_LAUNCH, '1', 'Obtain the serialized browser QA lane before launching.');
for (const name of ['UNDERTREE_REVIEW_BINARY', 'UNDERTREE_REVIEW_ASSETS', 'UNDERTREE_LATEX_WORKER']) {
  assert.ok(process.env[name], `Provide an isolated ${name}; this gate never builds.`);
}
const binary = resolve(process.env.UNDERTREE_REVIEW_BINARY);
const assets = resolve(process.env.UNDERTREE_REVIEW_ASSETS);
const worker = resolve(process.env.UNDERTREE_LATEX_WORKER);
const artifact = resolve(
  process.env.UNDERTREE_TEX_UI_OUTPUT || `artifacts/reverse-engineering/fast-tex/authoring-${Date.now()}`,
);
const temporary = await mkdtemp(join(tmpdir(), 'undertree-tex-ui-'));
const projectRoot = join(temporary, 'project');
const token = randomBytes(32).toString('hex');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const checks = [];
const checkFilter = process.env.UNDERTREE_TEX_UI_CHECK_FILTER;
const selectedChecks = checkFilter ? new RegExp(checkFilter) : null;
const pageErrors = [];
const operations = [];
const requestRecords = new WeakMap();
const receipt = {
  startedAt: new Date().toISOString(), status: 'FAILED', checks, operations,
  checkFilter: checkFilter || null, skippedChecks: [],
  limitations: [
    'Real Rust/Chrome editor and compiler path; not native Tauri or physical OS IME qualification.',
    'Synthetic composition events verify the composing veto only.',
    'Held API delivery verifies independent editor state; it is not a compiler throughput benchmark.',
  ],
};
let child;
let browser;
let page;
let base;
let project;
let log = '';
let activeCheck = 'startup';
let releaseSave;
let releaseCompile;
let holdSave = false;
let holdCompile = false;
let saveHeld = false;
let compileHeld = false;
const pause = milliseconds => new Promise(done => setTimeout(done, milliseconds));
const compileOperations = () => operations.filter(operation => operation.action === 'compile');

async function poll(run, message, timeout = 90000) {
  const until = performance.now() + timeout;
  while (performance.now() < until) {
    const value = await run();
    if (value) return value;
    await pause(50);
  }
  throw Error(message);
}

async function call(operation) {
  const response = await fetch(base + '/api/review', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(operation), signal: AbortSignal.timeout(90000),
  });
  const value = await response.json();
  assert.equal(value.ok, true, value.error?.message);
  return value.result;
}

async function editor() {
  return page.locator('.cm-content').evaluate(node => {
    const view = node.cmTile.root.view;
    return {
      text: view.state.doc.toString(), composing: view.compositionStarted,
      readOnly: node.getAttribute('contenteditable') === 'false',
    };
  });
}

async function append(text) {
  await page.locator('.cm-content').evaluate((node, text) => {
    const view = node.cmTile.root.view;
    view.dispatch({
      changes: { from: view.state.doc.length, insert: text },
      selection: { anchor: view.state.doc.length + text.length },
    });
    view.focus();
  }, text);
}

async function file(path) {
  for (const part of path.split('/').slice(0, -1)) {
    const folder = page.locator(`.file-folder[data-path="${part}"] > summary`);
    if (await folder.count() && !await folder.locator('..').evaluate(node => node.open)) {
      await folder.click();
    }
  }
  await page.locator(`.file-button[data-path="${path}"]`).click();
  await page.waitForFunction(path =>
    document.querySelector('#manuscript-tabs [aria-selected="true"]')?.textContent.replace(/ •$/, '') === path
      && document.querySelector('.cm-content'), path);
}

async function pdfText(preview) {
  const loading = getDocument({
    data: new Uint8Array(Buffer.from(preview.base64, 'base64')),
    useSystemFonts: false, isEvalSupported: false,
  });
  const document = await loading.promise;
  try {
    let text = '';
    for (let index = 1; index <= document.numPages; index++) {
      const page = await document.getPage(index);
      text += (await page.getTextContent()).items.map(item => item.str || '').join(' ');
    }
    return text;
  } finally {
    await loading.destroy();
  }
}

async function previewWith(marker) {
  return poll(async () => {
    const preview = await call({ action: 'pdf', project: project.id, path: 'main.tex' });
    return preview.available && (await pdfText(preview)).includes(marker) && preview;
  }, `PDF did not include ${marker}`);
}

async function check(name, run) {
  if (selectedChecks && !selectedChecks.test(name)) {
    receipt.skippedChecks.push(name);
    return;
  }
  activeCheck = name;
  await run();
  checks.push({ name, status: 'VERIFIED' });
  console.log('VERIFIED ' + name);
  await writeFile(join(artifact, 'receipt.json'), JSON.stringify(receipt, null, 2));
}

async function waitForIdleCompile() {
  await page.waitForFunction(() => document.querySelector('#typst-compile').textContent === 'Recompile');
}

async function emitComposition(type) {
  await page.locator('.cm-content').evaluate((node, type) =>
    (node.editContext || node).dispatchEvent(new CompositionEvent(type, { bubbles: true })), type);
}

// Query only children of this test's service, then require observed compiler CPU progress.
function observeOwnedWorker() {
  assert.equal(process.platform, 'win32', 'The live child CPU witness is scoped to Windows.');
  assert.ok(Number.isSafeInteger(child.pid) && child.pid > 0);
  const name = basename(worker).replaceAll("'", "''");
  const script = `
    $ErrorActionPreference = 'Stop'
    $ProgressPreference = 'SilentlyContinue'
    $ownedServicePid = ${child.pid}
    $null = Get-CimInstance Win32_Process -Filter "ParentProcessId = $ownedServicePid AND Name = '${name}'"
    [Console]::WriteLine('READY')
    $deadline = [Diagnostics.Stopwatch]::StartNew()
    while ($deadline.ElapsedMilliseconds -lt 20000) {
      $candidates = @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $ownedServicePid AND Name = '${name}'")
      foreach ($candidate in $candidates) {
        try {
          $ownedCompiler = [Diagnostics.Process]::GetProcessById([int]$candidate.ProcessId)
          $before = $ownedCompiler.TotalProcessorTime.TotalMilliseconds
          Start-Sleep -Milliseconds 50
          $ownedCompiler.Refresh()
          $after = $ownedCompiler.TotalProcessorTime.TotalMilliseconds
          if (-not $ownedCompiler.HasExited -and $after -gt $before) {
            [Console]::WriteLine((@{pid=[int]$candidate.ProcessId;parent=$ownedServicePid;path=$candidate.ExecutablePath;cpuBeforeMs=$before;cpuAfterMs=$after} | ConvertTo-Json -Compress))
            exit 0
          }
        } catch {}
      }
      Start-Sleep -Milliseconds 25
    }
    exit 3
  `;
  const observer = spawn('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64'),
  ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  observer.stdout.on('data', bytes => { stdout = (stdout + bytes).slice(-8192); });
  observer.stderr.on('data', bytes => { stderr = (stderr + bytes).slice(-8192); });
  let timer;
  const promise = new Promise((resolveWitness, reject) => {
    timer = setTimeout(() => { observer.kill(); reject(Error('Owned worker CPU witness deadline')); }, 25000);
    observer.once('error', reject);
    observer.once('close', code => {
      clearTimeout(timer);
      if (code !== 0) return reject(Error(`Owned worker CPU witness failed (${code}): ${stderr}`));
      try { resolveWitness(JSON.parse(stdout.trim().split(/\r?\n/).at(-1))); }
      catch (error) { reject(error); }
    });
  });
  // Retain rejection until the step awaits it, without an unhandled-rejection race.
  promise.catch(() => {});
  const ready = poll(() => {
    if (observer.exitCode !== null) throw Error(`Owned worker observer exited before readiness: ${stderr}`);
    return stdout.includes('READY\n') || stdout.includes('READY\r\n');
  }, 'Owned worker observer readiness deadline', 15000);
  ready.catch(() => {});
  return { ready, promise, stop: () => { clearTimeout(timer); if (observer.exitCode === null) observer.kill(); } };
}

try {
  await mkdir(artifact, { recursive: true });
  await mkdir(join(projectRoot, 'chapters'), { recursive: true });
  const main = [
    '\\documentclass[11pt]{article}', '\\begin{document}',
    'MAINUITEX. Shared source~\\cite{ui2024}.\\input{chapters/results.tex}',
    '\\bibliographystyle{plain}\\bibliography{references}', '\\end{document}', '',
  ].join('\n');
  const chapter = 'CHAPTERUITEX. Editable chapter text.\n';
  const bib = '@article{ui2024,author={Example, Alice},title={{INITIALBIBUITEX}},journal={Synthetic Journal},year={2024}}\n';
  await writeFile(join(projectRoot, 'main.tex'), main);
  await writeFile(join(projectRoot, 'chapters/results.tex'), chapter);
  await writeFile(join(projectRoot, 'references.bib'), bib);
  receipt.identities = {
    fixtureRoot: projectRoot,
    binary: { path: binary, sha256: digest(await readFile(binary)) },
    worker: { path: worker, sha256: digest(await readFile(worker)) },
    html: { path: join(assets, 'manuscript.html'), sha256: digest(await readFile(join(assets, 'manuscript.html'))) },
  };
  receipt.identities.assets = await Promise.all(
    (await readdir(join(assets, 'assets'))).sort().map(async name => ({
      path: join(assets, 'assets', name),
      sha256: digest(await readFile(join(assets, 'assets', name))),
    })),
  );
  child = spawn(binary, ['serve'], {
    env: {
      ...process.env, UNDERTREE_REVIEW_PORT: '0', UNDERTREE_REVIEW_STATE: join(temporary, 'state'),
      UNDERTREE_REVIEW_ASSETS: assets, UNDERTREE_REVIEW_TOKEN: token, UNDERTREE_LATEX_WORKER: worker,
    },
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let childError;
  child.on('error', error => { childError = error; });
  child.stdout.on('data', bytes => { log = (log + bytes).slice(-65536); });
  child.stderr.on('data', bytes => { log = (log + bytes).slice(-65536); });
  const port = await poll(() => {
    if (childError) throw childError;
    assert.equal(child.exitCode, null, log);
    return log.match(/127\.0\.0\.1:(\d+)/)?.[1];
  }, 'Service startup deadline', 15000);
  base = `http://127.0.0.1:${port}`;
  project = await call({ action: 'add_project', root: projectRoot });
  await call({ action: 'set_main_document', project: project.id, path: 'main.tex' });

  browser = await chromium.launch({
    executablePath: process.env.UNDERTREE_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: true, args: process.platform === 'linux' ? ['--no-sandbox'] : [],
  });
  receipt.browser = browser.version();
  const context = await browser.newContext({ viewport: { width: 1500, height: 950 } });
  await context.route('**/*', async route => {
    const request = route.request();
    if (new URL(request.url()).hostname !== '127.0.0.1') return route.abort();
    if (request.url().endsWith('/api/review') && request.method() === 'POST') {
      const operation = request.postDataJSON();
      const entry = { action: operation.action, path: operation.path, startedAt: performance.now() };
      operations.push(entry);
      requestRecords.set(request, entry);
      if (operation.action === 'save' && holdSave) {
        holdSave = false;
        saveHeld = true;
        await new Promise(done => { releaseSave = done; });
      }
      if (operation.action === 'compile' && holdCompile) {
        holdCompile = false;
        const response = await route.fetch();
        compileHeld = true;
        await new Promise(done => { releaseCompile = done; });
        return route.fulfill({ response });
      }
    }
    return route.continue();
  });
  page = await context.newPage();
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('requestfinished', request => {
    const entry = requestRecords.get(request);
    if (entry) entry.finishedAt = performance.now();
  });
  page.on('requestfailed', request => {
    const entry = requestRecords.get(request);
    if (entry) entry.failedAt = performance.now();
  });
  page.on('response', async response => {
    const entry = requestRecords.get(response.request());
    if (!entry) return;
    try {
      const value = await response.json();
      entry.ok = value.ok;
      if (!value.ok) entry.error = value.error;
    } catch (error) {
      entry.responseReadError = error.message;
    }
  });
  await page.goto(base + `/manuscript.html#session=${token}`);
  await file('main.tex');

  await check('Marked LaTeX main compiles and Smart deliberately exposes the full project', async () => {
    assert.equal(await page.locator('#files-smart').isDisabled(), true);
    assert.equal(await page.locator('#files-smart').getAttribute('aria-checked'), 'false');
    await page.locator('#typst-compile').click();
    await previewWith('MAINUITEX');
    await page.locator('#typst-pages canvas').first().waitFor();
    await waitForIdleCompile();
  });

  await check('A held chapter save precedes compilation and pending PDF delivery permits typing', async () => {
    await file('chapters/results.tex');
    holdSave = true;
    await append('\nFIRSTDRAFTUITEX.\n');
    await poll(() => saveHeld, 'Actual chapter autosave was not held');
    const before = compileOperations().length;
    holdCompile = true;
    await page.locator('#typst-compile').click();
    assert.equal(compileOperations().length, before);
    assert.equal(await readFile(join(projectRoot, 'chapters/results.tex'), 'utf8'), chapter);
    assert.ok((await editor()).text.includes('FIRSTDRAFTUITEX'));
    releaseSave();
    releaseSave = null;
    await poll(() => compileHeld, 'Compiled response was not held');
    assert.equal(compileOperations().at(-1).path, 'main.tex');
    assert.equal((await editor()).readOnly, false);
    await append('\nNEWERTYPINGUITEX.\n');
    assert.ok((await editor()).text.includes('NEWERTYPINGUITEX'));
    releaseCompile();
    releaseCompile = null;
    await previewWith('NEWERTYPINGUITEX');
    assert.ok((await editor()).text.includes('FIRSTDRAFTUITEX'));
    await waitForIdleCompile();
  });

  await check('Editing a bibliography keeps the marked TeX main as the build target', async () => {
    await waitForIdleCompile();
    await file('references.bib');
    await page.locator('.cm-content').evaluate(node => {
      const view = node.cmTile.root.view;
      const text = view.state.doc.toString();
      const from = text.indexOf('INITIALBIBUITEX');
      view.dispatch({ changes: { from, to: from + 'INITIALBIBUITEX'.length, insert: 'UPDATEDBIBUITEX' } });
      view.focus();
    });
    await page.locator('#typst-compile').click();
    await previewWith('UPDATEDBIBUITEX');
    assert.equal(compileOperations().at(-1).path, 'main.tex');
    assert.ok((await editor()).text.includes('UPDATEDBIBUITEX'));
    await waitForIdleCompile();
  });

  await check('Real typing remains available while the owned compiler child consumes CPU', async () => {
    await waitForIdleCompile();
    await file('chapters/results.tex');
    const original = (await editor()).text;
    const before = await call({ action: 'pdf', project: project.id, path: 'main.tex' });
    assert.equal(before.available, true);
    assert.equal(holdCompile, false);
    const workload = Array.from({ length: 200 }, (_, index) => [
      '\\clearpage', `\\subsection*{Owned live compilation page ${index + 1}}`,
      `WORKPAGEUITEX${index}. Local observations constrain the estimated model. `.repeat(8),
      '\\[\\sum_{i=1}^{20} i = 210, \\qquad q^2 = \\frac{a}{b}.\\]', '',
    ].join('\n')).join('\n');
    const observer = observeOwnedWorker();
    try {
      await observer.ready;
      const startedAt = performance.now();
      await append('\n' + workload);
      await page.locator('#typst-compile').click();
      const witness = await observer.promise;
      assert.equal(witness.parent, child.pid);
      const normalize = path => resolve(path.replace(/^\\\\\?\\/, '')).toLowerCase();
      assert.equal(normalize(witness.path), normalize(worker));
      assert.ok(witness.cpuAfterMs > witness.cpuBeforeMs);
      const activeRequest = operations.findLast(operation => operation.action === 'compile'
        && operation.path === 'main.tex' && operation.startedAt >= startedAt && !operation.finishedAt);
      assert.ok(activeRequest && !activeRequest.failedAt, 'An actual compile request remains pending.');
      const typedAt = performance.now();
      await page.locator('.cm-content').focus();
      await page.keyboard.press('Control+End');
      await page.keyboard.insertText('\nACTUALWORKERTYPINGUITEX.\n');
      const typingRoundTripMs = performance.now() - typedAt;
      assert.ok((await editor()).text.includes('ACTUALWORKERTYPINGUITEX'));
      assert.equal((await editor()).readOnly, false);
      process.kill(witness.pid, 0);
      assert.equal(activeRequest.finishedAt, undefined, 'The edit is retained before the compile reply finishes.');
      assert.equal(activeRequest.failedAt, undefined);
      assert.ok(await page.locator('#typst-pages canvas').count() > 0, 'The last good preview remains present.');
      receipt.liveWorkerEditing = {
        ...witness, workloadPages: 200, typingRoundTripMs,
        responsePendingWhenEditRetained: true, workerAliveAfterTyping: true,
        scope: 'Exact owned child CPU progress and editor typing; no claim of Typst-equivalent compiler speed.',
      };
      await previewWith('ACTUALWORKERTYPINGUITEX');
      assert.ok((await editor()).text.includes('ACTUALWORKERTYPINGUITEX'));
      await page.locator('.cm-content').evaluate((node, text) => {
        const view = node.cmTile.root.view;
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
      }, original + '\nRESTOREDWORKERUITEX.\n');
      await page.locator('#typst-compile').click();
      await previewWith('RESTOREDWORKERUITEX');
      await waitForIdleCompile();
    } finally {
      observer.stop();
    }
  });

  await check('Composing chapter input vetoes explicit compile without changing its source', async () => {
    await file('chapters/results.tex');
    await waitForIdleCompile();
    const before = compileOperations().length;
    const text = (await editor()).text;
    await emitComposition('compositionstart');
    await page.waitForFunction(() => document.querySelector('.cm-content').cmTile.root.view.compositionStarted);
    await page.locator('#typst-compile').click();
    assert.match(await page.locator('#review-status').innerText(), /composition/i);
    assert.equal(compileOperations().length, before);
    assert.equal((await editor()).text, text);
    await emitComposition('compositionend');
  });

  await check('A failed local TeX build retains the previous real PDF', async () => {
    await page.waitForFunction(() => !document.querySelector('.cm-content').cmTile.root.view.compositionStarted);
    const before = await call({ action: 'pdf', project: project.id, path: 'main.tex' });
    const compileCount = compileOperations().length;
    await append('\n\\undefinedTexUiCommand\n');
    await page.locator('#typst-compile').click();
    await poll(async () =>
      /Compilation failed/i.test(await page.locator('#typst-preview-status').innerText())
        || /LaTeX compilation failed/i.test(await page.locator('#review-status').innerText()),
    'Expected failed build status');
    const failure = await poll(() =>
      compileOperations().slice(compileCount).find(operation => operation.error?.code === 'latex'),
    'Expected an actual LaTeX compiler failure, rather than a preflight refusal');
    assert.match(failure.error.message, /Undefined control sequence|undefinedTexUiCommand/i);
    const after = await call({ action: 'pdf', project: project.id, path: 'main.tex' });
    assert.equal(after.pdfHash, before.pdfHash);
    assert.equal(after.base64, before.base64);
    assert.ok((await editor()).text.includes('undefinedTexUiCommand'));
  });

  await check('An external change blocks compilation without discarding the dirty draft', async () => {
    const beforeConflict = compileOperations().length;
    holdSave = true;
    saveHeld = false;
    await append('\nCONFLICTDRAFTUITEX.\n');
    await poll(() => saveHeld, 'Conflict save did not enter the held route');
    await writeFile(join(projectRoot, 'chapters/results.tex'), 'EXTERNALSAVEDUITEX.\n');
    releaseSave();
    releaseSave = null;
    await poll(async () =>
      /conflict|changed outside|changed externally/i.test(await page.locator('#review-status').innerText())
        || await page.locator('#review-conflict').evaluate(node => !node.hidden),
    'External source conflict was not shown');
    const count = compileOperations().length;
    receipt.conflictPriorAutomaticCompiles = count - beforeConflict;
    await page.locator('#typst-compile').click();
    assert.equal(compileOperations().length, count);
    assert.ok((await editor()).text.includes('CONFLICTDRAFTUITEX'));
    assert.equal(await readFile(join(projectRoot, 'chapters/results.tex'), 'utf8'), 'EXTERNALSAVEDUITEX.\n');
  });

  assert.deepEqual(pageErrors, []);
  receipt.status = 'VERIFIED';
  await page.screenshot({ path: join(artifact, 'tex-editor.png'), fullPage: true });
} catch (error) {
  receipt.failedCheck = activeCheck;
  receipt.error = { message: error.message, stack: error.stack };
  process.exitCode = 1;
  console.error(error);
  receipt.failureState = await page?.evaluate(() => ({
    reviewStatus: document.querySelector('#review-status')?.textContent,
    previewStatus: document.querySelector('#typst-preview-status')?.textContent,
    compileLog: document.querySelector('#compile-log')?.textContent,
    buffer: document.querySelector('.cm-content')?.cmTile?.root?.view?.state.doc.toString(),
  })).catch(() => null);
  await page?.screenshot({ path: join(artifact, 'failed.png'), fullPage: true }).catch(() => {});
} finally {
  releaseSave?.();
  releaseCompile?.();
  await browser?.close();
  if (child && child.exitCode === null) {
    child.kill();
    await poll(() => child.exitCode !== null || child.signalCode !== null, 'Owned service stop deadline', 5000)
      .catch(() => child.kill('SIGKILL'));
  }
  receipt.finishedAt = new Date().toISOString();
  receipt.pageErrors = pageErrors;
  await mkdir(artifact, { recursive: true });
  await writeFile(join(artifact, 'service.log'), log);
  await writeFile(join(artifact, 'receipt.json'), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify({ status: receipt.status, checks: checks.length, artifact }));
}
