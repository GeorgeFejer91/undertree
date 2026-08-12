const CSS_PX_PER_MM = 96 / 25.4;

export function parsePixelTracks(value) {
  const parts = String(value || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length || parts.some((part) => !/^-?\d+(?:\.\d+)?px$/i.test(part))) return [];
  return parts.map((part) => Number.parseFloat(part));
}

export function gridTrackRange(startValue, endValue, trackCount) {
  const startText = String(startValue || "").trim();
  const endText = String(endValue || "").trim();
  let start = /^\d+$/.test(startText) ? Number(startText) : null;
  let end = /^\d+$/.test(endText) ? Number(endText) : null;
  const startSpan = startText.match(/^span\s+(\d+)$/i);
  const endSpan = endText.match(/^span\s+(\d+)$/i);
  if (start !== null && endSpan) end = start + Number(endSpan[1]);
  if (end !== null && startSpan) start = end - Number(startSpan[1]);
  if (start !== null && endText === "auto") end = start + 1;
  if (end !== null && startText === "auto") start = end - 1;
  if (start === null || end === null || start < 1 || end <= start || end > trackCount + 1) return null;
  return { start: start - 1, end: end - 1 };
}

export function resizeTrackBoundary(tracks, boundaryIndex, delta, minimum = 18.9) {
  const next = [...tracks];
  if (!Number.isInteger(boundaryIndex) || boundaryIndex <= 0 || boundaryIndex >= next.length) return null;
  const before = next[boundaryIndex - 1] + delta;
  const after = next[boundaryIndex] - delta;
  if (before < minimum || after < minimum) return null;
  next[boundaryIndex - 1] = before;
  next[boundaryIndex] = after;
  return next;
}

export function tracksToMillimetres(tracks) {
  return tracks.map((track) => `${(track / CSS_PX_PER_MM).toFixed(2)}mm`).join(" ");
}

export function pixelDeltaToMillimetres(value) {
  return value / CSS_PX_PER_MM;
}
