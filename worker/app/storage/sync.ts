// Keeping a pod's view of its storage fresh: edits made directly in the
// folder are folded in, at most once per interval.

import type { Pod } from '../pods/pod.js';
import { nextPlacement, stored } from './placement.js';
import type { FileLister, PlacementStore } from './ports.js';

/** When a pod's storage was last asked for changes. */
export interface SyncClock {
  last: number;
}

export const neverSynced = (): SyncClock => ({ last: Number.NEGATIVE_INFINITY });

export class FolderSync {
  constructor(
    private readonly pod: Pod,
    private readonly placement: PlacementStore,
    private readonly lister: FileLister,
    private readonly intervalMs: number,
    private readonly nowMs: () => number,
    /** Shared by every sync of one pod, so a rebuilt sync keeps the interval. */
    private readonly clock: SyncClock = neverSynced(),
  ) {}

  /** Returns the number of changes applied; throws when the provider fails,
   * and the caller decides whether that blocks the request. */
  async syncIfStale(): Promise<number> {
    if (this.nowMs() - this.clock.last < this.intervalMs) return 0;
    this.clock.last = this.nowMs();
    const current = this.placement.current();
    if (current.state !== 'placed') return 0;
    const listing = await this.lister.changes(current.cursor);
    if (listing.entries.length > 0) await this.pod.applyChanges(listing.entries);
    this.placement.save(stored(nextPlacement(current, { kind: 'synced', cursor: listing.cursor }).state));
    return listing.entries.length;
  }
}
