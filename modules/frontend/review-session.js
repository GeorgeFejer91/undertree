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
    this.queue = Promise.resolve();
    this.conflict = null;
  }
  get dirty() { return this.version !== this.savedVersion; }
  edit(content) { this.content = content; this.version += 1; }
  async saveCurrent() {
    if (this.conflict) throw { message: 'Resolve the external change before saving; your buffer is preserved.' };
    if (!this.dirty) return this.snapshot;
    const content = this.content;
    const version = this.version;
    let response;
    try { response = await this.request({ action: 'save', project: this.project, path: this.path, revision: this.snapshot.review.revision, content }); }
    catch (error) {
      if (error.code === 'stale' || error.code === 'conflict') {
        this.conflict = await this.request({ action: 'review', project: this.project, path: this.path }).catch(() => ({ content: null }));
      }
      throw error;
    }
    this.snapshot = response;
    this.savedVersion = version;
    return response;
  }
  flush() {
    const work = this.queue.catch(() => {}).then(() => this.saveCurrent());
    this.queue = work;
    return work;
  }
  mutate(action, payload = {}) {
    const work = this.queue.catch(() => {}).then(async () => {
    await this.saveCurrent();
    const version = this.version;
    const response = await this.request({ action, project: this.project, path: this.path, revision: this.snapshot.review.revision, ...payload });
    if (response.content !== undefined) {
      this.snapshot = response;
      if (version === this.version) {
        this.content = response.content;
        this.savedVersion = this.version;
      } else if (action === 'decide' && payload.decision === 'accepted') {
        // Never overwrite typing that happened while an acceptance was in flight.
        this.conflict = response;
      }
    }
    return response;
    });
    this.queue = work;
    return work;
  }
  async refresh() {
    if (this.dirty || this.conflict) return false;
    const version = this.version;
    const response = await this.request({ action: 'review', project: this.project, path: this.path });
    if (version !== this.version) return false;
    if (response.content !== this.content) { this.conflict = response; return false; }
    this.snapshot = response;
    return true;
  }
}
