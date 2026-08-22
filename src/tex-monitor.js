export const LIVE_COMPILE_DELAY_MS = 650;
export const EXTERNAL_TEX_SCAN_MS = 60_000;

export function externalTexChanged(tab, file) {
  if (!tab || !file || tab.dirty) return false;
  const editorMtime = Number(tab.mtimeMs);
  const diskMtime = Number(file.mtimeMs);
  return Number.isFinite(editorMtime) && Number.isFinite(diskMtime) && Math.abs(diskMtime - editorMtime) > 1;
}
