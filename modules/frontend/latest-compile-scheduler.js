export class LatestCompileScheduler {
  #delayMs;
  #isBusy;
  #run;
  #setTimer;
  #clearTimer;
  #timer = null;
  #pendingKey = "";

  constructor({ delayMs, isBusy, run, setTimer = (callback, delay) => globalThis.setTimeout(callback, delay), clearTimer = handle => globalThis.clearTimeout(handle) }) {
    if (!Number.isFinite(delayMs) || delayMs < 0) throw new TypeError("delayMs must be a non-negative number");
    if (typeof isBusy !== "function" || typeof run !== "function") throw new TypeError("isBusy and run callbacks are required");
    this.#delayMs = delayMs;
    this.#isBusy = isBusy;
    this.#run = run;
    this.#setTimer = setTimer;
    this.#clearTimer = clearTimer;
  }

  request(key) {
    this.#pendingKey = String(key || "");
    this.#schedule(this.#delayMs);
  }

  release() {
    if (this.#pendingKey && !this.#isBusy()) this.#schedule(0);
  }

  cancel() {
    if (this.#timer !== null) this.#clearTimer(this.#timer);
    this.#timer = null;
    this.#pendingKey = "";
  }

  get pending() {
    return Boolean(this.#pendingKey);
  }

  #schedule(delayMs) {
    if (this.#timer !== null) this.#clearTimer(this.#timer);
    this.#timer = this.#setTimer(() => {
      this.#timer = null;
      void this.#drain();
    }, delayMs);
  }

  async #drain() {
    if (!this.#pendingKey || this.#isBusy()) return;
    const key = this.#pendingKey;
    this.#pendingKey = "";
    await this.#run(key);
    if (this.#pendingKey && !this.#isBusy()) this.#schedule(0);
  }
}
