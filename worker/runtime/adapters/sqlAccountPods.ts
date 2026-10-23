// A person's pods and storage links in their AccountObject's SQLite, beside
// the provider state: which pods they have, where each lives, the links to
// their storage, and link flows in progress.
//
// A link's refresh token is the one long-lived credential the service holds
// for someone's storage: it is stored sealed, bound to its account and link.

import type { AccountRepository, AccountState, LinkSummary, PendingLink, PodRecord } from '../../app/accounts/ports.js';
import type { Sealer } from './sealing.js';
import type { SqlRunner } from './sql.js';

const PENDING_TTL_S = 15 * 60;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS owner(id INTEGER PRIMARY KEY CHECK (id = 1), account_key TEXT NOT NULL, webid TEXT NOT NULL, created TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS pod(pod_id TEXT PRIMARY KEY, link_id TEXT, folder TEXT NOT NULL, seq INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS storage_link(link_id TEXT PRIMARY KEY, provider TEXT NOT NULL, account TEXT NOT NULL, refresh TEXT NOT NULL, created TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS link_pending(nonce TEXT PRIMARY KEY, verifier TEXT NOT NULL, expires INTEGER NOT NULL);
`;

export class SqlAccountPods implements AccountRepository {
  constructor(
    private readonly sql: SqlRunner,
    private readonly sealer: Sealer,
    private readonly atomically: <T>(fn: () => T) => T,
    private readonly nowMs: () => number = () => Date.now(),
  ) {
    this.sql.exec(SCHEMA);
  }

  async load(): Promise<AccountState | null> {
    const owner = this.sql.exec('SELECT account_key, webid FROM owner WHERE id = 1').toArray()[0];
    if (!owner) return null;
    return {
      key: String(owner.account_key),
      webid: String(owner.webid),
      pods: this.sql.exec('SELECT pod_id, link_id, folder FROM pod ORDER BY seq').toArray().map((r) => ({
        podId: String(r.pod_id),
        linkId: r.link_id === null ? null : String(r.link_id),
        folder: String(r.folder),
      })),
      links: this.sql.exec('SELECT link_id, provider, account FROM storage_link ORDER BY created, link_id').toArray().map((r) => ({
        linkId: String(r.link_id),
        provider: String(r.provider),
        account: String(r.account),
      })),
    };
  }

  async create(state: AccountState): Promise<AccountState> {
    this.atomically(() => {
      if (this.key()) return;
      this.sql.exec('INSERT INTO owner(id, account_key, webid, created) VALUES (1, ?, ?, ?)', state.key, state.webid, new Date(this.nowMs()).toISOString());
      state.pods.forEach((p) => this.insertPod(p));
    });
    return (await this.load())!;
  }

  async addPod(pod: PodRecord): Promise<void> {
    this.insertPod(pod);
  }

  async addLink(link: LinkSummary, refreshToken: string): Promise<void> {
    const sealed = await this.sealer.seal(refreshToken, this.recordId(link.linkId));
    this.sql.exec(
      'INSERT INTO storage_link(link_id, provider, account, refresh, created) VALUES (?, ?, ?, ?, ?)',
      link.linkId,
      link.provider,
      link.account,
      sealed,
      new Date(this.nowMs()).toISOString(),
    );
  }

  async placePod(podId: string, linkId: string): Promise<void> {
    this.sql.exec('UPDATE pod SET link_id = ? WHERE pod_id = ?', linkId, podId);
  }

  async rememberPending(nonce: string, pending: PendingLink): Promise<void> {
    const nowS = Math.floor(this.nowMs() / 1000);
    this.sql.exec('DELETE FROM link_pending WHERE expires < ?', nowS);
    this.sql.exec('INSERT INTO link_pending(nonce, verifier, expires) VALUES (?, ?, ?)', nonce, pending.verifier, nowS + PENDING_TTL_S);
  }

  /** Consumed on read, so a provider callback cannot be replayed. */
  async takePending(nonce: string): Promise<PendingLink | null> {
    const row = this.sql.exec('SELECT verifier, expires FROM link_pending WHERE nonce = ?', nonce).toArray()[0];
    this.sql.exec('DELETE FROM link_pending WHERE nonce = ?', nonce);
    if (!row || Number(row.expires) < Math.floor(this.nowMs() / 1000)) return null;
    return { verifier: String(row.verifier) };
  }

  /** A link's provider and refresh token, for minting access tokens. */
  async grant(linkId: string): Promise<{ provider: string; refreshToken: string } | null> {
    const row = this.sql.exec('SELECT provider, refresh FROM storage_link WHERE link_id = ?', linkId).toArray()[0];
    if (!row) return null;
    return { provider: String(row.provider), refreshToken: await this.sealer.open(String(row.refresh), this.recordId(linkId)) };
  }

  private insertPod(p: PodRecord): void {
    this.sql.exec('INSERT INTO pod(pod_id, link_id, folder, seq) VALUES (?, ?, ?, (SELECT COUNT(*) FROM pod))', p.podId, p.linkId, p.folder);
  }

  private key(): string | null {
    const row = this.sql.exec('SELECT account_key FROM owner WHERE id = 1').toArray()[0];
    return row ? String(row.account_key) : null;
  }

  private recordId(linkId: string): string {
    const key = this.key();
    if (!key) throw new Error('account used before it has pods');
    return `account/${key}/link/${linkId}`;
  }
}
