export function dirnamePath(path) {
  const index = path.lastIndexOf("/");
  return index < 0 ? "" : path.slice(0, index);
}

export function pathIsEntry(path, entryPath) {
  return path === entryPath || path.startsWith(`${entryPath}/`);
}

export function remapPath(path, oldPath, newPath) {
  return path === oldPath ? newPath : `${newPath}${path.slice(oldPath.length)}`;
}

export function absoluteProjectPath(projectRoot, relativePath = "") {
  const root = String(projectRoot || "").replace(/[\\/]+$/, "");
  if (!relativePath) return root;
  const separator = root.includes("\\") && !root.includes("/") ? "\\" : "/";
  return `${root}${separator}${relativePath.replaceAll("/", separator)}`;
}
