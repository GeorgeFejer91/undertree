// File inventory is authoritative; this only groups its existing paths for navigation.
export function manuscriptTree(paths) {
  const root = { children: new Map() };
  for (const path of paths) {
    const parts = path.split('/');
    let parent = root;
    for (let index = 0; index < parts.length; index += 1) {
      const name = parts[index];
      if (!parent.children.has(name)) parent.children.set(name, { name, path: parts.slice(0, index + 1).join('/'), children: new Map(), file: index === parts.length - 1 });
      parent = parent.children.get(name);
    }
  }
  const sorted = node => [...node.children.values()].sort((a, b) => Number(a.file) - Number(b.file) || a.name.localeCompare(b.name, undefined, { numeric: true })).map(child => ({ ...child, children: sorted(child) }));
  return sorted(root);
}

export function clampPaneWidth(requested, available, minimum = 150, reserved = 400) {
  return Math.max(Math.min(minimum, available), Math.min(requested, Math.max(minimum, available - reserved)));
}

export function pdfPageWindow(current, total, radius = 1) {
  const page = Math.max(1, Math.min(total, Math.round(current) || 1));
  return { page, first: Math.max(1, page - radius), last: Math.min(total, page + radius) };
}
