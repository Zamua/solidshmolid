// One person's provider state in their AccountObject's SQLite: their WebID,
// app approvals, pending consents, authorization codes and refresh families.

import type { AccountStore, Approval, CodeGrant, RefreshFamily } from '../../app/identity/ports.js';
import { type AuthorizeRequest, type ClientInfo, type CodeEffect, type CodeState, codeIssues, nextCode } from '../../domain/identity/oidc.js';
import { type SqlRunner, addColumn } from './sql.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS account(id INTEGER PRIMARY KEY CHECK (id = 1), key TEXT NOT NULL, webid TEXT);
CREATE TABLE IF NOT EXISTS approval(client_id TEXT NOT NULL, webid TEXT NOT NULL, client_name TEXT, approved INTEGER NOT NULL, PRIMARY KEY (client_id, webid));
CREATE TABLE IF NOT EXISTS pending(id TEXT PRIMARY KEY, request TEXT NOT NULL, client TEXT NOT NULL, expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS code(hash TEXT PRIMARY KEY, grant_json TEXT NOT NULL, used INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS family(id TEXT PRIMARY KEY, json TEXT NOT NULL, current_hash TEXT NOT NULL, from_code TEXT NOT NULL, expires INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
`;

export class SqlAccountStore implements AccountStore {
  readonly key: string;

  constructor(
    private readonly sql: SqlRunner,
    newKey: () => string,
    private readonly now: () => number,
  ) {
    this.sql.exec(SCHEMA);
    addColumn(this.sql, 'approval', 'site TEXT');
    addColumn(this.sql, 'code', 'state TEXT');
    const row = this.sql.exec('SELECT key FROM account WHERE id = 1').toArray()[0];
    if (row) {
      this.key = String(row.key);
    } else {
      this.key = newKey();
      this.sql.exec('INSERT INTO account(id, key) VALUES (1, ?)', this.key);
    }
  }

  async webid(): Promise<string | null> {
    const row = this.sql.exec('SELECT webid FROM account WHERE id = 1').toArray()[0];
    return typeof row?.webid === 'string' ? row.webid : null;
  }

  bindWebid(webid: string): void {
    this.sql.exec('UPDATE account SET webid = ? WHERE id = 1', webid);
  }

  async hasApproval(clientId: string, webid: string): Promise<boolean> {
    return this.sql.exec('SELECT 1 FROM approval WHERE client_id = ? AND webid = ?', clientId, webid).toArray().length > 0;
  }

  async approve(client: { clientId: string; name: string | null; site: string | null }, webid: string): Promise<void> {
    this.sql.exec(
      'INSERT INTO approval(client_id, webid, client_name, site, approved) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING',
      client.clientId,
      webid,
      client.name,
      client.site,
      this.now(),
    );
  }

  /** Revokes an app: its approval, its codes and every refresh family it holds. */
  async revokeApp(clientId: string): Promise<void> {
    this.sql.exec('DELETE FROM approval WHERE client_id = ?', clientId);
    for (const row of this.sql.exec('SELECT hash, grant_json FROM code').toArray()) {
      if ((JSON.parse(String(row.grant_json)) as CodeGrant).clientId === clientId) this.moveCode(String(row.hash), 'revoke');
    }
    for (const row of this.sql.exec('SELECT id, json FROM family WHERE revoked = 0').toArray()) {
      if ((JSON.parse(String(row.json)) as RefreshFamily).clientId === clientId) {
        this.sql.exec('UPDATE family SET revoked = 1 WHERE id = ?', String(row.id));
      }
    }
  }

  async approvals(): Promise<Approval[]> {
    return this.sql
      .exec('SELECT client_id, client_name, site, webid, approved FROM approval ORDER BY approved DESC')
      .toArray()
      .map((r) => ({
        clientId: String(r.client_id),
        clientName: r.client_name === null ? null : String(r.client_name),
        site: r.site === null || r.site === undefined ? null : String(r.site),
        webid: String(r.webid),
        approved: Number(r.approved),
      }));
  }

  async savePending(id: string, request: AuthorizeRequest, client: ClientInfo, expires: number): Promise<void> {
    this.sql.exec('DELETE FROM pending WHERE expires < ?', this.now());
    this.sql.exec('INSERT INTO pending(id, request, client, expires) VALUES (?, ?, ?, ?)', id, JSON.stringify(request), JSON.stringify(client), expires);
  }

  async takePending(id: string, now: number): Promise<{ request: AuthorizeRequest; client: ClientInfo } | null> {
    const row = this.sql.exec('SELECT request, client, expires FROM pending WHERE id = ?', id).toArray()[0];
    this.sql.exec('DELETE FROM pending WHERE id = ?', id);
    if (!row || Number(row.expires) < now) return null;
    return { request: JSON.parse(String(row.request)), client: JSON.parse(String(row.client)) };
  }

  async saveCode(hash: string, grant: CodeGrant): Promise<void> {
    this.sql.exec('INSERT INTO code(hash, grant_json) VALUES (?, ?)', hash, JSON.stringify(grant));
  }

  async presentCode(hash: string): Promise<{ grant: CodeGrant; effect: CodeEffect } | null> {
    const row = this.sql.exec('SELECT grant_json FROM code WHERE hash = ?', hash).toArray()[0];
    if (!row) return null;
    return { grant: JSON.parse(String(row.grant_json)) as CodeGrant, effect: this.moveCode(hash, 'present') };
  }

  /** Applies `nextCode` to a stored code and runs its effect on the families. */
  private moveCode(hash: string, event: 'present' | 'revoke'): CodeEffect {
    const { state, effect } = nextCode(this.codeState(hash)!, event);
    this.sql.exec('UPDATE code SET state = ? WHERE hash = ?', state, hash);
    if (effect === 'revoke-issued') this.sql.exec('UPDATE family SET revoked = 1 WHERE from_code = ?', hash);
    return effect;
  }

  private codeState(hash: string): CodeState | null {
    const row = this.sql.exec('SELECT state, used FROM code WHERE hash = ?', hash).toArray()[0];
    if (!row) return null;
    // Codes stored before the state column carry only the used flag.
    return (row.state as CodeState | null) ?? (Number(row.used) === 1 ? 'redeemed' : 'issued');
  }

  async saveFamily(f: RefreshFamily): Promise<boolean> {
    const code = this.codeState(f.fromCode);
    if (code === null || !codeIssues(code)) return false;
    this.sql.exec(
      'INSERT INTO family(id, json, current_hash, from_code, expires) VALUES (?, ?, ?, ?, ?)',
      f.id,
      JSON.stringify(f),
      f.currentHash,
      f.fromCode,
      f.expires,
    );
    return true;
  }

  async family(id: string): Promise<RefreshFamily | null> {
    const row = this.sql.exec('SELECT json, current_hash, expires FROM family WHERE id = ? AND revoked = 0', id).toArray()[0];
    if (!row) return null;
    return { ...(JSON.parse(String(row.json)) as RefreshFamily), currentHash: String(row.current_hash), expires: Number(row.expires) };
  }

  async rotateFamily(id: string, fromHash: string, newHash: string, expires: number): Promise<boolean> {
    return (
      this.sql
        .exec('UPDATE family SET current_hash = ?, expires = ? WHERE id = ? AND current_hash = ? AND revoked = 0 RETURNING id', newHash, expires, id, fromHash)
        .toArray().length > 0
    );
  }

  async revokeFamily(id: string): Promise<void> {
    this.sql.exec('UPDATE family SET revoked = 1 WHERE id = ?', id);
  }

}
