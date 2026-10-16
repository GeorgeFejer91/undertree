import { constants } from 'node:fs';
import { chmod, link, lstat, mkdir, mkdtemp, open, readdir, realpath, rm, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join, parse, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const MAX_FILE = 1024 * 1024, MAX_TOTAL = 8 * MAX_FILE, MAX_FILES = 128;
const ROOT_FILES = new Set(['environment.json', 'metadata.json', 'config.json']);
const fail = () => { throw new Error('Invalid or unsupported Secret Tunnel profile.'); };
const runFile = promisify(execFile);

// POSIX modes do not restrict Windows ACLs. Protect each newly owned tree before
// writing credentials; its files inherit only the current user and OS admins.
async function privateDirectory(path) {
  if (process.platform !== 'win32') return chmod(path, 0o700);
  const system = join(process.env.SystemRoot || 'C:\\Windows', 'System32');
  const { stdout } = await runFile(join(system, 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'],
    { windowsHide: true, timeout: 10_000, maxBuffer: 4096 });
  const sid = stdout.match(/S-1-5-\d+(?:-\d+)+/)?.[0];
  if (!sid) fail();
  await runFile(join(system, 'icacls.exe'), [path, '/inheritance:r', '/grant:r',
    `*${sid}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F'],
  { windowsHide: true, timeout: 10_000, maxBuffer: 4096 });
}

async function plainPath(path, directory = false) {
  const absolute = resolve(path), root = parse(absolute).root;
  let current = root;
  for (const part of absolute.slice(root.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    const info = await lstat(current);
    if (info.isSymbolicLink()) fail();
  }
  const info = await lstat(absolute);
  if (directory ? !info.isDirectory() : !info.isFile() || info.nlink !== 1) fail();
  return absolute;
}

async function bytes(path) {
  await plainPath(path);
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > MAX_FILE) fail();
    const buffer = Buffer.alloc(MAX_FILE + 1);
    let size = 0;
    while (size < buffer.length) {
      const result = await handle.read(buffer, size, buffer.length - size, null);
      if (!result.bytesRead) break;
      size += result.bytesRead;
    }
    if (size > MAX_FILE) fail();
    return buffer.subarray(0, size);
  } finally { await handle.close(); }
}

function profile(settings) {
  if (settings.mcpTransport && settings.mcpTransport !== 'zrok') fail();
  if (typeof settings.zrokName !== 'string' || !/^[a-z0-9][a-z0-9-]{2,98}[a-z0-9]$/.test(settings.zrokName)) fail();
  if (typeof settings.publicPathToken !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(settings.publicPathToken)) fail();
  return { mcpTransport: 'zrok', zrokName: settings.zrokName, publicPathToken: settings.publicPathToken };
}

async function snapshot(home) {
  await plainPath(home, true);
  const files = [];
  let total = 0;
  async function visit(directory, prefix = '') {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (!prefix && entry.name === 'identities') {
        await plainPath(join(directory, entry.name), true);
        await visit(join(directory, entry.name), 'identities');
      } else if ((!prefix && ROOT_FILES.has(entry.name))
        || (prefix === 'identities' && entry.name === 'environment.json')) {
        const content = await bytes(join(directory, entry.name));
        total += content.length;
        if (total > MAX_TOTAL || files.length >= MAX_FILES) fail();
        files.push({ name, content });
      }
    }
  }
  await visit(home);
  const environmentFile = files.find(file => file.name === 'environment.json');
  const metadataFile = files.find(file => file.name === 'metadata.json');
  if (!environmentFile || !metadataFile || !files.some(file => file.name === 'identities/environment.json')) fail();
  if (JSON.parse(metadataFile.content.toString('utf8')).v !== 'v0.4') fail();
  const environment = JSON.parse(environmentFile.content.toString('utf8'));
  if (['zrok_token', 'ziti_identity', 'api_endpoint'].some(key => typeof environment[key] !== 'string' || !environment[key])) fail();
  return files;
}

async function writeHome(home, files) {
  await mkdir(home, { mode: 0o700 });
  await mkdir(join(home, 'identities'), { mode: 0o700 });
  for (const file of files) await writeFile(join(home, file.name), file.content, { flag: 'wx', mode: 0o600 });
}

// Transfer only the connector identity and zrok enrolment, never other account sessions.
export async function exportSecretTunnel({ settings, zrokHome, output }) {
  const selected = profile(JSON.parse((await bytes(settings)).toString('utf8')));
  const files = await snapshot(zrokHome);
  output = resolve(output);
  await plainPath(parse(output).dir, true);
  await mkdir(output, { mode: 0o700 });
  try {
    await privateDirectory(output);
    await writeFile(join(output, 'settings.json'), JSON.stringify(selected), { flag: 'wx', mode: 0o600 });
    await writeHome(join(output, 'zrok-home'), files);
  } catch (error) { await rm(output, { recursive: true, force: true }); throw error; }
  return { files: files.length, bytes: files.reduce((sum, file) => sum + file.content.length, 0) };
}

export async function importSecretTunnel({ input, state }) {
  input = await plainPath(input, true);
  state = await plainPath(state, true);
  state = await realpath(state);
  const lockPath = join(state, '.connector-import.lock');
  const lock = await open(lockPath, 'wx', 0o600);
  try { return await installSecretTunnel(input, state); }
  finally { await lock.close(); await unlink(lockPath); }
}

async function installSecretTunnel(input, state) {
  // Close the desktop first; a stale descriptor also requires local review.
  if (await lstat(join(state, 'cli', 'instance.json')).catch(error => { if (error.code !== 'ENOENT') throw error; }))
    throw new Error('Close UnderTree before importing its connector profile.');
  const selected = profile(JSON.parse((await bytes(join(input, 'settings.json'))).toString('utf8')));
  const files = await snapshot(join(input, 'zrok-home'));
  const publicSettings = { reservation: selected.zrokName, publicUrl: `https://${selected.zrokName}.shares.zrok.io` };
  const target = join(state, 'secret-tunnel-connector.json'), config = join(state, 'connection.json');
  if (await lstat(target).catch(error => { if (error.code !== 'ENOENT') throw error; }))
    throw new Error('An imported connector already exists; review it locally before replacing it.');
  let createConfig = false;
  try {
    const current = JSON.parse((await bytes(config)).toString('utf8'));
    if (current.reservation !== publicSettings.reservation || current.publicUrl !== publicSettings.publicUrl)
      throw new Error('Existing zrok setup differs; review it locally before importing.');
  } catch (error) { if (error.code === 'ENOENT') createConfig = true; else throw error; }
  const home = await mkdtemp(join(state, 'zrok-home-'));
  const temporary = join(home, 'connector.tmp');
  let configCreated = false, published = false;
  try {
    await privateDirectory(home);
    // zrok v2 resolves .zrok2 from the child process's user home; no ZROK2_HOME override exists.
    await writeHome(join(home, '.zrok2'), files);
    const connector = { version: 1, ...publicSettings, publicPathToken: selected.publicPathToken, zrokHome: home };
    await writeFile(temporary, JSON.stringify(connector), { flag: 'wx', mode: 0o600 });
    if (createConfig) {
      await writeFile(config, JSON.stringify(publicSettings), { flag: 'wx', mode: 0o600 });
      configCreated = true;
    }
    await link(temporary, target);
    published = true;
    await unlink(temporary);
  } catch (error) {
    if (published) await unlink(target);
    if (configCreated) await unlink(config);
    await rm(home, { recursive: true, force: true });
    throw error;
  }
  return { files: files.length, imported: true, started: false };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [action, ...args] = process.argv.slice(2);
  const options = {};
  try {
    const allowed = action === 'export' ? ['settings', 'zrok-home', 'output'] : action === 'import' ? ['input', 'state'] : [];
    if (!allowed.length || args.length !== allowed.length * 2) fail();
    for (let i = 0; i < args.length; i += 2) {
      const key = args[i].slice(2);
      if (!args[i].startsWith('--') || !allowed.includes(key) || key in options || !isAbsolute(args[i + 1])) fail();
      options[key] = args[i + 1];
    }
    const result = action === 'export'
      ? await exportSecretTunnel({ ...options, zrokHome: options['zrok-home'] })
      : await importSecretTunnel(options);
    console.log(JSON.stringify(result));
  } catch {
    // Parser, OS and library errors can contain sensitive source text or paths.
    console.error('Profile operation failed. Use new private destinations and valid local profile paths; existing configuration is never replaced.');
    process.exitCode = 1;
  }
}
