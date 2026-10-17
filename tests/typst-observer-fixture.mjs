import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Preserve the real compiler's arguments and exit code while counting invocations.
export async function createTypstObserver(root, calls) {
  const source = join(root, 'typst-observer.rs');
  const executable = join(root, `typst-observer${process.platform === 'win32' ? '.exe' : ''}`);
  await writeFile(source, `use std::{io::Write,process::Command};
fn main() {
 let mut file=std::fs::OpenOptions::new().create(true).append(true).open(std::env::var_os("UNDERTREE_COMPILER_CALLS").unwrap()).unwrap();
 writeln!(file,"1").unwrap(); drop(file);
 std::thread::sleep(std::time::Duration::from_millis(300));
 let status=Command::new(std::env::var_os("UNDERTREE_OBSERVED_TYPST").unwrap()).args(std::env::args_os().skip(1)).status().unwrap();
 std::process::exit(status.code().unwrap_or(1));
}`);
  const compiled = spawnSync('rustc', ['--edition=2021', source, '-o', executable], {encoding:'utf8',windowsHide:true,timeout:60_000});
  assert.equal(compiled.status, 0, compiled.stderr || compiled.error?.message);
  return { executable, environment: { UNDERTREE_COMPILER_CALLS: calls, UNDERTREE_OBSERVED_TYPST: process.env.UNDERTREE_TYPST || 'typst' } };
}
