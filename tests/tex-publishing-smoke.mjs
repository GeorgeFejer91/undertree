import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  access, copyFile, mkdir, mkdtemp, readFile, readdir, rename, rmdir, symlink, writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { deflateSync } from 'node:zlib';
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';

assert.ok(
  process.env.UNDERTREE_REVIEW_BINARY && process.env.UNDERTREE_LATEX_WORKER,
  'Provide isolated service and confined LaTeX worker executables; this test never builds.',
);
const binary = resolve(process.env.UNDERTREE_REVIEW_BINARY);
const worker = resolve(process.env.UNDERTREE_LATEX_WORKER);
const artifact = resolve(
  process.env.UNDERTREE_TEX_QA_OUTPUT || `artifacts/reverse-engineering/fast-tex/native-qa-${Date.now()}`,
);
const temporary = await mkdtemp(join(tmpdir(), 'undertree-tex-native-'));
const projectRoot = join(temporary, 'project');
const outside = join(temporary, 'outside');
const workerCopy = join(artifact, 'owned-worker', basename(worker));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const token = randomBytes(32).toString('hex');
const checks = [];
const receipt = {
  startedAt: new Date().toISOString(), status: 'FAILED', checks,
  limitations: [
    'Saved-source Rust HTTP authority gate; browser dirty buffers, IME and Tauri lifecycle are separate gates.',
    'Synthetic article, not arbitrary LaTeX/package compatibility or engine-equivalent pagination.',
    'Compilation requires prepared offline resources; this harness never downloads.',
  ],
};
let child;
let base;
let log = '';
let activeCheck = 'startup';
let good;

for (const path of [artifact, join(projectRoot, 'chapters'), join(projectRoot, 'figures'),
  join(projectRoot, 'fonts'), outside, join(artifact, 'owned-worker')]) {
  await mkdir(path, { recursive: true });
}
await copyFile(worker, workerCopy);
assert.equal(digest(await readFile(workerCopy)), digest(await readFile(worker)));

// A tiny authored RGB figure makes image assertions independent of external renderers.
function png() {
  function crc(bytes) {
    let value = 0xffffffff;
    for (const byte of bytes) {
      value ^= byte;
      for (let bit = 0; bit < 8; bit++) {
        value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
      }
    }
    return (value ^ 0xffffffff) >>> 0;
  }
  function chunk(name, data) {
    const type = Buffer.from(name);
    const size = Buffer.alloc(4);
    const checksum = Buffer.alloc(4);
    size.writeUInt32BE(data.length);
    checksum.writeUInt32BE(crc(Buffer.concat([type, data])));
    return Buffer.concat([size, type, data, checksum]);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(16, 0);
  header.writeUInt32BE(16, 4);
  header[8] = 8;
  header[9] = 2;
  const pixels = Buffer.alloc(16 * (1 + 16 * 3));
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const offset = y * 49 + 1 + x * 3;
      pixels[offset] = x < 8 ? 18 : 215;
      pixels[offset + 1] = x < 8 ? 110 : 75;
      pixels[offset + 2] = 67;
    }
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

const main = [
  '\\documentclass[11pt]{article}', '\\usepackage{amsmath}', '\\usepackage{graphicx}',
  '\\begin{document}', '\\section{Native LaTeX fixture}',
  'MAINNATIVETEX. Shared citation~\\cite{qa2024}.', '\\input{chapters/results.tex}',
  '\\begin{figure}[h]\\centering\\includegraphics[width=25mm]{figures/chart.png}\\caption{FIGURENATIVETEX}\\end{figure}',
  '\\clearpage', '\\bibliographystyle{plain}', '\\bibliography{references}', '\\end{document}', '',
].join('\n');
const chapter = [
  '\\subsection{Results}', 'CHAPTERNATIVETEX. Literal observations remain in their original files.',
  '\\[q^2=\\frac{a}{b}.\\]', '',
].join('\n');
const bibliography = '@article{qa2024,author={Example, Alice},title={{Bibliography native fixture sentinel}},journal={Synthetic Journal},year={2024},volume={1},pages={1--3}}\n';
await writeFile(join(projectRoot, 'main.tex'), main);
await writeFile(join(projectRoot, 'chapters/results.tex'), chapter);
await writeFile(join(projectRoot, 'references.bib'), bibliography);
await writeFile(join(projectRoot, 'figures/chart.png'), png());
await writeFile(join(outside, 'sentinel.tex'), 'OUTSIDEPRIVATEQX293.\n');
await writeFile(join(outside, 'outside-chart.png'), png());

const cache = process.env.UNDERTREE_TECTONIC_CACHE || process.env.TECTONIC_CACHE_DIR;
assert.ok(cache, 'Provide the prepared offline resource cache explicitly.');
const data = join(cache, 'bundles/data');
let outsideFont;
for (const entry of await readdir(data, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const path = join(data, entry.name, 'lmroman10-regular.otf');
  try {
    await access(path);
    outsideFont = join(outside, 'owned-outside-font.otf');
    await copyFile(path, outsideFont);
    await copyFile(path, join(projectRoot, 'fonts/owned-font.otf'));
    break;
  } catch {}
}
assert.ok(outsideFont, 'The fixture requires an already prepared Latin Modern font, never a download.');
const texPath = path => path.replaceAll('\\', '/');

async function call(operation, { error = false } = {}) {
  const response = await fetch(base + '/api/review', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(operation), signal: AbortSignal.timeout(90000),
  });
  const value = await response.json();
  if (error) {
    assert.equal(value.ok, false, 'Compilation must report failure');
    assert.ok(value.error?.code);
    return value.error;
  }
  assert.equal(value.ok, true, value.error?.message);
  return value.result;
}

async function check(name, run) {
  activeCheck = name;
  await run();
  checks.push({ name, status: 'VERIFIED' });
  await writeFile(join(artifact, 'receipt.json'), JSON.stringify(receipt, null, 2));
  console.log('VERIFIED ' + name);
}

async function inspect(preview, name) {
  assert.equal(preview.available, true);
  const bytes = Buffer.from(preview.base64, 'base64');
  assert.equal(bytes.subarray(0, 5).toString(), '%PDF-');
  const loading = getDocument({ data: new Uint8Array(bytes), useSystemFonts: false, isEvalSupported: false });
  const document = await loading.promise;
  try {
    let text = '';
    let imageOps = 0;
    for (let index = 1; index <= document.numPages; index++) {
      const page = await document.getPage(index);
      text += (await page.getTextContent()).items.map(item => item.str || '').join(' ') + '\n';
      const operators = await page.getOperatorList();
      imageOps += operators.fnArray.filter(operation => [OPS.paintImageXObject, OPS.paintInlineImageXObject].includes(operation)).length;
      page.cleanup();
    }
    const summary = { name, pages: document.numPages, sha256: digest(bytes), imageOps, text };
    await writeFile(join(artifact, `${name}.pdf`), bytes);
    await writeFile(join(artifact, `${name}.json`), JSON.stringify(summary, null, 2));
    return summary;
  } finally {
    await loading.destroy();
  }
}

async function stop() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill();
  let timer;
  await Promise.race([
    new Promise(done => child.once('close', done)),
    new Promise(done => { timer = setTimeout(() => { child.kill('SIGKILL'); done(); }, 5000); }),
  ]);
  clearTimeout(timer);
}

try {
  receipt.binary = { path: binary, sha256: digest(await readFile(binary)) };
  receipt.worker = { path: worker, sha256: digest(await readFile(worker)), ownedCopy: workerCopy };
  receipt.projectRoot = projectRoot;
  child = spawn(binary, ['serve'], {
    env: {
      ...process.env, UNDERTREE_REVIEW_PORT: '0', UNDERTREE_REVIEW_TOKEN: token,
      UNDERTREE_REVIEW_STATE: join(temporary, 'state'), UNDERTREE_LATEX_WORKER: workerCopy,
      HTTP_PROXY: 'http://127.0.0.1:0', HTTPS_PROXY: 'http://127.0.0.1:0',
      ALL_PROXY: 'http://127.0.0.1:0', NO_PROXY: '', SOURCE_DATE_EPOCH: '1767225600',
    },
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((ready, reject) => {
    const timer = setTimeout(() => reject(Error('Native service startup deadline: ' + log)), 15000);
    const fail = error => { clearTimeout(timer); reject(error); };
    child.once('error', fail);
    child.once('exit', code => fail(Error(`Native service exited ${code}: ${log}`)));
    child.stderr.on('data', bytes => { log = (log + bytes).slice(-65536); });
    child.stdout.on('data', bytes => {
      log = (log + bytes).slice(-65536);
      const port = log.match(/127\.0\.0\.1:(\d+)/)?.[1];
      if (port) { base = `http://127.0.0.1:${port}`; clearTimeout(timer); ready(); }
    });
  });
  const project = await call({ action: 'add_project', root: projectRoot });
  const compile = source => call({ action: 'compile', project: project.id, path: 'main.tex', revision: digest(source) });
  const preview = () => call({ action: 'pdf', project: project.id, path: 'main.tex' });

  await check('Saved TeX main selection and actual nested BibTeX/image PDF', async () => {
    const selected = await call({ action: 'set_main_document', project: project.id, path: 'main.tex' });
    assert.equal(selected.mainDocument, 'main.tex');
    good = await compile(main);
    assert.equal(good.revision, digest(main));
    assert.equal(good.sourceEpoch, 0);
    const pdf = await inspect(good, 'initial');
    for (const marker of ['MAINNATIVETEX', 'CHAPTERNATIVETEX', 'FIGURENATIVETEX', 'Bibliography native fixture sentinel', 'Example']) {
      assert.ok(pdf.text.includes(marker), marker);
    }
    assert.ok(pdf.imageOps > 0, 'The included image contributes PDF painting operations');
    receipt.initial = { pdfHash: good.pdfHash, current: good.current, externalDependencyCount: good.externalDependencyCount, pages: pdf.pages };
  });

  await check('A missing owned worker preserves the PDF and recovers after restoration', async () => {
    const before = await preview();
    const unavailable = workerCopy + '.unavailable';
    await rename(workerCopy, unavailable);
    try {
      const error = await call({ action: 'compile', project: project.id, path: 'main.tex', revision: digest(main) }, { error: true });
      assert.equal(error.code, 'latex');
      assert.match(error.message, /worker is unavailable/i);
      const after = await preview();
      assert.equal(after.pdfHash, before.pdfHash);
      assert.equal(after.base64, before.base64);
      receipt.missingWorker = { code: error.code, lastGoodPreserved: true };
    } finally {
      await rename(unavailable, workerCopy);
    }
    assert.equal(digest(await readFile(workerCopy)), receipt.worker.sha256);
    good = await compile(main);
    assert.ok((await inspect(good, 'restored-worker')).text.includes('MAINNATIVETEX'));
  });

  await check('An explicit owned project font works with ambient font discovery disabled', async () => {
    const source = main.replace('MAINNATIVETEX.', '{\\font\\ownedFont="[fonts/owned-font.otf]" at 12pt \\ownedFont OWNEDPROJECTFONTQX293.}');
    await writeFile(join(projectRoot, 'main.tex'), source);
    const result = await compile(source);
    assert.ok((await inspect(result, 'project-font')).text.includes('OWNEDPROJECTFONTQX293'));
    await writeFile(join(projectRoot, 'main.tex'), main);
    good = await compile(main);
  });

  await check('Changed chapter never claims the old PDF current and recompiles exact text', async () => {
    await writeFile(join(projectRoot, 'chapters/results.tex'), chapter + '\nNEWCHAPTERNATIVETEX.\n');
    assert.equal((await preview()).current, false);
    good = await compile(main);
    assert.ok((await inspect(good, 'changed-chapter')).text.includes('NEWCHAPTERNATIVETEX'));
  });

  await check('Changed bibliography is reflected in the next full PDF', async () => {
    await writeFile(join(projectRoot, 'references.bib'), bibliography.replace('Bibliography native fixture sentinel', 'UPDATEDBIBNATIVETEX'));
    assert.equal((await preview()).current, false);
    good = await compile(main);
    assert.ok((await inspect(good, 'changed-bibliography')).text.includes('UPDATEDBIBNATIVETEX'));
  });

  await check('Stale main revision is rejected without replacing the last good PDF', async () => {
    const before = (await preview()).pdfHash;
    const error = await call({ action: 'compile', project: project.id, path: 'main.tex', revision: digest(main + 'stale') }, { error: true });
    assert.equal(error.code, 'stale');
    assert.equal((await preview()).pdfHash, before);
  });

  const biberRequest = [
    '\\newwrite\\qaexternal', '\\immediate\\openout\\qaexternal=\\jobname.run.xml',
    '\\immediate\\write\\qaexternal{<requests><external><cmdline><binary>biber</binary><infile>ignored</infile></cmdline></external></requests>}',
    '\\immediate\\closeout\\qaexternal',
  ].join('\n');
  const failures = [
    ['syntax-error', main.replace('MAINNATIVETEX.', '\\undefinedUnderTreeQaCommand')],
    ['offline-missing-package', main.replace('\\usepackage{amsmath}', '\\usepackage{undertree-unavailable-package-qx293}')],
    ['absolute-outside-input', main.replace('MAINNATIVETEX.', `\\input{${texPath(join(outside, 'sentinel.tex'))}}`)],
    ['macro-outside-input', main.replace('MAINNATIVETEX.', `\\edef\\ownedOutside{${texPath(join(outside, 'sentinel.tex'))}}\\input{\\ownedOutside}`)],
    ['conditional-outside-input', main.replace('MAINNATIVETEX.', `\\IfFileExists{${texPath(join(outside, 'sentinel.tex'))}}{UNSAFEFILEFOUND}{Conditional input absent.}`)],
    ['absolute-outside-image', main.replace('figures/chart.png', texPath(join(outside, 'outside-chart.png')))],
    ['absolute-outside-font', main.replace('MAINNATIVETEX.', `{\\font\\ownedOutsideFont="[${texPath(outsideFont)}]" at 11pt \\ownedOutsideFont OUTSIDEFONTQX293}`)],
    ['ambient-named-font', main.replace('MAINNATIVETEX.', '{\\font\\ambientFont="Arial" at 12pt \\ambientFont AMBIENTFONTQX293}')],
    ['external-biber-request', main.replace('MAINNATIVETEX.', biberRequest)],
  ];
  for (const [name, source] of failures) {
    await check(`${name} is denied and preserves identical last good PDF`, async () => {
      const before = await preview();
      await writeFile(join(projectRoot, 'main.tex'), source);
      const error = await call({ action: 'compile', project: project.id, path: 'main.tex', revision: digest(source) }, { error: true });
      if (name === 'external-biber-request') assert.match(error.message, /External bibliography tools are disabled/);
      const after = await preview();
      assert.equal(after.pdfHash, before.pdfHash);
      assert.equal(after.base64, before.base64);
      assert.equal(after.current, false);
      assert.ok(!error.message.includes('OUTSIDEPRIVATEQX293'));
      receipt[name] = { code: error.code, message: error.message };
      await writeFile(join(projectRoot, 'main.tex'), main);
    });
  }

  await check('Shell escape cannot write an owned external sentinel', async () => {
    const sideEffect = join(outside, 'shell-executed.txt');
    const source = main.replace('MAINNATIVETEX.', `\\immediate\\write18{cmd /c echo SHELLEXECUTEDQX293 > "${texPath(sideEffect)}"}\nSHELLSAFEMAINQX293.`);
    await writeFile(join(projectRoot, 'main.tex'), source);
    const response = await fetch(base + '/api/review', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ action: 'compile', project: project.id, path: 'main.tex', revision: digest(source) }),
      signal: AbortSignal.timeout(90000),
    });
    const value = await response.json();
    if (value.ok) assert.ok((await inspect(value.result, 'shell-escape-disabled')).text.includes('SHELLSAFEMAINQX293'));
    else assert.ok(value.error?.code);
    await assert.rejects(access(sideEffect));
    receipt.shellEscape = { compileSucceeded: value.ok, externalSentinelCreated: false };
    await writeFile(join(projectRoot, 'main.tex'), main);
  });

  await check('A directory junction to an outside input cannot replace the PDF', async () => {
    const before = await preview();
    const linked = join(projectRoot, 'linked');
    await symlink(outside, linked, process.platform === 'win32' ? 'junction' : 'dir');
    try {
      const source = main.replace('MAINNATIVETEX.', '\\input{linked/sentinel.tex}');
      await writeFile(join(projectRoot, 'main.tex'), source);
      await call({ action: 'compile', project: project.id, path: 'main.tex', revision: digest(source) }, { error: true });
      assert.equal((await preview()).pdfHash, before.pdfHash);
    } finally {
      await rmdir(linked);
      await writeFile(join(projectRoot, 'main.tex'), main);
    }
  });

  await check('A nested main resolves legitimate parent paths inside the project', async () => {
    const path = 'chapters/nested-main.tex';
    const source = main.replace('chapters/results.tex', 'results.tex')
      .replace('figures/chart.png', '../figures/chart.png').replace('{references}', '{../references}')
      .replace('\\end{document}', '\\IfFileExists{../absent-optional.tex}{UNEXPECTEDOPTIONALFOUND}{OPTIONALABSENTQX293.}\n\\end{document}');
    await writeFile(join(projectRoot, path), source);
    const selected = await call({ action: 'set_main_document', project: project.id, path });
    assert.equal(selected.mainDocument, path);
    const nested = await call({ action: 'compile', project: project.id, path, revision: digest(source) });
    const pdf = await inspect(nested, 'nested-main');
    for (const marker of ['MAINNATIVETEX', 'NEWCHAPTERNATIVETEX', 'UPDATEDBIBNATIVETEX', 'OPTIONALABSENTQX293']) assert.ok(pdf.text.includes(marker), marker);
    assert.ok(pdf.imageOps > 0);
  });

  await check('Generated files never appear in the authored project', async () => {
    const files = [];
    async function visit(root, prefix = '') {
      for (const entry of await readdir(root, { withFileTypes: true })) {
        const path = prefix + entry.name;
        if (entry.isDirectory()) await visit(join(root, entry.name), path + '/');
        else files.push(path);
      }
    }
    await visit(projectRoot);
    assert.deepEqual(files.sort(), [
      'chapters/nested-main.tex', 'chapters/results.tex', 'figures/chart.png',
      'fonts/owned-font.otf', 'main.tex', 'references.bib',
    ].sort());
    receipt.finalProjectFiles = files;
  });
  receipt.status = 'VERIFIED';
} catch (error) {
  receipt.failedCheck = activeCheck;
  receipt.error = { message: error.message, stack: error.stack };
  console.error(error);
  process.exitCode = 1;
} finally {
  await stop();
  receipt.finishedAt = new Date().toISOString();
  await writeFile(join(artifact, 'service.log'), log);
  await writeFile(join(artifact, 'receipt.json'), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify({ status: receipt.status, checks: checks.length, artifact }));
}
