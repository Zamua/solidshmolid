// Keeping a pod's view of its storage fresh: edits made directly in the
// folder are folded in, at most once per interval.

import type { Pod } from '../pods/pod.js';
import type { ReconcileReport } from '../pods/reconcile.js';
import { nextPlacement, stored } from './placement.js';
import { CursorLost, type FileLister, type PlacementStore } from './ports.js';

/** When a pod's storage was last asked for changes, and when it last answered. */
export interface SyncClock {
  last: number;
  /** The last time the index was known to match the folder. */
  ok: number;
}

export const neverSynced = (): SyncClock => ({ last: Number.NEGATIVE_INFINITY, ok: Number.NEGATIVE_INFINITY });

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

  /** What a sync that ran changed, or null when none was due; throws when the
   * provider fails, and the caller decides whether that blocks the request. */
  async syncIfStale(): Promise<ReconcileReport | null> {
    if (this.nowMs() - this.clock.last < this.intervalMs) return null;
    this.clock.last = this.nowMs();
    const current = this.placement.current();
    if (current.state !== 'placed') return null;
    const { report, cursor } = await this.changesSince(current.cursor);
    this.placement.save(stored(nextPlacement(current, { kind: 'synced', cursor }).state));
    this.clock.ok = this.nowMs();
    return report;
  }

  /** The feed from `cursor` applied; when the storage has lost the cursor,
   * the index rebuilt from a fresh listing instead. */
  private async changesSince(cursor: string): Promise<{ report: ReconcileReport; cursor: string }> {
    try {
      const listing = await this.lister.changes(cursor);
      return { report: await this.pod.applyChanges(listing.entries), cursor: listing.cursor };
    } catch (e) {
      if (!(e instanceof CursorLost)) throw e;
      return this.pod.relist(() => this.lister.listAll());
    }
  }
}
