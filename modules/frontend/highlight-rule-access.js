export function sourceHighlightColors(review, content, from, to = from) {
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to < from || to > content.length) return [];
  const colors = new Set();
  for (const marker of review.markers) {
    const { anchor } = marker;
    if (anchor.stale || content.slice(anchor.from, anchor.to) !== anchor.quote) continue;
    if (anchor.from <= from && from < anchor.to || from < to && anchor.from < to && from < anchor.to) colors.add(marker.rule);
  }
  return review.rules.filter(rule => colors.has(rule.id)).map(rule => rule.id);
}
