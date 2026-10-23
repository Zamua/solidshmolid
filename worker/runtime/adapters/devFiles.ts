// A FileStore inside the pod's own SQLite database. LOCAL DEVELOPMENT ONLY:
// it keeps user data on our side, which is exactly what deployments must not
// do, so the deployed configs never select it.

import { type ByteRange, type FileInfo, type FileStore, RevisionConflict, type StoredFile, type WriteOptions } from '../../app/storage/ports.js';
import type { SqlRunner } from './sql.js';

/** Durable Object SQLite rows top out near 2 MB. */
const DEV_FILE_LIMIT = 2 * 1024 * 1024;

export class DevFileStore implements FileStore {
  constructor(private readonly sql: SqlRunner) {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS dev_file(file TEXT PRIMARY KEY, body BLOB NOT NULL, rev TEXT NOT NULL, modified TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS dev_folder(folder TEXT PRIMARY KEY);
    `);
  }

  async read(file: string, range?: ByteRange): Promise<StoredFile | null> {
    const row = this.sql.exec('SELECT body, rev FROM dev_file WHERE file = ?', file).toArray()[0];
    if (!row) return null;
    const bytes = new Uint8Array(row.body as ArrayBuffer);
    const slice = range ? bytes.slice(range.start, range.end + 1) : bytes;
    return {
      body: new Response(slice).body!,
      size: bytes.byteLength,
      rev: String(row.rev),
    };
  }

  async write(file: string, body: ReadableStream<Uint8Array> | Uint8Array, options: WriteOptions = {}): Promise<FileInfo> {
    const current = this.sql.exec('SELECT rev FROM dev_file WHERE file = ?', file).toArray()[0];
    if (options.ifRev === null && current) throw new RevisionConflict(`${file} exists`);
    if (typeof options.ifRev === 'string' && String(current?.rev) !== options.ifRev) throw new RevisionConflict(`${file} changed`);
    const bytes = body instanceof Uint8Array ? body : new Uint8Array(await new Response(body).arrayBuffer());
    if (bytes.byteLength > DEV_FILE_LIMIT) throw new Error(`the dev store holds files up to ${DEV_FILE_LIMIT} bytes`);
    const rev = crypto.randomUUID().replaceAll('-', '');
    const modified = new Date().toISOString();
    this.sql.exec(
      'INSERT INTO dev_file(file, body, rev, modified) VALUES (?, ?, ?, ?) ON CONFLICT(file) DO UPDATE SET body = excluded.body, rev = excluded.rev, modified = excluded.modified',
      file,
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      rev,
      modified,
    );
    return { file, rev, size: bytes.byteLength, modified };
  }

  async remove(file: string): Promise<void> {
    this.sql.exec('DELETE FROM dev_file WHERE file = ?', file);
  }

  async makeFolder(folder: string): Promise<void> {
    this.sql.exec('INSERT OR IGNORE INTO dev_folder(folder) VALUES (?)', folder);
  }

  async removeFolder(folder: string): Promise<void> {
    this.sql.exec('DELETE FROM dev_folder WHERE folder = ?', folder);
    this.sql.exec("DELETE FROM dev_file WHERE file LIKE ? ESCAPE '\\'", `${folder.replace(/[\\%_]/gu, (c) => `\\${c}`)}%`);
  }
}
