export const PDF_MIN_SCALE = 0.25;
export const PDF_MAX_SCALE = 4;
export const PDF_MAX_RENDER_PIXELS = 10_000_000;

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

export function boundedPdfOutputScale(viewportWidth, viewportHeight, devicePixelRatio = 1) {
  const width = Math.max(1, Number(viewportWidth) || 1);
  const height = Math.max(1, Number(viewportHeight) || 1);
  const preferred = Math.max(1, Math.min(Number(devicePixelRatio) || 1, 2));
  const pixelBudgetScale = Math.sqrt(PDF_MAX_RENDER_PIXELS / (width * height));
  return Math.min(preferred, pixelBudgetScale);
}
