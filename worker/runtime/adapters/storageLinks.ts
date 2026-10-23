// A pod's link to its storage provider, kept in the pod's own SQLite.
//
// The refresh token is the one long-lived credential the service holds for a
// user's storage, so it is stored only encrypted (AES-GCM under TOKEN_KEY, the
// pod's handle as associated data, so a row copied to another pod does not
// decrypt). Access tokens live in memory only.

import type { LinkStore, PendingLink, StorageLink } from '../../app/storage/ports.js';
import type { SqlRunner } from './sql.js';

const PENDING_TTL_S = 15 * 60;

export class StorageLinks implements LinkStore {
  private key: CryptoKey | null = null;

  constructor(
    private readonly sql: SqlRunner,
    private readonly keyBase64: string | undefined,
    private readonly handle: string,
    private readonly nowMs: () => number = () => Date.now(),
  ) {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS storage_link(
        id       INTEGER PRIMARY KEY CHECK (id = 1),
        provider TEXT NOT NULL,
        account  TEXT NOT NULL,
        refresh  TEXT NOT NULL,
        cursor   TEXT,
        linked   TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pending_link(
        nonce    TEXT PRIMARY KEY,
        verifier TEXT NOT NULL,
        webid    TEXT NOT NULL,
        expires  INTEGER NOT NULL
      );
    `);
  }

  async current(): Promise<StorageLink | null> {
    const row = this.sql.exec('SELECT provider, account, refresh, cursor, linked FROM storage_link WHERE id = 1').toArray()[0];
    if (!row) return null;
    return {
      provider: String(row.provider),
      account: String(row.account),
      refreshToken: await this.decrypt(String(row.refresh)),
      cursor: row.cursor === null ? null : String(row.cursor),
    };
  }

  async save(link: StorageLink): Promise<void> {
    this.sql.exec(
      `INSERT INTO storage_link(id, provider, account, refresh, cursor, linked) VALUES (1, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET provider = excluded.provider, account = excluded.account,
         refresh = excluded.refresh, cursor = excluded.cursor, linked = excluded.linked`,
      link.provider,
      link.account,
      await this.encrypt(link.refreshToken),
      link.cursor,
      new Date(this.nowMs()).toISOString(),
    );
  }

  async setCursor(cursor: string): Promise<void> {
    this.sql.exec('UPDATE storage_link SET cursor = ? WHERE id = 1', cursor);
  }

  async remember(nonce: string, pending: PendingLink): Promise<void> {
    const nowS = Math.floor(this.nowMs() / 1000);
    this.sql.exec('DELETE FROM pending_link WHERE expires < ?', nowS);
    this.sql.exec(
      'INSERT INTO pending_link(nonce, verifier, webid, expires) VALUES (?, ?, ?, ?)',
      nonce,
      pending.verifier,
      pending.webid,
      nowS + PENDING_TTL_S,
    );
  }

  /** The pending link for `nonce`, consumed: a callback cannot be replayed. */
  async take(nonce: string): Promise<PendingLink | null> {
    const nowS = Math.floor(this.nowMs() / 1000);
    const row = this.sql.exec('SELECT verifier, webid, expires FROM pending_link WHERE nonce = ?', nonce).toArray()[0];
    this.sql.exec('DELETE FROM pending_link WHERE nonce = ?', nonce);
    if (!row || Number(row.expires) < nowS) return null;
    return { verifier: String(row.verifier), webid: String(row.webid) };
  }

  private async cryptoKey(): Promise<CryptoKey> {
    if (this.key) return this.key;
    if (!this.keyBase64) throw new Error('TOKEN_KEY is not configured');
    const raw = Uint8Array.from(atob(this.keyBase64), (c) => c.charCodeAt(0));
    if (raw.byteLength !== 32) throw new Error('TOKEN_KEY must be 32 bytes, base64');
    this.key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
    return this.key;
  }

  private async encrypt(plain: string): Promise<string> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(this.handle) },
        await this.cryptoKey(),
        new TextEncoder().encode(plain),
      ),
    );
    const out = new Uint8Array(iv.byteLength + ct.byteLength);
    out.set(iv);
    out.set(ct, iv.byteLength);
    return btoa(String.fromCharCode(...out));
  }

  private async decrypt(sealed: string): Promise<string> {
    const bytes = Uint8Array.from(atob(sealed), (c) => c.charCodeAt(0));
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bytes.slice(0, 12), additionalData: new TextEncoder().encode(this.handle) },
      await this.cryptoKey(),
      bytes.slice(12),
    );
    return new TextDecoder().decode(plain);
  }
}
