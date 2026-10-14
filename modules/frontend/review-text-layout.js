import { clearCache, setLocale, prepareWithSegments, measureLineStats, measureNaturalWidth } from '@chenglou/pretext';

const controls = '[data-measure], button, h2, h3';
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
  return element.scrollWidth <= element.clientWidth + 1 && element.scrollHeight <= element.clientHeight + 2;
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
  const run = () => {
    frame = 0;
    if (disposed || !fontsReady) return;
    const results = [];
    for (const element of dirty) {
      if (!element.isConnected) continue;
      const box = textBox(element, getComputedStyle(element));
      const { style, width, height } = box;
      if (width <= 0 || height <= 0) { results.push([element, 'deferred']); continue; }
      const text = box.element.textContent || '';
      const domFits = renderedFits(element) && renderedFits(box.element);
      if (!text.trim()) { results.push([element, domFits ? 'fit' : 'no-fit']); continue; }
      const font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      const spacing = pixels(style.letterSpacing);
      const whiteSpace = style.whiteSpace === 'pre-wrap' ? 'pre-wrap' : 'normal';
      const wordBreak = style.wordBreak === 'keep-all' ? 'keep-all' : 'normal';
      const language = box.element.closest('[lang]')?.lang || document.documentElement.lang || undefined;
      const key = JSON.stringify([text, font, spacing, whiteSpace, wordBreak, language]);
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
        const lineLimit = style.whiteSpace === 'nowrap' ? 1 : element.dataset.lines ? Number(element.dataset.lines) : Infinity;
        const natural = measureNaturalWidth(prepared);
        const fits = stats.maxLineWidth <= width + 1 && stats.lineCount <= lineLimit && stats.lineCount * lineHeight <= height + 2 && (lineLimit !== 1 || natural <= width + 1);
        results.push([element, !domFits ? 'no-fit' : fits ? 'fit' : 'reflow']);
      } catch { results.push([element, 'unavailable']); }
    }
    dirty.clear();
    for (const [element, result] of results) element.dataset.textFit = result;
  };
  const schedule = (element) => { dirty.add(element); if (!frame && fontsReady) frame = requestAnimationFrame(run); };
  const observer = new ResizeObserver(entries => entries.forEach(entry => schedule(entry.target)));
  const register = (subtree) => {
    if (!(subtree instanceof Element) || subtree.closest(documentContent)) return;
    const candidates = subtree.matches(controls) ? [subtree, ...subtree.querySelectorAll(controls)] : subtree.querySelectorAll(controls);
    for (const element of candidates) {
      if (element.closest(documentContent)) continue;
      if (!watched.has(element)) { watched.add(element); observer.observe(element); }
      schedule(element);
    }
  };
  const invalidate = () => { cache.clear(); clearCache(); for (const element of watched) schedule(element); };
  const mutation = new MutationObserver(records => {
    let removed = false;
    for (const record of records) {
      const target = record.target instanceof Element ? record.target : record.target.parentElement;
      if (!target || target.closest(documentContent)) continue;
      for (let parent = target; parent; parent = parent.parentElement) if (watched.has(parent)) schedule(parent);
      if (record.type === 'attributes') {
        if (record.attributeName === 'lang') { invalidate(); continue; }
        for (const element of watched) if (element === target || target.contains(element)) schedule(element);
      } else {
        for (const node of record.addedNodes || []) register(node);
        removed ||= record.removedNodes?.length > 0;
      }
    }
    if (removed) for (const element of watched) if (!element.isConnected) { observer.unobserve(element); watched.delete(element); dirty.delete(element); }
  });
  const observe = element => mutation.observe(element, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class', 'style', 'lang', 'hidden', 'data-lines', 'data-measure'] });
  observe(root);
  if (root !== document.documentElement) mutation.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'lang'] });
  const fonts = () => { if (!disposed) { fontsReady = true; invalidate(); } };
  document.fonts?.ready.then(fonts);
  document.fonts?.addEventListener('loadingdone', fonts);
  register(root);
  return () => { disposed = true; observer.disconnect(); mutation.disconnect(); document.fonts?.removeEventListener('loadingdone', fonts); cancelAnimationFrame(frame); cache.clear(); clearCache(); dirty.clear(); watched.clear(); };
}
