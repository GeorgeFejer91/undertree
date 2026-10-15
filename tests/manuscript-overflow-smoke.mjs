import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { chromium } from 'playwright-core';
import { createServer } from 'vite';

const root = resolve('.');
const artifacts = resolve('artifacts/manuscript-overflow');
const chromeReceipts = [];

// Use the real markup, stylesheet and Pretext observer without starting the app or its backend.
async function fixtureServer() {
  const cacheDir = await mkdtemp(join(tmpdir(), 'undertree-overflow-vite-'));
  const server = await createServer({
    root,
    cacheDir,
    configFile: false,
    appType: 'custom',
    optimizeDeps: { noDiscovery: true, include: ['@chenglou/pretext'] },
    server: { host: '127.0.0.1', port: 0, watch: null },
    plugins: [{
      name: 'manuscript-overflow-fixture',
      configureServer(vite) {
        vite.middlewares.use('/overflow-fixture', async (_request, response, next) => {
          try {
            const source = await readFile(resolve(root, 'manuscript.html'), 'utf8');
            const html = source.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '')
              .replace('</head>', '<link rel="stylesheet" href="/src/manuscript.css"></head>')
              .replace('</body>', `<script type="module">
                import { observeReviewText } from '/modules/frontend/review-text-layout.js';
                document.querySelector('#review-app').classList.add('native-window');
                document.querySelector('#window-titlebar').hidden = false;
                window.disposeTextFixture = observeReviewText(document.body);
                await document.fonts.ready;
                window.textFixtureReady = true;
              </script></body>`);
            response.setHeader('Content-Type', 'text/html');
            response.end(await vite.transformIndexHtml('/overflow-fixture', html));
          } catch (error) { next(error); }
        });
      },
    }],
  });
  await server.listen();
  return { server, cacheDir, url: `http://127.0.0.1:${server.httpServer.address().port}/overflow-fixture` };
}

async function settle(page) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function reset(page, url, width = 1100, height = 900, font = 14) {
  await page.setViewportSize({ width, height });
  await page.goto(url);
  await page.waitForFunction(() => window.textFixtureReady);
  await page.evaluate(font => { document.documentElement.style.fontSize = `${font}px`; }, font);
  await settle(page);
}

async function assertChrome(page, label) {
  const receipt = await page.evaluate(() => {
    const errors = [];
    const panels = '.window-titlebar,.review-topbar,.pane-heading,.manuscript-toolbar,.pdf-toolbar,.mobile-views,.review-status,.text-details-slot';
    for (const panel of document.querySelectorAll(panels)) {
      const bounds = panel.getBoundingClientRect();
      if (!panel.getClientRects().length || !bounds.width || !bounds.height) continue;
      if (panel.scrollWidth > panel.clientWidth + 1 || panel.scrollHeight > panel.clientHeight + 2) errors.push(`${panel.className}: internal overflow`);
      if (bounds.left < -1 || bounds.right > innerWidth + 1 || bounds.top < -1 || bounds.bottom > innerHeight + 1) errors.push(`${panel.className}: outside viewport`);
      for (const control of panel.querySelectorAll('button,h2,summary,input,select')) {
        const box = control.getBoundingClientRect();
        // Popovers/dialogs have their own viewport policy rather than toolbar geometry.
        if (!control.getClientRects().length || !box.width || !box.height || control.closest('.workspace-menu-panel,dialog')) continue;
        if (box.left < bounds.left - 1 || box.right > bounds.right + 1 || box.top < bounds.top - 1 || box.bottom > bounds.bottom + 1) errors.push(`${control.id || control.tagName}: outside ${panel.className}`);
      }
    }
    const source = document.querySelector('#manuscript-source').getBoundingClientRect();
    if (source.height <= 0 || source.bottom > innerHeight + 1) errors.push('manuscript source has no usable allocated region');
    if (document.documentElement.scrollWidth > innerWidth + 1 || document.documentElement.scrollHeight > innerHeight + 1) errors.push('document overflow');
    return { errors, width: innerWidth, height: innerHeight, fontSize: getComputedStyle(document.documentElement).fontSize, sourceHeight: source.height };
  });
  chromeReceipts.push({ label, ...receipt });
  assert.deepEqual(receipt.errors, [], label);
}

async function assertFullMessage(page, selector, message, { capture = false, context = [] } = {}) {
  const source = page.locator(selector);
  await source.evaluate((element, message) => { element.hidden = false; element.textContent = message; }, message);
  await page.waitForFunction(selector => {
    const source = document.querySelector(selector);
    return [...document.querySelectorAll('.text-details-active')].some(slot => slot.contains(source)
      && [...slot.children].some(child => child.matches('.text-details-button') && child.getClientRects().length));
  }, selector);
  assert.equal(await source.textContent(), message, 'fitting preserves the complete original message');
  const button = page.locator('.text-details-active').filter({ has: page.locator(selector) }).locator(':scope > .text-details-button:visible');
  assert.equal(await button.isVisible(), true, 'overflow exposes its full-value route');
  assert.ok(await button.getAttribute('aria-label'), 'details button has an accessible name');
  if (capture) await page.screenshot({ path: join(artifacts, 'status-320-200.png') });
  await button.focus();
  await page.keyboard.press('Enter');
  const dialog = page.locator('dialog.text-details-dialog[open]');
  await dialog.waitFor();
  const fullMessage = await dialog.locator('.text-details-message').textContent();
  if (context.length) {
    assert.ok(fullMessage.includes(message), 'the compact whole-footer route reveals every diagnostic character');
    for (const value of context) assert.ok(fullMessage.includes(value), `the compact footer retains ${value}`);
  } else assert.equal(fullMessage, message, 'keyboard activation reveals every character');
  assert.deepEqual(await dialog.evaluate(element => ({
    scrollTop: element.scrollTop,
    messageFocused: element.querySelector('.text-details-message') === document.activeElement,
  })), { scrollTop: 0, messageFocused: true }, 'long details open at the beginning with the message focused');
  if (capture) await page.screenshot({ path: join(artifacts, 'status-details-320-200.png') });
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(await button.evaluate(element => element === document.activeElement), true, 'closing details restores keyboard focus');
  assert.equal(await source.textContent(), message, 'opening details never rewrites the message');
  return { source, button };
}

test('manuscript bounded text reflows without losing source space or full messages', { timeout: 90_000 }, async t => {
  const { server, cacheDir, url } = await fixtureServer();
  let browser;
  try {
    await mkdir(artifacts, { recursive: true });
    browser = await chromium.launch({ executablePath: process.env.UNDERTREE_CHROME || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
    const page = await browser.newPage();
    const scriptErrors = [];
    const backendRequests = [];
    page.on('pageerror', error => scriptErrors.push(error.message));
    page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/')) backendRequests.push(request.url()); });

    await t.test('long German pane headings stay within the resized sidebar', async () => {
      await reset(page, url);
      await page.locator('#files-heading').evaluate(element => { element.textContent = 'Datenverzeichnisübersicht'; });
      await settle(page);
      await assertChrome(page, 'long unbroken German heading');
      assert.equal(await page.locator('#files-heading').textContent(), 'Datenverzeichnisübersicht');
    });

    await t.test('localized Recompile wraps inside an 80:20 source/PDF split at 200% text', async () => {
      await reset(page, url, 1100, 900, 28);
      await page.evaluate(() => {
        const workspace = document.querySelector('.review-workspace');
        workspace.style.setProperty('--editor-size', '.8fr');
        workspace.style.setProperty('--preview-size', '.2fr');
        const button = document.querySelector('#typst-compile');
        button.hidden = false;
        button.textContent = 'Recompiler le document';
      });
      await settle(page);
      await assertChrome(page, 'narrow preview with full French action');
      assert.equal(await page.locator('#typst-compile').textContent(), 'Recompiler le document');
      assert.equal(await page.locator('#typst-compile').evaluate(element => getComputedStyle(element).fontSize), '28px', 'user enlargement is preserved');
    });

    await t.test('mobile labels handle French, Unicode and text-spacing overrides', async () => {
      await reset(page, url, 320, 900, 28);
      await page.locator('.mobile-views [data-view="preview"]').evaluate(element => { element.textContent = 'Prévisualisation'; });
      await settle(page);
      await assertChrome(page, 'French mobile label at 200%');
      await page.locator('.mobile-views [data-view="review"]').evaluate(element => { element.textContent = '資料🧪e\u0301確認'; });
      await page.addStyleTag({ content: 'button,summary,p,label {line-height:1.5!important;letter-spacing:.12em!important;word-spacing:.16em!important} p {margin-bottom:2em!important}' });
      await settle(page);
      await assertChrome(page, 'mobile Unicode and user text spacing');
    });

    await t.test('long save errors retain source space and keyboard-accessible complete details', async () => {
      const message = `Could not save /${'長い研究資料🧪e\u0301/'.repeat(30)}manuscript.typ: the source on disk changed.`;
      for (const height of [900, 480]) {
        await reset(page, url, 320, height, 28);
        const { source, button } = await assertFullMessage(page, '#review-status', message, {
          capture: height === 480,
          context: height === 480 ? ['No file open', 'ChatGPT disconnected'] : [],
        });
        await assertChrome(page, `long footer error at ${height}px height`);
        await source.evaluate(element => { element.textContent = 'Saved.'; });
        if (height === 480) {
          await settle(page);
          assert.equal(await button.isVisible(), true, 'the entire short-window footer retains its compact route');
          await assertChrome(page, 'short footer remains bounded at minimum height');
          await page.setViewportSize({ width: 320, height: 900 });
        }
        await page.waitForFunction(() => document.querySelector('#review-status').getClientRects().length > 0 && !document.querySelector('#review-status').closest('.text-details-active'));
        assert.equal(await button.isVisible(), false, 'short status returns inline when height permits');
        await assertChrome(page, `short footer restored after ${height}px height`);
      }
    });

    await t.test('native-window errors use the same bounded full-message route', async () => {
      const message = `Window could not close: saving /${'unaufgelöste-Verzeichnisänderungen/'.repeat(30)}main.typ failed. Your buffer is preserved.`;
      for (const height of [900, 480]) {
        await reset(page, url, 320, height, 28);
        const { source, button } = await assertFullMessage(page, '#window-error', message);
        await assertChrome(page, `long window error at ${height}px height`);
        await source.evaluate(element => { element.textContent = 'Retry saving.'; });
        await page.waitForFunction(() => document.querySelector('#window-error').getClientRects().length > 0 && !document.querySelector('#window-error').closest('.text-details-active'));
        assert.equal(await button.isVisible(), false, 'short window notice returns inline');
        await assertChrome(page, `short window notice restored at ${height}px height`);
      }
    });

    await t.test('long open-file tabs stay keyboard-scrollable without exhausting minimum-height source', async () => {
      await reset(page, url, 320, 480, 28);
      const filename = `${'研究資料🧪e\u0301確認-'.repeat(14)}manuscript.typ`;
      await page.locator('#manuscript-tabs').evaluate((tabs, filename) => {
        const tab = document.createElement('div');
        tab.className = 'manuscript-tab';
        const label = document.createElement('button');
        label.type = 'button';
        label.setAttribute('role', 'tab');
        label.setAttribute('aria-selected', 'true');
        label.dataset.measure = '';
        label.textContent = filename;
        const close = document.createElement('button');
        close.type = 'button';
        close.setAttribute('aria-label', `Close ${filename}`);
        close.textContent = '×';
        tab.append(label, close);
        tabs.append(tab);
      }, filename);
      const saveError = `Could not save /${'資料/'.repeat(80)}main.typ. The source changed on disk.`;
      await assertFullMessage(page, '#review-status', saveError, { context: ['No file open', 'ChatGPT disconnected'] });
      await assertFullMessage(page, '#window-error', `Window could not close: ${'unaufgelöste-Änderungen/'.repeat(35)}the manuscript buffer is preserved.`);
      await assertChrome(page, 'populated tabs and simultaneous long errors at minimum size');
      const tabs = page.locator('#manuscript-tabs');
      const label = tabs.locator('[role="tab"]');
      const close = tabs.locator('button[aria-label^="Close "]');
      assert.equal(await label.textContent(), filename, 'the complete Unicode filename is retained');
      assert.equal(await close.getAttribute('aria-label'), `Close ${filename}`, 'Close retains the full accessible filename');
      const geometry = await tabs.evaluate(element => ({
        scrollWidth: element.scrollWidth, clientWidth: element.clientWidth,
        scrollHeight: element.scrollHeight, clientHeight: element.clientHeight,
        top: element.getBoundingClientRect().top, bottom: element.getBoundingClientRect().bottom,
        tabIndex: element.tabIndex,
      }));
      assert.ok(geometry.scrollWidth > geometry.clientWidth, 'long filenames remain in the horizontal inventory');
      assert.ok(geometry.scrollHeight <= geometry.clientHeight + 2, 'the filename inventory has no vertical overflow');
      assert.ok(geometry.top >= 0 && geometry.bottom <= 480, 'the inventory remains inside the window');
      assert.equal(geometry.tabIndex, 0, 'the horizontal inventory is keyboard focusable');
      assert.equal(await label.evaluate(element => element.scrollWidth <= element.clientWidth + 1), true, 'the label itself retains the full single-line filename');
      await tabs.focus();
      await page.keyboard.press('ArrowRight');
      await page.waitForFunction(() => document.querySelector('#manuscript-tabs').scrollLeft > 0);
      assert.equal(await tabs.evaluate(element => document.activeElement === element && element.matches(':focus-visible') && getComputedStyle(element).outlineStyle !== 'none'), true, 'keyboard scrolling keeps visible focus on the inventory');
      await page.keyboard.press('Tab');
      assert.equal(await label.evaluate(element => document.activeElement === element), true, 'the file tab remains in keyboard order');
      await page.keyboard.press('Tab');
      assert.equal(await close.evaluate(element => document.activeElement === element), true, 'Close is reachable from the inventory using Tab');
      assert.equal(await close.evaluate(element => {
        const box = element.getBoundingClientRect();
        const bounds = element.closest('#manuscript-tabs').getBoundingClientRect();
        return box.left >= bounds.left - 1 && box.right <= bounds.right + 1 && box.top >= bounds.top - 1 && box.bottom <= bounds.bottom + 1;
      }), true, 'keyboard focus scrolls Close into the visible inventory');
      await assertChrome(page, 'long filename scrolled to keyboard-accessible Close');
      await page.screenshot({ path: join(artifacts, 'tabs-320-200.png') });
    });

    await t.test('width/height breakpoints and contraction/regrowth preserve bounded chrome', async () => {
      await reset(page, url);
      for (const [width, height, font] of [[320, 480, 14], [320, 480, 28], [320, 900, 28], [500, 700, 14], [501, 700, 14], [900, 480, 14], [901, 600, 14], [1100, 480, 28], [1600, 1000, 14], [320, 900, 28], [1600, 1000, 14]]) {
        await page.setViewportSize({ width, height });
        await page.evaluate(font => { document.documentElement.style.fontSize = `${font}px`; }, font);
        await settle(page);
        await assertChrome(page, `${width}×${height}, ${font}px`);
      }
    });

    await t.test('expanding a status slot restores the full unchanged text inline', async () => {
      await reset(page, url, 320, 900, 28);
      const message = `Saved manuscript: ${'分析🧪e\u0301資料'.repeat(8)} / main.typ`;
      const { source, button } = await assertFullMessage(page, '#review-status', message);
      await page.setViewportSize({ width: 1600, height: 1000 });
      await page.evaluate(() => { document.documentElement.style.fontSize = '14px'; });
      await page.waitForFunction(() => document.querySelector('#review-status').getClientRects().length > 0 && !document.querySelector('#review-status').closest('.text-details-active'));
      assert.equal(await source.textContent(), message);
      assert.equal(await button.isVisible(), false, 'fitting text grows back into the expanded slot');
      await assertChrome(page, 'expanded full status');
    });

    await t.test('removed and replaced messages are never resurrected by observer cleanup', async () => {
      await reset(page, url, 320, 900, 28);
      const message = `Could not save ${'資料/'.repeat(80)}main.typ`;
      await assertFullMessage(page, '#review-status', message);
      await page.locator('#review-status').evaluate(element => element.remove());
      await settle(page);
      assert.equal(await page.locator('#review-status').count(), 0, 'removing the source does not reinsert its ID');
      assert.equal(await page.locator('.text-details-dialog').count(), 0, 'removed source leaves no detached details dialog');

      await reset(page, url, 320, 900, 28);
      await assertFullMessage(page, '#review-status', message);
      await page.locator('#review-status').evaluate(element => {
        const replacement = document.createElement('span');
        replacement.id = element.id;
        replacement.dataset.textDetails = element.dataset.textDetails;
        replacement.textContent = 'Replacement saved.';
        element.replaceWith(replacement);
      });
      await settle(page);
      assert.equal(await page.locator('#review-status').count(), 1, 'replacement keeps exactly one status ID');
      assert.equal(await page.locator('#review-status').textContent(), 'Replacement saved.', 'cleanup preserves the new source');
    });

    await t.test('disposing an open details dialog does not steal later keyboard focus', async () => {
      await reset(page, url, 320, 900, 28);
      const { button } = await assertFullMessage(page, '#review-status', 'Failed to save ' + '資料/'.repeat(80));
      await button.focus();
      await page.keyboard.press('Enter');
      await page.locator('dialog.text-details-dialog[open]').waitFor();
      await page.evaluate(() => {
        window.disposeTextFixture();
        const target = document.createElement('button');
        target.id = 'after-dispose-focus';
        target.textContent = 'Continue';
        document.body.append(target);
        target.focus();
      });
      await settle(page);
      assert.equal(await page.locator('.text-details-dialog').count(), 0, 'dispose removes the open dialog');
      assert.equal(await page.locator('#after-dispose-focus').evaluate(element => document.activeElement === element), true, 'queued dialog close cannot redirect focus after dispose');
    });

    assert.deepEqual(scriptErrors, [], 'real Pretext observer has no script errors');
    assert.deepEqual(backendRequests, [], 'fixture never starts application operations');
    await writeFile(join(artifacts, 'receipt.json'), JSON.stringify({ generatedAt: new Date().toISOString(), engine: 'Chromium; actual HTML/CSS with real Pretext observer; no app/backend', chrome: chromeReceipts, scriptErrors, backendRequests }, null, 2) + '\n');
  } finally {
    await browser?.close();
    await server.close();
    await rm(cacheDir, { recursive: true, force: true });
  }
});
