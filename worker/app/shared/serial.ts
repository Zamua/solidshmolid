// Runs async tasks one at a time, in arrival order.
//
// A Durable Object delivers a new request while an earlier one awaits a
// fetch, so storage calls to the user's provider interleave unless writes are
// queued here. One queue per pod makes every read-modify-write atomic with
// respect to this server.

export class Serial {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task, task);
    this.tail = result.catch(() => undefined);
    return result;
  }
}
