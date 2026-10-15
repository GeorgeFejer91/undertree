import { boundedPdfOutputScale, clampPdfPage, nextPdfScale } from '../../src/pdf-viewer-state.js';

const PDF_TO_CSS_UNITS = 96 / 72;
const MAX_LIVE_PAGES = 128;
const MAX_RENDER_PIXELS = 9_000_000;

// Visible pages and one page on either side are painted; spacers keep the whole PDF reachable.
export class ManuscriptPdfViewer {
  constructor({ scroller, pages, onChange, onError }) {
    this.scroller = scroller; this.pages = pages; this.onChange = onChange; this.onError = onError;
    this.pdf = null; this.page = 1; this.scale = null; this.generation = 0; this.tasks = new Set(); this.pending = 0; this.heights = new Map();
    this.scroll = () => {
      if (!this.pdf || !this.ready || !this.pageHeight || this.scroller.scrollTop === this.renderScrollTop) return;
      this.targetPage = null;
      this.page = this.pageAt(this.scroller.scrollTop + this.scroller.clientHeight * .4);
      if (this.rendering) this.renderAgain = true;
      else this.schedule();
    };
    scroller.addEventListener('scroll', this.scroll, { passive: true });
    this.observer = new ResizeObserver(() => { if (this.pdf && this.ready) this.schedule(); });
    this.observer.observe(scroller);
  }
  async setDocument(pdf) {
    this.cancel(); this.pdf = pdf; this.ready = false; this.page = 1; this.targetPage = null; this.scale = null; this.heights.clear();
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
  cancel() { this.generation += 1; this.rendering = false; this.renderAgain = false; for (const task of this.tasks) task.cancel(); this.tasks.clear(); clearTimeout(this.pending); this.pending = 0; }
  releaseCanvases() { for (const canvas of this.pages.querySelectorAll('canvas')) { canvas.width = 0; canvas.height = 0; } }
  clear() { this.cancel(); this.pdf = null; this.ready = false; this.targetPage = null; this.releaseCanvases(); this.pages.replaceChildren(); }
  schedule() {
    if (this.rendering) this.renderAgain = true;
    clearTimeout(this.pending);
    this.pending = setTimeout(() => { this.pending = 0; void this.render().catch(this.onError); }, 70);
  }
  offset(page, scale = this.currentScale, heights = this.heights) {
    let offset = (page - 1) * (this.base.height * scale * PDF_TO_CSS_UNITS + 16);
    for (const [number, height] of heights) if (number < page) offset += (height - this.base.height) * scale * PDF_TO_CSS_UNITS;
    return offset;
  }
  pageAt(position, offset = page => this.offset(page)) {
    let first = 1; let last = this.pdf.numPages;
    while (first < last) { const middle = Math.ceil((first + last) / 2); if (offset(middle) <= position) first = middle; else last = middle - 1; }
    return first;
  }
  async render() {
    if (!this.pdf || !this.ready) return;
    if (this.rendering) { this.renderAgain = true; return; }
    this.cancel();
    const generation = this.generation; const pdf = this.pdf;
    this.rendering = true;
    try {
    const width = Math.max(100, this.scroller.clientWidth - 32);
    const scale = this.scale ?? Math.min(2, width / this.base.width) / PDF_TO_CSS_UNITS;
    const viewportScale = scale * PDF_TO_CSS_UNITS;
    const pageHeight = this.base.height * viewportScale + 16;
    const heights = new Map(this.heights);
    const offset = page => this.offset(page, scale, heights);
    const anchor = this.targetPage ?? (this.height && this.height !== pageHeight ? this.page : null);
    const intendedScrollTop = this.scroller.scrollTop;
    const targetScrollTop = () => Math.max(0, Math.min(anchor === null ? intendedScrollTop : offset(anchor), offset(pdf.numPages + 1) - this.scroller.clientHeight));
    const first = Math.max(1, this.pageAt(targetScrollTop(), offset) - 1);
    const prepared = [];
    let covered = false;
    for (let number = first; number <= pdf.numPages && prepared.length < MAX_LIVE_PAGES; number += 1) {
      let page;
      try { page = await pdf.getPage(number); }
      catch (error) { if (generation !== this.generation) return; throw error; }
      if (generation !== this.generation) return;
      if (this.renderAgain) return;
      const viewport = page.getViewport({ scale: viewportScale });
      if (heights.size >= 1000 && !heights.has(number)) heights.delete(heights.keys().next().value);
      heights.set(number, viewport.height / viewportScale);
      prepared.push({ number, page, viewport });
      if (covered) break;
      covered = offset(number + 1) >= targetScrollTop() + this.scroller.clientHeight;
    }
    const last = prepared.at(-1).number;
    const top = document.createElement('div'); top.className = 'pdf-page-spacer'; top.style.height = `${offset(first)}px`;
    const bottom = document.createElement('div'); bottom.className = 'pdf-page-spacer'; bottom.style.height = `${offset(pdf.numPages + 1) - offset(last + 1)}px`;
    const slots = [];
    for (const { number, viewport } of prepared) {
      const slot = document.createElement('div'); slot.className = 'pdf-page'; slot.dataset.page = String(number);
      slot.setAttribute('aria-label', `PDF page ${number}`); slot.style.height = `${viewport.height}px`; slot.style.width = `${viewport.width}px`;
      slots.push(slot);
    }
    this.currentScale = scale; this.pageHeight = pageHeight; this.height = pageHeight; this.heights = heights;
    this.releaseCanvases(); this.pages.replaceChildren(top, ...slots, bottom);
    // Install the new full-document height before the browser clamps the intended position.
    this.scroller.scrollTop = targetScrollTop(); this.renderScrollTop = this.scroller.scrollTop; this.targetPage = null;
    this.onChange({ page: this.page, total: pdf.numPages, scale, fit: this.scale === null });
    for (let index = 0; index < slots.length; index += 1) {
      const slot = slots[index]; const { page, viewport } = prepared[index];
      const pixelBudget = Math.floor(MAX_RENDER_PIXELS / slots.length);
      const maxSide = Math.min(32767, pixelBudget);
      const output = Math.min(boundedPdfOutputScale(viewport.width, viewport.height, devicePixelRatio), Math.sqrt(pixelBudget / (viewport.width * viewport.height)), maxSide / Math.max(viewport.width, viewport.height));
      const canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.floor(viewport.width * output)); canvas.height = Math.max(1, Math.floor(viewport.height * output));
      canvas.style.width = `${viewport.width}px`; canvas.style.height = `${viewport.height}px`;
      slot.append(canvas);
      const task = page.render({ canvasContext: canvas.getContext('2d'), viewport, transform: output === 1 ? null : [output, 0, 0, output, 0, 0] });
      this.tasks.add(task);
      try { await task.promise; } catch (error) { if (generation === this.generation) throw error; }
      finally { this.tasks.delete(task); }
      if (generation !== this.generation) return;
      page.cleanup();
      if (this.renderAgain) return;
    }
    } finally {
      if (generation === this.generation) {
        this.rendering = false;
        if (this.renderAgain) { this.renderAgain = false; this.schedule(); }
      }
    }
  }
  go(page) {
    if (!this.pdf) return;
    this.page = clampPdfPage(page, 0, this.pdf.numPages);
    this.targetPage = this.page;
    if (!this.ready) return;
    this.scroller.scrollTop = this.offset(this.page);
    this.renderScrollTop = this.scroller.scrollTop;
    this.schedule();
  }
  zoom(factor) { if (!this.pdf) return; this.scale = nextPdfScale(this.scale, this.currentScale, factor); this.schedule(); }
  fit() { this.scale = null; this.schedule(); }
  destroy() { this.clear(); this.observer.disconnect(); this.scroller.removeEventListener('scroll', this.scroll); }
}
