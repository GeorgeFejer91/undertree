import assert from 'node:assert/strict';
import test from 'node:test';
import { EditorState, Transaction } from '@codemirror/state';
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import { history, undo, redo } from '@codemirror/commands';
import { typstLanguage } from '../modules/frontend/typst-language.js';

function editorState(source, selection) {
  return EditorState.create({ doc: source, selection, extensions: [EditorState.lineSeparator.of('\n'), typstLanguage, history()] });
}
function tokens(state) {
  const tree = ensureSyntaxTree(state, state.doc.length, 1000);
  assert.ok(tree, 'actual CodeMirror stream parsing completes within its bounded work slice');
  const result = [];
  tree.iterate({ enter(node) { if (node.name !== 'Document') result.push({ style: node.name, from: node.from, to: node.to, text: state.sliceDoc(node.from, node.to) }); } });
  assert.equal(state.doc.toString(), state.sliceDoc(), 'token inspection leaves the source unchanged');
  return result;
}
function styled(state, text, style, occurrence = 0) {
  const source = state.doc.toString(); let from = -1;
  for (let index = 0; index <= occurrence; index += 1) from = source.indexOf(text, from + 1);
  assert.ok(from >= 0, `fixture contains ${text}`);
  assert.ok(tokens(state).some(token => token.from <= from && token.to >= from + text.length && token.style.split('_').includes(style)), `${JSON.stringify(text)} receives ${style}`);
}
function plain(state, text) {
  const from = state.doc.toString().indexOf(text);
  assert.ok(from >= 0, `fixture contains ${text}`);
  assert.deepEqual(tokens(state).filter(token => token.from < from + text.length && token.to > from), [], `${JSON.stringify(text)} remains ordinary prose`);
}

test('headings, strong/emphasis and every common list marker follow markup syntax', () => {
  const state = editorState('= Heading\n== Second level\nPlain *strong* and _emphasis_.\n- Item\n+ Item\n2. Item\n/ Term: description\nA=word and snake_case stay ordinary.');
  styled(state, '= Heading', 'heading'); styled(state, '== Second level', 'heading');
  styled(state, '*strong*', 'strong'); styled(state, '_emphasis_', 'emphasis');
  for (const marker of ['- ', '+ ', '2. ', '/ ']) styled(state, marker.trimEnd(), 'list');
  plain(state, 'A=word'); plain(state, 'snake_case');
});

test('emphasis survives a soft linebreak and stops at LF or literal-CRLF paragraph breaks', () => {
  for (const newline of ['\n', '\r\n']) {
    const source = `*first${newline}second*${newline}${newline}_unfinished${newline}${newline}ordinary paragraph`;
    const state = editorState(source);
    styled(state, 'second', 'strong'); styled(state, '_unfinished', 'emphasis'); plain(state, 'ordinary paragraph');
    assert.equal(state.doc.toString(), source);
  }
  const nested = editorState('*before [inside* plain] ordinary');
  styled(nested, 'inside', 'strong'); plain(nested, 'ordinary');
});

test('escaped markup, labels/references, links and smart quotes do not enter code', () => {
  const state = editorState('\\#name \\*literal\\* \\u{1f600}\n<intro> @intro\nhttps://typst.app/docs/ ordinary prose\n"smart quotes" plain words');
  styled(state, '\\#', 'escape'); styled(state, '\\u{1f600}', 'escape');
  styled(state, '<intro>', 'labelName'); styled(state, '@intro', 'labelName'); styled(state, 'https://typst.app/docs/', 'link');
  plain(state, 'name'); plain(state, 'literal'); plain(state, 'plain words');
});

test('a one-sided escaped star still permits the remaining star to start strong markup', () => {
  const state = editorState('\\*literal* strong tail\n\nordinary paragraph');
  styled(state, '\\*', 'escape'); plain(state, 'literal');
  styled(state, 'strong tail', 'strong'); plain(state, 'ordinary paragraph');
});

test('atomic code, calls, field chains and content blocks return to following prose', () => {
  const state = editorState('#value ordinary1\n#calc.pi ordinary2\n#text(12pt)[Body #value inside] ordinary3\n#(1 + 2) ordinary4\n#{ 1 + 2 } ordinary5\n#"hello" ordinary6\n#none ordinary7');
  styled(state, 'value', 'variableName'); styled(state, 'calc', 'variableName'); styled(state, 'pi', 'variableName');
  styled(state, '12pt', 'number'); styled(state, '"hello"', 'string'); styled(state, 'none', 'atom');
  plain(state, 'Body'); plain(state, 'inside');
  for (let index = 1; index <= 7; index += 1) plain(state, `ordinary${index}`);
});

test('statements stop at semicolons/newlines and explicit nested expressions can span lines', () => {
  const state = editorState('#let x = 2; following1\n#set text(\n  size: 12pt,\n  fill: rgb("red"),\n)\nfollowing2\n#show heading: it => emph(it.body)\nfollowing3\n#import "helper.typ": helper\nfollowing4');
  for (const keyword of ['let', 'set', 'show', 'import']) styled(state, keyword, 'keyword');
  styled(state, 'size', 'variableName'); styled(state, '12pt', 'number'); styled(state, '"helper.typ"', 'string');
  for (let index = 1; index <= 4; index += 1) plain(state, `following${index}`);
});

test('conditionals, loops and context expressions exit after their bodies', () => {
  const state = editorState('#if true [Yes] else [No] following1\n#if true { [Yes] } else if false { [No] } following2\n#for x in (1, 2) [#x] following3\n#while false { break } following4\n#context text.lang following5');
  styled(state, 'if', 'keyword'); styled(state, 'else', 'keyword'); styled(state, 'true', 'bool'); styled(state, 'for', 'keyword'); styled(state, 'break', 'keyword'); styled(state, 'context', 'keyword');
  plain(state, 'Yes'); plain(state, 'No');
  for (let index = 1; index <= 5; index += 1) plain(state, `following${index}`);
});

test('code identifiers preserve Unicode XID, kebab case and fields named like keywords', () => {
  const state = editorState('#let _schön = "😊"\n#let 始料不及 = 1\n#let π = calc.pi\n#kebab-case prose1\n#data.if prose2\n#data.none prose3');
  for (const name of ['_schön', '始料不及', 'π', 'kebab-case', 'if', 'none']) styled(state, name, 'variableName');
  styled(state, '"😊"', 'string');
  for (const value of ['prose1', 'prose2', 'prose3']) plain(state, value);
});

test('code numbers include bases, exponent notation and Typst numeric units', () => {
  const state = editorState('#(10, 0xFF, 0b101, 0o17, 3.14, .5, 1e5, 5.0e-3in, 1em, 90deg, 2fr, 50%) ordinary');
  for (const value of ['10', '0xFF', '0b101', '0o17', '3.14', '.5', '1e5', '5.0e-3in', '1em', '90deg', '2fr', '50%']) styled(state, value, 'number');
  plain(state, 'ordinary');
});

test('strings ignore escaped quotes and comment/delimiter syntax, including multiline strings', () => {
  const state = editorState('#"quote \\" and /* # $ ` ) ] }" ordinary1\n#"line1\n\nline2" ordinary2');
  styled(state, '/* # $ ` ) ] }', 'string'); styled(state, 'line2"', 'string');
  plain(state, 'ordinary1'); plain(state, 'ordinary2');
});

test('nested block and line comments work across markup, code and math', () => {
  const state = editorState('/* outer\n /* nested */ still outer\n*/ ordinary1\n// #fake(123)\nordinary2\n#(1 /* nested /* two */ one */ + 2) ordinary3\n$x /* comment $ # */ + 2$ ordinary4');
  for (const value of ['outer', 'nested', 'still outer', '// #fake(123)', 'two', 'comment $ #']) styled(state, value, 'comment');
  for (let index = 1; index <= 4; index += 1) plain(state, `ordinary${index}`);
});

test('math supports multiline equations, strings, escapes and embedded code without leaking', () => {
  const state = editorState('$alpha + x_1^2 + \\$ + "text $ #" + #calc.pi$ ordinary1\n$\n sum_(i=1)^n i\n$ ordinary2\n$and + true$ ordinary3');
  styled(state, 'alpha', 'variableName'); styled(state, '1', 'number'); styled(state, '\\$', 'escape'); styled(state, '"text $ #"', 'string'); styled(state, 'calc', 'variableName'); styled(state, 'and', 'variableName'); styled(state, 'true', 'variableName');
  for (let index = 1; index <= 3; index += 1) plain(state, `ordinary${index}`);
});

test('raw spans/fences ignore markup, code and comments and resume after matching delimiters', () => {
  const state = editorState('`#code /* not comment */ $x$` ordinary1\n```rust\n// raw #code\n\n"raw" *text*\n``` ordinary2\n`` ordinary3\n````tag `three ``` backticks` ```` ordinary4\n`inline\nraw` ordinary5');
  for (const value of ['#code /* not comment */ $x$', '// raw #code', '"raw" *text*', 'three ``` backticks', 'inline', 'raw`']) styled(state, value, 'monospace');
  for (let index = 1; index <= 5; index += 1) plain(state, `ordinary${index}`);
});

test('malformed bare hashes and mismatched delimiters recover without coloring later prose as code', () => {
  const state = editorState('# ordinary1\n#// comment\nordinary2\n#? ordinary3\n#let x = [#f(1] ordinary4\n#\nordinary5\n#text()[#f(1] ordinary6');
  for (let index = 1; index <= 6; index += 1) plain(state, `ordinary${index}`);
});

test('completed let groups recover missing separators as markup and preserve valid code continuations', () => {
  const state = editorState('#let x = [#f(1] true *tail1*\n#let y = [content] false *tail2*\n#let z = (1, 2) true *tail3*\n#let f(x) = [Body]; ordinary1\n#let joined = [one] + [two]; ordinary2\n#let first = (1, 2).at(0); ordinary3');
  plain(state, 'true'); plain(state, 'false');
  for (let index = 1; index <= 3; index += 1) { styled(state, `*tail${index}*`, 'strong'); plain(state, `ordinary${index}`); }
  for (const value of ['f', 'x', 'joined', 'first', 'at']) styled(state, value, 'variableName');
  styled(state, '+', 'operator'); styled(state, '0', 'number');
  plain(state, 'Body'); plain(state, 'one'); plain(state, 'two');
  const logical = editorState('#let both = (true) and false; ordinary');
  styled(logical, 'true', 'bool'); styled(logical, 'and', 'keyword'); styled(logical, 'false', 'bool'); plain(logical, 'ordinary');
  const conditional = editorState('#let choice = if true [Yes] else if false [No] else [Last]; ordinary');
  styled(conditional, 'if', 'keyword'); styled(conditional, 'else', 'keyword'); styled(conditional, 'true', 'bool'); styled(conditional, 'false', 'bool');
  for (const value of ['Yes', 'No', 'Last', 'ordinary']) plain(conditional, value);
  const membership = editorState('#let absent = (1) not in (2, 3); ordinary');
  styled(membership, 'not', 'keyword'); styled(membership, 'in', 'keyword'); styled(membership, '3', 'number'); plain(membership, 'ordinary');
  const commentedMembership = editorState('#let absent = (1) not /* comment */ in (2, 3); ordinary');
  styled(commentedMembership, 'not', 'keyword'); styled(commentedMembership, '/* comment */', 'comment');
  styled(commentedMembership, 'in', 'keyword'); styled(commentedMembership, '3', 'number'); plain(commentedMembership, 'ordinary');
  const braceConditional = editorState('#let choice = if (true) { 1 } else { 2 }; ordinary');
  styled(braceConditional, 'true', 'bool'); styled(braceConditional, 'else', 'keyword');
  styled(braceConditional, '1', 'number'); styled(braceConditional, '2', 'number'); plain(braceConditional, 'ordinary');
  const braceFor = editorState('#let items = for x in (1, 2) { x }; ordinary');
  styled(braceFor, 'for', 'keyword'); styled(braceFor, 'x', 'variableName', 1); plain(braceFor, 'ordinary');
  const braceWhile = editorState('#let result = while (false) { break }; ordinary');
  styled(braceWhile, 'while', 'keyword'); styled(braceWhile, 'false', 'bool'); styled(braceWhile, 'break', 'keyword'); plain(braceWhile, 'ordinary');
});

test('incomplete literal modes retain their state and incremental closures restore prose', () => {
  for (const [open, close, style] of [['/* missing\n', '*/', 'comment'], ['`missing\n', '`', 'monospace'], ['#"missing\n', '"', 'string'], ['$missing\n', '$', 'variableName']]) {
    const before = editorState(open + 'unfinished');
    styled(before, 'unfinished', style);
    const after = before.update({ changes: { from: before.doc.length, insert: `${close} ordinary` } }).state;
    plain(after, 'ordinary'); styled(before, 'unfinished', style);
    assert.equal(after.doc.toString(), open + 'unfinished' + close + ' ordinary');
  }
});

test('deep input uses bounded contexts and recovers after opaque brackets with quoted/comment text', () => {
  const source = '#(' + '('.repeat(150) + '"ignore )" /* ignore ) */ 1' + ')'.repeat(151) + ' ordinary';
  const state = editorState(source);
  assert.ok(tokens(state).some(token => token.style === 'invalid'), 'the documented depth fallback is explicit');
  plain(state, 'ordinary'); assert.equal(state.doc.toString(), source);
});

test('literal CRLF, Unicode selections and normal edit/undo/redo survive syntax parsing', () => {
  const original = '= Manuscript 🧑‍🔬\r\n\r\n#text(12pt)[Café α]\r\nOrdinary prose.\r\n';
  let state = editorState(original, { anchor: original.indexOf('Café'), head: original.indexOf('Café') + 'Café'.length });
  tokens(state); assert.equal(state.doc.toString(), original);
  const selection = state.selection.main;
  state = state.update({ changes: { from: selection.from, to: selection.to, insert: 'Renamed 🧑‍🔬' }, annotations: Transaction.userEvent.of('input') }).state;
  tokens(state); assert.equal(state.doc.toString(), original.replace('Café', 'Renamed 🧑‍🔬'));
  const target = { get state() { return state; }, dispatch(transaction) { state = transaction.state; } };
  assert.equal(undo(target), true); tokens(state); assert.equal(state.doc.toString(), original);
  assert.equal(state.selection.main.from, selection.from); assert.equal(state.selection.main.to, selection.to);
  assert.equal(redo(target), true); tokens(state); assert.equal(state.doc.toString(), original.replace('Café', 'Renamed 🧑‍🔬'));
});

test('editing a mode boundary incrementally changes following tokens and preserves the old tree', () => {
  const original = '// Prefix\n'.repeat(800) + '$alpha$ ordinary\n= Following heading\n';
  const before = editorState(original); plain(before, 'ordinary');
  const oldTree = syntaxTree(before), close = original.lastIndexOf('$');
  const missing = before.update({ changes: { from: close, to: close + 1 } }).state;
  styled(missing, 'ordinary', 'variableName');
  const restored = missing.update({ changes: { from: close, insert: '$' } }).state;
  plain(restored, 'ordinary'); styled(restored, '= Following heading', 'heading');
  assert.equal(syntaxTree(before), oldTree, 'later parsing does not mutate a previously cached editor tree');
  plain(before, 'ordinary'); assert.equal(restored.doc.toString(), original);
});
