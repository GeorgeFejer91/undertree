import { captureSourceBinding, sourceBindingCurrent, sourceEpoch, sourceRootsEqual, assertSourceBinding } from './review-session.js';

// UI state is advisory; Rust validates each captured save and owns its durable receipt.
export class EditorSessionBridge {
  constructor({ request, state, onSaved = () => {}, onError = () => {}, digest = sha256 }) {
    Object.assign(this, { request, state, onSaved, onError, digest });
    this.entries = new Map();
    this.handled = new Set();
    this.running = new Set();
  }
  watch(session) {
    const entry = { session, binding: captureSourceBinding(session), id: null, queue: Promise.resolve(), changed: true, retired: false };
    this.entries.set(session, entry);
    session.onChange = () => this.changed(session);
    this.changed(session);
  }
  changed(session) {
    const entry = this.entries.get(session);
    if (!entry) return;
    entry.changed = true;
    if (!this.updateTimer) this.updateTimer = setTimeout(() => {
      this.updateTimer = null;
      void this.publishChanges();
    }, 75);
  }
  async unwatch(session) {
    const entry = this.entries.get(session);
    if (!entry) return;
    entry.retired = true;
    this.entries.delete(session);
    session.onChange = null;
    await entry.queue.catch(() => {});
    if (entry.id) await this.request({ action: 'editor_unregister', sessionId: entry.id }).catch(() => {});
  }
  current(entry) { return !entry.retired && sourceBindingCurrent(entry.session, entry.binding) && this.state(entry.session).current; }
  publish(entry, captured) {
    const binding = captureSourceBinding(entry.session);
    const work = entry.queue.catch(() => {}).then(async () => {
      const session = entry.session;
      assertSourceBinding(session, binding);
      const buffer = captured || { ...binding, generation: session.generation, revision: session.snapshot.review.revision, content: session.content };
      const contentDigest = entry.digest?.generation === buffer.generation ? entry.digest.value : await this.digest(buffer.content);
      if (!this.current(entry)) throw { code: 'stale_session', message: 'This editor session was retired.' };
      if (!sourceBindingCurrent(session, buffer) || buffer.generation !== session.generation || buffer.content !== session.content || buffer.revision !== session.snapshot.review.revision) throw { code: 'stale_buffer', message: 'The editor changed during save preparation.' };
      entry.digest = { generation: buffer.generation, value: contentDigest };
      const { composing, closing } = this.state(session);
      const fields = { generation: buffer.generation, revision: buffer.revision, contentDigest, dirty: session.dirty, composing: composing || closing, conflict: !!(session.conflict || session.reviewProblem || session.identityProblem) };
      let result;
      try {
        result = await this.request(entry.id
          ? { action: 'editor_update', sessionId: entry.id, ...fields }
          : { action: 'editor_register', ...binding, ...fields });
        if (result.protocolVersion !== 1 || !result.sessionId) throw { code: 'format', message: 'The native editor protocol is unavailable.' };
        assertSourceBinding(session, binding);
        if (!sourceRootsEqual(result, binding)) throw { code: 'stale_root', message: 'The editor registration belongs to another project folder identity.' };
        if (!this.current(entry) || sourceEpoch(result) !== binding.sourceEpoch) throw { code: 'stale_document', message: 'The editor registration belongs to another source identity.' };
        entry.id = result.sessionId;
        entry.published = fields;
        // A later edit owns the pending update, even if this publication finished afterward.
        if (sourceBindingCurrent(session, binding) && buffer.generation === session.generation && buffer.revision === session.snapshot.review.revision && fields.dirty === session.dirty && composing === this.state(session).composing && closing === this.state(session).closing && fields.conflict === !!(session.conflict || session.reviewProblem || session.identityProblem)) entry.changed = false;
      } catch (error) {
        if (error.code === 'stale_session') entry.id = null;
        if (result?.sessionId && (!this.current(entry) || ['stale_root', 'stale_document'].includes(error.code))) await this.request({ action: 'editor_unregister', sessionId: result.sessionId }).catch(() => {});
        if (session.recordIdentityProblem(error, binding)) this.onError(error, session);
        throw error;
      }
    });
    entry.queue = work;
    return work;
  }
  async publishChanges() {
    for (const entry of this.entries.values()) {
      const session = entry.session, state = this.state(session), previous = entry.published;
      // EditContext composition can begin without a DOM input/update event.
      if (!previous || previous.composing !== (state.composing || state.closing) || previous.conflict !== !!(session.conflict || session.reviewProblem || session.identityProblem) || previous.dirty !== session.dirty || previous.generation !== session.generation || previous.revision !== session.snapshot.review.revision) entry.changed = true;
    }
    await Promise.allSettled([...this.entries.values()].filter(entry => entry.changed && this.current(entry)).map(entry => {
      if (!entry.automatic) entry.automatic = this.publish(entry).finally(() => { entry.automatic = null; });
      return entry.automatic;
    }));
  }
  async poll() {
    if (this.polling) return;
    this.polling = true;
    try {
      await this.publishChanges();
      const result = await this.request({ action: 'editor_poll' });
      if (result.protocolVersion !== 1 || !Array.isArray(result.requests)) return;
      for (const action of result.requests) {
        if (this.running.has(action.requestId) || this.handled.has(action.requestId)) continue;
        const entry = [...this.entries.values()].find(entry => entry.id === action.sessionId && entry.session.project === action.project && entry.session.path === action.path);
        if (!entry) continue;
        this.running.add(action.requestId);
        void this.save(entry, action).finally(() => {
          this.running.delete(action.requestId);
          this.handled.add(action.requestId);
          if (this.handled.size > 128) this.handled.delete(this.handled.values().next().value);
        });
      }
    } catch { /* An unavailable UI bridge never licenses a fallback disk write. */ }
    finally { this.polling = false; }
  }
  async save(entry, action) {
    const session = entry.session;
    const identity = { requestId: action.requestId, ticket: action.ticket, sessionId: action.sessionId };
    let commitSent = false;
    try {
      const { result } = await session.saveEditorSnapshot({
        isCurrent: () => this.current(entry) && entry.id === action.sessionId,
        isBusy: () => { const state = this.state(session); return state.composing || state.closing; },
        publish: captured => this.publish(entry, captured),
        commit: captured => {
          commitSent = true;
          return this.request({ action: 'editor_commit', ...identity, generation: captured.generation, revision: captured.revision, content: captured.content });
        },
      });
      this.onSaved(session);
      await this.publish(entry).catch(() => {});
      const state = this.state(session);
      const current = this.current(entry) && !state.composing && !state.closing && !session.conflict && !session.reviewProblem && !session.identityProblem && sourceEpoch(result.receipt) === session.sourceEpoch && session.generation === result.receipt.savedGeneration && session.content === result.snapshot.content;
      await this.request({ action: 'editor_complete', ...identity, status: current ? 'saved' : 'newer_buffer', generation: session.generation });
    } catch (error) {
      // A lost commit response stays explicitly uncertain; never manufacture a second save.
      if (!(commitSent && (!error.code || error.code === 'outcome_unknown'))) await this.request({ action: 'editor_complete', ...identity, status: error.code === 'busy' ? 'busy' : 'stale_buffer', generation: session.generation }).catch(() => {});
      this.onError(error, session);
    }
  }
  start() {
    if (this.timer) return;
    void this.poll();
    this.timer = setInterval(() => void this.poll(), 1000);
  }
  stop() { clearInterval(this.timer); clearTimeout(this.updateTimer); this.timer = null; this.updateTimer = null; }
}

async function sha256(content) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
