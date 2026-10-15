import { StreamLanguage } from '@codemirror/language';

// Highlighting only: Typst remains the syntax/compilation authority.
// Reference: typst.app/docs/reference/syntax and typst-syntax 0.15.1 lexer/parser.
const keywords = new Set('not and or let set show context if else for in while break continue return import include as'.split(' '));
const statements = new Set('let set show return import include'.split(' '));
const bodies = new Set(['if', 'for', 'while']);
const identifier = /^(?:_|\p{XID_Start})(?:[\p{XID_Continue}_-])*/u;
const mathIdentifier = /^\p{XID_Start}(?:(?!_)\p{XID_Continue})*/u;
const number = /^(?:0x[\da-fA-F]+|0b[01]+|0o[0-7]+|(?:\d+(?:\.(?!\.|[_\p{XID_Start}])\d*)?|\.\d+)(?:[eE][+-]?\d+)?)(?:pt|mm|cm|in|deg|rad|em|fr|%)?/u;
const frame = (mode, close = '') => ({ mode, close, embedded: false, fresh: true, first: true, done: false, statement: '', conditional: false, body: false, strong: false, emphasis: false, heading: false });
const top = state => state.frames.at(-1);

function push(state, next) {
  // shortcut: track 64 structural contexts; deeper brackets are opaque until balanced again.
  if (state.frames.length >= 64) { if (next.close) { state.overflow = 1; state.overflowClose = next.close; } return 'invalid'; }
  state.frames.push(next);
  return 'bracket';
}
function complete(state) { if (top(state).embedded) top(state).done = true; }
function close(state) {
  const previous = state.frames.pop(), parent = top(state);
  if (previous.literal) { parent.strong = previous.strong; parent.emphasis = previous.emphasis; }
  if (previous.body && parent.embedded) { parent.done = true; parent.statement = ''; }
  else complete(state);
}
function lineEnd(state) {
  if (state.comment || state.raw || state.string || state.overflow) return;
  while (top(state).embedded) state.frames.pop();
}
function stringToken(stream, state) {
  let escaped = false;
  while (!stream.eol()) {
    const character = stream.next();
    if (character === '"' && !escaped) { state.string = false; complete(state); break; }
    escaped = character === '\\' && !escaped;
  }
  return 'string';
}
function rawToken(stream, state) {
  while (!stream.eol()) {
    if (stream.next() !== '`') continue;
    let count = 1;
    while (count < state.raw && stream.eat('`')) count += 1;
    if (count === state.raw) { state.raw = 0; complete(state); break; }
  }
  return 'monospace';
}
function commentToken(stream, state) {
  while (!stream.eol()) {
    if (stream.match('/*')) state.comment += 1;
    else if (stream.match('*/')) { state.comment -= 1; if (!state.comment) break; }
    else stream.next();
  }
  return 'comment';
}
function markupStyle(current) { return [current.heading && 'heading', current.strong && 'strong', current.emphasis && 'emphasis'].filter(Boolean).join(' ') || null; }
function wordCharacter(value) { return value && /[\p{L}\p{N}]/u.test(value) && !/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(value); }

function readToken(stream, state) {
  if (state.comment) return commentToken(stream, state);
  if (state.raw) return rawToken(stream, state);
  if (state.string) return stringToken(stream, state);
  let current = top(state);
  if (!state.overflow && current.embedded && current.fresh && (stream.match(/^\s/, false) || stream.match('//', false) || stream.match('/*', false))) { state.frames.pop(); current = top(state); }
  if (!state.overflow && current.embedded && current.done && !current.statement) {
    const suffix = stream.match(/^(?:\(|\[|\.(?=[_\p{XID_Start}]))/u, false);
    const alternate = current.conditional && stream.match(/^[ \t]*else\b/, false);
    if (!suffix && !alternate && stream.peek() !== ';') { state.frames.pop(); current = top(state); }
  }
  if (stream.match('//')) { stream.skipToEnd(); return 'comment'; }
  if (stream.match('/*')) { state.comment = 1; return commentToken(stream, state); }
  if (stream.eatSpace()) return current.mode === 'markup' ? markupStyle(current) : null;
  current.fresh = false;
  if (stream.peek() === '`' && current.mode !== 'math') {
    stream.next(); stream.eatWhile('`');
    state.raw = stream.pos - stream.start;
    if (state.raw === 2) { state.raw = 0; complete(state); return 'monospace'; }
    return rawToken(stream, state);
  }
  if (stream.peek() === '"' && (current.mode !== 'markup' || state.overflow)) { stream.next(); state.string = true; return stringToken(stream, state); }
  if (state.overflow) {
    const character = stream.next();
    if (state.overflowClose === '$') { if (character === '$') state.overflow -= 1; }
    else if ('([{'.includes(character)) state.overflow += 1;
    else if (')]}'.includes(character)) state.overflow -= 1;
    if (!state.overflow) complete(state);
    return 'invalid';
  }
  if (current.mode !== 'code' && stream.match(/^\\(?:u\{[\da-fA-F]+\}|[^\r]?)/u)) return 'escape';
  if (stream.peek() === '#' && current.mode !== 'code') {
    stream.next(); const code = frame('code'); code.embedded = true; return push(state, code) === 'invalid' ? 'invalid' : 'keyword';
  }
  if (stream.peek() === '$') {
    stream.next(); if (current.mode === 'math') close(state); else if (push(state, frame('math', '$')) === 'invalid') return 'invalid';
    return 'operator';
  }
  if (current.mode !== 'math' && stream.match(/^<[^<>\s]+>/)) { complete(state); return 'labelName'; }
  if (current.mode === 'markup') {
    if (stream.match(/^https?:\/\/[^\s<>]+/)) return 'link';
    if (state.lineStart && stream.match(/^=+(?=\s|$)/)) { current.heading = true; return 'heading'; }
    if (state.lineStart && stream.match(/^(?:[-+/]|\d+\.)(?=\s|$)/)) return 'list';
    if (stream.match(/^@[\p{XID_Continue}_.:-]+/u)) return 'labelName';
    const character = stream.peek();
    if (['*', '_'].includes(character)) {
      const before = [...stream.string.slice(Math.max(0, stream.pos - 2), stream.pos)].at(-1), after = String.fromCodePoint(stream.string.codePointAt(stream.pos + 1) || 0);
      stream.next();
      if (!wordCharacter(before) || !wordCharacter(after)) {
        const key = character === '*' ? 'strong' : 'emphasis'; current[key] = !current[key];
        return key;
      }
      return markupStyle(current);
    }
    if (character === '[') {
      stream.next(); const nested = frame('markup', ']'); nested.literal = true; nested.strong = current.strong; nested.emphasis = current.emphasis;
      return push(state, nested) === 'invalid' ? 'invalid' : markupStyle(current);
    }
    if (character === ']' && current.close === ']') { stream.next(); close(state); return 'bracket'; }
    if (!stream.match(/^[^\s\[\]*_#`$\\<@/]+/u)) stream.next();
    return markupStyle(current);
  }
  if (stream.match(number)) { current.first = false; current.done = true; return 'number'; }
  const name = stream.match(current.mode === 'math' ? mathIdentifier : identifier);
  if (name) {
    const word = name[0]; const field = stream.string[stream.start - 1] === '.';
    if (current.mode === 'math') return 'variableName';
    if (current.first && !field) {
      if (statements.has(word)) current.statement = 'line';
      if (bodies.has(word)) { current.statement = 'body'; current.conditional = word === 'if'; }
    }
    if (word === 'else' && current.conditional) { current.statement = 'body'; current.done = false; }
    else current.done = word !== 'context';
    if (word !== 'context') current.first = false;
    if (!field && ['none', 'auto'].includes(word)) return 'atom';
    if (!field && ['true', 'false'].includes(word)) return 'bool';
    return !field && keywords.has(word) ? 'keyword' : 'variableName';
  }
  const character = stream.next();
  if (current.mode === 'code' && '([{'.includes(character)) {
    const nested = frame(character === '[' ? 'markup' : 'code', { '(': ')', '[': ']', '{': '}' }[character]);
    nested.body = current.embedded && current.statement === 'body' && character !== '(';
    current.first = false;
    return push(state, nested);
  }
  if (current.mode === 'code' && ')]}'.includes(character)) {
    const match = state.frames.findLastIndex(value => value.close === character);
    if (match > 0) { state.frames.length = match + 1; close(state); return 'bracket'; }
    return 'invalid';
  }
  if (current.embedded && character === ';') { state.frames.pop(); return 'punctuation'; }
  if (character === '.' && !current.first) current.done = false;
  else if (current.embedded && current.first) current.done = true;
  return /[+\-−*/=<>^_&|:!]/u.test(character) ? 'operator' : 'punctuation';
}

export const typstLanguage = StreamLanguage.define({
  name: 'typst',
  startState: () => ({ frames: [frame('markup')], comment: 0, raw: 0, string: false, overflow: 0, overflowClose: '', lineStart: true }),
  copyState: state => ({ ...state, frames: state.frames.map(value => ({ ...value })) }),
  token(stream, state) {
    if (stream.sol()) { state.lineStart = true; for (const current of state.frames) current.heading = false; }
    const style = readToken(stream, state);
    if (style !== 'comment' && stream.current().trim()) state.lineStart = false;
    if (stream.eol()) lineEnd(state);
    if (stream.eol() && !stream.string.trim() && !state.comment && !state.raw && !state.string) for (const current of state.frames) { current.strong = false; current.emphasis = false; }
    return style;
  },
  blankLine(state) {
    lineEnd(state);
    if (state.comment || state.raw || state.string || state.overflow) return;
    for (const current of state.frames) { current.strong = false; current.emphasis = false; current.heading = false; }
  },
  languageData: { commentTokens: { line: '//', block: { open: '/*', close: '*/' } } },
});
