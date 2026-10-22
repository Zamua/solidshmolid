// A FileStore over a real directory, so another server can read what we wrote.

import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { type ByteRange, type FileInfo, type FileStore, RevisionConflict, type StoredFile, type WriteOptions } from '../../app/ports.js';
import { bytesOf, streamOf } from './fakes.js';

export class DirFileStore implements FileStore {
  private readonly revs = new Map<string, string>();
  private counter = 0;

  constructor(private readonly root: string) {}

  async read(file: string, range?: ByteRange): Promise<StoredFile | null> {
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await readFile(join(this.root, file)));
    } catch {
      return null;
    }
    const slice = range ? bytes.slice(range.start, range.end + 1) : bytes;
    return { body: streamOf(slice), size: bytes.byteLength, rev: this.revs.get(file) ?? 'unknown' };
  }

  async write(file: string, body: ReadableStream<Uint8Array> | Uint8Array, options: WriteOptions = {}): Promise<FileInfo> {
    const path = join(this.root, file);
    const exists = await stat(path).then(() => true, () => false);
    if (options.ifRev === null && exists) throw new RevisionConflict(`${file} exists`);
    if (typeof options.ifRev === 'string' && this.revs.get(file) !== options.ifRev) throw new RevisionConflict(`${file} changed`);
    const bytes = body instanceof Uint8Array ? body : await bytesOf(body);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
    const rev = `r${++this.counter}`;
    this.revs.set(file, rev);
    return { file, rev, size: bytes.byteLength, modified: new Date().toISOString() };
  }

  async remove(file: string): Promise<void> {
    await rm(join(this.root, file), { force: true });
    this.revs.delete(file);
  }

  async makeFolder(folder: string): Promise<void> {
    await mkdir(join(this.root, folder), { recursive: true });
  }

  async removeFolder(folder: string): Promise<void> {
    await rm(join(this.root, folder), { recursive: true, force: true });
  }
}
