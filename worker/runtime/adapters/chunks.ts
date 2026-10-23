// Fixed-size pieces of a byte stream, for providers' chunked uploads.

/** Re-chunks a byte stream into pieces of exactly `size` bytes (the last may
 * be shorter), without holding more than one piece. */
export async function* chunked(stream: ReadableStream<Uint8Array>, size: number): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  let buffer = new Uint8Array(size);
  let filled = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    let offset = 0;
    while (offset < value.byteLength) {
      const take = Math.min(size - filled, value.byteLength - offset);
      buffer.set(value.subarray(offset, offset + take), filled);
      filled += take;
      offset += take;
      if (filled === size) {
        yield buffer;
        buffer = new Uint8Array(size);
        filled = 0;
      }
    }
  }
  if (filled > 0) yield buffer.slice(0, filled);
}
