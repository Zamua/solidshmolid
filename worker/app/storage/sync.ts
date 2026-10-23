// Keeping a pod's view of its storage fresh: edits made directly in the
// folder are folded in, at most once per interval.

import type { Pod } from '../pods/pod.js';
import type { FileLister, SyncCursor } from './ports.js';

export class FolderSync {
  private last = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly pod: Pod,
    private readonly cursor: SyncCursor,
    private readonly lister: FileLister,
    private readonly intervalMs: number,
    private readonly nowMs: () => number,
  ) {}

  /** Returns the number of changes applied; throws when the provider fails,
   * and the caller decides whether that blocks the request. */
  async syncIfStale(): Promise<number> {
    if (this.nowMs() - this.last < this.intervalMs) return 0;
    this.last = this.nowMs();
    const from = await this.cursor.cursor();
    if (!from) return 0;
    const listing = await this.lister.changes(from);
    if (listing.entries.length > 0) await this.pod.applyChanges(listing.entries);
    await this.cursor.setCursor(listing.cursor);
    return listing.entries.length;
  }
}
