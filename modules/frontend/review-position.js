// Original layout: anchor the focused passage, pack collisions, then keep all cards scrollable.
export function positionReviewCards(entries, focusedId, gap = 8) {
  const items = entries.map(entry => ({ ...entry, top: Math.max(0, Number(entry.desiredTop) || 0) })).sort((a, b) => a.from - b.from);
  if (!items.length) return items;
  const found = items.findIndex(item => item.id === focusedId);
  const focused = found < 0 ? 0 : found;
  for (let index = focused - 1; index >= 0; index -= 1) items[index].top = Math.min(items[index].top, items[index + 1].top - items[index].height - gap);
  for (let index = focused + 1; index < items.length; index += 1) items[index].top = Math.max(items[index].top, items[index - 1].top + items[index - 1].height + gap);
  const shift = Math.max(0, -items[0].top);
  return items.map(item => ({ ...item, top: item.top + shift }));
}

export function acceptedTextChange(previous, next) {
  let from = 0; let suffix = 0;
  while (from < previous.length && from < next.length && previous[from] === next[from]) from += 1;
  if (from > 0 && /[\uD800-\uDBFF]/.test(previous[from - 1])) from -= 1;
  while (suffix < previous.length - from && suffix < next.length - from && previous[previous.length - 1 - suffix] === next[next.length - 1 - suffix]) suffix += 1;
  if (suffix > 0 && /[\uDC00-\uDFFF]/.test(previous[previous.length - suffix])) suffix -= 1;
  return { from, to: previous.length - suffix, insert: next.slice(from, next.length - suffix) };
}
