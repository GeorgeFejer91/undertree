function uncommentTex(content) {
  return String(content || "").split(/\r?\n/).map((line) => line.replace(/(^|[^\\])%.*/, "$1")).join("\n");
}

export function hasDocumentClass(content) {
  return /\\documentclass(?:\s*\[[^\]]*\])?\s*\{/.test(uncommentTex(content));
}

export function hasDocumentEnvironment(content) {
  return /\\begin\s*\{document\}/.test(uncommentTex(content));
}

export function isSelectedTexPdfTarget(path, content, configuredRoot = "") {
  const sourcePath = String(path || "");
  return sourcePath.toLowerCase().endsWith(".tex");
}
