// The one global object: handle reservations, which account belongs to which
// person, and dynamically registered clients. Every lookup here is keyed, so
// one object serves them all.

import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../env.js';

const RELEASE_HOLD_S = 90 * 24 * 3600;

export class DirectoryObject extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS person(person TEXT PRIMARY KEY, account_key TEXT NOT NULL UNIQUE);
      CREATE TABLE IF NOT EXISTS handle(handle TEXT PRIMARY KEY, owner TEXT NOT NULL, state TEXT NOT NULL, released INTEGER);
      CREATE TABLE IF NOT EXISTS client(id TEXT PRIMARY KEY, doc TEXT NOT NULL, created INTEGER NOT NULL);
    `);
  }

  /** The account key for a signed-in person, assigned on first sight. */
  async accountKeyFor(person: string): Promise<string> {
    const sql = this.ctx.storage.sql;
    const row = sql.exec('SELECT account_key FROM person WHERE person = ?', person).toArray()[0];
    if (row) return String(row.account_key);
    const key = crypto.randomUUID().replaceAll('-', '');
    sql.exec('INSERT INTO person(person, account_key) VALUES (?, ?)', person, key);
    return key;
  }

  /** Reserves a handle for `owner`; false when taken or still held after release. */
  async reserveHandle(handle: string, owner: string): Promise<boolean> {
    const sql = this.ctx.storage.sql;
    const row = sql.exec('SELECT owner, state, released FROM handle WHERE handle = ?', handle).toArray()[0];
    const now = Math.floor(Date.now() / 1000);
    if (row) {
      if (row.state === 'active') return String(row.owner) === owner;
      if (Number(row.released) + RELEASE_HOLD_S > now) return false;
    }
    sql.exec(
      "INSERT INTO handle(handle, owner, state, released) VALUES (?, ?, 'active', NULL) ON CONFLICT(handle) DO UPDATE SET owner = excluded.owner, state = 'active', released = NULL",
      handle,
      owner,
    );
    return true;
  }

  async releaseHandle(handle: string): Promise<void> {
    this.ctx.storage.sql.exec("UPDATE handle SET state = 'released', released = ? WHERE handle = ?", Math.floor(Date.now() / 1000), handle);
  }

  async registerClient(doc: Record<string, unknown>): Promise<string> {
    const id = `reg_${crypto.randomUUID().replaceAll('-', '')}`;
    this.ctx.storage.sql.exec('INSERT INTO client(id, doc, created) VALUES (?, ?, ?)', id, JSON.stringify({ ...doc, client_id: id }), Math.floor(Date.now() / 1000));
    return id;
  }

  async registeredClient(id: string): Promise<Record<string, unknown> | null> {
    const row = this.ctx.storage.sql.exec('SELECT doc FROM client WHERE id = ?', id).toArray()[0];
    return row ? (JSON.parse(String(row.doc)) as Record<string, unknown>) : null;
  }
}
