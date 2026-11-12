// DPoP proof ids already accepted, so a captured proof cannot be replayed.
// A proof names its host in `htu`, so one ledger per pod (and one per account,
// for the token endpoint) is enough.

import type { SqlRunner } from './sql.js';

export class ProofLedger {
  constructor(private readonly sql: SqlRunner) {
    this.sql.exec('CREATE TABLE IF NOT EXISTS seen_proof(jti TEXT PRIMARY KEY, expires INTEGER NOT NULL)');
    // Every check drops what ran out: by index, not by reading the table.
    this.sql.exec('CREATE INDEX IF NOT EXISTS seen_proof_expires ON seen_proof(expires)');
  }

  /** Whether `jti` was recorded and has not run out. */
  seen(jti: string, nowS = Math.floor(Date.now() / 1000)): boolean {
    this.sql.exec('DELETE FROM seen_proof WHERE expires < ?', nowS);
    return this.sql.exec('SELECT 1 FROM seen_proof WHERE jti = ?', jti).toArray().length > 0;
  }

  /** `expires` is epoch seconds. */
  record(jti: string, expires: number): void {
    this.sql.exec('INSERT INTO seen_proof(jti, expires) VALUES (?, ?) ON CONFLICT DO NOTHING', jti, Number.isFinite(expires) ? expires : 0);
  }

  /** Records `jti`; false if it was seen before. */
  firstUse(jti: string, expires: number, nowS = Math.floor(Date.now() / 1000)): boolean {
    if (this.seen(jti, nowS)) return false;
    this.record(jti, expires);
    return true;
  }
}
