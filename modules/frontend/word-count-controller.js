export function captureWordCount(session, state, requestId) {
  return { session, project: session.project, path: session.path, version: session.version, generation: session.generation, document: state.doc, selection: state.selection, selectionRangeCount: state.selection.ranges.length, requestId, ranges: state.selection.ranges.slice(0, 1001).map(({ from, to }) => ({ from, to })), dirty: session.dirty, conflict: !!session.conflict, reviewProblem: session.reviewProblem?.code || null };
}

export function wordCountCurrent(captured, session, state, requestId, { composing = false, closing = false } = {}) {
  return !!state && !composing && !closing && requestId === captured.requestId && session === captured.session && session.project === captured.project && session.path === captured.path && session.version === captured.version && session.generation === captured.generation && state.doc === captured.document && state.selection === captured.selection && state.selection.ranges.length === captured.selectionRangeCount;
}

// One explicit, immutable local analysis. It never enters a document save queue.
export class WordCountController {
  constructor({ analyzeTypst, native = false, isCurrent, onChange, worker = () => new Worker(new URL('./word-count-worker.js', import.meta.url), { type: 'module' }) }) {
    Object.assign(this, { analyzeTypst, native, isCurrent, onChange, worker });
    this.current = null;
  }
  close() {
    if (!this.current) return;
    clearTimeout(this.current.timer); this.current.worker?.terminate(); this.current = null;
  }
  changed() {
    const context = this.current;
    if (!context || context.phase === 'stale' || this.isCurrent(context.capture)) return;
    clearTimeout(context.timer); context.worker?.terminate(); context.worker = null;
    context.phase = 'stale'; context.result = null;
    context.message = 'The editor snapshot changed. Close and reopen Word count to count the current text.';
    this.onChange(context);
  }
  async open(capture, { source, format, locale }) {
    this.close();
    const context = { capture, phase: 'counting', result: null, message: 'Counting the captured editor snapshot…' };
    this.current = context; this.onChange(context);
    const current = () => {
      if (this.current !== context || context.phase !== 'counting') return false;
      this.changed(); return context.phase === 'counting';
    };
    context.timer = setTimeout(() => {
      if (!current()) return;
      context.worker?.terminate(); context.worker = null; context.phase = 'unavailable';
      context.message = 'Word count took too long. Close and reopen to try again.'; this.onChange(context);
    }, 15000);
    let literalText, proseReason;
    try {
      if (format === 'typ') {
        if (!this.native) proseReason = 'The Typst literal prose estimate requires the UnderTree desktop app. Source counts remain available.';
        else {
          try {
            const value = await this.analyzeTypst(capture.requestId, source);
            if (!current()) return;
            if (value?.requestId !== capture.requestId || value.method !== 'typst-literal-v1' || !['ready', 'unavailable'].includes(value.status)) throw new Error('The native analysis did not match this editor snapshot.');
            if (value.status === 'ready') {
              if (typeof value.literalText !== 'string') throw new Error('The native literal-text result is unavailable.');
              literalText = value.literalText;
            } else {
              if (!['incomplete_syntax', 'literal_limit'].includes(value.reasonCode) || typeof value.reason !== 'string' || value.reason.length > 1000) throw new Error('The native analysis reason is unavailable.');
              proseReason = value.reason;
            }
          } catch (error) { proseReason = error.message || 'The native Typst prose estimate is unavailable.'; }
        }
      }
      if (!current()) return;
      const worker = this.worker(); context.worker = worker;
      worker.onmessage = ({ data }) => {
        if (!current()) return;
        const value = data?.ok ? data.result : data;
        if (value?.requestId !== capture.requestId) { this.fail(context, 'The word count result did not match this editor snapshot.'); return; }
        if (!data.ok) { this.fail(context, data.error?.message || 'Word count is unavailable.'); return; }
        clearTimeout(context.timer); worker.terminate(); context.worker = null;
        context.phase = 'ready'; context.result = value; context.message = ''; this.onChange(context);
      };
      worker.onerror = () => { if (current()) this.fail(context, 'The word count worker is unavailable in this WebView.'); };
      worker.postMessage({ requestId: capture.requestId, source, format, ranges: capture.ranges, locale, literalText, proseReason });
    } catch (error) { if (current()) this.fail(context, error.message || 'Word count is unavailable.'); }
  }
  fail(context, message) {
    clearTimeout(context.timer); context.worker?.terminate(); context.worker = null;
    context.phase = 'unavailable'; context.message = message; this.onChange(context);
  }
}
