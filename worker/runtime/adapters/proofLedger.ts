// DPoP proof ids a pod has accepted, so a captured proof cannot be replayed.
// A proof names its pod's host in `htu`, so one ledger per pod is enough.

import type { SqlRunner } from './sql.js';

export class ProofLedger {
  constructor(private readonly sql: SqlRunner) {
    this.sql.exec('CREATE TABLE IF NOT EXISTS seen_proof(jti TEXT PRIMARY KEY, expires INTEGER NOT NULL)');
  }

  /** Records `jti`; false if it was seen before. `expires` is epoch seconds. */
  firstUse(jti: string, expires: number, nowS = Math.floor(Date.now() / 1000)): boolean {
    this.sql.exec('DELETE FROM seen_proof WHERE expires < ?', nowS);
    if (this.sql.exec('SELECT 1 FROM seen_proof WHERE jti = ?', jti).toArray().length > 0) return false;
    this.sql.exec('INSERT INTO seen_proof(jti, expires) VALUES (?, ?)', jti, Number.isFinite(expires) ? expires : 0);
    return true;
  }
}
