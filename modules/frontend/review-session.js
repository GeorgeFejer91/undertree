// A source epoch is native identity, not a revision or a value inferred from another tab.
export function sourceEpoch(record) {
  if (!Object.hasOwn(record, 'sourceEpoch')) return 0;
  if (!Number.isSafeInteger(record.sourceEpoch) || record.sourceEpoch < 0) throw { code: 'format', message: 'The manuscript source identity is invalid. Your buffer is kept.' };
  return record.sourceEpoch;
}
export function sourceRoot(record) {
  const supplied = Object.getOwnPropertyDescriptor(record, 'expectedRoot');
  if (!supplied && !('expectedRoot' in record)) return undefined;
  const root = supplied?.value;
  const valid = value => typeof value === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(value) && (value.length < 20 || value <= '18446744073709551615');
  if (!root || typeof root !== 'object' || Array.isArray(root) || (Object.getPrototypeOf(root) && Object.getPrototypeOf(Object.getPrototypeOf(root)) !== null) || Reflect.ownKeys(root).length !== 2 || !['dev', 'ino'].every(key => {
    const property = Object.getOwnPropertyDescriptor(root, key);
    return property && Object.hasOwn(property, 'value') && valid(property.value);
  })) throw { code: 'format', message: 'The project folder identity is invalid. Your buffer is kept.' };
  return Object.freeze({ dev: root.dev, ino: root.ino });
}
export function sourceRootsEqual(first, second) {
  const a = sourceRoot(first), b = sourceRoot(second);
  return a ? !!b && a.dev === b.dev && a.ino === b.ino : !b;
}
export function captureSourceBinding(session) {
  const root = sourceRoot(session);
  return Object.freeze({ project: session.project, path: session.path, sourceEpoch: sourceEpoch(session), ...(root ? { expectedRoot: root } : {}) });
}
export function sourceBindingCurrent(session, binding) {
  try { return !session.identityProblem && !session.uncertainMutation && !session.unresolvedMove && session.project === binding.project && session.path === binding.path && (!Object.hasOwn(session.snapshot, 'path') || session.snapshot.path === binding.path) && sourceEpoch(session) === binding.sourceEpoch && sourceEpoch(session.snapshot) === binding.sourceEpoch && sourceRootsEqual(session, binding) && sourceRootsEqual(session.snapshot, binding); }
  catch { return false; }
}
export function assertSourceBinding(session, binding = captureSourceBinding(session)) {
  if (!sourceBindingCurrent(session, binding)) throw session.identityProblem || { code: sourceRootsEqual(session, binding) && sourceRootsEqual(session.snapshot, binding) ? 'stale_document' : 'stale_root', message: 'This source or project folder identity changed. Your buffer and history are kept; reopen it deliberately after resolving the retired binding.' };
}
// Only an explicit local Close can dismiss a clean, known retired binding without saving.
export function localNoSaveClose(session) {
  if (session.dirty || session.conflict || session.pending || session.uncertainMutation || session.unresolvedMove) return false;
  if (!session.identityProblem) return ['policy_missing', 'recovery_conflict'].includes(session.reviewProblem?.code);
  if (!['stale_document', 'stale_root'].includes(session.identityProblem.code) || typeof session.identityProblem.message !== 'string' || !session.identityProblem.message.trim()) return false;
  try {
    if (session.identityProblem.code === 'stale_root' && !sourceRoot(session)) return false;
    assertSourceSnapshot(session.snapshot, captureSourceBinding(session));
    return true;
  } catch { return false; }
}
export function assertSourceSnapshot(snapshot, binding) {
  if (snapshot?.path !== binding.path || typeof snapshot.content !== 'string' || typeof snapshot.review?.revision !== 'string') throw { code: 'format', message: 'The response does not match this manuscript. Your buffer is kept.' };
  const epoch = sourceEpoch(snapshot);
  if (Object.hasOwn(snapshot, 'sidecarRevision') && snapshot.sidecarRevision !== null && (typeof snapshot.sidecarRevision !== 'string' || !/^[a-f0-9]{64}$/.test(snapshot.sidecarRevision))) throw { code: 'format', message: 'The review-file identity is invalid. Your last known data is kept.' };
  if (!sourceRootsEqual(snapshot, binding)) throw { code: 'stale_root', message: 'This project folder now has another identity. Your original buffer, protections and history are kept.' };
  if (epoch !== binding.sourceEpoch) throw { code: 'stale_document', message: 'This path now belongs to another source identity. Your original buffer, protections and history are kept.' };
}

// One session stays bound to one file even while saves and tab switches overlap.
export class ReviewSession {
  constructor(snapshot, project, request) {
    this.project = project;
    this.path = snapshot.path;
    this.sourceEpoch = sourceEpoch(snapshot);
    const root = sourceRoot(snapshot);
    if (root) this.expectedRoot = root;
    assertSourceSnapshot(snapshot, captureSourceBinding(this));
    this.request = request;
    this.snapshot = snapshot;
    this.content = snapshot.content;
    this.version = 0;
    this.savedVersion = 0;
    this.generation = 0;
    this.queue = Promise.resolve();
    this.pending = 0;
    this.conflict = null;
    this.reviewProblem = null;
    this.identityProblem = null;
  }
  get dirty() { return this.version !== this.savedVersion; }
  edit(content) { this.content = content; this.version += 1; this.generation += 1; this.onChange?.(); }
  recordReviewProblem(error) {
    if (!['policy_missing', 'recovery_conflict'].includes(error?.code)) return false;
    if (this.reviewProblem?.code === error.code && this.reviewProblem.message === error.message) return false;
    this.reviewProblem = { code: error.code, message: error.message };
    this.onChange?.();
    return true;
  }
  recordIdentityProblem(error, binding) {
    if (!['stale_document', 'stale_root'].includes(error?.code) || this.project !== binding.project || this.path !== binding.path || this.sourceEpoch !== binding.sourceEpoch || !sourceRootsEqual(this, binding)) return false;
    if (this.identityProblem) return false;
    this.identityProblem = { code: error.code, message: error.message }; this.onChange?.();
    return true;
  }
  checkSnapshot(response, binding) {
    assertSourceBinding(this, binding);
    try { assertSourceSnapshot(response, binding); }
    catch (error) { this.recordIdentityProblem(error, binding); throw error; }
  }
  async saveCurrent(binding = captureSourceBinding(this)) {
    assertSourceBinding(this, binding);
    if (this.reviewProblem) throw this.reviewProblem;
    if (this.conflict) throw { message: 'Resolve the external change before saving; your buffer is preserved.' };
    if (!this.dirty) return this.snapshot;
    const content = this.content;
    const version = this.version;
    const snapshot = this.snapshot;
    let response;
    try { response = await this.request({ action: 'save', ...binding, revision: snapshot.review.revision, content }); }
    catch (error) {
      if (this.recordIdentityProblem(error, binding) || !sourceBindingCurrent(this, binding)) throw error;
      this.recordReviewProblem(error);
      if (error.code === 'stale' || error.code === 'conflict') {
        const observed = await this.request({ action: 'review', ...binding }).catch(error => { this.recordIdentityProblem(error, binding); return { content: null }; });
        assertSourceBinding(this, binding);
        if (observed.content !== null) this.checkSnapshot(observed, binding);
        this.conflict = observed;
        this.onChange?.();
      }
      throw error;
    }
    this.checkSnapshot(response, binding);
    if (response.content !== content) throw { code: 'outcome_unknown', message: 'The save response does not match the captured draft. Inspect the native outcome before retrying.' };
    this.snapshot = snapshot.shared !== this.snapshot.shared ? { ...response, shared: this.snapshot.shared } : response;
    this.savedVersion = version;
    this.onChange?.();
    return response;
  }
  flush() {
    const binding = captureSourceBinding(this);
    return this.enqueue(() => this.saveCurrent(binding));
  }
  enqueue(callback) {
    this.pending += 1;
    const work = this.queue.catch(() => {}).then(callback).finally(() => { this.pending -= 1; });
    this.queue = work;
    return work;
  }
  mutate(action, payload = {}, assertCurrent) {
    const binding = captureSourceBinding(this);
    const pdfAnnotation = action === 'pdf_mark' || action === 'pdf_unmark';
    return this.enqueue(async () => {
    assertSourceBinding(this, binding);
    assertCurrent?.();
    const version = this.version;
    if (!pdfAnnotation) await this.saveCurrent(binding);
    assertSourceBinding(this, binding);
    assertCurrent?.();
    const snapshot = this.snapshot;
    let response;
    try {
      for (let attempt = 0; ; attempt += 1) {
        assertSourceBinding(this, binding);
        assertCurrent?.();
        if (attempt && version !== this.version) throw { code: 'stale_buffer', message: 'The editor changed while waiting to apply this review action. Select the passage again.' };
        try { response = await this.request({ action, ...payload, ...binding, revision: snapshot.review.revision }); break; }
        catch (error) {
          // This exact native refusal occurs before dispatch; uncertain mutation failures must never replay.
          if (attempt >= 3 || error?.code !== 'busy' || error.message !== 'A local document operation is running. Retry this action.') throw error;
          await new Promise(resolve => setTimeout(resolve, 50 * (attempt + 1)));
        }
      }
    }
    catch (error) { if (sourceBindingCurrent(this, binding)) this.recordReviewProblem(error); this.recordIdentityProblem(error, binding); throw error; }
    this.checkSnapshot(response, binding);
    if (pdfAnnotation && response.content !== snapshot.content) throw { code: 'conflict', message: 'The saved source changed while annotating the PDF. Your editor buffer is preserved.' };
    if (response.content !== undefined) {
      this.snapshot = snapshot.shared !== this.snapshot.shared ? { ...response, shared: this.snapshot.shared } : response;
      if (!pdfAnnotation && version === this.version) {
        if (this.content !== response.content) this.generation += 1;
        this.content = response.content;
        this.savedVersion = this.version;
        // A refresh may observe this acceptance on disk before its response arrives.
        if (action === 'decide' && payload.decision === 'accepted'
          && this.conflict?.content === response.content
          && this.conflict.review?.revision === response.review.revision) this.conflict = null;
      } else if (action === 'decide' && payload.decision === 'accepted') {
        // Never overwrite typing that happened while an acceptance was in flight.
        this.conflict = response;
      }
      this.onChange?.();
    }
    return response;
    });
  }
  saveEditorSnapshot({ isCurrent, isBusy, publish, commit }) {
    const binding = captureSourceBinding(this);
    return this.enqueue(async () => {
      const ready = () => {
        assertSourceBinding(this, binding);
        if (!isCurrent()) throw { code: 'stale_session', message: 'This editor session was closed or replaced.' };
        if (this.reviewProblem) throw this.reviewProblem;
        if (this.conflict) throw { code: 'conflict', message: 'Resolve the external change before saving; your buffer is preserved.' };
        if (isBusy()) throw { code: 'busy', message: 'The editor is composing text or closing. Retry after it is ready.' };
      };
      ready();
      const captured = { ...binding, generation: this.generation, version: this.version, revision: this.snapshot.review.revision, content: this.content, shared: this.snapshot.shared };
      await publish(captured);
      ready();
      if (captured.generation !== this.generation || captured.content !== this.content || captured.revision !== this.snapshot.review.revision) throw { code: 'stale_buffer', message: 'The editor changed while preparing the save. Your buffer is preserved.' };
      let result;
      try { result = await commit(captured); }
      catch (error) {
        if (this.recordIdentityProblem(error, binding) || !sourceBindingCurrent(this, binding)) throw error;
        this.recordReviewProblem(error);
        if (error.code === 'stale' || error.code === 'conflict') {
          const observed = await this.request({ action: 'review', ...binding }).catch(error => { this.recordIdentityProblem(error, binding); return { content: null }; });
          assertSourceBinding(this, binding);
          if (observed.content !== null) this.checkSnapshot(observed, binding);
          this.conflict = observed;
          this.onChange?.();
        }
        throw error;
      }
      this.checkSnapshot(result.snapshot, binding);
      if (sourceEpoch(result.receipt || {}) !== binding.sourceEpoch || !sourceRootsEqual(result.receipt || {}, binding)) throw { code: 'outcome_unknown', message: 'The save receipt belongs to another source or project folder identity. Inspect its native outcome.' };
      if (result.receipt?.status !== 'committed' || result.snapshot?.path !== this.path || result.snapshot?.content !== captured.content || result.receipt?.savedGeneration !== captured.generation || result.snapshot?.review?.revision !== result.receipt?.savedRevision) throw { code: 'outcome_unknown', message: 'The save receipt does not match the captured buffer. Inspect its native outcome before retrying.' };
      this.snapshot = captured.shared !== this.snapshot.shared ? { ...result.snapshot, shared: this.snapshot.shared } : result.snapshot;
      this.savedVersion = captured.version;
      this.onChange?.();
      return { result, current: isCurrent() && !isBusy() && !this.conflict && !this.reviewProblem && !this.identityProblem && this.generation === captured.generation && this.content === captured.content };
    });
  }
  async refresh({ retryProblem = false, metadataOnly = false, directEdits = false, isCurrent = () => true } = {}) {
    if (this.identityProblem) throw this.identityProblem;
    const binding = captureSourceBinding(this);
    assertSourceBinding(this, binding);
    const problem = this.reviewProblem;
    const retry = retryProblem && !!problem;
    if (((this.dirty && !metadataOnly) || this.conflict || problem) && !retry) return false;
    const version = this.version;
    const snapshot = this.snapshot;
    const conflict = this.conflict;
    const project = this.project, path = this.path;
    let response;
    try { response = await this.request({ action: 'review', ...binding }); }
    catch (error) {
      if (isCurrent() && sourceBindingCurrent(this, binding) && snapshot === this.snapshot && problem === this.reviewProblem) { this.recordReviewProblem(error); this.recordIdentityProblem(error, binding); }
      throw error;
    }
    if (!isCurrent() || !sourceBindingCurrent(this, binding) || project !== this.project || path !== this.path || (!metadataOnly && version !== this.version) || snapshot !== this.snapshot || problem !== this.reviewProblem || conflict !== this.conflict) return false;
    this.checkSnapshot(response, binding);
    if (retry) {
      this.reviewProblem = null;
      if (response.content !== snapshot.content) this.conflict = response;
      else if (!conflict) this.snapshot = response;
      this.onChange?.();
      return true;
    }
    if (response.content !== (metadataOnly ? snapshot.content : this.content)) {
      if (metadataOnly && this.pending) return false;
      const receipt = response.directEdit;
      if (!directEdits || !metadataOnly || this.dirty || this.pending || version !== this.version || this.content !== snapshot.content
        || !receipt || receipt.fromRevision !== snapshot.review.revision || receipt.toRevision !== response.review.revision) {
        this.conflict = response; this.onChange?.(); return false;
      }
      this.content = response.content;
      this.version += 1; this.generation += 1; this.savedVersion = this.version;
    }
    this.snapshot = response;
    this.onChange?.();
    return true;
  }
}
