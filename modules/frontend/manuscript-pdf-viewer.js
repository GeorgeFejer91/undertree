import { boundedPdfOutputScale, clampPdfPage, nextPdfScale } from '../../src/pdf-viewer-state.js';

const PDF_TO_CSS_UNITS = 96 / 72;
const MAX_LIVE_PAGES = 128;
const MAX_RENDER_PIXELS = 9_000_000;
const pdfIdentity = value => typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value);

export function pdfSelectionSegments(layers, range) {
  const segments = [];
  for (const layer of layers) {
    const walker = layer.ownerDocument.createTreeWalker(layer, 4);
    let offset = 0, from = null, to = null, quote = '';
    while (walker.nextNode()) {
      const node = walker.currentNode, text = node.textContent;
      if (range.intersectsNode(node)) {
        const start = range.startContainer === node ? range.startOffset : 0;
        const end = range.endContainer === node ? range.endOffset : text.length;
        if (end > start) { from ??= offset + start; to = offset + end; quote += text.slice(start, end); }
      }
      offset += text.length;
    }
    if (from !== null) segments.push({ page: Number(layer.parentElement.dataset.page), from, to, quote });
  }
  return segments;
}

export function pdfTextRange(layer, from, to, quote) {
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || from >= to || typeof quote !== 'string' || layer.textContent.slice(from, to) !== quote || to - from !== quote.length) return null;
  const walker = layer.ownerDocument.createTreeWalker(layer, 4), range = layer.ownerDocument.createRange();
  let offset = 0, started = false;
  while (walker.nextNode()) {
    const node = walker.currentNode, end = offset + node.textContent.length;
    if (!started && from < end) { range.setStart(node, from - offset); started = true; }
    if (started && to <= end) { range.setEnd(node, to - offset); return range; }
    offset = end;
  }
  return null;
}

export function pdfProseContent(content) {
  const stack = [], artifacts = [], body = [];
  for (const [index, item] of content.items.entries()) {
    if (item.type === 'beginMarkedContent' || item.type === 'beginMarkedContentProps') {
      const group = { tag: item.tag, entries: [] }; stack.push(group);
      if (item.tag === 'Artifact') artifacts.push(group);
    } else if (item.type === 'endMarkedContent') stack.pop();
    else if (typeof item.str === 'string') {
      const artifact = stack.find(group => group.tag === 'Artifact');
      if (artifact) artifact.entries.push({ index, item });
      else if (item.str.trim()) body.push(item);
    }
  }
  const horizontal = item => item.transform?.length === 6 && item.transform.every(Number.isFinite) && Math.abs(item.transform[1]) < .01 && Math.abs(item.transform[2]) < .01 && Number.isFinite(item.height) && Number.isFinite(item.width) && item.height > 0 && item.width > 0;
  const lines = body.filter(horizontal);
  if (!lines.length) return { content, lineNumbers: 0 };
  const bodyLeft = lines.reduce((left, item) => Math.min(left, item.transform[4]), Infinity);
  const excluded = new Set(); let lineNumbers = 0;
  for (const group of artifacts) {
    const written = group.entries.filter(({ item }) => item.str.trim());
    if (written.length !== 1 || !/^\d{1,5}$/.test(written[0].item.str)) continue;
    const number = written[0].item;
    if (!horizontal(number) || number.dir !== 'ltr') continue;
    const right = number.transform[4] + number.width;
    const gutterGap = Math.max(6, number.height * .5);
    if (right + gutterGap > bodyLeft) continue;
    const aligned = lines.some(item => Math.abs(item.transform[5] - number.transform[5]) <= Math.max(1, number.height * .15) && item.transform[4] >= right + gutterGap);
    if (!aligned) continue;
    for (const { index } of group.entries) excluded.add(index);
    lineNumbers += 1;
  }
  return { content: lineNumbers ? { ...content, items: content.items.filter((_, index) => !excluded.has(index)) } : content, lineNumbers };
}

// Visible pages and one page on either side are painted; spacers keep the whole PDF reachable.
export class ManuscriptPdfViewer {
  constructor({ scroller, pages, onChange, onError }) {
    this.scroller = scroller; this.pages = pages; this.onChange = onChange; this.onError = onError;
    this.pdf = null; this.page = 1; this.scale = null; this.generation = 0; this.tasks = new Set(); this.pending = 0; this.heights = new Map(); this.renderDeferred = false;
    this.scroll = () => {
      if (!this.pdf || !this.ready || !this.visible() || !this.pageHeight || this.scroller.scrollTop === this.renderScrollTop) return;
      this.targetPage = null;
      this.page = this.pageAt(this.scroller.scrollTop + this.scroller.clientHeight * .4);
      if (this.rendering) this.renderAgain = true;
      else this.schedule();
    };
    scroller.addEventListener('scroll', this.scroll, { passive: true });
    this.observer = new ResizeObserver(() => {
      if (this.pdf && this.ready && this.visible() && (this.renderDeferred || this.scroller.clientWidth !== this.renderedWidth || this.scroller.clientHeight !== this.renderedHeight)) this.schedule();
    });
    this.observer.observe(scroller);
  }
  async setDocument(pdf, { TextLayer, identity = null } = {}) {
    if (identity !== null && !pdfIdentity(identity)) throw new Error('A PDF annotation identity must be its complete SHA-256 digest.');
    this.cancel(); this.pdf = pdf; this.identity = identity; this.setPdfAnnotations([]); this.TextLayer = TextLayer; this.textIndex = null; this.verifiedText = null; this.ready = false; this.page = 1; this.targetPage = null; this.scale = null; this.heights.clear(); this.renderDeferred = false; this.paintedWindow = null;
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
  visible() { return this.scroller.clientWidth > 0 && this.scroller.clientHeight > 0; }
  releaseCanvases() { for (const canvas of this.pages.querySelectorAll('canvas')) { canvas.width = 0; canvas.height = 0; } }
  clear() { this.cancel(); this.pdf = null; this.identity = null; this.textIndex = null; this.verifiedText = null; this.ready = false; this.targetPage = null; this.paintedWindow = null; this.setHighlights([]); this.setPdfAnnotations([]); this.releaseCanvases(); this.pages.replaceChildren(); }
  selectedText() {
    const selected = this.pages.ownerDocument.getSelection();
    if (!this.pdf || !selected || selected.isCollapsed || selected.rangeCount !== 1) return null;
    const range = selected.getRangeAt(0).cloneRange();
    const closest = node => (node.nodeType === 1 ? node : node.parentElement)?.closest('.pdf-text-layer');
    const first = closest(range.startContainer), last = closest(range.endContainer);
    if (!first || !last || !this.pages.contains(first) || !this.pages.contains(last)) return null;
    if ((first.dataset.pdfIdentity || null) !== this.identity || (last.dataset.pdfIdentity || null) !== this.identity) return null;
    const segments = pdfSelectionSegments(this.pages.querySelectorAll('.pdf-text-layer'), range);
    const quote = segments.map(segment => segment.quote).join('\n');
    if (!quote.trim()) return null;
    return { quote, page: segments[0].page, identity: this.identity, segments, generation: this.generation, range };
  }
  selectionCurrent(selected) {
    return Boolean(this.pdf && selected && selected.identity === this.identity && selected.generation === this.generation
      && this.pages.contains(selected.range.startContainer) && this.pages.contains(selected.range.endContainer)
      && selected.quote === selected.segments.map(segment => segment.quote).join('\n')
      && JSON.stringify(pdfSelectionSegments(this.pages.querySelectorAll('.pdf-text-layer'), selected.range)) === JSON.stringify(selected.segments));
  }
  setPdfAnnotations(annotations) {
    if (!Array.isArray(annotations) || annotations.length > 500) throw new Error('Use at most 500 PDF annotations.');
    this.pdfAnnotations = annotations.map(annotation => {
      if (!pdfIdentity(annotation.identity) || !/^#[0-9a-f]{6}$/i.test(annotation.color) || !Array.isArray(annotation.segments) || !annotation.segments.length || annotation.segments.length > 512) throw new Error('This PDF annotation has an invalid identity, color or page range.');
      const segments = annotation.segments.map(segment => {
        if (!Number.isSafeInteger(segment.page) || segment.page < 1 || !Number.isSafeInteger(segment.from) || segment.from < 0 || !Number.isSafeInteger(segment.to) || segment.to <= segment.from || typeof segment.quote !== 'string' || segment.quote.length !== segment.to - segment.from) throw new Error('This PDF annotation has invalid UTF-16 text offsets.');
        return { page: segment.page, from: segment.from, to: segment.to, quote: segment.quote };
      });
      return { id: annotation.id, identity: annotation.identity, color: annotation.color, ruleId: annotation.rule, ownerPath: annotation.ownerPath, segments };
    });
    this.paintPdfAnnotations();
  }
  paintPdfAnnotations() {
    const registry = globalThis.CSS?.highlights;
    for (const name of this.pdfAnnotationNames || []) registry?.delete(name);
    this.pdfAnnotationNames = []; this.pdfAnnotationStyle?.remove(); this.annotationRuleRanges = [];
    const layers = [...this.pages.querySelectorAll('.pdf-text-layer')];
    for (const layer of layers) layer.dataset.pdfAnnotations = '0';
    const annotations = this.pdfAnnotations?.filter(annotation => annotation.identity === this.identity) || [];
    if (this.scroller.dataset) { this.scroller.dataset.pdfAnnotations = String(annotations.length); this.scroller.dataset.pdfAnnotationIdentity = this.identity || ''; }
    if (!registry || !globalThis.Highlight || !annotations.length || !this.pdf) return;
    const groups = new Map(), counts = new Map();
    for (const annotation of annotations) {
      for (const segment of annotation.segments) {
        const layer = layers.find(layer => Number(layer.parentElement.dataset.page) === segment.page && layer.dataset.pdfIdentity === this.identity);
        if (!layer) continue;
        const range = pdfTextRange(layer, segment.from, segment.to, segment.quote);
        if (!range) continue;
        this.annotationRuleRanges.push({ range, ruleId: annotation.ruleId, ownerPath: annotation.ownerPath, ...segment });
        if (!groups.has(annotation.color)) groups.set(annotation.color, []);
        groups.get(annotation.color).push(range); counts.set(layer, (counts.get(layer) || 0) + 1);
      }
    }
    for (const [layer, count] of counts) layer.dataset.pdfAnnotations = String(count);
    if (!groups.size) return;
    const style = this.pages.ownerDocument.createElement('style');
    for (const [color, ranges] of groups) {
      const name = `undertree-pdf-annotation-${this.pdfAnnotationNames.length}`;
      registry.set(name, new Highlight(...ranges)); this.pdfAnnotationNames.push(name);
      style.textContent += `::highlight(${name}){background-color:${color}88;color:transparent;}`;
    }
    this.pages.append(style); this.pdfAnnotationStyle = style;
  }
  async documentText() {
    const pdf = this.pdf;
    if (!pdf || pdf.numPages > 512) return null;
    if (!this.textIndex) this.textIndex = (async () => {
      const parts = []; let length = 0;
      for (let number = 1; number <= pdf.numPages; number += 1) {
        const page = await pdf.getPage(number);
        if (this.pdf !== pdf) return null;
        let extracted;
        try { extracted = await page.getTextContent({ includeMarkedContent: true }); }
        catch (error) { if (this.pdf !== pdf) return null; throw error; }
        if (this.pdf !== pdf) return null;
        const { content } = pdfProseContent(extracted);
        const runs = [];
        for (const item of content.items) {
          if (typeof item.str !== 'string') continue;
          length += item.str.length;
          if (length > 2_000_000) return null;
          runs.push(item.str);
        }
        parts.push(runs.join(''));
      }
      this.verifiedText = parts.join('\u0000');
      return this.verifiedText;
    })();
    return this.textIndex;
  }
  async isUniqueText(quote) {
    if (!quote || quote.includes('\u0000')) return false;
    const pdf = this.pdf;
    const text = await this.documentText();
    const from = text?.indexOf(quote) ?? -1;
    return this.pdf === pdf && from >= 0 && text.indexOf(quote, from + 1) === -1;
  }
  setHighlights(highlights) {
    this.highlights = highlights.filter(marker => typeof marker.quote === 'string' && marker.quote.trim() && /^#[0-9a-f]{6}$/i.test(marker.color));
    this.paintHighlights();
    if (this.highlights.length && this.verifiedText === null) {
      const current = this.highlights, pdf = this.pdf;
      void this.documentText().then(() => { if (this.pdf === pdf && this.highlights === current) this.paintHighlights(); }).catch(error => { if (this.pdf === pdf && this.highlights === current) this.onError(error); });
    }
  }
  paintHighlights() {
    const registry = globalThis.CSS?.highlights;
    if (!registry || !globalThis.Highlight) return;
    for (const name of this.highlightNames || []) registry.delete(name);
    this.highlightNames = []; this.highlightStyle?.remove(); this.sourceRuleRanges = [];
    if (!this.highlights?.length) return;
    const layers = [...this.pages.querySelectorAll('.pdf-text-layer')];
    const groups = new Map();
    for (const { quote, color, ruleId, ownerPath } of this.highlights) {
      const verifiedFrom = this.verifiedText?.indexOf(quote) ?? -1;
      if (verifiedFrom < 0 || this.verifiedText.indexOf(quote, verifiedFrom + 1) !== -1) continue;
      const matches = layers.flatMap(layer => {
        const from = layer.textContent.indexOf(quote);
        return from < 0 ? [] : [{ layer, from, repeated: layer.textContent.indexOf(quote, from + 1) !== -1 }];
      });
      if (matches.length !== 1 || matches[0].repeated) continue;
      const { layer, from } = matches[0], range = pdfTextRange(layer, from, from + quote.length, quote);
      if (!range) continue;
      this.sourceRuleRanges.push({ range, ruleId, ownerPath, page: Number(layer.parentElement.dataset.page), from, to: from + quote.length });
      if (!groups.has(color)) groups.set(color, []);
      groups.get(color).push(range);
    }
    const style = this.pages.ownerDocument.createElement('style');
    for (const [color, ranges] of groups) {
      const name = `undertree-pdf-rule-${this.highlightNames.length}`;
      registry.set(name, new Highlight(...ranges)); this.highlightNames.push(name);
      style.textContent += `::highlight(${name}){background-color:${color}66;color:transparent;}`;
    }
    this.pages.append(style); this.highlightStyle = style;
  }
  highlightedRulesAt(point = null) {
    if (!this.pdf) return [];
    const selected = !point && this.selectedText();
    if (!point && !selected) return [];
    const rules = new Map();
    for (const record of [...this.annotationRuleRanges || [], ...this.sourceRuleRanges || []]) {
      if (!record.ruleId || !this.pages.contains(record.range.startContainer) || !this.pages.contains(record.range.endContainer)) continue;
      const matches = point
        ? [...record.range.getClientRects()].some(rect => point.clientX >= rect.left && point.clientX < rect.right && point.clientY >= rect.top && point.clientY < rect.bottom)
        : selected.segments.some(segment => segment.page === record.page && segment.from < record.to && record.from < segment.to);
      if (matches) rules.set(JSON.stringify([record.ownerPath, record.ruleId]), { ruleId: record.ruleId, ownerPath: record.ownerPath });
    }
    return [...rules.values()];
  }
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
    if (!this.visible()) { this.renderDeferred = true; return; }
    if (this.rendering) { this.renderAgain = true; return; }
    this.cancel();
    const generation = this.generation; const pdf = this.pdf;
    this.rendering = true;
    try {
    const clientWidth = this.scroller.clientWidth, clientHeight = this.scroller.clientHeight;
    const width = Math.max(100, clientWidth - 32);
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
      if (!this.visible()) { this.renderDeferred = true; return; }
      if (this.renderAgain) return;
      const viewport = page.getViewport({ scale: viewportScale });
      if (heights.size >= 1000 && !heights.has(number)) heights.delete(heights.keys().next().value);
      heights.set(number, viewport.height / viewportScale);
      prepared.push({ number, page, viewport });
      if (covered) break;
      covered = offset(number + 1) >= targetScrollTop() + this.scroller.clientHeight;
    }
    const last = prepared.at(-1).number;
    const window = `${first}:${last}:${scale}:${clientWidth}:${clientHeight}:${devicePixelRatio}`;
    if (this.paintedWindow === window) {
      this.renderDeferred = false;
      this.scroller.scrollTop = targetScrollTop(); this.renderScrollTop = this.scroller.scrollTop; this.targetPage = null;
      this.onChange({ page: this.page, total: pdf.numPages, scale, fit: this.scale === null });
      return;
    }
    const top = document.createElement('div'); top.className = 'pdf-page-spacer'; top.style.height = `${offset(first)}px`;
    const bottom = document.createElement('div'); bottom.className = 'pdf-page-spacer'; bottom.style.height = `${offset(pdf.numPages + 1) - offset(last + 1)}px`;
    const slots = [];
    for (const { number, viewport } of prepared) {
      const slot = document.createElement('div'); slot.className = 'pdf-page'; slot.dataset.page = String(number);
      slot.setAttribute('aria-label', `PDF page ${number}`); slot.style.height = `${viewport.height}px`; slot.style.width = `${viewport.width}px`;
      slots.push(slot);
    }
    this.currentScale = scale; this.pageHeight = pageHeight; this.height = pageHeight; this.heights = heights;
    this.renderedWidth = clientWidth; this.renderedHeight = clientHeight; this.renderDeferred = false;
    this.paintedWindow = null;
    this.releaseCanvases(); this.pages.replaceChildren(top, ...slots, bottom);
    this.paintPdfAnnotations();
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
      if (this.TextLayer) {
        const layer = document.createElement('div'); layer.className = 'pdf-text-layer';
        layer.dataset.pdfIdentity = this.identity || '';
        layer.style.setProperty('--total-scale-factor', String(viewport.scale));
        layer.style.setProperty('--scale-round-x', '1px'); layer.style.setProperty('--scale-round-y', '1px');
        slot.append(layer);
        let extracted;
        try { extracted = await page.getTextContent({ includeMarkedContent: true }); }
        catch (error) { if (generation !== this.generation) return; throw error; }
        if (generation !== this.generation) return;
        const prose = pdfProseContent(extracted);
        layer.dataset.pdfLineNumbers = String(prose.lineNumbers);
        const text = new this.TextLayer({ textContentSource: prose.content, container: layer, viewport });
        this.tasks.add(text);
        try { await text.render(); } catch (error) { if (generation === this.generation) throw error; }
        finally { this.tasks.delete(text); }
        if (generation !== this.generation) return;
        this.paintHighlights();
        this.paintPdfAnnotations();
      }
      page.cleanup();
      if (this.renderAgain) return;
    }
    this.paintedWindow = window;
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
