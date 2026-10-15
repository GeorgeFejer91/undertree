import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { access, chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, truncate, utimes, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, extname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { getDocument, OPS, version as pdfjsVersion } from 'pdfjs-dist/legacy/build/pdf.mjs';

const exec = promisify(execFile);
const hash = value => createHash('sha256').update(value).digest('hex');
const fixture = resolve('examples/typst-parity');
const artifacts = resolve('artifacts/reverse-engineering/typst-parity');
const binary = resolve(process.env.UNDERTREE_REVIEW_BINARY || 'target/debug/undertree-review');
const compiler = process.env.UNDERTREE_TYPST || 'typst';
const temporary = await mkdtemp(join(tmpdir(), 'undertree-typst-delivery-'));
const projectRoot = join(temporary, 'project');
const mainPath = 'chapters/article.typ';
const token = randomBytes(32).toString('hex');
const delayEnabled = join(temporary, 'delay-enabled');
const delayStarted = join(temporary, 'delay-started');
const checks = [];
let service;
let serviceLog = '';
let base;
let activeCheck = 'toolchain preflight';
const receipt = {
  startedAt: new Date().toISOString(),
  status: 'FAILED',
  evidenceType: 'Real Rust service and external Typst PDF semantics',
  limitations: [
    'Representative authored Typst documents; arbitrary LaTeX conversion and complete Overleaf parity are not established.',
    'PDF text, links, outline, math glyph positions and drawing operators establish content semantics; visual fidelity is not compared.',
    'Dependency freshness covers project inputs; external fonts and package installations need separate qualification.',
    'No browser, native window, live collaboration or public network integration is exercised.',
    'Working-tree source hashes record the checkout; the service binary SHA-256 identifies the runtime, without establishing its build provenance.',
  ],
  pdfjsVersion,
  checks,
};

async function check(name, run) {
  activeCheck = name;
  await run();
  checks.push({ name, status: 'VERIFIED' });
}

async function executablePath(command) {
  const candidates = command.includes('/') || command.includes('\\')
    ? [resolve(command)]
    : (process.env.PATH || '').split(delimiter).map(directory => join(directory, command));
  for (const candidate of candidates) {
    try { await access(candidate, constants.X_OK); return candidate; } catch {}
  }
  throw new Error(`Required executable unavailable: ${command}. Install Typst or set UNDERTREE_TYPST; this gate cannot be skipped.`);
}

async function call(operation, expectedError) {
  const response = await fetch(`${base}/api/review`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(operation),
    signal: AbortSignal.timeout(55_000),
  });
  const value = await response.json();
  if (expectedError) {
    assert.equal(value.ok, false, 'The failing publication must report an error.');
    assert.equal(value.error.code, expectedError, value.error.message);
    return value.error;
  }
  assert.equal(value.ok, true, value.error?.message);
  return value.result;
}

async function inspect(preview) {
  assert.equal(preview.available, true);
  const bytes = Buffer.from(preview.base64, 'base64');
  assert.equal(bytes.subarray(0, 5).toString(), '%PDF-');
  const loading = getDocument({ data: new Uint8Array(bytes), useSystemFonts: false, isEvalSupported: false });
  const pdf = await loading.promise;
  try {
    const pages = [];
    for (let index = 1; index <= pdf.numPages; index++) {
      const page = await pdf.getPage(index);
      const content = await page.getTextContent();
      const operators = await page.getOperatorList();
      pages.push({
        text: content.items.map(item => item.str || '').join(' ').replace(/\s+/g, ' '),
        items: content.items,
        annotations: await page.getAnnotations(),
        fontNames: [...new Set(content.items.filter(item => item.fontName).map(item => page.commonObjs.get(item.fontName).name))],
        paths: operators.fnArray.filter(operator => operator === OPS.constructPath).length,
        colors: operators.fnArray.flatMap((operator, index) => [OPS.setFillRGBColor, OPS.setStrokeRGBColor].includes(operator) ? operators.argsArray[index] : []),
        width: page.view[2] - page.view[0],
        height: page.view[3] - page.view[1],
      });
    }
    return { pages, outline: await pdf.getOutline(), metadata: await pdf.getMetadata(), bytes };
  } finally {
    await loading.destroy();
  }
}

async function stopService() {
  if (!service?.pid || service.exitCode !== null || service.signalCode !== null) return;
  await new Promise(resolveStop => {
    const timer = setTimeout(() => service.kill('SIGKILL'), 5000);
    service.once('exit', () => { clearTimeout(timer); resolveStop(); });
    service.kill('SIGTERM');
  });
}

try {
  await mkdir(artifacts, { recursive: true });
  const compilerPath = await executablePath(compiler);
  const { stdout } = await exec(compilerPath, ['--version'], { timeout: 10_000 });
  assert.match(stdout, /^typst \d+\.\d+\.\d+/);
  receipt.compiler = { path: compilerPath, version: stdout.trim(), sha256: hash(await readFile(compilerPath)) };
  receipt.service = { path: binary, sha256: hash(await readFile(binary)) };
  receipt.fixtureHashes = {};
  for (const path of ['template.typ', 'chapters/article.typ', 'chapters/background.typ', 'references.bib', 'assets/plot.svg', 'import.tex']) {
    receipt.fixtureHashes[path] = hash(await readFile(join(fixture, path)));
  }
  receipt.workingTreeSourceHashes = {};
  for (const path of ['modules/review/src/publishing.rs', 'modules/review/src/service.rs', 'modules/review/src/tex_import.rs']) {
    receipt.workingTreeSourceHashes[path] = hash(await readFile(resolve(path)));
  }
  checks.push({ name: activeCheck, status: 'VERIFIED' });
  await cp(fixture, projectRoot, { recursive: true });
  const packages = join(temporary, 'packages');
  const localPackage = join(packages, 'local/undertree-parity/0.1.0');
  await mkdir(localPackage, { recursive: true });
  await writeFile(join(localPackage, 'typst.toml'), '[package]\nname = "undertree-parity"\nversion = "0.1.0"\nentrypoint = "lib.typ"\nauthors = ["UnderTree QA"]\n');
  await writeFile(join(localPackage, 'lib.typ'), '#let package-text = [Cached package sentinel.]\n');
  let compilerDriver = compilerPath;
  if (process.platform !== 'win32') {
    compilerDriver = join(temporary, 'typst-driver.mjs');
    const driver = `#!${process.execPath}\nimport { access, writeFile } from 'node:fs/promises';\nimport { spawn } from 'node:child_process';\ntry { await access(${JSON.stringify(delayEnabled)}); await writeFile(${JSON.stringify(delayStarted)}, 'ready'); await new Promise(resolve => setTimeout(resolve, 1000)); } catch {}\nconst child = spawn(${JSON.stringify(compilerPath)}, process.argv.slice(2), { stdio: 'inherit' });\nprocess.on('SIGTERM', () => child.kill('SIGTERM'));\nchild.once('error', error => { process.stderr.write(error.message); process.exit(1); });\nchild.once('exit', code => process.exit(code ?? 1));\n`;
    await writeFile(compilerDriver, driver);
    await chmod(compilerDriver, 0o700);
    receipt.compilerDriverSha256 = hash(driver);
  }
  activeCheck = 'Isolated native authority startup';
  service = spawn(binary, [], {
    env: {
      ...process.env,
      UNDERTREE_REVIEW_PORT: '0',
      UNDERTREE_REVIEW_TOKEN: token,
      UNDERTREE_REVIEW_STATE: join(temporary, 'state'),
      UNDERTREE_TYPST: compilerDriver,
      TYPST_IGNORE_SYSTEM_FONTS: 'true',
      TYPST_PACKAGE_PATH: packages,
      TYPST_PACKAGE_CACHE_PATH: join(temporary, 'package-cache'),
      XDG_DATA_HOME: join(temporary, 'data'),
      XDG_CONFIG_HOME: join(temporary, 'config'),
      XDG_CACHE_HOME: join(temporary, 'cache'),
      SOURCE_DATE_EPOCH: '1767225600',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolveStarted, reject) => {
    const timer = setTimeout(() => reject(new Error(`Rust service startup timed out. ${serviceLog}`)), 10_000);
    const fail = error => { clearTimeout(timer); reject(error); };
    service.once('error', fail);
    service.once('exit', code => fail(new Error(`Rust service exited (${code}). ${serviceLog}`)));
    service.stderr.on('data', chunk => { serviceLog = (serviceLog + chunk).slice(-65_536); });
    service.stdout.on('data', chunk => {
      serviceLog = (serviceLog + chunk).slice(-65_536);
      const port = serviceLog.match(/127\.0\.0\.1:(\d+)/)?.[1];
      if (port) { base = `http://127.0.0.1:${port}`; clearTimeout(timer); resolveStarted(); }
    });
  });
  const project = await call({ action: 'add_project', root: projectRoot });
  checks.push({ name: activeCheck, status: 'VERIFIED' });
  const mainSource = await readFile(join(projectRoot, mainPath), 'utf8');
  const revision = hash(mainSource);
  const compile = (path = mainPath, source = mainSource) => call({ action: 'compile', project: project.id, path, revision: hash(source) });
  const preview = () => call({ action: 'pdf', project: project.id, path: mainPath });
  let good;
  let publication;

  await check('Multi-file offline article produces three A4 PDF pages', async () => {
    good = await compile();
    assert.equal(good.current, true);
    assert.equal(good.revision, revision);
    publication = await inspect(good);
    assert.equal(publication.pages.length, 3);
    for (const page of publication.pages) {
      assert.ok(Math.abs(page.width - 595.28) < 1 && Math.abs(page.height - 841.89) < 1, 'The fixture uses A4 pages.');
    }
    assert.match(publication.pages[0].text, /Article sentinel/);
    assert.match(publication.pages[0].text, /Included chapter sentinel/);
    assert.match(publication.pages[0].text, /Imported template sentinel/);
    assert.match(publication.pages[0].text, /Footnote sentinel/);
    assert.match(publication.pages[2].text, /Discussion sentinel/);
    assert.equal(publication.metadata.info.Title, 'UnderTree Typst delivery fixture');
    await writeFile(join(artifacts, 'article.pdf'), publication.bytes);
    receipt.articlePdf = { sha256: hash(publication.bytes), pages: publication.pages.map(page => ({ text: page.text, paths: page.paths })) };
  });

  await check('Math renders Greek symbols, a raised exponent and a stacked fraction', async () => {
    const page = publication.pages[1];
    assert.match(page.text.normalize('NFKC'), /α/);
    const glyph = character => page.items.find(item => item.str?.normalize('NFKC') === character);
    const q = glyph('q');
    const exponent = glyph('2');
    const numerator = glyph('a');
    const denominator = glyph('b');
    assert.ok(q && exponent && numerator && denominator, 'Expected independently positioned math glyphs.');
    assert.ok(exponent.transform[5] > q.transform[5] + 1, 'The exponent sits above the q baseline.');
    assert.ok(numerator.transform[5] > denominator.transform[5] + 2, 'The fraction numerator sits above its denominator.');
    assert.doesNotMatch(page.text, /frac\(|\$q\^2/);
    receipt.mathBaselines = Object.fromEntries(Object.entries({ q, exponent, numerator, denominator }).map(([name, item]) => [name, item.transform[5]]));
  });

  await check('Outline, resolved cross-references, local bibliography and external PDF link', async () => {
    const titles = entries => entries.flatMap(entry => [entry.title, ...titles(entry.items || [])]);
    assert.ok(publication.outline?.length, 'The PDF contains bookmarks.');
    const outline = titles(publication.outline).join(' ');
    for (const heading of ['Offline article', 'Background', 'Methods', 'Discussion']) assert.ok(outline.includes(heading));
    const methods = publication.pages[1];
    assert.match(methods.text, /Section 1\.1/);
    assert.match(methods.text, /Section 2/);
    assert.match(methods.text, /Equation 1/);
    assert.match(methods.text, /Figure 1/);
    assert.match(methods.text, /Table 1/);
    assert.doesNotMatch(methods.text, /@(?:sec|eq|fig|tab)-/);
    assert.match(publication.pages[0].text, /\[1\]/);
    assert.match(publication.pages[2].text, /An offline publishing reference/);
    assert.match(publication.pages[2].text, /UnderTree Fixture Journal/);
    assert.ok(methods.annotations.some(annotation => annotation.url === 'https://example.org/undertree'));
    assert.ok(methods.annotations.some(annotation => annotation.dest), 'Cross-references contain internal PDF destinations.');
  });

  await check('Figure and table contain drawing operations, captions and cell content', async () => {
    const methods = publication.pages[1];
    for (const sentinel of ['Vector plot sentinel', 'Results table sentinel', 'Control sentinel', 'Treatment sentinel']) assert.ok(methods.text.includes(sentinel));
    assert.match(methods.text, /11/);
    assert.match(methods.text, /23/);
    assert.ok(methods.paths >= 10, 'Vector figure and table contribute actual PDF paths.');
    assert.ok(methods.colors.includes('#126e43'), 'The SVG contributes its authored plot color on the methods page.');
  });

  await check('Syntax, missing assets, root escape and offline-package failures preserve identical last-good PDF bytes', async () => {
    await writeFile(join(temporary, 'outside.txt'), 'Private outside-project sentinel.');
    for (const [source, code] of [
      ['#unknown-function()', 'typst'],
      ['#image("missing-asset.svg")', 'typst'],
      ['#read("../../outside.txt")', 'typst'],
      ['#import "@preview/undertree-offline-unavailable:0.0.1": *\nHello.', 'offline'],
    ]) {
      await writeFile(join(projectRoot, mainPath), source);
      const started = Date.now();
      await call({ action: 'compile', project: project.id, path: mainPath, revision: hash(source) }, code);
      if (code === 'offline') assert.ok(Date.now() - started < 10_000, 'Missing packages fail promptly offline.');
      const preserved = await preview();
      assert.equal(preserved.base64, good.base64);
      assert.equal(preserved.revision, revision);
      assert.equal(preserved.current, false);
    }
    await call({ action: 'compile', project: project.id, path: mainPath, revision }, 'stale');
    await writeFile(join(projectRoot, mainPath), mainSource);
  });

  if (process.platform !== 'win32') {
    await check('Project symlinks cannot disclose outside file contents through compiler errors or output', async () => {
      const marker = `Outside-private-${randomBytes(16).toString('hex')}`;
      const outside = join(temporary, 'outside-inputs');
      await mkdir(outside);
      await writeFile(join(outside, 'private.typ'), `#panic(${JSON.stringify(marker)})`);
      const linkedFile = join(projectRoot, 'linked-private.typ');
      const linkedDirectory = join(projectRoot, 'linked-inputs');
      await symlink(join(outside, 'private.typ'), linkedFile, 'file');
      await symlink(outside, linkedDirectory, 'dir');
      try {
        for (const source of [
          '#panic(read("../linked-private.typ"))',
          '#panic(read("../linked-inputs/private.typ"))',
          '#include "../linked-private.typ"',
          '#include "../linked-inputs/private.typ"',
        ]) {
          await writeFile(join(projectRoot, mainPath), source);
          const error = await call({ action: 'compile', project: project.id, path: mainPath, revision: hash(source) }, 'typst');
          assert.ok(!error.message.includes(marker), 'No outside bytes may reach compiler diagnostics.');
          const preserved = await preview();
          assert.equal(preserved.base64, good.base64, 'An isolated input failure preserves the exact last-good PDF.');
          assert.equal(preserved.revision, revision);
        }
      } finally {
        await rm(linkedFile, { force: true });
        await rm(linkedDirectory, { force: true });
        await writeFile(join(projectRoot, mainPath), mainSource);
      }
    });
  } else {
    checks.push({ name: 'Project symlink compiler-input isolation', status: 'NOT RUN', reason: 'Windows symlink privilege is a separate platform gate.' });
  }

  await check('An oversized project input fails within the staging budget and retains the last-good PDF', async () => {
    const oversized = join(projectRoot, 'oversized-unused.bin');
    await writeFile(oversized, '');
    await truncate(oversized, 128 * 1024 * 1024 + 1);
    try {
      await call({ action: 'compile', project: project.id, path: mainPath, revision }, 'limit');
      assert.equal((await preview()).base64, good.base64);
    } finally {
      await rm(oversized, { force: true });
    }
  });

  await check('TeX import reports unsupported math, references, bibliography and layout while preserving originals', async () => {
    const original = await readFile(join(projectRoot, 'import.tex'), 'utf8');
    const imported = await call({ action: 'import_tex', project: project.id, path: 'import.tex', target: 'imported.typ' });
    assert.equal(imported.exactFormatting, false);
    const warnings = imported.warnings.join('\n');
    for (const unsupported of ['math', 'ref', 'cite', 'includegraphics', 'tabular', 'customphrase']) assert.ok(warnings.includes(unsupported), `The import report identifies ${unsupported}.`);
    assert.equal(await readFile(join(projectRoot, 'import.tex'), 'utf8'), original);
    const report = JSON.parse(await readFile(join(projectRoot, 'imported.typ.import-report.json'), 'utf8'));
    assert.equal(report.exactFormatting, false);
    assert.deepEqual(report.warnings, imported.warnings);
    const converted = await readFile(join(projectRoot, 'imported.typ'), 'utf8');
    const result = await compile('imported.typ', converted);
    const importedPdf = await inspect(result);
    const text = importedPdf.pages.map(page => page.text).join(' ');
    for (const sentinel of ['Imported structure sentinel', 'Strong sentinel', 'Emphasis sentinel', 'List first sentinel', 'List second sentinel', 'Imported footnote sentinel']) assert.ok(text.includes(sentinel));
    assert.match(text, /x\^2/);
    assert.match(text, /\\cite/);
    await call({ action: 'import_tex', project: project.id, path: 'import.tex', target: 'imported.typ' }, 'conflict');
    assert.equal(await readFile(join(projectRoot, 'imported.typ'), 'utf8'), converted);
    await writeFile(join(artifacts, 'imported.pdf'), importedPdf.bytes);
  });

  await check('Changed chapter, bibliography and image invalidate the PDF and rebuild their content', async () => {
    good = await compile();
    assert.ok(good.dependencyCount >= 5, 'The receipt identifies the root source and four local dependencies.');
    for (const [path, before, after, expected] of [
      ['chapters/background.typ', 'Included chapter sentinel.', 'Updated chapter sentinel.', 'Updated chapter sentinel'],
      ['references.bib', 'An offline publishing reference', 'An updated publishing reference', 'An updated publishing reference'],
      ['assets/plot.svg', '#126e43', '#7f245c', null],
    ]) {
      const file = join(projectRoot, path);
      const original = await readFile(file, 'utf8');
      await writeFile(file, original.replaceAll(before, after));
      const stale = await preview();
      assert.equal(stale.current, false, `${path} changes invalidate the publication.`);
      assert.equal(stale.base64, good.base64, 'The stale PDF remains available.');
      await writeFile(file, original);
      assert.equal((await preview()).current, true, 'An exact dependency reversion makes the existing receipt current again.');
      await writeFile(file, original.replaceAll(before, after));
      good = await compile();
      assert.equal(good.current, true);
      const rebuilt = await inspect(good);
      if (expected) assert.ok(rebuilt.pages.map(page => page.text).join(' ').includes(expected));
      else assert.ok(rebuilt.pages[1].colors.includes(after), 'Recompilation embeds the changed SVG plot color.');
      await writeFile(file, original);
      assert.equal((await preview()).current, false, 'Restoring an earlier dependency invalidates the rebuilt publication.');
      good = await compile();
      assert.equal(good.current, true);
    }
  });

  await check('Successful publication retains Typst warnings for the compile log', async () => {
    const source = '#set text(font: "UnderTree deliberately missing fixture font")\nWarning sentinel.';
    await writeFile(join(projectRoot, 'warning.typ'), source);
    const warning = await compile('warning.typ', source);
    assert.equal(warning.current, true);
    assert.match(warning.diagnostics, /unknown font family/i);
    assert.ok(warning.diagnostics.includes('UnderTree deliberately missing fixture font'));
    assert.ok(!warning.diagnostics.includes('.undertree-compile-'), 'Diagnostics reference the authored source path.');
    receipt.successDiagnostics = warning.diagnostics;
  });

  await check('A locally prepared package publishes offline with explicit untracked external coverage', async () => {
    const source = '#import "@local/undertree-parity:0.1.0": package-text\n#package-text\n';
    await writeFile(join(projectRoot, 'package.typ'), source);
    const result = await compile('package.typ', source);
    assert.equal(result.current, false, 'Untracked external package bytes cannot claim a current project receipt.');
    assert.equal(result.dependencyCoverage, 'project');
    assert.ok(result.externalDependencyCount >= 2, 'The package manifest and source are reported as external inputs.');
    const rendered = await inspect(result);
    assert.ok(rendered.pages[0].text.includes('Cached package sentinel'));
    receipt.cachedPackage = { current: result.current, dependencyCount: result.dependencyCount, externalDependencyCount: result.externalDependencyCount };
    await writeFile(join(artifacts, 'cached-package.pdf'), rendered.bytes);
  });

  const fontCandidates = process.env.UNDERTREE_TEST_FONT ? [resolve(process.env.UNDERTREE_TEST_FONT)] : [
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    '/usr/share/fonts/opentype/urw-base35/NimbusRoman-Regular.otf',
    '/System/Library/Fonts/Supplemental/Arial.ttf',
    'C:\\Windows\\Fonts\\arial.ttf',
  ];
  let testFont;
  for (const candidate of fontCandidates) {
    try { await access(candidate, constants.R_OK); testFont = candidate; break; } catch {}
  }
  if (!testFont) {
    assert.ok(!process.env.UNDERTREE_TEST_FONT, 'The explicitly configured UNDERTREE_TEST_FONT must be readable.');
    checks.push({ name: 'Project font rendering, freshness and linked-font isolation', status: 'NOT RUN', reason: 'No usable local font path found; set UNDERTREE_TEST_FONT.' });
  } else {
    await check('Project font renders its configured family and tracks added, changed and removed bytes', async () => {
      const fontDirectory = join(projectRoot, 'fonts');
      await mkdir(fontDirectory);
      const fontFile = join(fontDirectory, `project${extname(testFont)}`);
      await cp(testFont, fontFile);
      const original = await readFile(fontFile);
      const { stdout: families } = await exec(compilerPath, ['fonts', '--font-path', fontDirectory, '--ignore-system-fonts', '--ignore-embedded-fonts']);
      const family = families.trim().split('\n')[0].trim();
      assert.ok(family, 'Typst discovers the regular project font.');
      const source = `#set text(font: ${JSON.stringify(family)})\nProject font sentinel.`;
      await writeFile(join(projectRoot, 'font.typ'), source);
      const fontPreview = () => call({ action: 'pdf', project: project.id, path: 'font.typ' });
      const result = await compile('font.typ', source);
      assert.equal(result.current, true);
      assert.equal(result.dependencyCount, 2);
      assert.doesNotMatch(result.diagnostics, /unknown font family/i);
      const rendered = await inspect(result);
      const identity = value => value.replace(/^[A-Z]{6}\+/, '').replace(/[^a-z0-9]/gi, '').toLowerCase();
      assert.ok(rendered.pages[0].fontNames.some(name => identity(name).includes(identity(family))), 'The actual PDF uses the configured project font.');
      await writeFile(fontFile, Buffer.concat([original, Buffer.from([0])]));
      assert.equal((await fontPreview()).current, false, 'A font byte change invalidates the PDF.');
      await writeFile(fontFile, original);
      assert.equal((await fontPreview()).current, true, 'Exact font restoration restores freshness.');
      await rm(fontFile);
      assert.equal((await fontPreview()).current, false, 'Removing a used project font invalidates the PDF.');
      receipt.projectFont = { path: testFont, family, sha256: hash(original), pdfFontNames: rendered.pages[0].fontNames };
      await writeFile(join(artifacts, 'project-font.pdf'), rendered.bytes);
      if (process.platform !== 'win32') {
        const outsideFonts = join(temporary, 'outside-fonts');
        await mkdir(outsideFonts);
        const outsideFont = join(outsideFonts, `outside${extname(testFont)}`);
        await cp(testFont, outsideFont);
        for (const [target, linked, type] of [[outsideFont, fontFile, 'file'], [outsideFonts, join(projectRoot, 'linked-fonts'), 'dir']]) {
          await symlink(target, linked, type);
          const isolated = await compile('font.typ', source);
          assert.match(isolated.diagnostics, /unknown font family/i, 'A linked font file/directory is unavailable to the compiler.');
          assert.equal(isolated.dependencyCount, 1);
          await rm(linked);
        }
        checks.push({ name: 'Linked project font files and directories cannot supply outside fonts', status: 'VERIFIED' });
      } else {
        checks.push({ name: 'Linked project font files and directories cannot supply outside fonts', status: 'NOT RUN', reason: 'Windows symlink privilege is a separate platform gate.' });
      }
      await rm(fontDirectory, { recursive: true });
    });
  }

  if (process.platform !== 'win32') {
    for (const preserveTimestamp of [false, true]) await check(`${preserveTimestamp ? 'A timestamp-preserving' : 'An ordinary'} dependency edit during compilation keeps the staged bytes and produces a stale receipt`, async () => {
      const source = '#include "race-input.typ"';
      await writeFile(join(projectRoot, 'race.typ'), source);
      const input = join(projectRoot, 'race-input.typ');
      await writeFile(input, 'Before compiler sentinel.');
      if (preserveTimestamp) await utimes(input, 1_767_225_600, 1_767_225_600);
      await rm(delayStarted, { force: true });
      await writeFile(delayEnabled, 'delay');
      const compiling = compile('race.typ', source);
      compiling.catch(() => {});
      let started = false;
      for (let attempt = 0; attempt < 100 && !started; attempt++) {
        try { await access(delayStarted); started = true; } catch { await new Promise(resolveWait => setTimeout(resolveWait, 20)); }
      }
      assert.ok(started, 'The actual compiler wrapper reached the deterministic delay.');
      await writeFile(input, 'During compiler sentinel.');
      if (preserveTimestamp) await utimes(input, 1_767_225_600, 1_767_225_600);
      const raced = await compiling;
      assert.equal(raced.current, false, 'Changed project bytes cannot receive a current PDF receipt.');
      const rendered = (await inspect(raced)).pages[0].text;
      assert.ok(rendered.includes('Before compiler sentinel'), 'The compiler reads the immutable staged input.');
      assert.ok(!rendered.includes('During compiler sentinel'));
      await rm(delayEnabled);
      const stable = await compile('race.typ', source);
      assert.equal(stable.current, true);
    });

    for (const replaceMain of [false, true]) await check(`Replacing the live ${replaceMain ? 'main source' : 'dependency'} with an outside symlink cannot affect the compiler snapshot`, async () => {
      const source = '#read("swap-input.txt")';
      const input = join(projectRoot, 'swap-input.txt');
      const main = join(projectRoot, 'swap.typ');
      const replaced = replaceMain ? main : input;
      const outside = join(temporary, 'private-swap-input.txt');
      const marker = `Outside-swap-${randomBytes(16).toString('hex')}`;
      await writeFile(main, source);
      await writeFile(input, 'Before swap sentinel.');
      await writeFile(outside, marker);
      await rm(delayStarted, { force: true });
      await writeFile(delayEnabled, 'delay');
      const compiling = compile('swap.typ', source);
      compiling.catch(() => {});
      try {
        let started = false;
        for (let attempt = 0; attempt < 100 && !started; attempt++) {
          try { await access(delayStarted); started = true; } catch { await new Promise(resolveWait => setTimeout(resolveWait, 20)); }
        }
        assert.ok(started, 'Staging finished before the actual compiler starts.');
        await rm(replaced);
        await symlink(outside, replaced, 'file');
        const result = await compiling;
        assert.equal(result.current, false, 'A linked current input cannot validate the older snapshot.');
        const text = (await inspect(result)).pages[0].text;
        assert.ok(text.includes('Before swap sentinel'));
        assert.ok(!text.includes(marker), 'No outside bytes reach the PDF.');
        assert.ok(!result.diagnostics.includes(marker), 'No outside bytes reach the build log.');
        const cached = await call({ action: 'pdf', project: project.id, path: 'swap.typ' });
        assert.equal(cached.available, true, 'The safe cached snapshot remains accessible when its original input is linked.');
        assert.equal(cached.current, false);
        assert.equal(cached.base64, result.base64);
      } finally {
        await rm(delayEnabled, { force: true });
        await compiling.catch(() => {});
        await rm(replaced, { force: true });
        await writeFile(replaced, replaceMain ? source : 'Before swap sentinel.');
      }
    });
  } else {
    checks.push({ name: 'Dependency edit during first compilation', status: 'NOT RUN', reason: 'The deterministic compiler driver requires a POSIX executable script.' });
  }

  await check('Build cleanup leaves authored project inputs and the tested service identity intact', async () => {
    const files = await readdir(projectRoot, { recursive: true });
    assert.ok(!files.some(path => path.includes('.undertree-compile-')));
    const privateFiles = await readdir(join(temporary, 'state'), { recursive: true });
    assert.ok(!privateFiles.some(path => path.includes('.undertree-build-')), 'Successful and failed builds remove their owned input snapshots.');
    assert.equal(hash(await readFile(binary)), receipt.service.sha256, 'A concurrent rebuild cannot qualify a different service binary.');
  });
  receipt.status = checks.some(check => check.status === 'NOT RUN') ? 'PARTIAL' : 'VERIFIED';
  console.log(`Real Typst publication: ${receipt.status}; ${checks.filter(check => check.status === 'VERIFIED').length} checks verified, ${checks.filter(check => check.status === 'NOT RUN').length} not run. PDF content, math, references, bibliography, figures/tables/links, import limitations, failure retention and project dependency freshness were exercised.`);
} catch (error) {
  checks.push({ name: activeCheck, status: 'FAILED', error: error.message });
  receipt.error = error.message;
  throw error;
} finally {
  await stopService();
  receipt.finishedAt = new Date().toISOString();
  await mkdir(artifacts, { recursive: true });
  await writeFile(join(artifacts, 'evidence.json'), JSON.stringify(receipt, null, 2) + '\n');
  await rm(temporary, { recursive: true, force: true });
}
