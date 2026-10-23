// One household's records in its HouseholdObject's SQLite: members, pods and
// where they live, storage links, and link flows in progress.
//
// A link's refresh token is the one long-lived credential the service holds
// for someone's storage: it is stored sealed, bound to its household and link.

import type { HouseholdRepository, HouseholdState, LinkSummary, PendingLink, PodPlacement } from '../../app/households/ports.js';
import type { Kind, Member, Role } from '../../domain/households/household.js';
import type { Sealer } from './sealing.js';
import type { SqlRunner } from './sql.js';

const PENDING_TTL_S = 15 * 60;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS household(id INTEGER PRIMARY KEY CHECK (id = 1), household_id TEXT NOT NULL, created TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS member(person TEXT PRIMARY KEY, role TEXT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL, webid TEXT NOT NULL, handle TEXT NOT NULL, seq INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS pod(pod_id TEXT PRIMARY KEY, owner TEXT NOT NULL, link_id TEXT, folder TEXT NOT NULL, seq INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS link(link_id TEXT PRIMARY KEY, provider TEXT NOT NULL, account TEXT NOT NULL, refresh TEXT NOT NULL, created TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS pending(nonce TEXT PRIMARY KEY, verifier TEXT NOT NULL, person TEXT NOT NULL, expires INTEGER NOT NULL);
`;

export class SqlHousehold implements HouseholdRepository {
  constructor(
    private readonly sql: SqlRunner,
    private readonly sealer: Sealer,
    private readonly atomically: <T>(fn: () => T) => T,
    private readonly nowMs: () => number = () => Date.now(),
  ) {
    this.sql.exec(SCHEMA);
  }

  async load(): Promise<HouseholdState | null> {
    const id = this.id();
    if (!id) return null;
    return {
      id,
      members: this.sql.exec('SELECT person, role, kind, name, webid, handle FROM member ORDER BY seq').toArray().map((r) => ({
        clerkUserId: String(r.person),
        role: String(r.role) as Role,
        kind: String(r.kind) as Kind,
        name: String(r.name),
        webid: String(r.webid),
        handle: String(r.handle),
      })),
      pods: this.sql.exec('SELECT pod_id, owner, link_id, folder FROM pod ORDER BY seq').toArray().map((r) => ({
        podId: String(r.pod_id),
        owner: String(r.owner),
        linkId: r.link_id === null ? null : String(r.link_id),
        folder: String(r.folder),
      })),
      links: this.sql.exec('SELECT link_id, provider, account FROM link ORDER BY created, link_id').toArray().map((r) => ({
        linkId: String(r.link_id),
        provider: String(r.provider),
        account: String(r.account),
      })),
    };
  }

  async create(state: HouseholdState): Promise<HouseholdState> {
    this.atomically(() => {
      if (this.id()) return;
      this.sql.exec('INSERT INTO household(id, household_id, created) VALUES (1, ?, ?)', state.id, new Date(this.nowMs()).toISOString());
      state.members.forEach((m) => this.insertMember(m));
      state.pods.forEach((p) => this.insertPod(p));
    });
    return (await this.load())!;
  }

  async addMember(member: Member, pod: PodPlacement): Promise<void> {
    this.atomically(() => {
      this.insertMember(member);
      this.insertPod(pod);
    });
  }

  async addLink(link: LinkSummary, refreshToken: string): Promise<void> {
    const sealed = await this.sealer.seal(refreshToken, this.recordId(link.linkId));
    this.sql.exec(
      'INSERT INTO link(link_id, provider, account, refresh, created) VALUES (?, ?, ?, ?, ?)',
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
    this.sql.exec('DELETE FROM pending WHERE expires < ?', nowS);
    this.sql.exec('INSERT INTO pending(nonce, verifier, person, expires) VALUES (?, ?, ?, ?)', nonce, pending.verifier, pending.person, nowS + PENDING_TTL_S);
  }

  /** Consumed on read, so a provider callback cannot be replayed. */
  async takePending(nonce: string): Promise<PendingLink | null> {
    const row = this.sql.exec('SELECT verifier, person, expires FROM pending WHERE nonce = ?', nonce).toArray()[0];
    this.sql.exec('DELETE FROM pending WHERE nonce = ?', nonce);
    if (!row || Number(row.expires) < Math.floor(this.nowMs() / 1000)) return null;
    return { verifier: String(row.verifier), person: String(row.person) };
  }

  /** A link's provider and refresh token, for minting access tokens. */
  async grant(linkId: string): Promise<{ provider: string; refreshToken: string } | null> {
    const row = this.sql.exec('SELECT provider, refresh FROM link WHERE link_id = ?', linkId).toArray()[0];
    if (!row) return null;
    return { provider: String(row.provider), refreshToken: await this.sealer.open(String(row.refresh), this.recordId(linkId)) };
  }

  private insertMember(m: Member): void {
    this.sql.exec(
      'INSERT INTO member(person, role, kind, name, webid, handle, seq) VALUES (?, ?, ?, ?, ?, ?, (SELECT COUNT(*) FROM member))',
      m.clerkUserId,
      m.role,
      m.kind,
      m.name,
      m.webid,
      m.handle,
    );
  }

  private insertPod(p: PodPlacement): void {
    this.sql.exec('INSERT INTO pod(pod_id, owner, link_id, folder, seq) VALUES (?, ?, ?, ?, (SELECT COUNT(*) FROM pod))', p.podId, p.owner, p.linkId, p.folder);
  }

  private id(): string | null {
    const row = this.sql.exec('SELECT household_id FROM household WHERE id = 1').toArray()[0];
    return row ? String(row.household_id) : null;
  }

  private recordId(linkId: string): string {
    const id = this.id();
    if (!id) throw new Error('household used before it was created');
    return `household/${id}/link/${linkId}`;
  }
}
