import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';

const source = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const dialogs = [...source.matchAll(/<dialog\b[\s\S]*?<\/dialog>/g)].map(match => match[0]).join('');
const fixture = `<!doctype html><html lang="en"><head><meta charset="utf-8"><link rel="stylesheet" href="/src/styles.css"></head><body>
<button id="opener">Open dialog</button>${dialogs}<script type="module">
import { createLegacyDialog } from '/src/legacy-dialog.js';
window.showDialog = createLegacyDialog(document.querySelector('#legacy-action-dialog'));
window.ready = true;
</script></body></html>`;
const server = await createServer({
  configFile: false, cacheDir: 'artifacts/ui-popups/vite-cache', logLevel: 'error', optimizeDeps: { noDiscovery: true, include: ['@chenglou/pretext'] }, server: { host: '127.0.0.1', port: 0, watch: null },
  plugins: [{ name: 'legacy-popup-fixture', configureServer(vite) {
    vite.middlewares.use((request, response, next) => {
      if (request.url === '/__legacy_popup_fixture') { response.setHeader('Content-Type', 'text/html'); response.end(fixture); }
      else next();
    });
  } }],
});
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__legacy_popup_fixture`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.ready);
  assert.equal(await page.evaluate(async () => {
    const dialog = document.querySelector('#legacy-action-dialog');
    dialog.show();
    try { await window.showDialog('Cannot become modal while already nonmodal'); }
    catch (error) { dialog.close(); return error.name; }
    return 'no error';
  }), 'InvalidStateError');
  const open = async (text, options) => {
    await page.locator('#opener').focus();
    await page.evaluate(([text, options]) => { window.result = 'pending'; window.showDialog(text, options).then(result => { window.result = result; }); }, [text, options]);
  };
  await open('Rename file:', { value: 'methods.tex', action: 'Rename' });
  assert.equal(await page.locator('#legacy-dialog-value').inputValue(), 'methods.tex');
  assert.equal(await page.locator('#legacy-dialog-value').evaluate(element => document.activeElement === element && element.selectionEnd === element.value.length), true);
  await page.locator('#legacy-dialog-value').fill('results.tex');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.result === 'results.tex');
  assert.equal(await page.locator('#opener').evaluate(element => document.activeElement === element), true);
  await open('Delete “methods.tex”?', { action: 'Delete' });
  assert.equal(await page.locator('[data-dialog-cancel]').evaluate(element => document.activeElement === element), true);
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.result === null);
  await open('Delete “methods.tex”?', { action: 'Delete' });
  await page.locator('[data-dialog-accept]').click();
  await page.waitForFunction(() => window.result === true);
  await open('New file:', { value: '', action: 'Create' });
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => window.result === null);
  await open('New file:', { value: '', action: 'Create' });
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.result === '');
  await open('Rename file:', { value: 'methods.tex', action: 'Rename' });
  assert.equal(await page.evaluate(() => window.showDialog('Concurrent action')), null);
  await page.keyboard.press('Tab');
  assert.equal(await page.locator('[data-dialog-cancel]').evaluate(element => document.activeElement === element), true);
  await page.keyboard.press('Tab');
  assert.equal(await page.locator('[data-dialog-accept]').evaluate(element => document.activeElement === element), true);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => window.result === null);
  for (const [width, height, scale] of [[320, 640, 1], [900, 300, 1], [900, 900, 1], [640, 480, 1], [640, 720, 2], [320, 640, 2]]) {
    await page.setViewportSize({ width, height });
    await page.evaluate(scale => { document.documentElement.style.fontSize = `${16 * scale}px`; }, scale);
    await open('Rename file:', { value: 'methods.tex', action: 'Rename' });
    await page.waitForFunction(() => ['fit', 'no-fit', 'unavailable', 'reflow'].includes(document.querySelector('[data-dialog-accept]').dataset.textFit));
    assert.equal(await page.locator('[data-dialog-accept]').getAttribute('data-text-fit'), 'fit', `${width}×${height} at ${scale}× text Pretext action`);
    const bounds = await page.locator('#legacy-action-dialog').evaluate(dialog => {
      const shell = dialog.getBoundingClientRect();
      return [dialog, ...dialog.querySelectorAll('form, header, .legacy-dialog-body, footer, button, input:not([hidden]), label:not([hidden])')].map(element => {
        const rect = element.getBoundingClientRect();
        return { tag: element.tagName, overflow: element.scrollWidth > element.clientWidth + 2 || element.scrollHeight > element.clientHeight + 2, inside: rect.left >= shell.left - 1 && rect.right <= shell.right + 1 && rect.top >= shell.top - 1 && rect.bottom <= shell.bottom + 1 };
      });
    });
    assert.deepEqual(bounds.filter(item => item.overflow || !item.inside), [], `${width}×${height} at ${scale}× text`);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => window.result === null);
    await page.evaluate(() => {
      const dialog = document.querySelector('#project-modal');
      document.querySelector('#project-list').innerHTML = '<button class="project-row"><span class="project-monogram">UT</span><span class="project-details"><strong>Long localized manuscript project name with all its words</strong><small>chapter/files/methods-and-results</small></span><span class="project-row-meta"><span class="project-engine">TeX</span><small>Edited October 17, 2026</small></span></button>';
      dialog.showModal();
    });
    const project = await page.locator('#project-modal').evaluate(dialog => {
      const rect = dialog.getBoundingClientRect();
      return { horizontalOverflow: dialog.scrollWidth > dialog.clientWidth + 2, verticalOverflow: dialog.scrollHeight > dialog.clientHeight + 2, inside: rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight };
    });
    const overflowing = await page.locator('#project-modal').evaluate(dialog => [...dialog.querySelectorAll('*')].filter(element => element.scrollWidth > element.clientWidth + 2).map(element => `${element.tagName}.${element.className} (${element.clientWidth}/${element.scrollWidth})`));
    assert.deepEqual(project, { horizontalOverflow: false, verticalOverflow: false, inside: true }, `Project ${width}×${height} at ${scale}× text ${overflowing.join(', ')}`);
    await page.keyboard.press('Escape');
  }
  await page.setViewportSize({ width: 900, height: 700 });
  await page.evaluate(() => { document.documentElement.style.fontSize = '16px'; });
  await open('Eine lokale Datei mit einem längeren Namen umbenennen:', { value: 'ergebnisse-mit-lokalisiertem-namen.tex', action: 'Umbenennen' });
  await page.waitForFunction(() => document.querySelector('[data-dialog-accept]').dataset.textFit === 'fit');
  assert.equal(await page.locator('label[for="legacy-dialog-value"]').textContent(), 'Eine lokale Datei mit einem längeren Namen umbenennen:');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => window.result === null);
  const textSpacing = await page.addStyleTag({ content: '.legacy-action-dialog * { line-height: 1.5 !important; letter-spacing: .12em !important; word-spacing: .16em !important; } .legacy-action-dialog p { margin-bottom: 2em !important; }' });
  await open('Rename file:', { value: 'methods.tex', action: 'Rename' });
  assert.equal(await page.locator('#legacy-action-dialog').evaluate(dialog => [dialog, ...dialog.querySelectorAll('form, .legacy-dialog-body, footer, button')].some(element => element.scrollWidth > element.clientWidth + 2 || element.scrollHeight > element.clientHeight + 2)), false);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => window.result === null);
  await textSpacing.evaluate(element => element.remove());
  await open('Rename file:', { value: 'methods.tex', action: 'Rename' });
  const contracted = await page.locator('.legacy-dialog-body').evaluate(element => parseFloat(getComputedStyle(element).rowGap));
  await page.locator('#legacy-action-dialog').evaluate(element => { element.style.height = '400px'; });
  const stretched = await page.locator('.legacy-dialog-body').evaluate(element => parseFloat(getComputedStyle(element).rowGap));
  assert.ok(stretched > contracted, 'extra dialog height must increase group separation');
  await page.locator('#legacy-action-dialog').evaluate(element => { element.style.height = ''; });
  await mkdir('artifacts/ui-popups', { recursive: true });
  await page.screenshot({ path: 'artifacts/ui-popups/legacy-rename.png' });
  assert.deepEqual(errors, []);
  console.log('Legacy popup controls: prompt/confirm/cancel, focus, Pretext and six viewport/text-size cases passed.');
} finally {
  await browser?.close();
  await server.close();
}
