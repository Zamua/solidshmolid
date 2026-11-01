// Where a pod's files live, in the pod's own SQLite: which of its account's storage links,
// which folder in it, and where its change feed was last read. A row with no cursor is a
// placement under way.

import type { Placement, PlacementStore, PodPlacement } from '../../app/storage/ports.js';
import type { SqlRunner } from './sql.js';

export class SqlPlacement implements PlacementStore {
  constructor(private readonly sql: SqlRunner) {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS placement(
        id           INTEGER PRIMARY KEY CHECK (id = 1),
        account_key TEXT NOT NULL,
        link_id      TEXT NOT NULL,
        provider     TEXT NOT NULL,
        folder       TEXT NOT NULL,
        cursor       TEXT
      );
    `);
  }

  current(): PodPlacement {
    const row = this.sql.exec('SELECT account_key, link_id, provider, folder, cursor FROM placement WHERE id = 1').toArray()[0];
    if (!row) return { state: 'unplaced' };
    const target: Placement = { accountKey: String(row.account_key), linkId: String(row.link_id), provider: String(row.provider), folder: String(row.folder) };
    return row.cursor === null ? { state: 'placing', target } : { state: 'placed', target, cursor: String(row.cursor) };
  }

  save(placement: PodPlacement): void {
    if (placement.state === 'unplaced') {
      this.sql.exec('DELETE FROM placement WHERE id = 1');
      return;
    }
    const { target } = placement;
    this.sql.exec(
      `INSERT INTO placement(id, account_key, link_id, provider, folder, cursor) VALUES (1, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET account_key = excluded.account_key, link_id = excluded.link_id,
         provider = excluded.provider, folder = excluded.folder, cursor = excluded.cursor`,
      target.accountKey,
      target.linkId,
      target.provider,
      target.folder,
      placement.state === 'placed' ? placement.cursor : null,
    );
  }
}
