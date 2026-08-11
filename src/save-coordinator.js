export function markTabEdited(tab, content) {
  if (!tab) return tab;
  tab.content = content ?? "";
  tab.revision = (tab.revision || 0) + 1;
  tab.dirty = true;
  return tab;
}

export function tabContent(tab) {
  const content = tab?.content ?? "";
  return typeof content === "string" ? content : String(content);
}

export async function buildTabSnapshot(tab) {
  if (!tab) return null;
  if (tab.savePromise) await tab.savePromise;
  const contentSource = tab.content;
  return {
    content: tabContent(tab),
    contentSource,
    dirty: Boolean(tab.dirty),
    revision: tab.revision || 0,
  };
}

export function acceptBuildSave(tab, snapshot, result) {
  if (!tab || !snapshot || !result) return false;
  tab.mtimeMs = result.mtimeMs;
  tab.size = result.size;
  if ((tab.revision || 0) !== snapshot.revision || tab.content !== snapshot.contentSource) return false;
  tab.content = snapshot.content;
  tab.dirty = false;
  return true;
}

export function markPathEdited(tabs, path, content) {
  return markTabEdited(tabs?.get(path), content);
}

export async function saveTabSnapshot(tab, persist) {
  if (!tab) return tab;
  if (tab.savePromise) await tab.savePromise;
  if (!tab.dirty) return tab;

  const contentSource = tab.content;
  const content = tabContent(tab);
  const revision = tab.revision || 0;
  const expectedMtimeMs = tab.mtimeMs;
  const pending = (async () => {
    const result = await persist({ content, expectedMtimeMs });
    tab.mtimeMs = result.mtimeMs;
    tab.size = result.size;
    if ((tab.revision || 0) === revision && tab.content === contentSource) {
      tab.content = content;
      tab.dirty = false;
    }
    return tab;
  })();
  tab.savePromise = pending;
  try {
    return await pending;
  } finally {
    if (tab.savePromise === pending) tab.savePromise = null;
  }
}

export async function flushTabSave(tab, persist) {
  while (tab && (tab.dirty || tab.savePromise)) {
    if (tab.savePromise) await tab.savePromise;
    else await saveTabSnapshot(tab, persist);
  }
  return tab;
}

export async function persistWithConflictRecovery(snapshot, persist, refresh) {
  try {
    return await persist(snapshot);
  } catch (error) {
    if (error?.status !== 409) throw error;
    let current;
    try {
      current = await refresh();
    } catch (refreshError) {
      if (refreshError?.status !== 404) throw refreshError;
      current = { mtimeMs: null };
    }
    return persist({
      ...snapshot,
      expectedMtimeMs: current.mtimeMs,
      preserveCurrent: Number.isFinite(current.mtimeMs),
    });
  }
}
