function lineCounter(content) {
  let line = 1;
  let offset = 0;
  return (index) => {
    for (let newline = content.indexOf("\n", offset); newline !== -1 && newline < index; newline = content.indexOf("\n", offset)) {
      line += 1;
      offset = newline + 1;
    }
    return line;
  };
}

export function documentOutline(source, mode = false) {
  const content = String(source || "");
  const lineAt = lineCounter(content);
  const headings = [];
  if (mode === "html") {
    const pattern = /<h([1-6])(?:\s[^>]*)?>([\s\S]*?)<\/h\1>/gi;
    let match;
    while ((match = pattern.exec(content))) {
      headings.push({
        title: match[2].replace(/<[^>]+>/g, "").replace(/&nbsp;/gi, " ").replace(/\s+/g, " ").trim(),
        line: lineAt(match.index),
        level: Math.min(3, Number(match[1])),
      });
    }
    return headings;
  }
  if (mode === true || mode === "layout") {
    const pattern = /<heading(?:\s[^>]*)?>([\s\S]*?)<\/heading>/gi;
    let match;
    while ((match = pattern.exec(content))) {
      headings.push({
        title: match[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim(),
        line: lineAt(match.index),
        level: 1,
      });
    }
    return headings;
  }
  const pattern = /^\s*\\(part|chapter|section|subsection|subsubsection|paragraph)\*?\{([^}]*)\}/gm;
  const levels = { part: 1, chapter: 1, section: 1, subsection: 2, subsubsection: 3, paragraph: 3 };
  let match;
  while ((match = pattern.exec(content))) {
    headings.push({ title: match[2], line: lineAt(match.index), level: levels[match[1]] });
  }
  return headings;
}
