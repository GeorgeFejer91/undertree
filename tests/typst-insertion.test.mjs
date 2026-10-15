import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EditorState } from '@codemirror/state';
import { history, undo, redo } from '@codemirror/commands';
import { typstInsertion } from '../modules/frontend/typst-insertion.js';

const apply = (text, spec) => text.slice(0, spec.changes.from) + spec.changes.insert + text.slice(spec.changes.to);
const selected = (text, spec) => apply(text, spec).slice(spec.selection.anchor, spec.selection.head);
const commands = ['inline-math', 'display-math', 'citation', 'reference', 'link', 'figure', 'table'];

test('math wraps selected source literally and empty commands select a usable expression', () => {
  const text = 'Before e\u0301 + α after', from = 'Before '.length, to = text.indexOf(' after');
  for (const [command, prefix, suffix] of [['inline-math', '$', '$'], ['display-math', '$ ', ' $']]) {
    const spec = typstInsertion(text, { from, to }, command, 'typ');
    assert.equal(apply(text, spec), `Before ${prefix}e\u0301 + α${suffix} after`);
    assert.equal(selected(text, spec), text.slice(from, to), 'no Unicode or whitespace normalization');
    const empty = typstInsertion('', { from: 0, to: 0 }, command, 'typ');
    assert.equal(empty.changes.insert, prefix + 'x^2' + suffix);
    assert.equal(selected('', empty), 'x^2');
  }
  const multiline = 'Before\r\na^2\r\n+ b^2\r\nAfter';
  const spec = typstInsertion(multiline, { from: 8, to: multiline.indexOf('\r\nAfter') }, 'display-math', 'typ');
  assert.equal(selected(multiline, spec), 'a^2\r\n+ b^2');
  assert.ok(!apply(multiline, spec).replaceAll('\r\n', '').includes('\n'));
  for (const body of [' x', 'x ', 'x\ny', '$x$']) assert.throws(() => typstInsertion(body, { from: 0, to: body.length }, 'inline-math', 'typ'), /inline expression|dollar delimiters/);
});

test('links retain selected rich source and safely serialize the editable destination', () => {
  const text = 'Before 😀 _scientific_ [wording] after', from = 7, to = text.indexOf(' after');
  const url = 'https://example.org/"quoted"?key=😀';
  const spec = typstInsertion(text, { from, to }, 'link', 'typ', { url });
  assert.equal(apply(text, spec), `Before #link(${JSON.stringify(url)})[${text.slice(from, to)}] after`);
  assert.equal(selected(text, spec), JSON.stringify(url).slice(1, -1));
  assert.equal(typstInsertion('', { from: 0, to: 0 }, 'link', 'typ').changes.insert, '#link("https://example.org")[Link text]');
});

test('citations and references insert after the selected prose without erasing it', () => {
  const text = 'Before 😀 proof after', from = 7, to = text.indexOf(' after');
  const key = 'DBLP:books/lib/Knuth86a"😀';
  for (const [command, call] of [['citation', 'cite'], ['reference', 'ref']]) {
    const spec = typstInsertion(text, { from, to }, command, 'typ', { key });
    assert.deepEqual({ from: spec.changes.from, to: spec.changes.to }, { from: to, to });
    assert.equal(apply(text, spec), text.slice(0, to) + `#${call}(label(${JSON.stringify(key)}))` + text.slice(to));
    assert.equal(selected(text, spec), JSON.stringify(key).slice(1, -1));
    const placeholder = typstInsertion('', { from: 0, to: 0 }, command, 'typ');
    assert.equal(selected('', placeholder), command === 'citation' ? 'citation-key' : 'label');
  }
});

test('figure and 2×2 table snippets preserve the selection and surrounding CRLF', () => {
  const text = 'Before\r\nSelected 😀 prose\r\nAfter', from = 8, to = text.indexOf('\r\nAfter');
  for (const command of ['figure', 'table']) {
    const spec = typstInsertion(text, { from, to }, command, 'typ');
    assert.equal(spec.changes.from, to); assert.equal(spec.changes.to, to);
    const result = apply(text, spec);
    assert.equal(result.slice(0, to), text.slice(0, to));
    assert.equal(result.slice(to + spec.changes.insert.length), text.slice(to));
    assert.ok(!result.replaceAll('\r\n', '').includes('\n'), 'new snippet lines use existing CRLF');
    assert.equal(selected(text, spec), command === 'figure' ? 'image.svg' : 'Cell');
  }
  const table = typstInsertion('', { from: 0, to: 0 }, 'table', 'typ');
  assert.equal((table.changes.insert.match(/\[Cell\]/g) || []).length, 4);
  const path = 'plots/"😀".svg';
  assert.equal(selected('', typstInsertion('', { from: 0, to: 0 }, 'figure', 'typ', { path })), JSON.stringify(path).slice(1, -1));
});

test('mixed line endings outside the inserted block stay byte-for-byte intact', () => {
  const text = 'First\r\nSecond\nThird\r\nLast', at = text.indexOf('\nThird');
  const spec = typstInsertion(text, { from: at, to: at }, 'table', 'typ');
  assert.equal(spec.changes.from, at); assert.equal(spec.changes.to, at);
  assert.equal(apply(text, spec), text.slice(0, at) + spec.changes.insert + text.slice(at));
  assert.ok(spec.changes.insert.includes('\r\n'));
});

test('native End selections keep the complete CRLF outside every insertion', () => {
  const text = 'Before\r\nx^2\r\nAfter', end = text.indexOf('\nAfter');
  for (const command of commands) {
    const caret = typstInsertion(text, { from: end, to: end }, command, 'typ');
    assert.equal(caret.changes.from, end - 1); assert.equal(caret.changes.to, end - 1);
    const result = apply(text, caret);
    assert.ok(!result.replaceAll('\r\n', '').includes('\r'), `${command} never separates CR and LF`);
    const range = typstInsertion(text, { from: 8, to: end }, command, 'typ');
    assert.equal(range.changes.to, end - 1);
    assert.ok(!apply(text, range).replaceAll('\r\n', '').includes('\r'));
  }
  assert.throws(() => typstInsertion(text, { from: end, to: text.length }, 'link', 'typ'), /CRLF/);
});

test('invalid formats, ranges, Unicode boundaries and fields reject without a transaction', () => {
  for (const format of ['html', 'tex', undefined]) assert.throws(() => typstInsertion('x', { from: 0, to: 1 }, 'inline-math', format), /Typst files only/);
  for (const command of ['constructor', '__proto__', 'unknown']) assert.throws(() => typstInsertion('x', { from: 0, to: 1 }, command, 'typ'), /Choose inline-math/);
  assert.throws(() => typstInsertion(null, { from: 0, to: 0 }, 'link', 'typ'), TypeError);
  for (const range of [null, { from: -1, to: 0 }, { from: 1, to: 0 }, { from: 0, to: 3 }, { from: 0.5, to: 1 }, { from: 1, to: 2 }, { from: 0, to: 1 }]) assert.throws(() => typstInsertion('😀', range, 'link', 'typ'), RangeError);
  for (const options of [null, [], 'key', { unexpected: true }, { rows: 3 }]) assert.throws(() => typstInsertion('', { from: 0, to: 0 }, 'table', 'typ', options), /options|option/);
  for (const value of [null, undefined, '', 4, 'line\nbreak', 'NUL\0', '\ud800', '\udfff', 'x'.repeat(4097)]) {
    for (const [command, field] of [['citation', 'key'], ['reference', 'key'], ['link', 'url'], ['figure', 'path']]) assert.throws(() => typstInsertion('', { from: 0, to: 0 }, command, 'typ', { [field]: value }), TypeError);
  }
  for (const url of ['not a url', 'javascript:alert(1)', 'data:text/html,example', 'file:///tmp/example']) assert.throws(() => typstInsertion('', { from: 0, to: 0 }, 'link', 'typ', { url }), /valid http/);
});

test('each insertion is one undoable CodeMirror transaction with literal CRLF and restored selection', () => {
  const text = 'Before 😀\r\nx^2\r\nAfter', from = text.indexOf('x^2'), to = text.indexOf('\nAfter');
  for (const command of commands) {
    let state = EditorState.create({ doc: text, selection: { anchor: to, head: from }, extensions: [history(), EditorState.lineSeparator.of('\n')] });
    const spec = typstInsertion(state.doc.toString(), state.selection.main, command, 'typ');
    state = state.update({ ...spec, userEvent: 'input.insert' }).state;
    const inserted = state.doc.toString();
    assert.equal(inserted, apply(text, spec));
    assert.deepEqual({ anchor: state.selection.main.anchor, head: state.selection.main.head }, spec.selection);
    const target = { get state() { return state; }, dispatch(transaction) { state = transaction.state; } };
    assert.equal(undo(target), true); assert.equal(state.doc.toString(), text);
    assert.equal(state.selection.main.anchor, to); assert.equal(state.selection.main.head, from);
    assert.equal(undo(target), false, 'no extra history entry');
    assert.equal(redo(target), true); assert.equal(state.doc.toString(), inserted);
  }
});

test('generated complete LF and CRLF examples compile with real Typst and contain the intended PDF content', async t => {
  const compiler = process.env.UNDERTREE_TYPST || 'typst';
  const version = execFileSync(compiler, ['--version'], { encoding: 'utf8', timeout: 10000 }).trim();
  assert.match(version, /^typst 0\.15\.1\b/, 'this gate qualifies the pinned compiler and cannot silently skip it');
  const directory = await mkdtemp(join(tmpdir(), 'undertree-typst-insertion-'));
  const { getDocument, OPS } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const key = 'DBLP:books/lib/Knuth86a', path = 'quoted "plot" 😀.svg', url = 'https://example.org/authoring?quoted=%22';
  try {
    await writeFile(join(directory, path), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 30"><rect x="1" y="1" width="198" height="28" fill="red"/></svg>');
    await writeFile(join(directory, 'references.bib'), `@article{${key}, title={Citation sentinel}, author={UnderTree, Reviewer}, journal={Authoring fixture}, year={2026}}`);
    const compile = [];
    for (const [name, newline] of [['lf', '\n'], ['crlf', '\r\n']]) {
      let source = [
        '#set text(size: 10pt)', '#set heading(numbering: "1.")', '= Results <sec-results>',
        'Inline sentinel. x^2.', 'Display sentinel. a^2 + b^2', 'Citation prose sentinel.',
        'Reference prose sentinel.', 'Link text sentinel.', 'Figure prose sentinel.', 'Table prose sentinel.',
        '#bibliography("references.bib", style: "ieee")',
      ].join(newline + newline);
      for (const [body, command, options] of [
        ['x^2', 'inline-math'], ['a^2 + b^2', 'display-math'],
        ['Citation prose sentinel.', 'citation', { key }], ['Reference prose sentinel.', 'reference', { key: 'sec-results' }],
        ['Link text sentinel.', 'link', { url }], ['Figure prose sentinel.', 'figure', { path }], ['Table prose sentinel.', 'table'],
      ]) {
        const from = source.indexOf(body);
        source = apply(source, typstInsertion(source, { from, to: from + body.length }, command, 'typ', options));
      }
      if (newline === '\r\n') assert.ok(!source.replaceAll('\r\n', '').includes('\n'), 'the complete example contains no normalized or introduced lone LF');
      await writeFile(join(directory, name + '.typ'), source);
      const output = join(directory, name + '.pdf');
      execFileSync(compiler, ['compile', '--root', directory, join(directory, name + '.typ'), output], { timeout: 45000, maxBuffer: 65536 });
      const bytes = await readFile(output);
      const loading = getDocument({ data: new Uint8Array(bytes), useSystemFonts: false, isEvalSupported: false });
      try {
        const pdf = await loading.promise;
        assert.equal(pdf.numPages, 1);
        const page = await pdf.getPage(1), content = await page.getTextContent(), annotations = await page.getAnnotations(), operators = await page.getOperatorList();
        const words = content.items.map(item => item.str || '').join(' ').replace(/\s+/g, ' ');
        for (const sentinel of ['Inline sentinel.', 'Display sentinel.', 'Citation prose sentinel.', 'Reference prose sentinel.', 'Link text sentinel.', 'Figure prose sentinel.', 'Table prose sentinel.', 'Caption', 'Citation sentinel']) assert.ok(words.includes(sentinel), `${name}: ${sentinel} survives into the actual PDF`);
        assert.equal((words.match(/\bCell\b/g) || []).length, 4, 'the actual table has all four cells');
        assert.ok(annotations.some(item => item.url === url), 'the source link is an actual PDF hyperlink');
        assert.ok(annotations.some(item => item.dest), 'the inserted reference resolves to a PDF destination');
        assert.ok(operators.fnArray.includes(OPS.constructPath), 'the inserted local vector figure is drawn');
        assert.ok(content.items.some(item => item.str === '2' && item.height < 10), 'math superscripts are typeset rather than displayed as raw source');
        compile.push({ source: name, pages: pdf.numPages, bytes: bytes.length });
      } finally { await loading.destroy(); }
    }
    t.diagnostic(JSON.stringify({ compiler: version, compiled: compile, scope: 'Generated source/PDF semantics; no UI, native, visual-parity or remote-authority qualification.' }));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
