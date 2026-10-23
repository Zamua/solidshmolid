// The global directory in SQLite: which account belongs to which person,
// handle reservations, and dynamically registered clients.

import type { SqlRunner } from './sql.js';

const RELEASE_HOLD_S = 90 * 24 * 3600;

export class SqlDirectory {
  constructor(
    private readonly sql: SqlRunner,
    private readonly nowS: () => number = () => Math.floor(Date.now() / 1000),
    private readonly newKey: () => string = () => crypto.randomUUID().replaceAll('-', ''),
  ) {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS person(person TEXT PRIMARY KEY, account_key TEXT NOT NULL UNIQUE);
      CREATE TABLE IF NOT EXISTS handle(handle TEXT PRIMARY KEY, owner TEXT NOT NULL, state TEXT NOT NULL, released INTEGER);
      CREATE TABLE IF NOT EXISTS client(id TEXT PRIMARY KEY, doc TEXT NOT NULL, created INTEGER NOT NULL);
    `);
  }

  /** The account key for a person, assigned on first sight. */
  accountKeyFor(person: string): string {
    const row = this.sql.exec('SELECT account_key FROM person WHERE person = ?', person).toArray()[0];
    if (row) return String(row.account_key);
    const key = this.newKey();
    this.sql.exec('INSERT INTO person(person, account_key) VALUES (?, ?)', person, key);
    return key;
  }

  /** Reserves `handle` for `owner`. False when someone else holds it, or it
   * was released less than 90 days ago, so old links never point at a stranger. */
  reserveHandle(handle: string, owner: string): boolean {
    const row = this.sql.exec('SELECT owner, state, released FROM handle WHERE handle = ?', handle).toArray()[0];
    if (row) {
      if (row.state === 'active') return String(row.owner) === owner;
      if (Number(row.released) + RELEASE_HOLD_S > this.nowS()) return false;
    }
    this.sql.exec(
      "INSERT INTO handle(handle, owner, state, released) VALUES (?, ?, 'active', NULL) ON CONFLICT(handle) DO UPDATE SET owner = excluded.owner, state = 'active', released = NULL",
      handle,
      owner,
    );
    return true;
  }

  releaseHandle(handle: string): void {
    this.sql.exec("UPDATE handle SET state = 'released', released = ? WHERE handle = ?", this.nowS(), handle);
  }

  registerClient(doc: Record<string, unknown>): string {
    const id = `reg_${this.newKey()}`;
    this.sql.exec('INSERT INTO client(id, doc, created) VALUES (?, ?, ?)', id, JSON.stringify({ ...doc, client_id: id }), this.nowS());
    return id;
  }

  registeredClient(id: string): Record<string, unknown> | null {
    const row = this.sql.exec('SELECT doc FROM client WHERE id = ?', id).toArray()[0];
    return row ? (JSON.parse(String(row.doc)) as Record<string, unknown>) : null;
  }
}
