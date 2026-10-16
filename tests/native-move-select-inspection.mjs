import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

// Only new read-only X11 inspection calls use this bound; existing native key semantics stay unchanged.
export function inspectNativeMoveWindow(executable,args,privateEnvironment) {
  assert.ok(['/usr/bin/xwininfo','/usr/bin/xprop'].includes(executable));
  return execFileSync(executable,args.map(String),{env:privateEnvironment,encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:2000,maxBuffer:65536,killSignal:'SIGKILL'}).trim();
}
