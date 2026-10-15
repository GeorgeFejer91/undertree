import { boundedPdfOutputScale, clampPdfPage, nextPdfScale } from '../../src/pdf-viewer-state.js';
import { pdfPageWindow } from './manuscript-workspace.js';

const PDF_TO_CSS_UNITS = 96 / 72;

// Only three page canvases live at once; spacers keep every page reachable by scrolling.
export class ManuscriptPdfViewer {
  constructor({ scroller, pages, onChange, onError }) {
    this.scroller = scroller; this.pages = pages; this.onChange = onChange; this.onError = onError;
    this.pdf = null; this.page = 1; this.scale = null; this.generation = 0; this.tasks = new Set(); this.pending = 0; this.heights = new Map();
    this.scroll = () => {
      if (!this.pdf || !this.ready || this.pending || this.rendering || !this.pageHeight) return;
      const readingPosition = this.scroller.scrollTop + this.scroller.clientHeight * .4;
      let first = 1; let last = this.pdf.numPages;
      while (first < last) { const middle = Math.ceil((first + last) / 2); if (this.offset(middle) <= readingPosition) first = middle; else last = middle - 1; }
      const page = first;
      if (page !== this.page) { this.page = page; this.schedule(); }
    };
    scroller.addEventListener('scroll', this.scroll, { passive: true });
    this.observer = new ResizeObserver(() => { if (this.pdf && this.ready && this.scale === null) this.schedule(); });
    this.observer.observe(scroller);
  }
  async setDocument(pdf) {
    this.cancel(); this.pdf = pdf; this.ready = false; this.page = 1; this.scale = null; this.heights.clear();
    const generation = this.generation;
    let first;
    try { first = await pdf.getPage(1); }
    catch (error) { if (generation !== this.generation || this.pdf !== pdf) return false; throw error; }
    if (generation !== this.generation || this.pdf !== pdf) return false;
    this.base = first.getViewport({ scale: 1 }); this.ready = true;
    this.scroller.scrollTop = 0;
    await this.render();
    return this.pdf === pdf;
  }
  cancel() { this.generation += 1; this.rendering = false; for (const task of this.tasks) task.cancel(); this.tasks.clear(); clearTimeout(this.pending); this.pending = 0; }
  releaseCanvases() { for (const canvas of this.pages.querySelectorAll('canvas')) { canvas.width = 0; canvas.height = 0; } }
  clear() { this.cancel(); this.pdf = null; this.ready = false; this.releaseCanvases(); this.pages.replaceChildren(); }
  schedule() {
    clearTimeout(this.pending);
    this.pending = setTimeout(() => { this.pending = 0; void this.render().catch(this.onError); }, 70);
  }
  offset(page) {
    let offset = (page - 1) * this.pageHeight;
    for (const [number, height] of this.heights) if (number < page) offset += (height - this.base.height) * this.currentScale * PDF_TO_CSS_UNITS;
    return offset;
  }
  async render() {
    if (!this.pdf || !this.ready) return;
    this.cancel();
    const generation = this.generation; const pdf = this.pdf;
    this.rendering = true;
    try {
    const width = Math.max(100, this.scroller.clientWidth - 32);
    const scale = this.scale ?? Math.min(2, width / this.base.width) / PDF_TO_CSS_UNITS;
    const viewportScale = scale * PDF_TO_CSS_UNITS;
    this.currentScale = scale; this.pageHeight = this.base.height * viewportScale + 16;
    const window = pdfPageWindow(this.page, pdf.numPages);
    const previousHeight = this.height;
    this.height = this.pageHeight;
    const top = document.createElement('div'); top.className = 'pdf-page-spacer'; top.style.height = `${this.offset(window.first)}px`;
    const bottom = document.createElement('div'); bottom.className = 'pdf-page-spacer'; bottom.style.height = `${this.offset(pdf.numPages + 1) - this.offset(window.last + 1)}px`;
    const slots = [];
    for (let number = window.first; number <= window.last; number += 1) {
      const slot = document.createElement('div'); slot.className = 'pdf-page'; slot.dataset.page = String(number);
      slot.setAttribute('aria-label', `PDF page ${number}`); slot.style.height = `${(this.heights.get(number) || this.base.height) * viewportScale}px`; slot.style.width = `${this.base.width * viewportScale}px`;
      slots.push(slot);
    }
    this.releaseCanvases(); this.pages.replaceChildren(top, ...slots, bottom);
    if (previousHeight && previousHeight !== this.pageHeight) this.scroller.scrollTop = this.offset(this.page);
    this.onChange({ page: this.page, total: pdf.numPages, scale, fit: this.scale === null });
    for (const slot of slots) {
      let page;
      try { page = await pdf.getPage(Number(slot.dataset.page)); }
      catch (error) { if (generation !== this.generation) return; throw error; }
      if (generation !== this.generation) return;
      const viewport = page.getViewport({ scale: viewportScale });
      if (this.heights.size >= 1000 && !this.heights.has(Number(slot.dataset.page))) this.heights.delete(this.heights.keys().next().value);
      this.heights.set(Number(slot.dataset.page), viewport.height / viewportScale);
      slot.style.height = `${viewport.height}px`; slot.style.width = `${viewport.width}px`;
      top.style.height = `${this.offset(window.first)}px`; bottom.style.height = `${this.offset(pdf.numPages + 1) - this.offset(window.last + 1)}px`;
      // One third of the legacy 10-million-pixel budget per live page.
      const output = Math.min(boundedPdfOutputScale(viewport.width, viewport.height, devicePixelRatio), Math.sqrt(3_000_000 / (viewport.width * viewport.height)));
      const canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.floor(viewport.width * output)); canvas.height = Math.max(1, Math.floor(viewport.height * output));
      canvas.style.width = `${viewport.width}px`; canvas.style.height = `${viewport.height}px`;
      slot.append(canvas);
      const task = page.render({ canvasContext: canvas.getContext('2d'), viewport, transform: output === 1 ? null : [output, 0, 0, output, 0, 0] });
      this.tasks.add(task);
      try { await task.promise; } catch (error) { if (generation === this.generation) throw error; }
      finally { this.tasks.delete(task); }
      if (generation !== this.generation) return;
      page.cleanup();
    }
    } finally { if (generation === this.generation) this.rendering = false; }
  }
  go(page) {
    if (!this.pdf) return;
    this.page = clampPdfPage(page, 0, this.pdf.numPages);
    this.scroller.scrollTop = this.offset(this.page);
    this.schedule();
  }
  zoom(factor) { if (!this.pdf) return; this.scale = nextPdfScale(this.scale, this.currentScale, factor); this.schedule(); }
  fit() { this.scale = null; this.schedule(); }
  destroy() { this.clear(); this.observer.disconnect(); this.scroller.removeEventListener('scroll', this.scroll); }
}
