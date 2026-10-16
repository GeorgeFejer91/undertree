// Build-time attribution only. No product service, account state or network credentials are read.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const windows = process.platform === 'win32';
assert.ok(!windows || ['x64', 'arm64'].includes(process.arch), 'Windows notices support x64 and arm64 MSVC targets.');
const target = windows ? `${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-pc-windows-msvc` : 'x86_64-unknown-linux-gnu';
const output = resolve(root, process.env.UNDERTREE_NOTICES_DIR || `native/tauri/notices${windows ? '-windows' : ''}`);
const scratch = join(root, 'artifacts/third-party-notices', target);
const version = '0.9.2';
const files = ['THIRD-PARTY-RUST.md', 'THIRD-PARTY-JAVASCRIPT.md'];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const canonicalText = async path => (await readFile(path, 'utf8')).replace(/\r\n/g, '\n');
const hash = async path => sha(await canonicalText(join(root, path)));
const check = process.argv.slice(2).length === 1 && process.argv[2] === '--check';
assert.ok(process.argv.length === 2 || check, 'Use generate-notices.mjs [--check].');

async function inputs() {
  const paths = ['Cargo.lock', 'Cargo.toml', 'modules/review/Cargo.toml', 'native/tauri/Cargo.toml',
    'package.json', 'package-lock.json', 'vite.config.js', 'index.html', 'manuscript.html',
    'packaging/licenses/about.toml',
    'modules/maintenance/generate-notices.mjs'];
  async function walk(directory) {
    for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) await walk(path);
      else if (directory.startsWith('packaging/licenses') || /\.(?:js|mjs|css)$/.test(entry.name)) paths.push(path);
    }
  }
  for (const directory of ['src', 'modules/frontend', 'layout', 'packaging/licenses/upstream']) await walk(directory);
  return Object.fromEntries(await Promise.all(paths.sort().map(async path => [path, await hash(path)])));
}

async function verify() {
  const manifest = JSON.parse(await readFile(join(output, 'manifest.json'), 'utf8'));
  assert.equal(manifest.schema, 1);
  assert.equal(manifest.cargoAbout, version);
  assert.equal(manifest.target, target);
  assert.deepEqual(manifest.inputs, await inputs(), 'Notice inputs changed; regenerate the locked attribution payload.');
  for (const file of files) {
    const bytes = await readFile(join(output, file));
    assert.ok([sha(bytes), sha(bytes.toString('utf8').replace(/\r\n/g, '\n'))].includes(manifest.outputs[file]), `Notice changed: ${file}`);
  }
  for (const file of manifest.upstreamFiles) assert.equal(sha(await readFile(join(root, file.path))), file.sha256, `Upstream attribution changed: ${file.path}`);
  const rust = await readFile(join(output, files[0]), 'utf8');
  const js = await readFile(join(output, files[1]), 'utf8');
  const lock = await canonicalText(join(root, 'Cargo.lock'));
  for (const [name, crateVersion] of manifest.rustComponents) {
    assert.ok(lock.includes(`name = "${name}"\nversion = "${crateVersion}"`), `Rust component absent from lock: ${name}`);
  }
  for (const name of ['zip', 'tauri', 'serde', 'typst-syntax']) assert.ok(manifest.rustComponents.some(([component]) => component === name), `Missing Rust attribution: ${name}`);
  for (const name of ['pdfjs-dist', '@chenglou/pretext', '@codemirror/view', '@tauri-apps/api']) assert.ok(manifest.javascriptComponents.some(component => component.name === name), `Missing JavaScript attribution: ${name}`);
  assert.ok(rust.includes('Copyright (c) 2014 Mathijs van de Nes') && rust.includes('Tauri Apps Contributors'), 'Rust copyright notices must be preserved.');
  assert.ok(js.includes('Pretext contributors') && js.includes('Copyright 2024 Mozilla Foundation'), 'Bundled JavaScript copyright notices must be preserved.');
  assert.ok(rust.includes('Mozilla Public License') && js.includes('Apache License'), 'Full applicable license texts are required.');
  console.log(`Third-party notices verified: ${manifest.rustComponents.length} Rust components and ${manifest.javascriptComponents.length} bundled JavaScript components.`);
}

if (check) {
  await verify();
} else {
  await mkdir(scratch, { recursive: true });
  await mkdir(output, { recursive: true });
  const tool = resolve(process.env.UNDERTREE_CARGO_ABOUT || join(root, `artifacts/tools/bin/cargo-about${windows ? '.exe' : ''}`));
  const toolVersion = (await exec(tool, ['--version'], { cwd: root })).stdout.trim();
  assert.match(toolVersion, /^cargo-about 0\.9\.2$/, 'Use the reviewed cargo-about0.9.2 tool.');
  const before = await inputs();
  const environment = { ...process.env, CARGO_TARGET_DIR: join(scratch, 'cargo-target') };
  const licenseRoot = join(scratch, 'upstream');
  await mkdir(licenseRoot, { recursive: true });
  for (const file of await readdir(join(root, 'packaging/licenses/upstream'))) {
    await writeFile(join(licenseRoot, file), await canonicalText(join(root, 'packaging/licenses/upstream', file)));
  }
  const config = (await canonicalText(join(root, 'packaging/licenses/about.toml')))
    .replace(/^targets = .*$/m, `targets = [${JSON.stringify(target)}]`)
    .replace(/"@LICENSE_ROOT@\/([^"\n]+)"/g, (_, file) => JSON.stringify(join(licenseRoot, file)));
  await writeFile(join(scratch, 'about-local.toml'), config);
  const rustKey = sha(JSON.stringify({ target, tool: sha(await readFile(tool)),
    inputs: Object.fromEntries(Object.entries(before).filter(([path]) => path.startsWith('packaging/licenses/') || path.endsWith('Cargo.toml') || path === 'Cargo.lock')) }));
  const previous = await readFile(join(scratch, 'rust-cache.json'), 'utf8').then(JSON.parse).catch(() => null);
  const cachedJson = await readFile(join(scratch, 'rust.json')).catch(() => null);
  if (previous?.key !== rustKey || !cachedJson || previous.sha256 !== sha(cachedJson)) {
    await exec(tool, ['generate', '--locked', '--offline', '--fail', '--manifest-path', 'native/tauri/Cargo.toml',
      '--features', 'custom-protocol', '--config', join(scratch, 'about-local.toml'),
      '--format', 'json', '--output-file', join(scratch, 'rust.json')],
    { cwd: root, env: environment, timeout: 600_000, maxBuffer: 4 * 1024 * 1024 });
    await writeFile(join(scratch, 'rust-cache.json'), JSON.stringify({ key: rustKey, sha256: sha(await readFile(join(scratch, 'rust.json'))) }) + '\n');
  }
  const rustData = JSON.parse(await readFile(join(scratch, 'rust.json'), 'utf8'));
  const covered = new Set(rustData.licenses.flatMap(license => license.used_by.map(({ crate: component }) => `${component.name}@${component.version}`)));
  const expected = new Set(rustData.crates.filter(component => component.license !== 'Ignore').map(({ package: component }) => `${component.name}@${component.version}`));
  assert.deepEqual([...covered].sort(), [...expected].sort(), 'Every selected transitive Rust component needs an actual license text.');
  const missing = rustData.licenses.filter(license => !license.source_path || /<year>|<copyright holders>/.test(license.text));
  await writeFile(join(scratch, 'missing-texts.json'), JSON.stringify(missing.map(license => ({ id: license.id,
    components: license.used_by.map(({ crate: component }) => ({ name: component.name, version: component.version })) })), null, 2) + '\n');
  assert.equal(missing.length, 0, `Canonical license fallback lacks upstream text/copyright; see ${join(scratch, 'missing-texts.json')} and add a verified clarification.`);
  let rust = `# UnderTree third-party Rust notices\n\nGenerated by cargo-about0.9.2 from Cargo.lock for the ${windows ? 'Windows' : 'Linux'} desktop and its Rust CLI, including transitive/build dependencies. Exact-version source links accompany each component. These notices do not change UnderTree’s own license.\n`;
  for (const license of rustData.licenses) {
    rust += `\n## ${license.name} (${license.id})\n\n`;
    for (const { crate: component } of license.used_by) rust += `- [${component.name} ${component.version}](https://crates.io/crates/${component.name}/${component.version})\n`;
    rust += `\n\`\`\`text\n${license.text}\n\`\`\`\n`;
  }
  const rustNotices = [];
  let visited = 0;
  for (const { package: component, license } of rustData.crates) {
    if (license === 'Ignore') continue;
    const packageRoot = dirname(component.manifest_path);
    async function notices(directory, prefix = '') {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        assert.ok(++visited <= 200_000, 'Unexpected Rust notice inventory size.');
        const path = join(directory, entry.name), relative = prefix + entry.name;
        if (entry.isDirectory()) await notices(path, `${relative}/`);
        else if (entry.isFile() && /^NOTICE(?:[._-]|$)/i.test(entry.name)) {
          const text = await readFile(path, 'utf8');
          assert.ok(Buffer.byteLength(text) <= 1024 * 1024, 'Unexpected upstream NOTICE size.');
          rust += `\n## ${component.name} ${component.version}: upstream ${relative}\n\n\`\`\`text\n${text}\n\`\`\`\n`;
          rustNotices.push({ name: component.name, version: component.version, file: relative, sha256: sha(text) });
        }
      }
    }
    await notices(packageRoot);
  }
  await exec(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--outDir', join(scratch, 'dist'), '--emptyOutDir'],
    { cwd: root, timeout: 120_000, maxBuffer: 2 * 1024 * 1024 });
  const components = JSON.parse(await readFile(join(scratch, 'dist/THIRD-PARTY-JAVASCRIPT.json'), 'utf8'));
  assert.ok(Array.isArray(components) && components.length > 0);
  const upstreamFiles = [];
  let javascript = '# UnderTree bundled JavaScript notices\n\nGenerated by Vite from the locked frontend build. Full upstream license/NOTICE files follow when supplied.\n';
  for (const component of components) {
    assert.match(component.name, /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i);
    assert.ok(typeof component.text === 'string' && component.text.trim(), `Missing license: ${component.name}`);
    const packageRoot = `node_modules/${component.name}`;
    const metadata = JSON.parse(await readFile(join(root, packageRoot, 'package.json'), 'utf8'));
    assert.equal(metadata.version, component.version, 'A nested package needs an explicit exact-version attribution path.');
    javascript += `\n## ${component.name} ${component.version} (${component.identifier})\n\n\`\`\`text\n${component.text}\n\`\`\`\n`;
    for (const entry of (await readdir(join(root, packageRoot), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isFile() || !/^(?:LICEN[CS]E|NOTICE|COPYING|COPYRIGHT)(?:[._-]|$)/i.test(entry.name)) continue;
      const path = `${packageRoot}/${entry.name}`;
      const text = await readFile(join(root, path), 'utf8');
      upstreamFiles.push({ path, sha256: sha(text) });
      javascript += `\n### Upstream ${entry.name}\n\n\`\`\`text\n${text}\n\`\`\`\n`;
    }
  }
  // Vite emits the PDF.js worker as a URL asset. Preserve its own leading copyright notice too.
  const workerPath = 'node_modules/pdfjs-dist/build/pdf.worker.min.mjs';
  const worker = await readFile(join(root, workerPath), 'utf8');
  const notice = worker.match(/^\/\*![\s\S]*?\*\//)?.[0] || worker.match(/^\/\*[\s\S]*?\*\//)?.[0];
  assert.ok(notice?.includes('Mozilla Foundation'), 'PDF.js worker copyright header is required.');
  upstreamFiles.push({ path: workerPath, sha256: sha(worker) });
  javascript += `\n## PDF.js emitted worker copyright\n\n\`\`\`text\n${notice}\n\`\`\`\n`;
  assert.deepEqual(await inputs(), before, 'Source/lock inputs changed during notice generation.');
  const rustComponents = [...new Map([...rust.matchAll(/\[([A-Za-z0-9_-]+) ([^\]]+)\]\(https:\/\/crates\.io\/crates\/[^)]+\)/g)]
    .map(match => [`${match[1]}@${match[2]}`, [match[1], match[2]]])).values()].sort(([a, av], [b, bv]) => a.localeCompare(b) || av.localeCompare(bv));
  assert.ok(rustComponents.length > 100, 'The Rust transitive graph must not be reduced to direct dependencies.');
  rust = rust.replace(/\r\n/g, '\n');
  javascript = javascript.replace(/\r\n/g, '\n');
  const outputs = { [files[0]]: sha(rust), [files[1]]: sha(javascript) };
  await writeFile(join(output, files[0]), rust);
  await writeFile(join(output, files[1]), javascript);
  await writeFile(join(output, 'manifest.json'), JSON.stringify({ schema: 1, cargoAbout: version, cargoAboutBinarySha256: sha(await readFile(tool)),
    target, inputs: before, outputs, rustComponents,
    javascriptComponents: components.map(({ name, version, identifier }) => ({ name, version, identifier })), upstreamFiles,
    rustNotices, rustLicenseTexts: rustData.licenses.map(license => ({ id: license.id, sha256: sha(license.text),
      components: license.used_by.map(({ crate: component }) => `${component.name}@${component.version}`) })) }, null, 2) + '\n');
  await verify();
}
