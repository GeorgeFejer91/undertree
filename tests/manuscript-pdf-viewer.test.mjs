import test from 'node:test';
import assert from 'node:assert/strict';
import { ManuscriptPdfViewer } from '../modules/frontend/manuscript-pdf-viewer.js';

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
