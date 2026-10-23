// Where a pod's files live, in the pod's own SQLite: which household link,
// which folder in it, and where its change feed was last read.

import type { Placement } from '../../app/households/ports.js';
import type { SyncCursor } from '../../app/storage/ports.js';
import type { SqlRunner } from './sql.js';

export interface StoredPlacement extends Placement {
  cursor: string | null;
}

export class SqlPlacement implements SyncCursor {
  constructor(private readonly sql: SqlRunner) {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS placement(
        id           INTEGER PRIMARY KEY CHECK (id = 1),
        household_id TEXT NOT NULL,
        link_id      TEXT NOT NULL,
        provider     TEXT NOT NULL,
        folder       TEXT NOT NULL,
        cursor       TEXT
      );
    `);
  }

  current(): StoredPlacement | null {
    const row = this.sql.exec('SELECT household_id, link_id, provider, folder, cursor FROM placement WHERE id = 1').toArray()[0];
    if (!row) return null;
    return {
      householdId: String(row.household_id),
      linkId: String(row.link_id),
      provider: String(row.provider),
      folder: String(row.folder),
      cursor: row.cursor === null ? null : String(row.cursor),
    };
  }

  /** Records a new placement; its cursor is set once the pod is in place. */
  save(placement: Placement): void {
    this.sql.exec(
      `INSERT INTO placement(id, household_id, link_id, provider, folder, cursor) VALUES (1, ?, ?, ?, ?, NULL)
       ON CONFLICT(id) DO UPDATE SET household_id = excluded.household_id, link_id = excluded.link_id,
         provider = excluded.provider, folder = excluded.folder, cursor = NULL`,
      placement.householdId,
      placement.linkId,
      placement.provider,
      placement.folder,
    );
  }

  async cursor(): Promise<string | null> {
    return this.current()?.cursor ?? null;
  }

  async setCursor(cursor: string): Promise<void> {
    this.sql.exec('UPDATE placement SET cursor = ? WHERE id = 1', cursor);
  }
}
