import assert from 'node:assert/strict';
import test from 'node:test';
import { ManuscriptPdfViewer, pdfTextRange } from '../modules/frontend/manuscript-pdf-viewer.js';

const identity = 'a'.repeat(64), anotherIdentity = 'b'.repeat(64);
function fixture(t, text = [['Repeat. ', 'Bold ', 'Repeat. 🌳'], ['Second ', 'page.']]) {
  const names = ['document', 'ResizeObserver', 'devicePixelRatio', 'CSS', 'Highlight'];
  const previous = Object.fromEntries(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const nodes = root => root.children?.flatMap(child => child.nodeType === 3 ? [child] : nodes(child)) || [];
  class Element {
    constructor(tag) { this.tag = tag; this.nodeType = 1; this.dataset = {}; this.children = []; this.style = { setProperty(key, value) { this[key] = value; } }; this.ownerDocument = doc; this.literal = ''; }
    setAttribute() {} getContext() { return {}; }
    append(...children) { for (const child of children) { child.parentElement = this; this.children.push(child); } }
    replaceChildren(...children) { for (const child of this.children) child.parentElement = null; this.children = []; this.append(...children); }
    remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this); this.parentElement = null; }
    contains(node) { return node === this || this.children.some(child => child === node || child.contains?.(node)); }
    closest(selector) { return selector === '.' + this.className ? this : this.parentElement?.closest(selector); }
    querySelectorAll(selector) { return this.children.flatMap(child => child.nodeType === 3 ? [] : [...(selector === child.tag || selector === '.' + child.className ? [child] : []), ...child.querySelectorAll(selector)]); }
    get textContent() { return this.literal + this.children.map(child => child.textContent).join(''); }
    set textContent(value) { this.literal = value; this.replaceChildren(); }
  }
  const position = (node, offset) => {
    const all = nodes(pages);
    const first = node.nodeType === 3 ? node : nodes(node)[0];
    let index = all.slice(0, all.indexOf(first)).reduce((sum, text) => sum + text.textContent.length, 0);
    return index + (node.nodeType === 3 ? offset : node.children.slice(0, offset).reduce((sum, child) => sum + child.textContent.length, 0));
  };
  class Range {
    setStart(node, offset) { this.startContainer = node; this.startOffset = offset; }
    setEnd(node, offset) { this.endContainer = node; this.endOffset = offset; }
    cloneRange() { const clone = new Range(); Object.assign(clone, this); return clone; }
    intersectsNode(node) { return position(this.startContainer, this.startOffset) < position(node, node.textContent.length) && position(this.endContainer, this.endOffset) > position(node, 0); }
    toString() { return nodes(pages).filter(node => this.intersectsNode(node)).map(node => node.textContent.slice(node === this.startContainer ? this.startOffset : 0, node === this.endContainer ? this.endOffset : undefined)).join(''); }
  }
  const doc = {
    createElement: tag => new Element(tag), createRange: () => new Range(),
    createTreeWalker(root) { const texts = nodes(root); let index = -1; return { nextNode() { return !!texts[++index]; }, get currentNode() { return texts[index]; } }; },
    getSelection() { return this.selection; },
  };
  const pages = new Element('div');
  const scroller = { dataset: {}, clientWidth: 832, clientHeight: 1200, scrollTop: 0, addEventListener() {}, removeEventListener() {} };
  globalThis.document = doc; globalThis.devicePixelRatio = 1;
  globalThis.ResizeObserver = class { observe() {} disconnect() {} };
  globalThis.CSS = { highlights: new Map() }; globalThis.Highlight = class extends Set { constructor(...ranges) { super(ranges); } };
  class TextLayer {
    constructor({ container, textContentSource }) { this.container = container; this.content = textContentSource; }
    async render() { for (const { str } of this.content.items) if (str) { const span = new Element('span'); span.append({ nodeType: 3, textContent: str, ownerDocument: doc }); this.container.append(span); } }
    cancel() {}
  }
  const pdf = { numPages: text.length, getPage: async number => ({
    getViewport: ({ scale }) => ({ width: 600 * scale, height: 800 * scale, scale }),
    getTextContent: async () => ({ items: text[number - 1].map(str => ({ str })) }),
    render: () => ({ promise: Promise.resolve(), cancel() {} }), cleanup() {},
  }) };
  const viewer = new ManuscriptPdfViewer({ scroller, pages, onChange() {}, onError(error) { throw error; } });
  viewer.schedule = () => {};
  const select = (startPage, startRun, start, endPage, endRun, end) => {
    const layers = pages.querySelectorAll('.pdf-text-layer');
    const range = new Range(); range.setStart(nodes(layers[startPage - 1])[startRun], start); range.setEnd(nodes(layers[endPage - 1])[endRun], end);
    doc.selection = { isCollapsed: false, rangeCount: 1, getRangeAt: () => range }; return range;
  };
  t.after(() => { viewer.destroy(); for (const [name, descriptor] of Object.entries(previous)) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name]; } });
  return { viewer, pages, scroller, pdf, TextLayer, select, doc, nodes };
}

test('positional PDF selections retain exact UTF-16 offsets across runs and pages without searching duplicate quotes', async t => {
  const f = fixture(t); await f.viewer.setDocument(f.pdf, { TextLayer: f.TextLayer, identity });
  f.select(1, 2, 0, 1, 2, 7);
  const repeated = f.viewer.selectedText();
  assert.deepEqual(repeated.segments, [{ page: 1, from: 13, to: 20, quote: 'Repeat.' }]); assert.equal(repeated.identity, identity);
  f.select(1, 1, 2, 2, 1, 5);
  const multi = f.viewer.selectedText();
  assert.deepEqual(multi.segments, [{ page: 1, from: 10, to: 23, quote: 'ld Repeat. 🌳' }, { page: 2, from: 0, to: 12, quote: 'Second page.' }]);
  assert.equal(multi.quote, 'ld Repeat. 🌳\nSecond page.');
  assert.equal(f.viewer.selectionCurrent(repeated), true, 'Moving the live selection does not replace a captured clone range.');
  const first = f.pages.querySelectorAll('.pdf-text-layer')[0];
  const exact = pdfTextRange(first, 13, 23, 'Repeat. 🌳');
  assert.equal(exact.toString(), 'Repeat. 🌳'); assert.equal(pdfTextRange(first, 0, 7, 'Wrong!!'), null);
});

test('PDF annotations paint exact repeated occurrences, survive repaint and remain separate from source-linked highlights', async t => {
  const f = fixture(t); await f.viewer.setDocument(f.pdf, { TextLayer: f.TextLayer, identity });
  const annotations = [{ id: 'second-occurrence', identity, color: '#12ab34', segments: [{ page: 1, from: 13, to: 20, quote: 'Repeat.' }, { page: 2, from: 0, to: 12, quote: 'Second page.' }] }];
  f.viewer.setPdfAnnotations(annotations); annotations[0].segments[0].from = 0;
  let highlights = [...CSS.highlights].filter(([name]) => name.startsWith('undertree-pdf-annotation-'));
  assert.equal(highlights.length, 1); assert.equal(highlights[0][1].size, 2);
  const repeated = [...highlights[0][1]][0]; assert.equal(repeated.startOffset, 0); assert.equal(repeated.startContainer.textContent, 'Repeat. 🌳');
  f.viewer.verifiedText = 'Repeat. Bold Repeat. 🌳\u0000Second page.';
  f.viewer.setHighlights([{ quote: 'Bold ', color: '#aa3344' }]);
  assert.ok([...CSS.highlights.keys()].some(name => name.startsWith('undertree-pdf-rule-')));
  f.viewer.zoom(1.25); await f.viewer.render();
  highlights = [...CSS.highlights].filter(([name]) => name.startsWith('undertree-pdf-annotation-'));
  assert.equal(highlights[0][1].size, 2); assert.ok([...highlights[0][1]].every(range => f.pages.contains(range.startContainer)));
  assert.equal(f.scroller.dataset.pdfAnnotations, '1');
  assert.deepEqual(f.pages.querySelectorAll('.pdf-text-layer').map(layer => layer.dataset.pdfAnnotations), ['1', '1']);
  f.viewer.setPdfAnnotations([]);
  assert.ok(![...CSS.highlights.keys()].some(name => name.startsWith('undertree-pdf-annotation-')));
  assert.ok([...CSS.highlights.keys()].some(name => name.startsWith('undertree-pdf-rule-')), 'Clearing visual marks cannot clear source-linked colors.');
});

test('PDF color-rule access follows exact painted occurrences and rejects retired ranges', async t => {
  const f = fixture(t); await f.viewer.setDocument(f.pdf, { TextLayer: f.TextLayer, identity });
  f.viewer.setPdfAnnotations([
    { id: 'first', rule: 'neutral', ownerPath: 'main.typ', identity, color: '#12ab34', segments: [{ page: 1, from: 0, to: 7, quote: 'Repeat.' }] },
    { id: 'second', rule: 'protected', ownerPath: 'main.typ', identity, color: '#ab1234', segments: [{ page: 1, from: 13, to: 20, quote: 'Repeat.' }] },
    { id: 'other-source', rule: 'foreign', ownerPath: 'chapter.typ', identity, color: '#3412ab', segments: [{ page: 1, from: 13, to: 20, quote: 'Repeat.' }] },
  ]);
  f.select(1, 2, 0, 1, 2, 7);
  assert.deepEqual(f.viewer.highlightedRulesAt(), [{ ruleId: 'protected', ownerPath: 'main.typ' }, { ruleId: 'foreign', ownerPath: 'chapter.typ' }]);
  for (const record of f.viewer.annotationRuleRanges) record.range.getClientRects = () => [{ left: record.from, right: record.to, top: 0, bottom: 10 }];
  assert.deepEqual(f.viewer.highlightedRulesAt({ clientX: 3, clientY: 5 }), [{ ruleId: 'neutral', ownerPath: 'main.typ' }]);
  assert.deepEqual(f.viewer.highlightedRulesAt({ clientX: 15, clientY: 5 }), [{ ruleId: 'protected', ownerPath: 'main.typ' }, { ruleId: 'foreign', ownerPath: 'chapter.typ' }]);
  f.pages.replaceChildren();
  assert.deepEqual(f.viewer.highlightedRulesAt({ clientX: 15, clientY: 5 }), []);
});

test('stale PDF identities, shifted offsets and replaced retained ranges fail closed', async t => {
  const f = fixture(t); await f.viewer.setDocument(f.pdf, { TextLayer: f.TextLayer, identity });
  f.select(1, 0, 0, 1, 0, 7); const selected = f.viewer.selectedText();
  f.viewer.setPdfAnnotations([
    { id: 'wrong-pdf', identity: anotherIdentity, color: '#123456', segments: selected.segments },
    { id: 'wrong-offset', identity, color: '#654321', segments: [{ page: 1, from: 1, to: 8, quote: 'Repeat.' }] },
  ]);
  assert.equal(CSS.highlights.size, 0);
  f.viewer.zoom(1.25); await f.viewer.render(); assert.equal(f.viewer.selectionCurrent(selected), false);
  await f.viewer.setDocument(f.pdf, { TextLayer: f.TextLayer, identity: anotherIdentity });
  assert.equal(f.viewer.pdfAnnotations.length, 0); assert.equal(f.viewer.selectionCurrent(selected), false);
  await assert.rejects(f.viewer.setDocument(f.pdf, { identity: 'a-short-fingerprint' }), /SHA-256/);
  assert.throws(() => f.viewer.setPdfAnnotations([{ identity, color: '#123456', segments: [{ page: 1, from: 0, to: 2, quote: 'x' }] }]), /UTF-16/);
});
