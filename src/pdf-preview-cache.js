export const PDF_PREVIEW_CACHE_LIMIT = 6;

export function pdfPreviewCacheKey(projectId, sourcePath) {
  const project = String(projectId || "");
  return project ? `${project}:${String(sourcePath || "")}` : "";
}

export function touchPdfPreviewCache(cache, key, entry) {
  if (!key) return entry;
  cache.delete(key);
  cache.set(key, entry);
  return entry;
}

export function pdfPreviewEvictionKeys(cache, activeKey = "", limit = PDF_PREVIEW_CACHE_LIMIT) {
  const maximum = Math.max(1, Number(limit) || PDF_PREVIEW_CACHE_LIMIT);
  const keys = [];
  let remaining = cache.size;
  for (const key of cache.keys()) {
    if (remaining <= maximum) break;
    if (key === activeKey) continue;
    keys.push(key);
    remaining -= 1;
  }
  return keys;
}
