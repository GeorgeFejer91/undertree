const commands = new Set(['inline-math', 'display-math', 'citation', 'reference', 'link', 'figure', 'table']);

function quoted(value, name) {
  if (typeof value !== 'string' || !value || value.length > 4096 || /[\u0000-\u001f\u007f]/u.test(value)) throw new TypeError(`${name} must be nonempty text without control characters, at most 4096 characters.`);
  for (const character of value) {
    const point = character.codePointAt(0);
    if (point >= 0xd800 && point <= 0xdfff) throw new TypeError(`${name} must not contain an incomplete Unicode character.`);
  }
  return JSON.stringify(value);
}

// shortcut: insertions target markup; use syntax-tree context checks when supporting code/raw regions.
// One ordinary CodeMirror transaction; source outside the selection is never rewritten.
export function typstInsertion(text, range, command, format, options = {}) {
  if (typeof text !== 'string') throw new TypeError('Supply manuscript source text.');
  if (format !== 'typ') throw new Error('These insertion commands support Typst files only.');
  if (!commands.has(command)) throw new Error('Choose inline-math, display-math, citation, reference, link, figure or table.');
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('Supply insertion options as an object.');
  const allowed = command === 'link' ? 'url' : command === 'figure' ? 'path' : ['citation', 'reference'].includes(command) ? 'key' : null;
  if (Object.keys(options).some(key => key !== allowed)) throw new Error('That option does not belong to this insertion command.');
  let { from, to } = range || {};
  const splitUnicode = position => {
    const previous = text.charCodeAt(position - 1), next = text.charCodeAt(position);
    return previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff;
  };
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || from > to || to > text.length || splitUnicode(from) || splitUnicode(to)) throw new RangeError('Choose a valid source selection without splitting a Unicode character.');
  const splitCRLF = position => text[position - 1] === '\r' && text[position] === '\n';
  // Native End includes the literal CR; keep its complete line ending outside the insertion.
  if (from === to && splitCRLF(from)) from = to = from - 1;
  else {
    if (splitCRLF(from)) throw new RangeError('Choose source text without splitting a CRLF line ending.');
    if (splitCRLF(to)) to -= 1;
  }
  let at = to, end = to, insert, selectedFrom, selectedLength;
  if (command === 'inline-math' || command === 'display-math') {
    const body = text.slice(from, to) || 'x^2';
    if (body.includes('$')) throw new Error('Select a math expression without its dollar delimiters.');
    if (command === 'inline-math' && /(^\s|\s$|[\r\n])/u.test(body)) throw new Error('Select an inline expression without outer whitespace or line breaks.');
    const prefix = command === 'inline-math' ? '$' : '$ ';
    insert = prefix + body + (command === 'inline-math' ? '$' : ' $');
    at = from; selectedFrom = prefix.length; selectedLength = body.length;
  } else if (command === 'citation' || command === 'reference') {
    const key = quoted(Object.hasOwn(options, 'key') ? options.key : command === 'citation' ? 'citation-key' : 'label', 'Citation or reference key');
    const prefix = command === 'citation' ? '#cite(label(' : '#ref(label(';
    insert = prefix + key + '))';
    selectedFrom = prefix.length + 1; selectedLength = key.length - 2;
  } else if (command === 'link') {
    const url = Object.hasOwn(options, 'url') ? options.url : 'https://example.org';
    const destination = quoted(url, 'Link destination');
    let parsed;
    try { parsed = new URL(url); } catch { throw new Error('Supply a valid http, https, mailto or tel link.'); }
    if (!['http:', 'https:', 'mailto:', 'tel:'].includes(parsed.protocol)) throw new Error('Supply a valid http, https, mailto or tel link.');
    insert = `#link(${destination})[${text.slice(from, to) || 'Link text'}]`;
    at = from; selectedFrom = '#link('.length + 1; selectedLength = destination.length - 2;
  } else {
    const newline = text.match(/\r\n|\n/)?.[0] || '\n';
    const prefix = at > 0 && text[at - 1] !== '\n' ? newline : '';
    const suffix = at < text.length && text[at] !== '\n' && !(text[at] === '\r' && text[at + 1] === '\n') ? newline : '';
    if (command === 'figure') {
      const path = quoted(Object.hasOwn(options, 'path') ? options.path : 'image.svg', 'Image path');
      insert = `${prefix}#figure(${newline}  image(${path}, width: 80%),${newline}  caption: [Caption],${newline})${suffix}`;
      selectedFrom = prefix.length + '#figure('.length + newline.length + '  image('.length + 1; selectedLength = path.length - 2;
    } else {
      insert = `${prefix}#table(${newline}  columns: 2,${newline}  [Cell], [Cell],${newline}  [Cell], [Cell],${newline})${suffix}`;
      selectedFrom = insert.indexOf('[Cell]') + 1; selectedLength = 'Cell'.length;
    }
  }
  return { changes: { from: at, to: end, insert }, selection: { anchor: at + selectedFrom, head: at + selectedFrom + selectedLength } };
}
