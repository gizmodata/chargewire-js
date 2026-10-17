// Licensed under the Apache License, Version 2.0.

/**
 * A bounded queue between producers and one consumer. `push` waits while the queue is
 * full, which is how a partition download is held back until its rows are wanted.
 */
export class AsyncQueue<T> {
  readonly #capacity: number;
  readonly #items: T[] = [];
  #producers: number;
  #error: unknown;
  #failed = false;
  #takers: Array<() => void> = [];
  #pushers: Array<() => void> = [];

  constructor(capacity: number, producers = 1) {
    this.#capacity = Math.max(1, capacity);
    this.#producers = producers;
  }

  /** Adds an item, waiting for room. Resolves false when the queue was failed or ended meanwhile. */
  async push(item: T): Promise<boolean> {
    while (this.#items.length >= this.#capacity && !this.#failed) {
      await new Promise<void>((resolve) => this.#pushers.push(resolve));
    }
    if (this.#failed) return false;
    this.#items.push(item);
    this.#wake(this.#takers);
    return true;
  }

  /** One producer is done. The queue ends once every producer is. */
  close(): void {
    this.#producers = Math.max(0, this.#producers - 1);
    this.#wake(this.#takers);
  }

  /** Fails the queue: the consumer gets `error` and producers stop. */
  fail(error: unknown): void {
    if (this.#failed) return;
    this.#failed = true;
    this.#error = error;
    this.#items.length = 0;
    this.#wake(this.#takers);
    this.#wake(this.#pushers);
  }

  get failed(): boolean {
    return this.#failed;
  }

  /** The next item; done once every producer closed and the queue is empty. */
  async next(): Promise<IteratorResult<T, undefined>> {
    for (;;) {
      if (this.#failed) throw this.#error;
      if (this.#items.length > 0) {
        const item = this.#items.shift() as T;
        this.#wake(this.#pushers);
        return { value: item, done: false };
      }
      if (this.#producers === 0) return { value: undefined, done: true };
      await new Promise<void>((resolve) => this.#takers.push(resolve));
    }
  }

  #wake(waiters: Array<() => void>): void {
    const all = waiters.splice(0);
    for (const wake of all) wake();
  }
}
