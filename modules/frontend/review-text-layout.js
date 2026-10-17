import { clearCache, setLocale, prepareWithSegments, measureLineStats, measureNaturalWidth } from '@chenglou/pretext';
import { createTextDetails } from './text-details.js';

const controls = '[data-measure], [data-text-details], button, summary, h2, h3, [role="status"], [role="alert"]';
const documentContent = '.cm-editor, [contenteditable="true"], iframe, canvas';
const pixels = value => parseFloat(value) || 0;

function textBox(element, style) {
  const label = element.querySelector(':scope > [data-text-label]');
  if (label) return textBox(label, getComputedStyle(label));
  let width = element.clientWidth - pixels(style.paddingLeft) - pixels(style.paddingRight);
  const height = element.clientHeight - pixels(style.paddingTop) - pixels(style.paddingBottom);
  if (['flex', 'inline-flex', 'grid', 'inline-grid'].includes(style.display)) {
    for (const icon of element.children) {
      if (icon.matches('svg, [aria-hidden="true"]') && !icon.textContent.trim()) {
        const iconStyle = getComputedStyle(icon);
        width -= icon.getBoundingClientRect().width + pixels(iconStyle.marginLeft) + pixels(iconStyle.marginRight) + pixels(style.columnGap);
      }
    }
  }
  return { element, style, width, height };
}

function renderedFits(element) {
  let parent = element.parentElement;
  while (parent && getComputedStyle(parent).display === 'contents') parent = parent.parentElement;
  return element.scrollWidth <= element.clientWidth + 1 && element.scrollHeight <= element.clientHeight + 2
    && (!parent || element.getBoundingClientRect().width <= parent.clientWidth + 2);
}

// Measurements validate finite chrome; no manuscript font is changed to fit the viewport.
export function observeReviewText(root) {
  const cache = new Map();
  let frame = 0;
  let disposed = false;
  let fontsReady = !document.fonts;
  let locale;
  const dirty = new Set();
  const watched = new Set();
  const details = new Map();
  const slots = new Map();
  const failedDetails = new Map();
  const run = () => {
    frame = 0;
    if (disposed || !fontsReady) return;
    const results = [];
    for (const element of dirty) {
      if (!element.isConnected) continue;
      const detail = details.get(element);
      const box = textBox(element, getComputedStyle(element));
      let detailLines;
      if (detail) {
        box.width = detail.slot.clientWidth - pixels(box.style.paddingLeft) - pixels(box.style.paddingRight);
        const lineHeight = pixels(box.style.lineHeight) || pixels(box.style.fontSize) * 1.4;
        const limit = box.style.getPropertyValue('--text-details-lines').trim();
        detailLines = limit === 'none' ? Infinity : Number(limit) || Number(element.dataset.lines) || 2;
        box.height = lineHeight * detailLines;
      }
      const { style, width, height } = box;
      if (element.hidden || width <= 0 || height <= 0) { results.push([element, 'deferred']); continue; }
      const text = detail ? detail.text : box.element.textContent || '';
      const domFits = detail?.active || (renderedFits(element) && renderedFits(box.element)
        && (!detail || element.clientHeight - pixels(style.paddingTop) - pixels(style.paddingBottom) <= height + 2));
      if (!text.trim()) { results.push([element, domFits ? 'fit' : 'no-fit']); continue; }
      const font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      const spacing = pixels(style.letterSpacing);
      const whiteSpace = style.whiteSpace === 'pre-wrap' ? 'pre-wrap' : 'normal';
      const wordBreak = style.wordBreak === 'keep-all' ? 'keep-all' : 'normal';
      const language = box.element.closest('[lang]')?.lang || document.documentElement.lang || undefined;
      const key = JSON.stringify([text, font, spacing, whiteSpace, wordBreak, language]);
      const attempt = `${key}:${width}:${height}`;
      if (detail && !domFits) failedDetails.set(element, attempt);
      try {
        // Pretext cannot model user word-spacing or arbitrary inline typography; keep the readable DOM fallback.
        if (pixels(style.wordSpacing) || style.hyphens === 'auto' || !['normal', 'keep-all'].includes(style.wordBreak)
          || !['normal', 'pre-wrap', 'nowrap'].includes(style.whiteSpace)) {
          results.push([element, domFits ? 'unavailable' : 'no-fit']);
          continue;
        }
        if (locale !== language) { setLocale(language); locale = language; }
        let prepared = cache.get(key);
        if (!prepared) {
          if (cache.size >= 128) { cache.clear(); clearCache(); }
          prepared = prepareWithSegments(text, font, { letterSpacing: spacing, whiteSpace, wordBreak });
          cache.set(key, prepared);
        }
        const stats = measureLineStats(prepared, width);
        const lineHeight = pixels(style.lineHeight) || pixels(style.fontSize) * 1.4;
        const lineLimit = style.whiteSpace === 'nowrap' ? 1 : element.dataset.lines ? Number(element.dataset.lines) : detail ? detailLines : Infinity;
        const natural = measureNaturalWidth(prepared);
        const fits = stats.maxLineWidth <= width + 1 && stats.lineCount <= lineLimit && stats.lineCount * lineHeight <= height + 2 && (lineLimit !== 1 || natural <= width + 1);
        results.push([element, !domFits || (detail && (!fits || failedDetails.get(element) === attempt)) ? 'no-fit' : fits ? 'fit' : 'reflow']);
      } catch { results.push([element, domFits ? 'unavailable' : 'no-fit']); }
    }
    dirty.clear();
    for (const [element, result] of results) {
      const value = details.get(element)?.present(result) || result;
      if (element.dataset.textFit !== value) element.dataset.textFit = value;
    }
  };
  const schedule = (element) => { dirty.add(element); if (!frame && fontsReady) frame = requestAnimationFrame(run); };
  const observer = new ResizeObserver(entries => entries.forEach(entry => schedule(slots.get(entry.target) || entry.target)));
  const register = (subtree) => {
    if (!(subtree instanceof Element) || subtree.closest(documentContent)) return;
    const candidates = subtree.matches(controls) ? [subtree, ...subtree.querySelectorAll(controls)] : subtree.querySelectorAll(controls);
    for (const element of candidates) {
      if (element.closest(documentContent)) continue;
      if (!watched.has(element)) {
        watched.add(element); observer.observe(element);
      }
      if (element.hasAttribute('data-text-details') && !details.has(element)) {
        const detail = createTextDetails(element);
        details.set(element, detail); slots.set(detail.slot, element); observer.observe(detail.slot);
      }
      schedule(element);
    }
  };
  const invalidate = () => { cache.clear(); failedDetails.clear(); clearCache(); for (const element of watched) schedule(element); };
  const mutation = new MutationObserver(records => {
    let removed = false;
    for (const record of records) {
      const target = record.target instanceof Element ? record.target : record.target.parentElement;
      if (!target || target.closest(documentContent)) continue;
      for (let parent = target; parent; parent = parent.parentElement) if (watched.has(parent)) schedule(parent);
      if (record.type === 'attributes') {
        if (record.attributeName === 'lang') { invalidate(); continue; }
        if (record.attributeName === 'data-text-details') register(target);
        for (const element of watched) if (element === target || target.contains(element)) schedule(element);
      } else {
        if (target.closest('style') || [...record.addedNodes, ...record.removedNodes].some(node => node.nodeType === 1 && node.matches('style, link[rel="stylesheet"]'))) invalidate();
        for (const node of record.addedNodes || []) register(node);
        removed ||= record.removedNodes?.length > 0;
      }
    }
    if (removed) for (const element of watched) if (!element.isConnected) {
      observer.unobserve(element); watched.delete(element); dirty.delete(element); failedDetails.delete(element);
      const detail = details.get(element);
      if (detail) { observer.unobserve(detail.slot); slots.delete(detail.slot); detail.destroy(); details.delete(element); }
    }
  });
  const observe = element => mutation.observe(element, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class', 'style', 'lang', 'hidden', 'data-lines', 'data-measure', 'data-text-details'] });
  observe(root);
  if (root !== document.documentElement) mutation.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'lang'] });
  const fonts = () => { if (!disposed) { fontsReady = true; invalidate(); } };
  document.fonts?.ready.then(fonts);
  document.fonts?.addEventListener('loadingdone', fonts);
  const refresh = () => { for (const element of watched) schedule(element); };
  const styles = new MutationObserver(records => {
    if (records.some(record => {
      const target = record.target instanceof Element ? record.target : record.target.parentElement;
      return target?.closest('style, link[rel="stylesheet"]')
        || [...record.addedNodes, ...record.removedNodes].some(node => node.nodeType === 1 && node.matches('style, link[rel="stylesheet"]'));
    })) invalidate();
  });
  if (document.head) styles.observe(document.head, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['href', 'media', 'disabled'] });
  window.addEventListener('resize', refresh);
  register(root);
  return () => {
    disposed = true; observer.disconnect(); mutation.disconnect(); styles.disconnect(); window.removeEventListener('resize', refresh);
    document.fonts?.removeEventListener('loadingdone', fonts); cancelAnimationFrame(frame);
    for (const detail of details.values()) detail.destroy();
    cache.clear(); clearCache(); dirty.clear(); watched.clear(); details.clear(); slots.clear(); failedDetails.clear();
  };
}
