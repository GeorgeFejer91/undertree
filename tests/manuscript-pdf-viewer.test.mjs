import test from 'node:test';
import assert from 'node:assert/strict';
import { ManuscriptPdfViewer } from '../modules/frontend/manuscript-pdf-viewer.js';

function viewerFixture(t, width = 832) {
  const previous = Object.fromEntries(['document', 'ResizeObserver', 'devicePixelRatio'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  class Element {
    constructor(tag) { this.tag = tag; this.style = {}; this.dataset = {}; this.children = []; }
    setAttribute() {}
    append(child) { this.children.push(child); }
    replaceChildren(...children) { this.children = children; }
    querySelectorAll(tag) { return this.children.flatMap(child => [...(child.tag === tag ? [child] : []), ...child.querySelectorAll(tag)]); }
    getContext() { return {}; }
  }
  globalThis.document = { createElement: tag => new Element(tag) };
  globalThis.ResizeObserver = class { observe() {} disconnect() {} };
  globalThis.devicePixelRatio = 2;
  const pages = new Element('div');
  const scroller = { clientWidth: width, clientHeight: 600, scrollTop: 0, addEventListener() {}, removeEventListener() {} };
  const changes = []; const errors = [];
  const viewer = new ManuscriptPdfViewer({ scroller, pages, onChange: change => changes.push(change), onError: error => errors.push(error) });
  // Drive scheduling explicitly, retaining the actual viewport/canvas rendering path.
  viewer.schedule = () => {};
  t.after(() => {
    viewer.destroy();
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
    }
    assert.deepEqual(errors, []);
  });
  return { viewer, scroller, pages, changes };
}

function pdfFixture(numPages = 1, sizes = {}) {
  const renders = [];
  const page = number => ({
    getViewport({ scale }) { const [width, height] = sizes[number] || [600, 800]; return { width: width * scale, height: height * scale }; },
    render(options) { renders.push({ number, ...options }); return { promise: Promise.resolve(), cancel() {} }; },
    cleanup() {},
  });
  return { numPages, getPage: async number => page(number), page, renders };
}

test('100% PDF zoom displays points at 96 CSS pixels per inch', async t => {
  const { viewer, pages, changes } = viewerFixture(t);
  await viewer.setDocument(pdfFixture());
  viewer.scale = 1;
  await viewer.render();
  const [canvas] = pages.querySelectorAll('canvas');
  assert.equal(canvas.style.width, '800px');
  assert.ok(Math.abs(parseFloat(canvas.style.height) - 800 * 96 / 72) < .001);
  assert.equal(changes.at(-1).scale, 1);
  assert.equal(changes.at(-1).fit, false);
});

test('fit width reports normalized zoom and reciprocal steps keep the same fitted size', async t => {
  const { viewer, pages, changes, scroller } = viewerFixture(t, 632);
  await viewer.setDocument(pdfFixture());
  assert.equal(changes.at(-1).scale, .75);
  assert.equal(changes.at(-1).fit, true);
  assert.equal(pages.querySelectorAll('canvas')[0].style.width, '600px');
  viewer.zoom(1.25);
  await viewer.render();
  assert.equal(viewer.scale, .9375);
  assert.equal(pages.querySelectorAll('canvas')[0].style.width, '750px');
  viewer.zoom(.8);
  await viewer.render();
  assert.equal(viewer.scale, .75);
  assert.equal(changes.at(-1).fit, false);
  assert.equal(pages.querySelectorAll('canvas')[0].style.width, '600px');
  viewer.fit(); scroller.clientWidth = 832;
  await viewer.render();
  assert.equal(changes.at(-1).scale, 1);
  assert.equal(changes.at(-1).fit, true);
  assert.equal(pages.querySelectorAll('canvas')[0].style.width, '800px');
});

test('zoom clamps and long PDF navigation retain three canvases within nine million pixels', async t => {
  const { viewer, pages, changes } = viewerFixture(t);
  await viewer.setDocument(pdfFixture(5000));
  viewer.zoom(100);
  await viewer.render();
  assert.equal(viewer.scale, 9.99);
  viewer.go(2500);
  await viewer.render();
  const canvases = pages.querySelectorAll('canvas');
  assert.equal(canvases.length, 3);
  assert.ok(canvases.reduce((pixels, canvas) => pixels + canvas.width * canvas.height, 0) <= 9_000_000);
  assert.equal(changes.at(-1).page, 2500);
  assert.equal(changes.at(-1).total, 5000);
  viewer.zoom(.001);
  await viewer.render();
  assert.equal(viewer.scale, .1);
  viewer.go(99999);
  await viewer.render();
  assert.equal(changes.at(-1).page, 5000);
  assert.equal(pages.querySelectorAll('canvas').length, 2);
});

test('mixed page heights position later pages using CSS-normalized dimensions', async t => {
  const { viewer, scroller } = viewerFixture(t);
  await viewer.setDocument(pdfFixture(3, { 2: [600, 1200] }));
  viewer.scale = 1;
  await viewer.render();
  viewer.go(3);
  assert.ok(Math.abs(scroller.scrollTop - ((800 + 1200) * 96 / 72 + 32)) < .001);
});

test('a superseded document cannot paint its deferred later page over the new PDF', async t => {
  const { viewer, pages, changes } = viewerFixture(t);
  const old = pdfFixture(3);
  let releasePage; let awaitingPage;
  const waiting = new Promise(resolve => { awaitingPage = resolve; });
  old.getPage = async number => {
    if (number !== 2) return old.page(number);
    awaitingPage();
    return new Promise(resolve => { releasePage = () => resolve(old.page(number)); });
  };
  const loading = viewer.setDocument(old);
  await waiting;
  const replacement = pdfFixture(1, { 1: [300, 400] });
  await viewer.setDocument(replacement);
  releasePage();
  assert.equal(await loading, false);
  assert.equal(viewer.pdf, replacement);
  assert.equal(pages.querySelectorAll('canvas').length, 1);
  assert.equal(changes.at(-1).total, 1);
  assert.equal(old.renders.length, 1);
});

test('a deferred PDF first page cannot repopulate the viewer after switching files', async () => {
  const previous = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class { observe() {} disconnect() {} };
  try {
    const viewer = new ManuscriptPdfViewer({
      scroller: { addEventListener() {}, removeEventListener() {} },
      pages: { querySelectorAll: () => [], replaceChildren() {} },
      onChange() {}, onError() {},
    });
    let resolveFirst;
    const document = { getPage: () => new Promise(resolve => { resolveFirst = resolve; }) };
    let rendered = 0; viewer.render = async () => { rendered += 1; };
    const pending = viewer.setDocument(document);
    viewer.clear();
    resolveFirst({ getViewport: () => ({ width: 600, height: 800 }) });
    assert.equal(await pending, false);
    assert.equal(rendered, 0);
    assert.equal(viewer.pdf, null);
    assert.equal(viewer.base, undefined);
    viewer.destroy();
  } finally { globalThis.ResizeObserver = previous; }
});
