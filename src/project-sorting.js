export const DEFAULT_PROJECT_SORT = "activity";

export const PROJECT_SORT_OPTIONS = new Set([
  "activity",
  "name-asc",
  "name-desc",
  "created-desc",
  "created-asc",
]);

export function normalizeProjectSort(value) {
  return PROJECT_SORT_OPTIONS.has(value) ? value : DEFAULT_PROJECT_SORT;
}

export function projectActivityTime(project, activity = {}) {
  const local = activity[project.id] || {};
  return Math.max(
    Number(local.openedAt) || 0,
    Number(local.editedAt) || 0,
    Number(project.modifiedAt) || 0,
  );
}

export function sortProjects(projects, mode = DEFAULT_PROJECT_SORT, activity = {}) {
  const selected = normalizeProjectSort(mode);
  const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true });
  const compare = {
    activity: (a, b) => projectActivityTime(b, activity) - projectActivityTime(a, activity) || byName(a, b),
    "name-asc": byName,
    "name-desc": (a, b) => byName(b, a),
    "created-desc": (a, b) => (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0) || byName(a, b),
    "created-asc": (a, b) => (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0) || byName(a, b),
  }[selected];
  return [...projects].sort(compare);
}
