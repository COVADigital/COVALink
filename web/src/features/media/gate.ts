/**
 * Process-local bound on concurrent image decodes. At most
 * `maxActive` tasks run; up to `maxQueued` wait, each for at most
 * `queueTimeoutMs`. Anything beyond that is refused at once with
 * `GateSaturatedError` instead of piling up decodes. A slot is released only
 * when the task's own promise settles, so a caller that stops waiting (a
 * response deadline) never frees a slot while the decode is still running.
 */

export class GateSaturatedError extends Error {
  constructor() {
    super("Too many images are being processed right now");
    this.name = "GateSaturatedError";
  }
}

export interface GateOptions {
  maxActive: number;
  maxQueued: number;
  queueTimeoutMs: number;
}

export class ConcurrencyGate {
  #active = 0;
  #queue: { resolve: () => void; timer: ReturnType<typeof setTimeout> }[] = [];

  constructor(readonly options: GateOptions) {}

  get active() {
    return this.#active;
  }

  get queued() {
    return this.#queue.length;
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.#acquire();
    try {
      return await task();
    } finally {
      this.#release();
    }
  }

  #acquire(): Promise<void> {
    if (this.#active < this.options.maxActive) {
      this.#active++;
      return Promise.resolve();
    }
    if (this.#queue.length >= this.options.maxQueued) return Promise.reject(new GateSaturatedError());
    return new Promise<void>((resolve, reject) => {
      const entry = {
        resolve,
        timer: setTimeout(() => {
          const i = this.#queue.indexOf(entry);
          if (i >= 0) this.#queue.splice(i, 1);
          reject(new GateSaturatedError());
        }, this.options.queueTimeoutMs),
      };
      this.#queue.push(entry);
    });
  }

  #release() {
    const next = this.#queue.shift();
    if (next) {
      clearTimeout(next.timer); // the slot passes directly to the next waiter
      next.resolve();
    } else {
      this.#active--;
    }
  }
}

export class DeadlineError extends Error {
  constructor() {
    super("Processing took too long");
    this.name = "DeadlineError";
  }
}

/** Rejects with `DeadlineError` if `promise` hasn't settled within `ms`; the work itself keeps running. */
export async function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DeadlineError()), ms);
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    clearTimeout(timer);
  }
}
