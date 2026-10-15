const inline = { typ: { bold: ['*', '*'], italic: ['_', '_'] }, html: { bold: ['<strong>', '</strong>'], italic: ['<em>', '</em>'] } };
const blocks = new Set(['heading', 'bullet-list', 'numbered-list']);
const tags = /<!--[\s\S]*?-->|<\/?([a-z][\w:-]*)(?:"[^"]*"|'[^']*'|[^'"<>])*>/gi;
const blockTags = /^(?:html|head|body|title|script|style|p|h[1-6]|div|section|article|aside|main|nav|header|footer|blockquote|pre|ul|ol|li|dl|dt|dd|table|thead|tbody|tfoot|tr|td|th|form|fieldset|hr|meta|link)$/;
const voidTags = new Set('area base br col embed hr img input link meta param source track wbr'.split(' '));
const clamp = (value, maximum) => Math.max(0, Math.min(value, maximum));

function htmlPhrasing(content) {
  const stack = [];
  for (const match of content.matchAll(tags)) {
    if (!match[1]) continue;
    const name = match[1].toLowerCase();
    if (blockTags.test(name)) throw new Error('Format complete paragraph/heading lines or plain inline content, not partial HTML containers.');
    if (match[0].startsWith('</')) {
      if (stack.pop() !== name) throw new Error('Select complete HTML inline elements before formatting this block.');
    } else if (!voidTags.has(name)) stack.push(name);
  }
  if (stack.length || /<[a-z!/?]/i.test(content.replace(tags, ''))) throw new Error('Select complete HTML inline elements before formatting this block.');
}

function htmlContext(text, position) {
  const stack = [];
  for (const match of text.slice(0, position).matchAll(tags)) {
    if (!match[1]) continue;
    const name = match[1].toLowerCase();
    if (match[0].startsWith('</')) {
      const index = stack.lastIndexOf(name);
      if (index >= 0) stack.length = index;
    } else if (!voidTags.has(name)) stack.push(name);
  }
  return stack;
}

function blockLine(line, command, format, keepBlank) {
  const indent = line.match(/^[ \t]*/)[0];
  if (keepBlank && !line.trim()) return { prefix: line, body: '', suffix: '', offset: line.length };
  if (format === 'typ') return { prefix: indent + { heading: '= ', 'bullet-list': '- ', 'numbered-list': '+ ' }[command], body: line.slice(indent.length), suffix: '', offset: indent.length };
  // shortcut: HTML blocks support complete paragraph/heading or phrasing lines; multiline containers need syntax-tree editing.
  const paragraph = line.match(/^([ \t]*)<(p|h[1-6])((?:"[^"]*"|'[^']*'|[^'"<>])*)>([\s\S]*)<\/\2>([ \t]*)$/i);
  htmlPhrasing(paragraph ? paragraph[4] : line);
  if (command === 'heading' && paragraph) {
    const [, whitespace, tag, attributes, body, trailing] = paragraph;
    return { prefix: `${whitespace}<h2${attributes}>`, body, suffix: `</h2>${trailing}`, offset: whitespace.length + tag.length + attributes.length + 2 };
  }
  const tag = command === 'heading' ? 'h2' : 'li';
  return { prefix: `${indent}${command === 'heading' ? '' : '  '}<${tag}>`, body: line.slice(indent.length), suffix: `</${tag}>`, offset: indent.length };
}

// UTF-16 positions match CodeMirror; callers dispatch this one transaction through the ordinary local editor.
export function sourceFormat(text, range, command, format) {
  if (typeof text !== 'string') throw new TypeError('Supply manuscript source text.');
  if (!['typ', 'html', 'htm'].includes(format)) throw new Error('Source formatting supports Typst and HTML files only.');
  let { from, to } = range || {};
  const splitBoundary = position => {
    const previous = text.charCodeAt(position - 1), next = text.charCodeAt(position);
    return previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff;
  };
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || from > to || to > text.length || splitBoundary(from) || splitBoundary(to)) throw new RangeError('Choose a valid source selection without splitting a Unicode character or line ending.');
  const kind = format === 'typ' ? 'typ' : 'html';
  const delimiters = Object.hasOwn(inline[kind], command) ? inline[kind][command] : null;
  if (delimiters) {
    const betweenCRLF = position => text[position - 1] === '\r' && text[position] === '\n';
    // Native End may select the CR; keep the complete line ending outside inline delimiters.
    if (from === to && betweenCRLF(from)) from = to = from - 1;
    else {
      if (betweenCRLF(from)) throw new RangeError('Choose inline text without splitting a CRLF line ending.');
      if (betweenCRLF(to)) to -= 1;
    }
    if (kind === 'html') {
      for (const match of text.matchAll(/<!--[\s\S]*?-->|<\/?[a-z][\w:-]*(?:"[^"]*"|'[^']*'|[^'"<>])*>|&(?:#[0-9]+|#x[0-9a-f]+|[a-z][\w]+);/gi)) {
        const end = match.index + match[0].length;
        if ((from > match.index && from < end) || (to > match.index && to < end)) throw new RangeError('Select HTML text without splitting tags, comments or character entities.');
      }
      if (htmlContext(text, from).some(name => ['head', 'title', 'script', 'style'].includes(name))) throw new Error('Format HTML manuscript text, not document metadata, scripts or styles.');
      htmlPhrasing(text.slice(from, to));
    }
    const [prefix, suffix] = delimiters;
    return { changes: { from, to, insert: prefix + text.slice(from, to) + suffix }, selection: { anchor: from + prefix.length, head: to + prefix.length } };
  }
  if (!blocks.has(command)) throw new Error('Choose bold, italic, heading, bullet-list or numbered-list formatting.');
  const start = from === 0 ? 0 : text.lastIndexOf('\n', from - 1) + 1;
  if (kind === 'html' && htmlContext(text, start).some(name => ['head', 'title', 'script', 'style', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'em', 'span', 'a', 'code'].includes(name))) throw new Error('Select the complete HTML paragraph or heading lines before block formatting.');
  const selectedEnd = to > from && text[to - 1] === '\n' ? to - 1 : to;
  let end = text.indexOf('\n', selectedEnd);
  if (end < 0) end = text.length;
  if (end > start && text[end - 1] === '\r') end -= 1;
  const parts = text.slice(start, end).split(/(\r\n|\n)/);
  const newline = parts.find(part => part === '\r\n' || part === '\n') || (text.includes('\r\n') ? '\r\n' : '\n');
  const list = kind === 'html' && command !== 'heading';
  const indent = parts[0].match(/^[ \t]*/)[0];
  const listTag = command === 'bullet-list' ? 'ul' : 'ol';
  let insert = list ? `${indent}<${listTag}>${newline}` : '';
  let oldStart = start;
  const positions = [];
  for (let index = 0; index < parts.length; index += 2) {
    const line = parts[index];
    const formatted = blockLine(line, command, kind, parts.length > 1);
    positions.push({ oldStart, length: line.length, bodyStart: oldStart + formatted.offset, newStart: start + insert.length + formatted.prefix.length, bodyLength: formatted.body.length });
    insert += formatted.prefix + formatted.body + formatted.suffix + (parts[index + 1] || '');
    oldStart += line.length + (parts[index + 1]?.length || 0);
  }
  if (list) insert += `${newline}${indent}</${listTag}>`;
  const map = position => {
    const line = positions.find(line => position <= line.oldStart + line.length) || positions.at(-1);
    return line.newStart + clamp(position - line.bodyStart, line.bodyLength);
  };
  return { changes: { from: start, to: end, insert }, selection: { anchor: map(from), head: map(to) } };
}
