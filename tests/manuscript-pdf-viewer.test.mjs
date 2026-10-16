import test from 'node:test';
import assert from 'node:assert/strict';
import { ManuscriptPdfViewer } from '../modules/frontend/manuscript-pdf-viewer.js';

function viewerFixture(t, width = 832, height = 600) {
  const previous = Object.fromEntries(['document', 'ResizeObserver', 'devicePixelRatio'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  class Element {
    constructor(tag) { this.tag = tag; this.style = {}; this.dataset = {}; this.children = []; }
    setAttribute() {}
    append(child) { this.children.push(child); }
    replaceChildren(...children) { this.children = children; this.onLayout?.(); }
    querySelectorAll(tag) { return this.children.flatMap(child => [...(child.tag === tag ? [child] : []), ...child.querySelectorAll(tag)]); }
    getContext() { return {}; }
  }
  globalThis.document = { createElement: tag => new Element(tag) };
  globalThis.ResizeObserver = class { constructor(callback) { this.callback = callback; } observe() {} disconnect() {} };
  globalThis.devicePixelRatio = 2;
  const pages = new Element('div');
  let scrollTop = 0;
  const scroller = {
    clientWidth: width, clientHeight: height,
    get scrollHeight() { return Math.max(this.clientHeight, pages.children.reduce((height, child) => height + (parseFloat(child.style.height) || 0) + (child.className === 'pdf-page' ? 16 : 0), 0)); },
    get scrollTop() { return scrollTop; },
    set scrollTop(value) { scrollTop = Math.max(0, Math.min(Number.isFinite(value) ? value : 0, this.scrollHeight - this.clientHeight)); },
    addEventListener() {}, removeEventListener() {},
  };
  pages.onLayout = () => { scroller.scrollTop = scroller.scrollTop; };
  const changes = []; const errors = [];
  const viewer = new ManuscriptPdfViewer({ scroller, pages, onChange: change => changes.push(change), onError: error => errors.push(error) });
  // Drive scheduling explicitly, retaining the actual viewport/canvas rendering path.
  viewer.schedule = () => { ManuscriptPdfViewer.prototype.schedule.call(viewer); clearTimeout(viewer.pending); viewer.pending = 0; };
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

test('scrolling within the painted page window retains canvases and updates navigation without raster work', async t => {
  const { viewer, pages, scroller, changes } = viewerFixture(t, 832, 1000);
  const pdf = pdfFixture(30);
  await viewer.setDocument(pdf);
  scroller.scrollTop = 700; viewer.scroll(); await viewer.render();
  const canvases = pages.querySelectorAll('canvas');
  const renders = pdf.renders.length;
  for (let offset = 710; offset <= 850; offset += 10) {
    scroller.scrollTop = offset; viewer.scroll(); await viewer.render();
    assert.deepEqual(pages.querySelectorAll('canvas'), canvases, 'small scrolls reuse the installed pixels');
  }
  assert.equal(pdf.renders.length, renders, 'the unchanged window performs no more PDF raster work');
  assert.equal(changes.at(-1).page, 2, 'toolbar navigation still follows the viewport');
  scroller.scrollTop = viewer.offset(10); viewer.scroll(); await viewer.render();
  assert.ok(pdf.renders.length > renders, 'newly visible pages are painted');
  assert.ok(pages.children.some(node => node.dataset.page === '10'));
});

test('changed pixel density and a replacement PDF repaint an otherwise identical window', async t => {
  const { viewer, pages } = viewerFixture(t);
  const pdf = pdfFixture(); await viewer.setDocument(pdf);
  const canvas = pages.querySelectorAll('canvas')[0];
  globalThis.devicePixelRatio = 1;
  await viewer.render();
  assert.notEqual(pages.querySelectorAll('canvas')[0], canvas);
  assert.equal(pdf.renders.length, 2);
  const replacement = pdfFixture(); await viewer.setDocument(replacement);
  assert.equal(replacement.renders.length, 1);
});

test('100% PDF zoom displays points at 96 CSS pixels per inch', async t => {
  const { viewer, pages, changes, scroller } = viewerFixture(t);
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

test('fractional and nonfinite page jumps retain integer navigation state and painted target pages', async t => {
  const { viewer, pages, changes, scroller } = viewerFixture(t);
  await viewer.setDocument(pdfFixture(10));
  for (const [input, expected] of [[2.5, 2], ['3.75', 3], [9.9, 9], [Infinity, 1], [-Infinity, 1], [NaN, 1], ['invalid', 1], [-2.5, 1], [999.9, 10]]) {
    viewer.go(input);
    assert.equal(viewer.page, expected);
    assert.equal(viewer.targetPage, expected, 'the pending render target is an actual document page');
    await viewer.render();
    assert.equal(changes.at(-1).page, expected, 'toolbar updates receive an integer page');
    const target = pages.children.find(node => node.dataset.page === String(expected));
    assert.ok(target?.querySelectorAll('canvas').some(canvas => canvas.width > 0 && canvas.height > 0), 'the normalized target is painted');
    assert.ok(Number.isFinite(scroller.scrollTop));
  }
  viewer.go(2.9);
  viewer.go(viewer.page + 1);
  await viewer.render();
  assert.equal(changes.at(-1).page, 3, 'Next after a fractional page request advances from its normalized integer');
});

test('high zoom and long PDF navigation retain a small window within nine million pixels', async t => {
  const { viewer, pages, changes, scroller } = viewerFixture(t);
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
  assert.ok(pages.children.some(node => node.dataset.page === '5000'));
  const first = Number(pages.children.find(node => node.dataset.page)?.dataset.page);
  assert.ok(viewer.offset(first) <= scroller.scrollTop, 'bottom viewport starts inside the painted window');
  assert.ok(pages.querySelectorAll('canvas').length >= 5, 'browser-clamped final-page navigation paints the preceding visible pages');
  assert.ok(pages.querySelectorAll('canvas').reduce((pixels, canvas) => pixels + canvas.width * canvas.height, 0) <= 9_000_000);
});

test('fit-width growth publishes new geometry before jumping beyond the old scroll limit', async t => {
  const { viewer, pages, scroller, changes } = viewerFixture(t, 320, 896);
  await viewer.setDocument(pdfFixture(10));
  const oldLimit = scroller.scrollHeight - scroller.clientHeight;
  scroller.clientWidth = 832;
  viewer.go(10);
  assert.equal(scroller.scrollTop, oldLimit, 'the browser initially clamps the jump to the old narrow layout');
  await viewer.render();
  assert.equal(changes.at(-1).page, 10);
  assert.ok(pages.children.some(node => node.dataset.page === '10'), 'requested page is painted after regrowth');
  assert.ok(scroller.scrollTop > oldLimit);
  assert.ok(Math.abs(scroller.scrollTop - viewer.offset(10)) < .001);
});

test('a newer page jump during deferred resize preparation replaces the pending target', async t => {
  const { viewer, pages, scroller } = viewerFixture(t, 320, 896);
  const pdf = pdfFixture(20);
  await viewer.setDocument(pdf);
  let releasePage; let awaitingPage;
  const waiting = new Promise(resolve => { awaitingPage = resolve; });
  pdf.getPage = async number => {
    if (number !== 9) return pdf.page(number);
    awaitingPage();
    return new Promise(resolve => { releasePage = () => resolve(pdf.page(number)); });
  };
  scroller.clientWidth = 832; viewer.go(10);
  const rendering = viewer.render(); await waiting;
  viewer.go(18); releasePage(); await rendering;
  await viewer.render();
  assert.equal(viewer.page, 18);
  assert.ok(pages.children.some(node => node.dataset.page === '18'));
  assert.ok(!pages.children.some(node => node.dataset.page === '9'));
  assert.ok(Math.abs(scroller.scrollTop - viewer.offset(18)) < .001);
});

test('genuine scrolling during deferred resize preparation overrides the old page jump', async t => {
  const { viewer, pages, scroller } = viewerFixture(t, 320, 896);
  const pdf = pdfFixture(20);
  await viewer.setDocument(pdf);
  let releasePage; let awaitingPage;
  const waiting = new Promise(resolve => { awaitingPage = resolve; });
  pdf.getPage = async number => {
    if (number !== 9) return pdf.page(number);
    awaitingPage();
    return new Promise(resolve => { releasePage = () => resolve(pdf.page(number)); });
  };
  scroller.clientWidth = 832; viewer.go(10);
  const rendering = viewer.render(); await waiting;
  scroller.scrollTop = viewer.offset(4); viewer.scroll();
  const requested = viewer.page;
  assert.equal(requested, 4, 'user scroll is interpreted using the still-visible narrow geometry');
  releasePage(); await rendering; await viewer.render();
  assert.equal(viewer.page, 4);
  assert.ok(pages.children.some(node => node.dataset.page === '4'));
  assert.ok(!pages.children.some(node => node.dataset.page === '9'));
});

test('mixed page heights position later pages using CSS-normalized dimensions', async t => {
  const { viewer, scroller } = viewerFixture(t);
  await viewer.setDocument(pdfFixture(3, { 2: [600, 1200] }));
  viewer.scale = 1;
  await viewer.render();
  viewer.go(3);
  assert.ok(Math.abs(scroller.scrollTop - ((800 + 1200) * 96 / 72 + 32)) < .001);
});

for (const [width, height] of [[.01, 1_000_000], [1_000_000, .01]]) {
  test(`extreme ${width < height ? 'tall' : 'wide'} pages retain positive bounded canvas dimensions and uniform scaling`, async t => {
    const { viewer, pages } = viewerFixture(t);
    const pdf = pdfFixture(1, { 1: [width, height] });
    await viewer.setDocument(pdf);
    viewer.scale = 9.99;
    await viewer.render();
    const [canvas] = pages.querySelectorAll('canvas');
    assert.ok(canvas.width >= 1 && canvas.height >= 1);
    assert.ok(canvas.width <= 32767 && canvas.height <= 32767);
    assert.ok(canvas.width * canvas.height <= 9_000_000);
    const rendered = pdf.renders.at(-1);
    assert.ok(Math.abs(parseFloat(canvas.style.width) - width * 9.99 * 96 / 72) < .001);
    assert.ok(Math.abs(parseFloat(canvas.style.height) - height * 9.99 * 96 / 72) < .001);
    assert.equal(rendered.transform[0], rendered.transform[3], 'one uniform transform paints the complete page');
    assert.ok(rendered.viewport.width * rendered.transform[0] <= canvas.width + 1);
    assert.ok(rendered.viewport.height * rendered.transform[3] <= canvas.height + 1);
  });
}

test('10% zoom paints every visible page in a tall viewport rather than three pages', async t => {
  const { viewer, pages } = viewerFixture(t, 832, 1000);
  await viewer.setDocument(pdfFixture(20));
  viewer.scale = .1;
  await viewer.render();
  const painted = pages.children.filter(node => node.dataset.page).map(node => Number(node.dataset.page));
  assert.deepEqual(painted, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 'nine visible pages and one following page');
  assert.ok(pages.querySelectorAll('canvas').reduce((pixels, canvas) => pixels + canvas.width * canvas.height, 0) <= 9_000_000);
});

test('a narrow tall viewport fills mixed very short pages using their actual heights', async t => {
  const { viewer, pages } = viewerFixture(t, 320, 1000);
  const sizes = Object.fromEntries(Array.from({ length: 99 }, (_, index) => [index + 2, [600, 20]]));
  await viewer.setDocument(pdfFixture(100, sizes));
  viewer.scale = .1;
  await viewer.render();
  const painted = pages.children.filter(node => node.dataset.page);
  let position = 0;
  const visible = [];
  for (const slot of painted) {
    if (position < 1000 - .01) visible.push(Number(slot.dataset.page));
    position += parseFloat(slot.style.height) + 16;
  }
  assert.ok(visible.length > 40, 'short visible pages were loaded instead of assuming the first-page height');
  assert.ok(position > 1000, 'painted pages cover the complete viewport');
  assert.equal(painted.length, visible.length + 1, 'one following page provides overscan');
  assert.ok(painted.length <= 128);
});

test('growing the viewport at explicit 10% zoom paints the newly visible pages automatically', async t => {
  const { viewer, pages, scroller } = viewerFixture(t, 832, 600);
  await viewer.setDocument(pdfFixture(20));
  viewer.scale = .1;
  await viewer.render();
  assert.equal(pages.querySelectorAll('canvas').length, 6);
  viewer.schedule = ManuscriptPdfViewer.prototype.schedule.bind(viewer);
  const rendered = new Promise(resolve => {
    const onChange = viewer.onChange;
    viewer.onChange = change => { onChange(change); resolve(); };
  });
  scroller.clientHeight = 1000;
  viewer.observer.callback();
  await rendered;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(viewer.scale, .1, 'the user zoom remains unchanged');
  assert.equal(pages.querySelectorAll('canvas').length, 10);
});

test('page dimensions and live canvases stay bounded for very long short-page PDFs', async t => {
  const { viewer, pages } = viewerFixture(t, 320, 1000);
  const pdf = pdfFixture(12000);
  pdf.getPage = async number => pdfFixture(1, { 1: [600, 1] }).page(1);
  await viewer.setDocument(pdf);
  viewer.scale = .1;
  await viewer.render();
  assert.ok(pages.querySelectorAll('canvas').length > 50);
  assert.ok(pages.querySelectorAll('canvas').length <= 128);
  viewer.heights = new Map(Array.from({ length: 1000 }, (_, index) => [index + 1, 1]));
  viewer.go(6000);
  await viewer.render();
  assert.equal(viewer.heights.size, 1000);
  assert.ok(pages.children.some(node => node.dataset.page === '6000'));
  assert.ok(pages.querySelectorAll('canvas').length <= 128);
  assert.ok(pages.querySelectorAll('canvas').reduce((pixels, canvas) => pixels + canvas.width * canvas.height, 0) <= 9_000_000);
});

test('scrolling while page dimensions load schedules the latest viewport without another scroll', async t => {
  const { viewer, pages, scroller } = viewerFixture(t);
  const pdf = pdfFixture(30);
  await viewer.setDocument(pdf);
  let releasePage; let awaitingPage;
  const waiting = new Promise(resolve => { awaitingPage = resolve; });
  pdf.getPage = async number => {
    if (number !== 9) return pdf.page(number);
    awaitingPage();
    return new Promise(resolve => { releasePage = () => resolve(pdf.page(number)); });
  };
  viewer.go(10);
  const rendering = viewer.render();
  await waiting;
  viewer.schedule = ManuscriptPdfViewer.prototype.schedule.bind(viewer);
  scroller.scrollTop = viewer.offset(15);
  viewer.scroll();
  releasePage();
  await rendering;
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(viewer.page, 15);
  assert.ok(pages.children.some(node => node.dataset.page === '15'), 'latest viewport painted automatically');
  assert.ok(!pages.children.some(node => node.dataset.page === '9'), 'superseded viewport released');
});

test('a superseded document cannot paint its deferred later page over the new PDF', async t => {
  const { viewer, pages, changes, scroller } = viewerFixture(t);
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
  viewer.go(3);
  assert.equal(viewer.targetPage, 3);
  const replacement = pdfFixture(1, { 1: [300, 400] });
  await viewer.setDocument(replacement);
  releasePage();
  assert.equal(await loading, false);
  assert.equal(viewer.pdf, replacement);
  assert.equal(viewer.targetPage, null);
  assert.equal(viewer.page, 1);
  assert.equal(scroller.scrollTop, 0);
  assert.equal(pages.querySelectorAll('canvas').length, 1);
  assert.equal(changes.at(-1).total, 1);
  assert.equal(old.renders.length, 0, 'superseded dimensions never reach the canvas painting phase');
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


test('History hide and unchanged-size reveal preserve the installed canvases without a redraw', async t => {
  const { viewer, pages, scroller } = viewerFixture(t, 446, 747);
  const pdf = pdfFixture(3); await viewer.setDocument(pdf);
  const canvas = pages.querySelectorAll('canvas')[0];
  const dimensions = [canvas.width, canvas.height];
  const generation = viewer.generation, renders = pdf.renders.length;
  let scheduled = 0; viewer.schedule = () => { scheduled += 1; };
  scroller.clientWidth = 0; scroller.clientHeight = 0;
  viewer.observer.callback();
  scroller.scrollTop = 0; viewer.scroll();
  assert.equal(scheduled, 0, 'a hidden scroller is not a resize/scroll paint intent');
  scroller.clientWidth = 446; scroller.clientHeight = 747;
  viewer.observer.callback();
  assert.equal(scheduled, 0, 'the already installed visible geometry needs no replacement paint');
  assert.equal(pages.querySelectorAll('canvas')[0], canvas);
  assert.deepEqual([canvas.width, canvas.height], dimensions);
  assert.equal(viewer.pdf, pdf); assert.equal(viewer.generation, generation);
  assert.equal(pdf.renders.length, renders);
});

test('explicit hidden page and zoom work resumes even when the visible size is unchanged', async t => {
  const { viewer, pages, scroller } = viewerFixture(t, 446, 747);
  const pdf = pdfFixture(20); await viewer.setDocument(pdf);
  const canvas = pages.querySelectorAll('canvas')[0], dimensions = [canvas.width, canvas.height];
  scroller.clientWidth = 0; scroller.clientHeight = 0;
  viewer.zoom(1.25); viewer.go(10); await viewer.render();
  assert.equal(pages.querySelectorAll('canvas')[0], canvas, 'hidden explicit work retains the last good pixels');
  assert.deepEqual([canvas.width, canvas.height], dimensions);
  assert.equal(viewer.targetPage, 10, 'the hidden request is not acknowledged as rendered');
  const requestedScale = viewer.scale;
  let scheduled = 0; viewer.schedule = () => { scheduled += 1; };
  scroller.clientWidth = 446; scroller.clientHeight = 747; viewer.observer.callback();
  assert.equal(scheduled, 1, 'pending explicit work defeats the unchanged-size observer no-op');
  await viewer.render();
  assert.equal(viewer.pdf, pdf); assert.equal(viewer.page, 10); assert.equal(viewer.scale, requestedScale);
  assert.ok(pages.children.some(node => node.dataset.page === '10'));
  assert.notEqual(pages.querySelectorAll('canvas')[0], canvas);
});

test('page preparation crossing History hide cannot release the retained canvases', async t => {
  const { viewer, pages, scroller } = viewerFixture(t, 446, 747);
  const pdf = pdfFixture(20); await viewer.setDocument(pdf);
  const canvas = pages.querySelectorAll('canvas')[0], dimensions = [canvas.width, canvas.height];
  let announce, release, held = false;
  const waiting = new Promise(resolve => { announce = resolve; });
  pdf.getPage = async number => {
    if (number !== 9 || held) return pdf.page(number);
    held = true; announce(); return new Promise(resolve => { release = () => resolve(pdf.page(number)); });
  };
  viewer.go(10); const rendering = viewer.render(); await waiting;
  // Visibility can change before ResizeObserver delivers its notification.
  scroller.clientWidth = 0; scroller.clientHeight = 0;
  release(); await rendering;
  assert.equal(pages.querySelectorAll('canvas')[0], canvas);
  assert.deepEqual([canvas.width, canvas.height], dimensions);
  assert.equal(viewer.targetPage, 10);
  assert.equal(viewer.rendering, false);
  let scheduled = 0; viewer.schedule = () => { scheduled += 1; };
  scroller.clientWidth = 446; scroller.clientHeight = 747; viewer.observer.callback();
  assert.equal(scheduled, 1);
  await viewer.render();
  assert.equal(viewer.page, 10);
  assert.ok(pages.children.some(node => node.dataset.page === '10'));
});

test('a genuine visible geometry change after History still repaints at the new fit size', async t => {
  const { viewer, pages, scroller } = viewerFixture(t, 446, 747);
  await viewer.setDocument(pdfFixture(3));
  const canvas = pages.querySelectorAll('canvas')[0];
  let scheduled = 0; viewer.schedule = () => { scheduled += 1; };
  scroller.clientWidth = 0; scroller.clientHeight = 0; viewer.observer.callback();
  scroller.clientWidth = 832; scroller.clientHeight = 600; viewer.observer.callback();
  assert.equal(scheduled, 1, 'only the real visible geometry change schedules repainting');
  await viewer.render();
  assert.notEqual(pages.querySelectorAll('canvas')[0], canvas);
  assert.equal(pages.querySelectorAll('canvas')[0].style.width, '800px');
  assert.equal(viewer.currentScale, 1);
});

test('a newly published document while hidden is painted on unchanged-size reveal', async t => {
  const { viewer, pages, scroller } = viewerFixture(t, 446, 747);
  await viewer.setDocument(pdfFixture(3));
  const canvas = pages.querySelectorAll('canvas')[0], dimensions = [canvas.width, canvas.height];
  scroller.clientWidth = 0; scroller.clientHeight = 0;
  const replacement = pdfFixture(1, { 1: [300, 400] });
  await viewer.setDocument(replacement);
  assert.equal(viewer.pdf, replacement);
  assert.equal(pages.querySelectorAll('canvas')[0], canvas);
  assert.deepEqual([canvas.width, canvas.height], dimensions);
  assert.equal(replacement.renders.length, 0, 'hidden publication does not paint a fallback size');
  let scheduled = 0; viewer.schedule = () => { scheduled += 1; };
  scroller.clientWidth = 446; scroller.clientHeight = 747; viewer.observer.callback();
  assert.equal(scheduled, 1);
  await viewer.render();
  assert.notEqual(pages.querySelectorAll('canvas')[0], canvas);
  assert.equal(replacement.renders.length, 1);
  assert.equal(viewer.pdf, replacement);
});
