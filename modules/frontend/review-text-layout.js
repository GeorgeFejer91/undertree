import { prepareWithSegments, measureLineStats, measureNaturalWidth } from '@chenglou/pretext';

// Measurements validate finite chrome; no manuscript font is changed to fit the viewport.
export function observeReviewText(root) {
  const cache = new Map();
  let frame = 0;
  let disposed = false;
  const dirty = new Set();
  const run = () => {
    frame = 0;
    if (disposed) return;
    const results = [];
    for (const element of dirty) {
      if (!element.isConnected) continue;
      const style = getComputedStyle(element);
      const width = element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      const height = element.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
      if (width <= 0 || height <= 0) continue;
      const text = element.textContent || '';
      const font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      const spacing = parseFloat(style.letterSpacing) || 0;
      const key = JSON.stringify([text, font, spacing, document.documentElement.lang]);
      try {
        let prepared = cache.get(key);
        if (!prepared) {
          prepared = prepareWithSegments(text, font, { letterSpacing: spacing, whiteSpace: 'normal' });
          if (cache.size >= 128) cache.delete(cache.keys().next().value);
          cache.set(key, prepared);
        }
        const stats = measureLineStats(prepared, width);
        const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.4;
        const lineLimit = element.dataset.lines ? Number(element.dataset.lines) : Infinity;
        const natural = measureNaturalWidth(prepared);
        const fits = stats.maxLineWidth <= width + 1 && stats.lineCount <= lineLimit && stats.lineCount * lineHeight <= height + 2 && (lineLimit !== 1 || natural <= width + 1);
        results.push([element, fits ? 'fit' : 'reflow']);
      } catch { results.push([element, 'unavailable']); }
    }
    dirty.clear();
    for (const [element, result] of results) element.dataset.textFit = result;
  };
  const schedule = (element) => { dirty.add(element); if (!frame) frame = requestAnimationFrame(run); };
  const observer = new ResizeObserver(entries => entries.forEach(entry => schedule(entry.target)));
  const watched = new Set();
  const register = () => {
    for (const element of root.querySelectorAll('[data-measure], button, h2, h3')) {
      if (!watched.has(element)) { watched.add(element); observer.observe(element); }
      schedule(element);
    }
    for (const element of watched) if (!element.isConnected) { observer.unobserve(element); watched.delete(element); }
  };
  const mutation = new MutationObserver(register);
  mutation.observe(root, { subtree: true, childList: true, characterData: true });
  const fonts = () => { cache.clear(); register(); };
  document.fonts?.ready.then(fonts);
  document.fonts?.addEventListener('loadingdone', fonts);
  register();
  return () => { disposed = true; observer.disconnect(); mutation.disconnect(); document.fonts?.removeEventListener('loadingdone', fonts); cancelAnimationFrame(frame); cache.clear(); watched.clear(); };
}
