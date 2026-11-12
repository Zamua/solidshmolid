// Reading a request body into memory, with a cap.

import { PayloadTooLarge } from './errors.js';

export async function readAll(stream: ReadableStream<Uint8Array>, limit: number): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new PayloadTooLarge(`bodies read into memory are limited to ${limit} bytes`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

/** The first `limit` bytes of a stream, and the stream to go on from: null
 * when it ended within them. */
export async function readAhead(stream: ReadableStream<Uint8Array>, limit: number): Promise<{ head: Uint8Array; rest: ReadableStream<Uint8Array> | null }> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let ended = false;
  while (total <= limit) {
    const { done, value } = await reader.read();
    if (done) {
      ended = true;
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }
  const head = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    head.set(c, offset);
    offset += c.byteLength;
  }
  if (ended) return { head, rest: null };
  let first = true;
  const rest = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (first) {
        first = false;
        controller.enqueue(head);
        return;
      }
      const { done, value } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel: (reason) => reader.cancel(reason),
  });
  return { head, rest };
}

/** The same bytes, given up with `stalled()` once none arrive for `ms`: a
 * sender that stops sending does not keep its request, or what waits on it. */
export function paced(stream: ReadableStream<Uint8Array>, ms: number, stalled: () => Error): ReadableStream<Uint8Array> {
  const reader = stream.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(stalled()), ms);
      });
      try {
        const { done, value } = await Promise.race([reader.read(), late]);
        if (done) controller.close();
        else controller.enqueue(value);
      } catch (e) {
        void reader.cancel(e).catch(() => undefined);
        throw e;
      } finally {
        clearTimeout(timer);
      }
    },
    cancel: (reason) => reader.cancel(reason),
  });
}
