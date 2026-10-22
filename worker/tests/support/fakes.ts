// Test doubles: an in-memory FileStore and the SQLite index over node:sqlite.

import { createRequire } from 'node:module';
import { type ByteRange, type FileInfo, type FileStore, RevisionConflict, type StoredFile, type WriteOptions } from '../../app/ports.js';
import { Pod } from '../../app/pod.js';
import { SqlIndex } from '../../runtime/sqlIndex.js';

// Vite does not know node:sqlite as a builtin and fails to resolve the import.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

export function sqliteIndex(): SqlIndex {
  const db = new DatabaseSync(':memory:');
  const sql = {
    exec(query: string, ...args: unknown[]) {
      const parts = query.split(';').filter((s) => s.trim());
      if (args.length === 0 && parts.length > 1) {
        db.exec(query);
        return { toArray: () => [] };
      }
      const rows = db.prepare(query).all(...(args as never[])) as Record<string, unknown>[];
      return { toArray: () => rows };
    },
  };
  const transaction = <T>(fn: () => T): T => {
    db.exec('BEGIN');
    try {
      const out = fn();
      db.exec('COMMIT');
      return out;
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  };
  return new SqlIndex(sql, transaction);
}

interface Entry {
  bytes: Uint8Array;
  rev: string;
  modified: string;
}

/** Files and folders in maps, revs from a counter. */
export class MemoryFileStore implements FileStore {
  readonly files = new Map<string, Entry>();
  readonly folders = new Set<string>();
  private counter = 0;

  async read(file: string, range?: ByteRange): Promise<StoredFile | null> {
    const entry = this.files.get(file);
    if (!entry) return null;
    const bytes = range ? entry.bytes.slice(range.start, range.end + 1) : entry.bytes;
    return { body: streamOf(bytes), size: entry.bytes.byteLength, rev: entry.rev };
  }

  async write(file: string, body: ReadableStream<Uint8Array> | Uint8Array, options: WriteOptions = {}): Promise<FileInfo> {
    const current = this.files.get(file);
    if (options.ifRev === null && current) throw new RevisionConflict(`${file} exists`);
    if (typeof options.ifRev === 'string' && current?.rev !== options.ifRev) throw new RevisionConflict(`${file} changed`);
    const bytes = body instanceof Uint8Array ? body : await bytesOf(body);
    const entry = { bytes, rev: `r${++this.counter}`, modified: new Date(0).toISOString() };
    this.files.set(file, entry);
    return { file, rev: entry.rev, size: bytes.byteLength, modified: entry.modified };
  }

  async remove(file: string): Promise<void> {
    this.files.delete(file);
  }

  async makeFolder(folder: string): Promise<void> {
    this.folders.add(folder);
  }

  async removeFolder(folder: string): Promise<void> {
    this.folders.delete(folder);
    for (const f of [...this.files.keys()]) if (f.startsWith(folder)) this.files.delete(f);
  }

  text(file: string): string | undefined {
    const entry = this.files.get(file);
    return entry && new TextDecoder().decode(entry.bytes);
  }
}

export function streamOf(bytes: Uint8Array | string): ReadableStream<Uint8Array> {
  const data = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes;
  return new ReadableStream({
    start(controller) {
      controller.enqueue(data);
      controller.close();
    },
  });
}

export async function bytesOf(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function textOf(body: ReadableStream<Uint8Array> | string | null): Promise<string> {
  if (body === null) return '';
  return typeof body === 'string' ? body : new TextDecoder().decode(await bytesOf(body));
}

export const BASE = 'https://alice.example';
export const ALICE = `${BASE}/profile/card#me`;
export const BOB = 'https://bob.example/profile/card#me';

export const PROFILE = `@prefix foaf: <http://xmlns.com/foaf/0.1/>.
<> a foaf:PersonalProfileDocument; foaf:primaryTopic <#me>.
<#me> a foaf:Person.
`;

/** A provisioned pod owned by ALICE. */
export async function newPod() {
  const index = sqliteIndex();
  const files = new MemoryFileStore();
  let id = 0;
  const pod = new Pod({ index, files, base: BASE, now: () => new Date('2026-10-22T12:00:00Z'), newId: () => `id${++id}` });
  await pod.provision(ALICE, PROFILE);
  return { pod, index, files };
}
