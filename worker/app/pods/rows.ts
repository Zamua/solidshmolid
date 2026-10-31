// Index rows as both the pod service and reconcile write them.

import { basePathOf } from '../../domain/pods/layout.js';
import type { PodPath } from '../../domain/pods/paths.js';
import type { ContainerRow, PodIndex } from './ports.js';

export interface Stamps {
  now: () => Date;
  newId: () => string;
}

export function newContainerRow(path: PodPath, stamps: Stamps): ContainerRow {
  return { path, kind: 'container', file: basePathOf(path), etag: stamps.newId(), modified: stamps.now().toISOString() };
}

/** `container`'s membership changed: it gets a new ETag. */
export function touch(index: PodIndex, container: PodPath | null, stamps: Stamps): void {
  if (container === null) return;
  const row = index.get(container);
  if (row) index.upsert({ ...row, etag: stamps.newId(), modified: stamps.now().toISOString() });
}
