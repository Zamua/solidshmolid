// Keeping a pod's view of its storage fresh: edits made directly in the
// folder are folded in, at most once per interval.

import type { Pod } from '../pods/pod.js';
import { nextPlacement, stored } from './placement.js';
import type { FileLister, PlacementStore } from './ports.js';

export class FolderSync {
  private last = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly pod: Pod,
    private readonly placement: PlacementStore,
    private readonly lister: FileLister,
    private readonly intervalMs: number,
    private readonly nowMs: () => number,
  ) {}

  /** Returns the number of changes applied; throws when the provider fails,
   * and the caller decides whether that blocks the request. */
  async syncIfStale(): Promise<number> {
    if (this.nowMs() - this.last < this.intervalMs) return 0;
    this.last = this.nowMs();
    const current = this.placement.current();
    if (current.state !== 'placed') return 0;
    const listing = await this.lister.changes(current.cursor);
    if (listing.entries.length > 0) await this.pod.applyChanges(listing.entries);
    this.placement.save(stored(nextPlacement(current, { kind: 'synced', cursor: listing.cursor }).state));
    return listing.entries.length;
  }
}
