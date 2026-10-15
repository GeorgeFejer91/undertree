// One session stays bound to one file even while saves and tab switches overlap.
export class ReviewSession {
  constructor(snapshot, project, request) {
    this.project = project;
    this.path = snapshot.path;
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
  async saveCurrent() {
    if (this.reviewProblem) throw this.reviewProblem;
    if (this.conflict) throw { message: 'Resolve the external change before saving; your buffer is preserved.' };
    if (!this.dirty) return this.snapshot;
    const content = this.content;
    const version = this.version;
    const snapshot = this.snapshot;
    let response;
    try { response = await this.request({ action: 'save', project: this.project, path: this.path, revision: this.snapshot.review.revision, content }); }
    catch (error) {
      this.recordReviewProblem(error);
      if (error.code === 'stale' || error.code === 'conflict') {
        this.conflict = await this.request({ action: 'review', project: this.project, path: this.path }).catch(() => ({ content: null }));
        this.onChange?.();
      }
      throw error;
    }
    this.snapshot = snapshot.shared !== this.snapshot.shared ? { ...response, shared: this.snapshot.shared } : response;
    this.savedVersion = version;
    this.onChange?.();
    return response;
  }
  flush() {
    return this.enqueue(() => this.saveCurrent());
  }
  enqueue(callback) {
    this.pending += 1;
    const work = this.queue.catch(() => {}).then(callback).finally(() => { this.pending -= 1; });
    this.queue = work;
    return work;
  }
  mutate(action, payload = {}, assertCurrent) {
    return this.enqueue(async () => {
    assertCurrent?.();
    const version = this.version;
    await this.saveCurrent();
    assertCurrent?.();
    const snapshot = this.snapshot;
    let response;
    try { response = await this.request({ action, project: this.project, path: this.path, revision: this.snapshot.review.revision, ...payload }); }
    catch (error) { this.recordReviewProblem(error); throw error; }
    if (response.content !== undefined) {
      this.snapshot = snapshot.shared !== this.snapshot.shared ? { ...response, shared: this.snapshot.shared } : response;
      if (version === this.version) {
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
    return this.enqueue(async () => {
      const ready = () => {
        if (!isCurrent()) throw { code: 'stale_session', message: 'This editor session was closed or replaced.' };
        if (this.reviewProblem) throw this.reviewProblem;
        if (this.conflict) throw { code: 'conflict', message: 'Resolve the external change before saving; your buffer is preserved.' };
        if (isBusy()) throw { code: 'busy', message: 'The editor is composing text or closing. Retry after it is ready.' };
      };
      ready();
      const captured = { generation: this.generation, version: this.version, revision: this.snapshot.review.revision, content: this.content, shared: this.snapshot.shared };
      await publish(captured);
      ready();
      if (captured.generation !== this.generation || captured.content !== this.content || captured.revision !== this.snapshot.review.revision) throw { code: 'stale_buffer', message: 'The editor changed while preparing the save. Your buffer is preserved.' };
      let result;
      try { result = await commit(captured); }
      catch (error) {
        this.recordReviewProblem(error);
        if (error.code === 'stale' || error.code === 'conflict') {
          this.conflict = await this.request({ action: 'review', project: this.project, path: this.path }).catch(() => ({ content: null }));
          this.onChange?.();
        }
        throw error;
      }
      if (result.receipt?.status !== 'committed' || result.snapshot?.path !== this.path || result.snapshot?.content !== captured.content || result.receipt?.savedGeneration !== captured.generation || result.snapshot?.review?.revision !== result.receipt?.savedRevision) throw { code: 'outcome_unknown', message: 'The save receipt does not match the captured buffer. Inspect its native outcome before retrying.' };
      this.snapshot = captured.shared !== this.snapshot.shared ? { ...result.snapshot, shared: this.snapshot.shared } : result.snapshot;
      this.savedVersion = captured.version;
      this.onChange?.();
      return { result, current: isCurrent() && !isBusy() && !this.conflict && !this.reviewProblem && this.generation === captured.generation && this.content === captured.content };
    });
  }
  async refresh({ retryProblem = false, isCurrent = () => true } = {}) {
    const problem = this.reviewProblem;
    const retry = retryProblem && !!problem;
    if ((this.dirty || this.conflict || problem) && !retry) return false;
    const version = this.version;
    const snapshot = this.snapshot;
    const conflict = this.conflict;
    const project = this.project, path = this.path;
    let response;
    try { response = await this.request({ action: 'review', project, path }); }
    catch (error) {
      if (isCurrent() && snapshot === this.snapshot && problem === this.reviewProblem) this.recordReviewProblem(error);
      throw error;
    }
    if (!isCurrent() || project !== this.project || path !== this.path || version !== this.version || snapshot !== this.snapshot || problem !== this.reviewProblem || conflict !== this.conflict) return false;
    if (response?.path !== path || typeof response.content !== 'string' || typeof response.review?.revision !== 'string') throw { code: 'format', message: 'The review response does not match this manuscript. Your draft and last known review data are kept.' };
    if (retry) {
      this.reviewProblem = null;
      if (response.content !== snapshot.content) this.conflict = response;
      else if (!conflict) this.snapshot = response;
      this.onChange?.();
      return true;
    }
    if (response.content !== this.content) { this.conflict = response; this.onChange?.(); return false; }
    this.snapshot = response;
    this.onChange?.();
    return true;
  }
}
