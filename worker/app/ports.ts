// The ports the pod service depends on. Interfaces only.

import type { PodPath } from '../domain/paths.js';

/** A stored file. `file` is relative to the pod folder, `/`-separated. */
export interface FileInfo {
  file: string;
  /** The storage provider's revision; changes on every write. */
  rev: string;
  size: number;
  modified: string;
}

export interface StoredFile {
  body: ReadableStream<Uint8Array>;
  /** Size of the whole file, not of the range. */
  size: number;
  rev: string;
}

/** Inclusive byte offsets, already resolved against the file size. */
export interface ByteRange {
  start: number;
  end: number;
}

export interface WriteOptions {
  /** Absent: write unconditionally. Null: the file must not exist. A string:
   * the file must be at that revision. */
  ifRev?: string | null;
}

/** The user's storage, rooted at the pod folder. */
export interface FileStore {
  read(file: string, range?: ByteRange): Promise<StoredFile | null>;
  write(file: string, body: ReadableStream<Uint8Array> | Uint8Array, options?: WriteOptions): Promise<FileInfo>;
  /** Removing a missing file succeeds. */
  remove(file: string): Promise<void>;
  /** Creating an existing folder succeeds. */
  makeFolder(folder: string): Promise<void>;
  removeFolder(folder: string): Promise<void>;
}

/** A write's revision precondition failed. */
export class RevisionConflict extends Error {}

export interface ResourceRow {
  path: PodPath;
  kind: 'container' | 'document';
  /** Documents only. */
  contentType: string | null;
  /** Stored file (documents) or folder (containers), relative to the pod folder. */
  file: string;
  /** Documents only: the storage revision of `file`. */
  rev: string | null;
  /** Opaque, unquoted; changes whenever the resource or its membership does. */
  etag: string;
  size: number;
  modified: string;
  /** A metadata file exists for this resource. */
  hasMeta: boolean;
}

export interface PodState {
  owner: string;
  created: string;
}

/** The per-pod index of every resource. Synchronous: it is local to the pod. */
export interface PodIndex {
  state(): PodState | null;
  setState(state: PodState): void;
  get(path: PodPath): ResourceRow | null;
  /** The resource whose case-folded path equals `fold`, if any. */
  byFold(fold: string): ResourceRow | null;
  children(container: PodPath): ResourceRow[];
  upsert(row: ResourceRow): void;
  delete(path: PodPath): void;
  /** Cached text of a small RDF document, or null. */
  cachedText(path: PodPath): string | null;
  setCachedText(path: PodPath, text: string | null): void;
  atomically<T>(fn: () => T): T;
}
