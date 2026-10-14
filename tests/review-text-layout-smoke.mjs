import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>
* { box-sizing: border-box; }
[hidden] { display: none !important; }
html { font-size: 14px; }
body { margin: 0; padding: 12px; font: 1rem/1.5 Arial, sans-serif; }
#chrome { display: grid; gap: 12px; width: 800px; }
button { font: inherit; display: flex; align-items: center; gap: 10px; padding: 8px; border: 1px solid #666; min-width: 0; height: 44px; }
[data-text-label] { display: block; flex: 1; min-width: 0; white-space: nowrap; }
#icon-control { width: 260px; }
#icon-slot { display: block; width: 16px; height: 20px; flex: none; }
#typography { width: 360px; }
#late-font { font-family: UnderTreeLateFontFixture, Arial, sans-serif; width: 104px; white-space: nowrap; }
#wrapping { width: 260px; height: 64px; white-space: pre-wrap; display: block; text-align: left; }
#regrow-panel { container-type: size; width: 800px; height: 360px; border: 1px solid #666; }
#regrowing { width: 100%; height: 68px; font-size: clamp(1rem, min(2cqw, 4cqh), 1.285714rem); }
#source { width: 600px; height: 180px; }
.cm-editor { height: 180px; }
.cm-scroller { overflow: auto; }
#detail-route { max-width: 360px; overflow-wrap: anywhere; }
</style></head><body><section id="chrome">
<button id="icon-control" data-measure data-lines="1"><span id="icon-slot" aria-hidden="true"></span><span id="icon-label" data-text-label>A label next to an icon</span></button>
<button id="typography" data-measure data-lines="1"><span id="typography-label" data-text-label>Typography stays readable</span></button>
<button id="late-font" data-measure data-lines="1">iiiiiiiiiiiiii</button>
<div id="wrapping" data-measure data-lines="2">First forced line\nSecond forced line</div>
<div id="regrow-panel"><button id="regrowing" data-measure data-lines="1">Preferred readable type regrows</button></div>
<button id="reveal" data-measure hidden>Revealed control</button>
<details id="detail-route"><summary>Full label</summary><p tabindex="0">A label next to an icon</p></details>
</section><section id="source" aria-label="Synthetic manuscript editor"></section></body></html>`;
const virtualModule = '/__review_text_layout_fixture.js';
const server = await createServer({
  configFile: false,
  root: resolve('.'),
  logLevel: 'error',
  server: { host: '127.0.0.1', port: 0 },
  plugins: [{
    name: 'review-text-layout-fixture',
    resolveId(id) { if (id === virtualModule) return '\0review-text-layout-fixture'; },
    load(id) {
      if (id === '\0review-text-layout-fixture') return `export { observeReviewText } from '/modules/frontend/review-text-layout.js'; export { EditorView, basicSetup } from 'codemirror'; export { EditorState } from '@codemirror/state'; export { prepareWithSegments, measureNaturalWidth, measureLineStats } from '@chenglou/pretext';`;
    },
    configureServer(vite) {
      vite.middlewares.use((request, response, next) => {
        if (request.url === '/__review_text_layout_fixture.html') { response.setHeader('Content-Type', 'text/html'); response.end(html); }
        else next();
      });
    },
  }],
});
let browser;
const observations = [];
try {
  await server.listen();
  const address = server.httpServer.address();
  const base = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ ...(process.env.UNDERTREE_CHROME ? { executablePath: process.env.UNDERTREE_CHROME } : { channel: 'chrome' }), headless: true, args: process.platform === 'linux' ? ['--no-sandbox'] : [] });
  const page = await browser.newPage({ viewport: { width: 1100, height: 1000 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${base}/__review_text_layout_fixture.html`);
  await page.evaluate(async moduleUrl => {
    window.fixture = await import(moduleUrl);
    await document.fonts.ready;
    window.counters = { rootQueries: 0, chromeStyleReads: 0, fontMeasurements: 0 };
    const bodyQuery = document.body.querySelectorAll;
    document.body.querySelectorAll = function(selector) { counters.rootQueries += 1; return bodyQuery.call(this, selector); };
    const computed = window.getComputedStyle;
    window.getComputedStyle = function(element, ...rest) { if (element.closest?.('#chrome')) counters.chromeStyleReads += 1; return computed.call(this, element, ...rest); };
    for (const prototype of [window.CanvasRenderingContext2D?.prototype, window.OffscreenCanvasRenderingContext2D?.prototype].filter(Boolean)) {
      const measure = prototype.measureText;
      prototype.measureText = function(...args) { counters.fontMeasurements += 1; return measure.apply(this, args); };
    }
    window.view = new fixture.EditorView({ state: fixture.EditorState.create({ doc: 'Synthetic source remains readable.\n', extensions: [fixture.basicSetup] }), parent: document.querySelector('#source') });
    window.stopMeasurement = fixture.observeReviewText(document.body);
  }, virtualModule);
  const settle = async () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)))));
  const fit = async id => page.locator(`#${id}`).getAttribute('data-text-fit');
  await page.waitForFunction(() => document.querySelector('#icon-control').dataset.textFit === 'fit');
  await settle();

  const initial = await page.evaluate(() => ({ ...counters }));
  await page.locator('.cm-content').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('Typing into CodeMirror must not rescan finite controls.');
  await settle();
  const typed = await page.evaluate(() => ({ ...counters }));
  assert.equal(typed.rootQueries - initial.rootQueries, 0, 'CodeMirror keystrokes do not rescan the root');
  assert.equal(typed.chromeStyleReads - initial.chromeStyleReads, 0, 'CodeMirror keystrokes do not remeasure unrelated chrome');
  observations.push({ check: 'real_codemirror_keystrokes', rootRescans: typed.rootQueries - initial.rootQueries, chromeStyleReads: typed.chromeStyleReads - initial.chromeStyleReads });

  const iconBudget = await page.evaluate(() => {
    const button = document.querySelector('#icon-control');
    const label = document.querySelector('#icon-label');
    const style = getComputedStyle(label);
    const font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    const natural = fixture.measureNaturalWidth(fixture.prepareWithSegments(label.textContent, font));
    const painted = document.createRange(); painted.selectNodeContents(label);
    return { natural, renderedTextWidth: painted.getBoundingClientRect().width, outerWidth: button.clientWidth, labelWidth: label.clientWidth, fontSize: parseFloat(style.fontSize) };
  });
  assert.ok(iconBudget.natural <= iconBudget.labelWidth + 1);
  assert.ok(Math.abs(iconBudget.natural - iconBudget.renderedTextWidth) <= 1, 'Pretext and actual rendered glyph width agree within one CSS pixel');
  await page.locator('#icon-slot').evaluate(icon => { icon.style.width = '160px'; });
  await settle();
  assert.equal(await fit('icon-control'), 'no-fit', 'a changed icon slot invalidates its fixed-size parent control');
  const narrowBudget = await page.evaluate(() => ({ labelWidth: document.querySelector('#icon-label').clientWidth, outerWidth: document.querySelector('#icon-control').clientWidth, fontSize: parseFloat(getComputedStyle(document.querySelector('#icon-label')).fontSize) }));
  assert.equal(narrowBudget.outerWidth, iconBudget.outerWidth, 'outer control geometry stays fixed');
  assert.equal(narrowBudget.fontSize, iconBudget.fontSize, 'no-fit never shrinks the CSS-preferred readable text');
  assert.ok(iconBudget.natural > narrowBudget.labelWidth && iconBudget.natural < narrowBudget.outerWidth, 'text fits the whole button but exceeds the actual label budget');
  assert.equal(await page.locator('#icon-label').textContent(), 'A label next to an icon');
  await page.locator('#detail-route summary').click();
  await page.locator('#detail-route p').focus();
  assert.equal(await page.locator('#detail-route p').textContent(), 'A label next to an icon', 'explicit no-fit detail route preserves the full value');
  await page.locator('#icon-slot').evaluate(icon => { icon.style.width = '16px'; });
  await settle();
  assert.equal(await fit('icon-control'), 'fit');
  observations.push({ check: 'icon_slot_budget_and_recovery', ...iconBudget, narrowLabelWidth: narrowBudget.labelWidth, recovered: true });

  assert.equal(await fit('wrapping'), 'fit', 'pre-wrap forced lines use the computed whitespace contract');
  await page.locator('#typography-label').evaluate(label => { label.style.letterSpacing = '8px'; });
  await settle();
  assert.equal(await fit('typography'), 'no-fit', 'label-slot spacing changes invalidate the owning control');
  await page.locator('#typography-label').evaluate(label => { label.style.letterSpacing = ''; label.style.wordSpacing = '.16em'; });
  await settle();
  assert.equal(await fit('typography'), 'unavailable', 'unsupported word spacing retains a readable DOM fallback without claiming Pretext fit');
  await page.locator('#typography-label').evaluate(label => { label.style.wordSpacing = ''; });
  await settle();
  assert.equal(await fit('typography'), 'fit');
  const beforeLanguage = await page.evaluate(() => counters.fontMeasurements);
  await page.evaluate(() => { document.documentElement.lang = 'de'; });
  await settle();
  assert.ok(await page.evaluate(() => counters.fontMeasurements) > beforeLanguage, 'locale invalidation clears prepared and underlying font caches');
  observations.push({ check: 'whitespace_spacing_and_locale', forcedLinesFit: true, unsupportedSpacing: 'unavailable', localeReprepared: true });

  assert.equal(await fit('late-font'), 'fit');
  const measurementsBeforeFont = await page.evaluate(() => counters.fontMeasurements);
  await page.evaluate(async () => {
    const font = new FontFace('UnderTreeLateFontFixture', 'local("Liberation Mono"), local("DejaVu Sans Mono"), local("Courier New")');
    document.fonts.add(font);
    await font.load();
    await document.fonts.ready;
  });
  await settle();
  assert.equal(await fit('late-font'), 'no-fit', 'late-loaded font metrics replace fallback-font measurements');
  assert.ok(await page.evaluate(() => counters.fontMeasurements) > measurementsBeforeFont);
  observations.push({ check: 'late_font_invalidation', initial: 'fit', loaded: 'no-fit', measurementsReprepared: true });

  const sizes = [];
  for (const [width, height] of [[1000, 500], [320, 500], [1000, 140], [320, 140], [1000, 500]]) {
    await page.locator('#regrow-panel').evaluate((panel, size) => { panel.style.width = `${size[0]}px`; panel.style.height = `${size[1]}px`; }, [width, height]);
    await settle();
    sizes.push(await page.locator('#regrowing').evaluate(button => parseFloat(getComputedStyle(button).fontSize)));
  }
  assert.ok(sizes[0] > sizes[1] && sizes[0] > sizes[2], 'CSS type budgets depend independently on panel width and height');
  assert.equal(sizes[4], sizes[0], 'preferred type regrows after contraction');
  assert.ok(sizes.every(size => size >= 14), 'measurement does not shrink below the CSS readability floor');
  await page.evaluate(() => { document.documentElement.style.fontSize = '28px'; });
  await settle();
  assert.ok(await page.locator('#regrowing').evaluate(button => parseFloat(getComputedStyle(button).fontSize)) >= 28, '200% user text scale is preserved');
  observations.push({ check: 'two_axis_css_regrowth_and_text_enlargement', sizes, userTextScalePreserved: true });

  await page.evaluate(() => { document.documentElement.style.fontSize = ''; });
  await settle();
  assert.equal(await fit('reveal'), 'deferred');
  await page.locator('#reveal').evaluate(button => { button.hidden = false; });
  await settle();
  assert.equal(await fit('reveal'), 'fit');
  await page.evaluate(() => {
    const button = document.createElement('button');
    button.id = 'added-control'; button.textContent = 'Added finite control';
    document.querySelector('#chrome').append(button);
  });
  await settle();
  assert.equal(await fit('added-control'), 'fit', 'new finite controls are registered without a root scan');
  const beforeDispose = await page.evaluate(() => { stopMeasurement(); return { ...counters }; });
  await page.locator('#typography').evaluate(button => { button.textContent = 'After disposal'; });
  await settle();
  const afterDispose = await page.evaluate(() => ({ ...counters }));
  assert.equal(afterDispose.chromeStyleReads, beforeDispose.chromeStyleReads, 'disposal stops observers and scheduled work');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, observations }));
} finally {
  await browser?.close();
  await server.close();
}
