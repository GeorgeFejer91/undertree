export const PDF_MIN_SCALE = 0.25;
export const PDF_MAX_SCALE = 4;

export function clampPdfPage(currentPage, delta, totalPages) {
  const total = Math.max(1, Number(totalPages) || 1);
  const current = Math.max(1, Math.min(total, Number(currentPage) || 1));
  return Math.max(1, Math.min(total, current + Number(delta || 0)));
}

export function nextPdfScale(explicitScale, currentScale, factor) {
  const base = Number.isFinite(explicitScale) ? explicitScale : Number(currentScale) || 1;
  const requested = base * Number(factor || 1);
  return Math.max(PDF_MIN_SCALE, Math.min(PDF_MAX_SCALE, requested));
}
