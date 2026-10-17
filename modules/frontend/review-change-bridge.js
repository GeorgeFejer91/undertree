// Native invalidations contain no manuscript content. Read the bound review after each change.
export class ReviewChangeBridge {
  constructor({ request, onChange, retryMs = 1000 }) { Object.assign(this, { request, onChange, retryMs }); }
  start() {
    if (this.running) return;
    this.running = true;
    const generation = this.generation = (this.generation || 0) + 1;
    void this.run(generation);
  }
  stop() { this.running = false; this.generation = (this.generation || 0) + 1; }
  async run(generation) {
    let after = null, instanceId = null;
    while (this.running && generation === this.generation) {
      try {
        const result = await this.request({ action: 'review_changes', after, waitMs: 25000 });
        if (!this.running || generation !== this.generation) return;
        if (typeof result.instanceId !== 'string' || typeof result.sequence !== 'string' || !/^\d{1,20}$/.test(result.sequence) || typeof result.changed !== 'boolean') throw Error('Invalid review change notification.');
        after = result.sequence;
        const restarted = instanceId !== result.instanceId;
        instanceId = result.instanceId;
        if (result.changed || restarted) await this.onChange();
      } catch {
        after = null;
        // Read-only fallback polling remains active if this notification channel is unavailable.
        await new Promise(resolve => setTimeout(resolve, this.retryMs));
      }
    }
  }
}
