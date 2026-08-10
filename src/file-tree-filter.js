const SOURCE_EXTENSIONS = new Set([".tex", ".bib"]);

export function isPdfSourceFile(path) {
  const normalized = String(path || "").toLowerCase();
  return [...SOURCE_EXTENSIONS].some((extension) => normalized.endsWith(extension));
}

export function pdfSourceTree(nodes) {
  const filtered = [];
  for (const node of nodes || []) {
    if (node.type === "directory") {
      const children = pdfSourceTree(node.children);
      if (children.length) filtered.push({ ...node, children });
    } else if (isPdfSourceFile(node.path || node.name)) {
      filtered.push(node);
    }
  }
  return filtered;
}
