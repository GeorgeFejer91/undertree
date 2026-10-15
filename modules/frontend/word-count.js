import { parse } from 'parse5';

export const MAX_WORD_COUNT_BYTES = 2 * 1024 * 1024;
export const MAX_WORD_COUNT_RANGES = 1000;
const encoder = new TextEncoder();
const excluded = new Set(['head', 'script', 'style', 'template', 'pre', 'code', 'textarea', 'math', 'svg']);
const blocks = new Set(['address', 'article', 'aside', 'blockquote', 'body', 'caption', 'dd', 'details', 'dialog', 'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'li', 'main', 'nav', 'ol', 'p', 'section', 'summary', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul', 'br']);

function boundedText(source) {
  if (typeof source !== 'string' || encoder.encode(source).byteLength > MAX_WORD_COUNT_BYTES) throw new RangeError('Word count supports at most 2 MiB of UTF-8 text.');
  return source;
}

export function htmlLiteralText(source) {
  boundedText(source);
  // In-memory AST only: no DOM insertion, execution, URL resolution or CSS evaluation.
  const document = parse(source);
  const html = document.childNodes.find(node => node.tagName === 'html');
  const body = html?.childNodes.find(node => node.tagName === 'body');
  const parts = [];
  let bytes = 0;
  const append = text => {
    bytes += encoder.encode(text).byteLength;
    if (bytes > MAX_WORD_COUNT_BYTES) throw new RangeError('The literal-text estimate exceeds the 2 MiB limit.');
    parts.push(text);
  };
  const stack = body ? [{ node: body, leaving: false }] : [];
  while (stack.length) {
    const { node, leaving } = stack.pop();
    if (leaving) { append('\n'); continue; }
    if (node.nodeName === '#text') { append(node.value); continue; }
    if (excluded.has(node.tagName)) { append('\n'); continue; }
    if (blocks.has(node.tagName)) { append('\n'); stack.push({ node, leaving: true }); }
    const children = node.childNodes || [];
    for (let index = children.length - 1; index >= 0; index--) stack.push({ node: children[index], leaving: false });
  }
  return parts.join('');
}

function selectedRanges(source, ranges) {
  if (!Array.isArray(ranges)) return { selectionReason: 'The source selection is invalid.' };
  if (ranges.length > MAX_WORD_COUNT_RANGES) return { selectionReason: 'Source selection count supports at most 1,000 ranges.' };
  const splitsSurrogate = position => position > 0 && position < source.length && /[\uD800-\uDBFF]/.test(source[position - 1]) && /[\uDC00-\uDFFF]/.test(source[position]);
  let previousTo = 0;
  const selected = [];
  for (const range of ranges) {
    if (!range || !Number.isSafeInteger(range.from) || !Number.isSafeInteger(range.to) || range.from < previousTo || range.from > range.to || range.to > source.length || splitsSurrogate(range.from) || splitsSurrogate(range.to)) return { selectionReason: 'Choose valid disjoint source ranges without splitting a Unicode character.' };
    previousTo = range.to;
    if (range.to > range.from) selected.push(range);
  }
  return { selected };
}

export function countWords({ source, ranges = [], literalText, locale = 'en' }, Segmenter = Intl.Segmenter) {
  boundedText(source);
  if (typeof Segmenter !== 'function') throw new Error('Unicode word segmentation is unavailable in this WebView.');
  let segmenter;
  try { segmenter = new Segmenter(locale, { granularity: 'word' }); }
  catch { segmenter = new Segmenter(undefined, { granularity: 'word' }); }
  const count = text => {
    let words = 0;
    for (const segment of segmenter.segment(text)) if (segment.isWordLike) words += 1;
    return words;
  };
  const { selected, selectionReason } = selectedRanges(source, ranges);
  if (literalText !== undefined) boundedText(literalText);
  return {
    locale: segmenter.resolvedOptions().locale, sourceWords: count(source),
    selectionWords: selected?.length ? selected.reduce((total, range) => total + count(source.slice(range.from, range.to)), 0) : null,
    selectionRanges: selected?.length || 0, selectionReason: selectionReason || null,
    proseWords: literalText === undefined ? null : count(literalText),
  };
}

export function analyzeWordCount({ requestId, source, format, ranges, locale, literalText, proseReason }) {
  boundedText(source);
  if (format === 'html') {
    try { literalText = htmlLiteralText(source); }
    catch (error) { literalText = undefined; proseReason = error.message; }
  }
  else if (format !== 'typ') throw new Error('Word count supports Typst and HTML files.');
  if (literalText !== undefined) {
    try { boundedText(literalText); }
    catch { literalText = undefined; proseReason = 'The literal-text estimate exceeds the 2 MiB limit.'; }
  }
  return { requestId, ...countWords({ source, ranges, locale, literalText }), proseReason: proseReason || null, method: format === 'html' ? 'html-literal-v1' : 'typst-literal-v1' };
}
