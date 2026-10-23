// The global directory in SQLite: which account belongs to which person,
// every pod id ever assigned, and dynamically registered clients.

import { podIdFrom } from '../../domain/accounts/podIds.js';
import type { SqlRunner } from './sql.js';

export class SqlDirectory {
  constructor(
    private readonly sql: SqlRunner,
    private readonly nowS: () => number = () => Math.floor(Date.now() / 1000),
    private readonly newKey: () => string = () => crypto.randomUUID().replaceAll('-', ''),
    private readonly randomBytes: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n)),
  ) {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS person(person TEXT PRIMARY KEY, account_key TEXT NOT NULL UNIQUE);
      CREATE TABLE IF NOT EXISTS pod_id(pod_id TEXT PRIMARY KEY, account_key TEXT NOT NULL, state TEXT NOT NULL, assigned INTEGER NOT NULL);
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

  /** A fresh random pod id for the account. Ids are never released, so a
   * deleted pod's URLs can never come to point at someone else. */
  allocatePodId(accountKey: string): string {
    for (;;) {
      const id = podIdFrom(this.randomBytes(32));
      if (!id) continue;
      const taken = this.sql.exec('SELECT 1 FROM pod_id WHERE pod_id = ?', id).toArray().length > 0;
      if (taken) continue;
      this.sql.exec("INSERT INTO pod_id(pod_id, account_key, state, assigned) VALUES (?, ?, 'active', ?)", id, accountKey, this.nowS());
      return id;
    }
  }

  retirePodId(podId: string): void {
    this.sql.exec("UPDATE pod_id SET state = 'deleted' WHERE pod_id = ?", podId);
  }

  forget(person: string): void {
    this.sql.exec('DELETE FROM person WHERE person = ?', person);
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
