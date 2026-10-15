// Only fixed non-content effects belong here. Ordinary command handlers can autosave.
const fields = {
  open_manuscript: ['documentId'],
  select_passage: ['documentId', 'revision', 'from', 'to', 'quote'],
  set_workspace_view: ['filesVisible', 'editorVisible', 'previewVisible', 'reviewVisible', 'outlineVisible', 'logsVisible'],
  set_editor_preferences: ['fontSize', 'wordWrap'],
  set_preview_view: ['page', 'zoomPercent', 'fitWidth'],
  set_window_state: ['state'],
  compile_manuscript: ['documentId', 'revision'],
};
const identity = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
const fail = (code, message) => { throw { code, message }; };
const present = value => value !== undefined && value !== null;

export function assertMcpCommand(command, snapshot) {
  const allowed = Object.hasOwn(fields, command?.kind) && fields[command.kind];
  if (!allowed || Object.keys(command).some(key => key !== 'kind' && !allowed.includes(key))) fail('arguments', 'Unsupported app control.');
  if (!Array.isArray(snapshot?.openDocuments) || snapshot.openDocuments.length > 20) fail('unavailable', 'The workspace is unavailable.');
  const clean = () => {
    if (snapshot.openDocuments.some(doc => doc.dirty !== false || doc.conflict !== false || doc.composing !== false)) fail('busy', 'Resolve local buffers before using this app control.');
  };
  const document = () => {
    if (!identity(command.documentId)) fail('arguments', 'Use an approved manuscript ID.');
    const doc = snapshot.openDocuments.find(doc => doc.documentId === command.documentId);
    if (!doc || doc.revision !== command.revision || !identity(command.revision)) fail('stale', 'Read the current saved manuscript first.');
    return doc;
  };
  const changed = () => {
    if (!allowed.some(key => present(command[key]))) fail('arguments', 'Choose a setting to change.');
  };
  const booleans = keys => {
    if (keys.some(key => present(command[key]) && typeof command[key] !== 'boolean')) fail('arguments', 'Use boolean view settings.');
  };
  switch (command.kind) {
    case 'open_manuscript':
      if (!identity(command.documentId)) fail('arguments', 'Use an approved manuscript ID.');
      clean(); break;
    case 'select_passage': {
      const doc = document();
      if (snapshot.activeDocumentId !== command.documentId || doc.dirty !== false || doc.conflict !== false || doc.composing !== false) fail('stale', 'Select a passage in the active clean manuscript.');
      if (!integer(command.from, 0, 2 * 1024 * 1024) || !integer(command.to, command.from + 1, 2 * 1024 * 1024) || typeof command.quote !== 'string' || command.quote.length !== command.to - command.from || new TextEncoder().encode(command.quote).length > 32_000) fail('arguments', 'Use an exact bounded UTF-16 passage.');
      break;
    }
    case 'set_workspace_view':
      changed(); booleans(allowed);
      if (!(command.editorVisible ?? snapshot.view?.editorVisible) && !(command.previewVisible ?? snapshot.view?.previewVisible)) fail('arguments', 'Keep the editor or preview visible.');
      break;
    case 'set_editor_preferences':
      changed(); booleans(['wordWrap']);
      if (present(command.fontSize) && !integer(command.fontSize, 10, 28)) fail('arguments', 'Editor font size must be between 10 and 28.');
      break;
    case 'set_preview_view':
      changed(); booleans(['fitWidth']);
      if (!snapshot.preview) fail('unavailable', 'No PDF preview is rendered.');
      if ((present(command.page) && !integer(command.page, 1, snapshot.preview.pages)) || (present(command.zoomPercent) && !integer(command.zoomPercent, 10, 400)) || (present(command.zoomPercent) && command.fitWidth === true)) fail('arguments', 'Use an existing page and either 10–400% zoom or fit width.');
      break;
    case 'set_window_state':
      if (!['minimize', 'maximize', 'restore', 'focus', 'close'].includes(command.state)) fail('arguments', 'Unsupported window action.');
      if (command.state === 'close') clean();
      break;
    case 'compile_manuscript': document(); clean(); break;
  }
}

// Async effects must call guard.check() again immediately before applying their effect.
export class McpControlBridge {
  constructor({ request, snapshot, effects, onError = () => {}, afterAcknowledged = () => {}, onRevoked = () => {}, onAcknowledgementFailed = () => {} }) {
    Object.assign(this, { request, snapshot, effects, onError, afterAcknowledged, onRevoked, onAcknowledgementFailed });
    this.handled = new Map();
    this.queue = [];
    this.generation = null;
    this.stopped = false;
  }

  async apply(job, generation, targetDocument) {
    const key = `${generation}:${job.requestId}`;
    if (this.handled.has(key)) return;
    if (this.handled.size >= 128) fail('limit', 'Re-enable app controls to start a new command history.');
    // Mark before execution. Lost acknowledgements may be retried; effects never are.
    this.handled.set(key, null);
    let outcome;
    const assertCurrent = () => {
      if (this.stopped || this.generation !== generation) fail('scope', 'App controls were revoked or replaced.');
      const current = this.snapshot();
      assertMcpCommand(job.command, current);
      if (job.command.kind === 'set_preview_view' && current.activeDocumentId !== targetDocument) fail('stale', 'The preview document changed.');
      return current;
    };
    const check = async () => {
      const response = await this.request({ action: 'control_check', requestId: job.requestId, ackToken: job.ackToken });
      if (response.authorized !== true || response.generation !== generation) fail('scope', 'App controls were revoked or replaced.');
      return assertCurrent();
    };
    try {
      await check();
      const effect = Object.hasOwn(this.effects, job.command.kind) && this.effects[job.command.kind];
      if (typeof effect !== 'function') fail('unavailable', 'This app control is unavailable in this window.');
      const compileSaved = async (assertPrepared = () => {}) => {
        if (job.command.kind !== 'compile_manuscript') fail('scope', 'This command cannot compile.');
        await check();
        assertPrepared();
        return this.request({ action: 'control_compile', requestId: job.requestId, ackToken: job.ackToken });
      };
      const openSaved = async (assertPrepared = () => {}) => {
        if (job.command.kind !== 'open_manuscript') fail('scope', 'This command cannot open a manuscript.');
        await check();
        assertPrepared();
        return this.request({ action: 'control_open', requestId: job.requestId, ackToken: job.ackToken });
      };
      const result = await effect(job.command, { check, assertCurrent, compileSaved, openSaved });
      outcome = { state: 'applied', result: result ?? {} };
    } catch (error) {
      // Keep uncertain effects reserved until native expiry; neither reject nor replay them.
      if (error?.code === 'outcome_unknown') throw error;
      outcome = { state: 'rejected', code: typeof error?.code === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(error.code) ? error.code : 'unavailable', message: Array.from(String(error?.message || 'The app control could not be applied.')).slice(0, 1000).join('') };
    }
    if (this.stopped || this.generation !== generation) return;
    this.handled.set(key, { job, outcome });
    await this.acknowledge(key);
  }

  async acknowledge(key) {
    const entry = this.handled.get(key);
    if (!entry || entry.acknowledging) return;
    entry.acknowledging = true;
    const { job, outcome } = entry;
    try {
      await this.request({ action: 'control_complete', requestId: job.requestId, ackToken: job.ackToken, outcome });
    } catch (error) {
      if (this.handled.get(key) === entry) this.onAcknowledgementFailed(job.command, outcome, error);
      throw error;
    } finally { entry.acknowledging = false; }
    if (this.handled.get(key) === entry) {
      this.handled.set(key, null);
      if (outcome.state === 'applied' && !this.stopped) await this.afterAcknowledged(job.command, outcome);
    }
  }

  async poll() {
    if (this.polling || this.stopped) return;
    this.polling = true;
    try {
      const snapshot = this.snapshot(), targetDocument = snapshot.activeDocumentId;
      const response = await this.request({ action: 'control_poll', snapshot });
      if (this.stopped) return;
      this.replaceGeneration(response.enabled ? response.generation : null);
      if (!this.generation) return;
      // Completion retry never retries the UI effect.
      for (const [key, entry] of this.handled) if (entry) {
        void this.acknowledge(key).catch(error => this.onError(error));
      }
      for (const job of response.jobs || []) {
        if (!identity(job.requestId) || !identity(job.ackToken)) continue;
        const generation = this.generation;
        if (this.handled.has(`${generation}:${job.requestId}`) || this.queue.some(entry => entry.generation === generation && entry.job.requestId === job.requestId)) continue;
        if (this.queue.length >= 16) { this.onError({ code: 'limit', message: 'The app control queue is full.' }); continue; }
        this.queue.push({ job, generation, targetDocument });
      }
      void this.drain();
    } catch (error) { this.onError(error); }
    finally { this.polling = false; }
  }

  replaceGeneration(generation) {
    if (this.generation === generation) return;
    const previous = this.generation;
    this.generation = generation;
    this.handled.clear(); this.queue = [];
    if (previous) this.onRevoked();
  }

  // Heartbeats continue during builds; effects remain ordered and bounded.
  drain() {
    if (this.draining) return this.draining;
    this.draining = (async () => {
      while (this.queue.length && !this.stopped) {
        const { job, generation, targetDocument } = this.queue.shift();
        if (generation !== this.generation) continue;
        try { await this.apply(job, generation, targetDocument); } catch (error) { this.onError(error, job.command); }
      }
    })().finally(() => { this.draining = null; });
    return this.draining;
  }

  start() {
    if (this.timer) return;
    this.stopped = false;
    void this.poll();
    this.timer = setInterval(() => void this.poll(), 750);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
    this.stopped = true;
    this.replaceGeneration(null);
  }
}
