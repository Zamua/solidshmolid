// The pod index port. Interfaces only.

import type { PodPath } from '../../domain/pods/paths.js';

interface Row {
  path: PodPath;
  /** Stored file (documents) or folder (containers), relative to the pod folder. */
  file: string;
  /** Opaque, unquoted; changes whenever the resource or its membership does. */
  etag: string;
  modified: string;
}

export interface ContainerRow extends Row {
  kind: 'container';
}

export interface DocumentRow extends Row {
  kind: 'document';
  contentType: string;
  /** The storage revision of `file`. */
  rev: string;
  size: number;
  /** A metadata file exists for this resource. */
  hasMeta: boolean;
}

export type ResourceRow = ContainerRow | DocumentRow;

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
