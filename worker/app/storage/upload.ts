// The three-step write for storage that has no upload of its own to split:
// the body is held, and written whole at the end.

import { readAll } from '../shared/streams.js';
import type { FileInfo, FileStore, Upload, WriteOptions } from './ports.js';

export function heldUpload(store: Pick<FileStore, 'write'>, file: string, options: WriteOptions | undefined, limit = Number.POSITIVE_INFINITY): Upload {
  let held: Uint8Array = new Uint8Array();
  return {
    async send(body: ReadableStream<Uint8Array>): Promise<void> {
      held = await readAll(body, limit);
    },
    finish(): Promise<FileInfo> {
      return store.write(file, held, options);
    },
  };
}
