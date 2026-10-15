import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFragment } from 'parse5';
import { EditorState } from '@codemirror/state';
import { history, undo, redo } from '@codemirror/commands';
import { sourceFormat } from '../modules/frontend/source-format.js';

function apply(text, spec) {
  assert.ok(spec.changes && !Array.isArray(spec.changes), 'one source replacement');
  return text.slice(0, spec.changes.from) + spec.changes.insert + text.slice(spec.changes.to);
}
const textContent = node => node.nodeName === '#text' ? node.value : (node.childNodes || []).map(textContent).join('');

test('inline formatting preserves Unicode source and selects the original wording', () => {
  const selected = '😀 cafe\u0301';
  const text = `Before ${selected} after`;
  const from = 'Before '.length, to = from + selected.length;
  const bold = sourceFormat(text, { from, to }, 'bold', 'typ');
  const result = apply(text, bold);
  assert.equal(result, `Before *${selected}* after`);
  assert.equal(result.slice(bold.selection.anchor, bold.selection.head), selected);
  const html = '<p>😀 &amp; <em>scientific wording</em></p>';
  const start = html.indexOf('😀');
  const formatted = sourceFormat(html, { from: start, to: start + 2 }, 'bold', 'html');
  assert.equal(apply(html, formatted), '<p><strong>😀</strong> &amp; <em>scientific wording</em></p>');
  assert.equal(textContent(parseFragment(apply(html, formatted))), textContent(parseFragment(html)));
});

test('empty inline selections put the caret inside Typst and HTML delimiters', () => {
  const typst = sourceFormat('word', { from: 2, to: 2 }, 'italic', 'typ');
  assert.equal(apply('word', typst), 'wo__rd');
  assert.deepEqual(typst.selection, { anchor: 3, head: 3 });
  const html = sourceFormat('<p>Text</p>', { from: 7, to: 7 }, 'italic', 'htm');
  assert.equal(apply('<p>Text</p>', html), '<p>Text<em></em></p>');
  assert.deepEqual(html.selection, { anchor: 11, head: 11 });
});

for (const [format, prefix, suffix] of [['typ', '*', '*'], ['html', '<strong>', '</strong>']]) {
  test(`${format} whole-line and empty End selections leave the CRLF outside inline formatting`, () => {
    const text = 'Before\r\nTitle 😀\r\nAfter';
    const from = text.indexOf('Title'), to = text.indexOf('\nAfter');
    const spec = sourceFormat(text, { from, to }, 'bold', format);
    const formatted = apply(text, spec);
    assert.equal(formatted, `Before\r\n${prefix}Title 😀${suffix}\r\nAfter`);
    assert.equal(spec.changes.to, to - 1, 'selected CR remains outside the replacement');
    assert.equal(formatted.slice(spec.selection.anchor, spec.selection.head), 'Title 😀');
    const empty = sourceFormat(text, { from: to, to }, 'bold', format);
    assert.equal(apply(text, empty), `Before\r\nTitle 😀${prefix}${suffix}\r\nAfter`);
    assert.deepEqual(empty.changes, { from: to - 1, to: to - 1, insert: prefix + suffix });
    assert.deepEqual(empty.selection, { anchor: to - 1 + prefix.length, head: to - 1 + prefix.length });
    assert.throws(() => sourceFormat(text, { from: to, to: text.length }, 'bold', format), /line ending/);
  });
}

test('a Typst heading affects only the current full line and preserves caret position', () => {
  const text = 'Before\n  Title 😀\nAfter';
  const caret = text.indexOf('Title') + 3;
  const spec = sourceFormat(text, { from: caret, to: caret }, 'heading', 'typ');
  assert.equal(apply(text, spec), 'Before\n  = Title 😀\nAfter');
  assert.equal(text.slice(0, spec.changes.from), 'Before\n');
  assert.equal(text.slice(spec.changes.to), '\nAfter');
  assert.deepEqual(spec.selection, { anchor: caret + 2, head: caret + 2 });
});

for (const [command, marker] of [['bullet-list', '-'], ['numbered-list', '+']]) {
  test(`${command} preserves CRLF, indentation and the next unselected line`, () => {
    const text = 'Before\r\n  first\r\n  second\r\nThird\r\nAfter';
    const from = text.indexOf('first') + 2, to = text.indexOf('Third');
    const spec = sourceFormat(text, { from, to }, command, 'typ');
    const result = apply(text, spec);
    assert.equal(result, `Before\r\n  ${marker} first\r\n  ${marker} second\r\nThird\r\nAfter`);
    assert.equal(result[spec.selection.anchor], text[from]);
    assert.equal(result[spec.selection.head - 1], 'd');
    assert.equal(text.slice(spec.changes.to), '\r\nThird\r\nAfter');
    assert.ok(!result.replaceAll('\r\n', '').includes('\n'), 'no lone LF introduced');
  });
}

for (const [command, wrapper] of [['bullet-list', 'ul'], ['numbered-list', 'ol']]) {
  test(`HTML ${command} emits a valid ${wrapper}/li structure and retains inline content`, () => {
    const text = 'Before\n  one &amp; two\n  <p>😀 second</p>\nAfter';
    const from = text.indexOf('one'), to = text.indexOf('\nAfter');
    const spec = sourceFormat(text, { from, to }, command, 'html');
    assert.equal(apply(text, spec), `Before\n  <${wrapper}>\n    <li>one &amp; two</li>\n    <li><p>😀 second</p></li>\n  </${wrapper}>\nAfter`);
    const parsed = parseFragment(spec.changes.insert);
    const list = parsed.childNodes.find(node => node.tagName === wrapper);
    assert.ok(list, 'outer list stays an actual list element');
    const items = list.childNodes.filter(node => node.tagName === 'li');
    assert.equal(items.length, 2);
    assert.equal(textContent(items[0]), 'one & two');
    assert.equal(textContent(items[1]), '😀 second');
    assert.equal(text.slice(0, spec.changes.from), 'Before\n');
    assert.equal(text.slice(spec.changes.to), '\nAfter');
  });
}

test('HTML heading converts a paragraph wrapper while preserving attributes and inline prose', () => {
  const line = '  <p title="score > threshold" class=\'result\'>Text <em>😀</em></p>  ';
  const text = `Before\n${line}\nAfter`;
  const caret = text.indexOf('Text') + 2;
  const spec = sourceFormat(text, { from: caret, to: caret }, 'heading', 'htm');
  assert.equal(apply(text, spec), `Before\n${line.replace('<p ', '<h2 ').replace('</p>', '</h2>')}\nAfter`);
  const heading = parseFragment(spec.changes.insert).childNodes.find(node => node.tagName === 'h2');
  assert.equal(textContent(heading), 'Text 😀');
  assert.equal(heading.attrs.find(attribute => attribute.name === 'title').value, 'score > threshold');
  assert.deepEqual(spec.selection, { anchor: caret + 1, head: caret + 1 });
});

test('empty block selections create a writable placeholder and selected blank lines retain their whitespace', () => {
  const typst = sourceFormat('\nAfter', { from: 0, to: 0 }, 'numbered-list', 'typ');
  assert.equal(apply('\nAfter', typst), '+ \nAfter');
  assert.deepEqual(typst.selection, { anchor: 2, head: 2 });
  const html = sourceFormat('', { from: 0, to: 0 }, 'bullet-list', 'html');
  assert.equal(html.changes.insert, '<ul>\n  <li></li>\n</ul>');
  assert.deepEqual(html.selection, { anchor: 11, head: 11 });
  const text = 'one\n  \u00a0\u2003\ntwo';
  assert.equal(apply(text, sourceFormat(text, { from: 0, to: text.length }, 'heading', 'typ')), '= one\n  \u00a0\u2003\n= two');
});

test('unsupported commands/formats, invalid Unicode boundaries and incomplete block fragments reject clearly', () => {
  for (const command of ['underline', 'constructor', '__proto__']) assert.throws(() => sourceFormat('text', { from: 0, to: 4 }, command, 'typ'), /Choose bold/);
  assert.throws(() => sourceFormat('text', { from: 0, to: 4 }, 'bold', 'tex'), /Typst and HTML/);
  for (const range of [{ from: -1, to: 0 }, { from: 1, to: 0 }, { from: 0, to: 20 }, { from: 0.5, to: 2 }, { from: 1, to: 2 }, { from: 0, to: 1 }]) assert.throws(() => sourceFormat('😀', range, 'bold', 'typ'), RangeError);
  assert.throws(() => sourceFormat('x\r\ny', { from: 2, to: 3 }, 'bold', 'html'), /line ending/);
  for (const text of ['<p>\nText\n</p>', '<body>', '<strong>unfinished', '<strong/>']) assert.throws(() => sourceFormat(text, { from: 0, to: text.length }, 'heading', 'html'), /complete|partial/);
});

test('block formatting accepts CodeMirror CRLF line-end carets and preserves every CR', () => {
  const text = 'Before\r\nTitle\r\nAfter';
  const caret = text.indexOf('\nAfter');
  const spec = sourceFormat(text, { from: caret, to: caret }, 'heading', 'typ');
  assert.equal(apply(text, spec), 'Before\r\n= Title\r\nAfter');
  assert.equal(apply(text, spec).slice(spec.selection.anchor), '\r\nAfter');
});

test('HTML formatting rejects split syntax and block insertion inside a multiline paragraph', () => {
  const entity = '<p>&amp;</p>';
  assert.throws(() => sourceFormat(entity, { from: 4, to: 7 }, 'bold', 'html'), /character entities/);
  const attribute = '<p title="hello">Text</p>';
  assert.throws(() => sourceFormat(attribute, { from: 10, to: 15 }, 'italic', 'html'), /splitting tags/);
  const script = '<script>Text</script>';
  assert.throws(() => sourceFormat(script, { from: 8, to: 12 }, 'bold', 'html'), /scripts or styles/);
  const paragraph = '<p>\nText\n</p>';
  const cursor = paragraph.indexOf('Text') + 1;
  assert.throws(() => sourceFormat(paragraph, { from: cursor, to: cursor }, 'heading', 'html'), /complete HTML paragraph/);
  const formatted = sourceFormat(entity, { from: 3, to: 8 }, 'bold', 'html');
  assert.equal(apply(entity, formatted), '<p><strong>&amp;</strong></p>');
  assert.equal(textContent(parseFragment(apply(entity, formatted))), '&');
});

test('formatting is one normal CodeMirror history transaction with one-step undo and redo', () => {
  const text = 'Before\none\ntwo\nAfter';
  const from = text.indexOf('one'), to = text.indexOf('\nAfter');
  let state = EditorState.create({ doc: text, selection: { anchor: from, head: to }, extensions: [history()] });
  const spec = sourceFormat(text, { from, to }, 'bullet-list', 'typ');
  state = state.update({ ...spec, userEvent: 'input.format' }).state;
  const formatted = state.doc.toString();
  assert.equal(formatted, 'Before\n- one\n- two\nAfter');
  const target = { get state() { return state; }, dispatch(transaction) { state = transaction.state; } };
  assert.equal(undo(target), true);
  assert.equal(state.doc.toString(), text);
  assert.equal(state.selection.main.from, from);
  assert.equal(state.selection.main.to, to);
  assert.equal(undo(target), false, 'no second formatting undo entry');
  assert.equal(redo(target), true);
  assert.equal(state.doc.toString(), formatted);
});

for (const format of ['typ', 'html']) {
  for (const command of ['bold', 'heading']) {
    test(`${format} ${command} remains separate from adjacent typing through undo and redo`, context => {
      context.mock.method(Date, 'now', () => 1_700_000_000_000);
      const original = 'Before\r\nWord 😀\r\nAfter';
      const from = original.indexOf('Word');
      let state = EditorState.create({ doc: original, selection: { anchor: from, head: from + 'Word 😀'.length }, extensions: [history(), EditorState.lineSeparator.of('\n')] });
      const target = { get state() { return state; }, dispatch(transaction) { state = transaction.state; } };
      const snapshot = () => ({ text: state.doc.toString(), selection: { anchor: state.selection.main.anchor, head: state.selection.main.head } });
      const initial = snapshot();
      state = state.update({ changes: { from, to: state.selection.main.to, insert: 'Typed 😀' }, selection: { anchor: from, head: from + 'Typed 😀'.length }, userEvent: 'input.type' }).state;
      const typedBefore = snapshot();
      const spec = sourceFormat(state.doc.toString(), state.selection.main, command, format);
      state = state.update({ ...spec, userEvent: 'input.format' }).state;
      const formatted = snapshot();
      assert.notEqual(formatted.text, typedBefore.text);
      const nextFrom = state.selection.main.from;
      state = state.update({ changes: { from: nextFrom, to: state.selection.main.to, insert: 'Next 😀' }, selection: { anchor: nextFrom + 'Next 😀'.length }, userEvent: 'input.type' }).state;
      const typedAfter = snapshot();
      for (const expected of [formatted, typedBefore, initial]) {
        assert.equal(undo(target), true);
        assert.deepEqual(snapshot(), expected, 'one undo reverses only its own typing or formatting action');
      }
      assert.equal(undo(target), false);
      for (const expected of [typedBefore, formatted, typedAfter]) {
        assert.equal(redo(target), true);
        assert.equal(state.doc.toString(), expected.text, 'redo restores each typing or formatting action independently');
        assert.equal(state.doc.toString().split('\r\n').length, 3);
        assert.ok(!state.doc.toString().replaceAll('\r\n', '').match(/[\r\n]/), 'literal CRLF bytes remain intact');
      }
      assert.equal(state.sliceDoc(state.selection.main.from, state.selection.main.to), 'Next 😀', 'ordinary CodeMirror redo reselects the restored wording without splitting Unicode');
      assert.equal(redo(target), false);
    });
  }
}

test('literal-CR CodeMirror selections format and undo without splitting or normalizing CRLF', () => {
  const text = 'Before\r\nTitle 😀\r\nAfter';
  const end = text.indexOf('\nAfter');
  for (const format of ['typ', 'html']) {
    for (const from of [text.indexOf('Title'), end]) {
      let state = EditorState.create({ doc: text, selection: { anchor: from, head: end }, extensions: [history(), EditorState.lineSeparator.of('\n')] });
      assert.equal(state.doc.toString(), text, 'the editor retains literal CR positions');
      assert.equal(state.selection.main.to, end);
      const spec = sourceFormat(state.doc.toString(), state.selection.main, 'italic', format);
      state = state.update({ ...spec, userEvent: 'input.format' }).state;
      const formatted = apply(text, spec);
      assert.equal(state.doc.toString(), formatted);
      assert.equal(formatted.split('\r\n').length, text.split('\r\n').length);
      assert.ok(!formatted.replaceAll('\r\n', '').includes('\r'), 'no split CR remains');
      assert.ok(!formatted.replaceAll('\r\n', '').includes('\n'), 'no normalized LF remains');
      assert.deepEqual({ anchor: state.selection.main.anchor, head: state.selection.main.head }, spec.selection);
      const target = { get state() { return state; }, dispatch(transaction) { state = transaction.state; } };
      assert.equal(undo(target), true);
      assert.equal(state.doc.toString(), text);
      assert.equal(state.selection.main.from, from);
      assert.equal(state.selection.main.to, end, 'undo restores the original native End selection');
      assert.equal(undo(target), false, 'one formatting history entry');
      assert.equal(redo(target), true);
      assert.equal(state.doc.toString(), formatted);
    }
  }
});
