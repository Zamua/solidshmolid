// One person's account. Addressed by their account key, which the directory
// assigns; codes and refresh tokens carry that key. It holds their provider
// state and their pods and storage links, and alone holds the storage grants,
// handing the person's pods short-lived access tokens over RPC.

import { DurableObject } from 'cloudflare:workers';
import type { AccountState, LinkSummary, PendingDeletion, PendingLink, PodRecord } from '../../app/accounts/ports.js';
import type { CodeGrant, RefreshFamily } from '../../app/identity/ports.js';
import type { AuthorizeRequest, ClientInfo } from '../../domain/identity/oidc.js';
import { type AccessToken, LinkTokens } from '../adapters/linkTokens.js';
import { Sealer } from '../adapters/sealing.js';
import { type SqlRunner, isBlank } from '../adapters/sql.js';
import { SqlAccountPods } from '../adapters/sqlAccountPods.js';
import { SqlAccountStore } from '../adapters/sqlAccountStore.js';
import { storageGrants } from '../composition.js';
import type { Env } from '../env.js';

export class AccountObject extends DurableObject<Env> {
  private store: SqlAccountStore | null = null;
  private accountPods: SqlAccountPods | null = null;
  private readonly tokens: LinkTokens;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.tokens = new LinkTokens((linkId) => this.pods.grant(linkId), storageGrants(env));
  }

  /** Opened on first use, so an object reached by a guessed key stores nothing. */
  private get pods(): SqlAccountPods {
    this.accountPods ??= new SqlAccountPods(this.ctx.storage.sql as SqlRunner, new Sealer(this.env.TOKEN_KEY), (fn) => this.ctx.storage.transactionSync(fn), {
      revoke: (linkId) => this.tokens.revoke(linkId),
      wipe: async () => {
        await this.ctx.storage.deleteAll();
        this.store = null;
        this.accountPods = null;
      },
    });
    return this.accountPods;
  }

  /** The store, created under `key` on first use. */
  private open(key?: string): SqlAccountStore {
    if (!this.store) {
      this.store = new SqlAccountStore(
        this.ctx.storage.sql as SqlRunner,
        () => {
          if (!key) throw new Error('account used before it was created');
          return key;
        },
        () => Math.floor(Date.now() / 1000),
      );
    }
    return this.store;
  }

  /** Whether this account was ever created; asking creates nothing. */
  async exists(): Promise<boolean> {
    return !isBlank(this.ctx.storage.sql as SqlRunner);
  }

  async ensure(key: string): Promise<string> {
    return this.open(key).key;
  }

  async webid(): Promise<string | null> {
    return this.open().webid();
  }

  async bindWebid(webid: string): Promise<void> {
    this.open().bindWebid(webid);
  }

  async hasApproval(clientId: string, webid: string): Promise<boolean> {
    return this.open().hasApproval(clientId, webid);
  }

  async approve(client: { clientId: string; name: string | null; site: string | null }, webid: string): Promise<void> {
    return this.open().approve(client, webid);
  }

  async approvals() {
    return this.open().approvals();
  }

  async revokeApp(clientId: string): Promise<void> {
    return this.open().revokeApp(clientId);
  }

  async savePending(id: string, request: AuthorizeRequest, client: ClientInfo, expires: number): Promise<void> {
    return this.open().savePending(id, request, client, expires);
  }

  async takePending(id: string, now: number) {
    return this.open().takePending(id, now);
  }

  async saveCode(hash: string, grant: CodeGrant): Promise<void> {
    return this.open().saveCode(hash, grant);
  }

  async takeCode(hash: string) {
    return this.open().takeCode(hash);
  }

  async saveFamily(f: RefreshFamily): Promise<void> {
    return this.open().saveFamily(f);
  }

  async family(id: string) {
    return this.open().family(id);
  }

  async rotateFamily(id: string, fromHash: string, newHash: string, expires: number): Promise<boolean> {
    return this.open().rotateFamily(id, fromHash, newHash, expires);
  }

  async revokeFamily(id: string): Promise<void> {
    return this.open().revokeFamily(id);
  }

  async revokeFromCode(codeHash: string): Promise<void> {
    return this.open().revokeFromCode(codeHash);
  }

  // ---- pods and storage ---------------------------------------------------

  async load(): Promise<AccountState | null> {
    return this.pods.load();
  }

  async create(state: AccountState): Promise<AccountState> {
    this.open(state.key);
    return this.pods.create(state);
  }

  async addPod(pod: PodRecord): Promise<void> {
    return this.pods.addPod(pod);
  }

  async addLink(link: LinkSummary, refreshToken: string): Promise<void> {
    return this.pods.addLink(link, refreshToken);
  }

  async placePod(podId: string, linkId: string): Promise<void> {
    return this.pods.placePod(podId, linkId);
  }

  async rememberLinkPending(nonce: string, pending: PendingLink): Promise<void> {
    return this.pods.rememberLinkPending(nonce, pending);
  }

  async takeLinkPending(nonce: string): Promise<PendingLink | null> {
    return this.pods.takeLinkPending(nonce);
  }

  async rememberDeletion(token: string, pending: PendingDeletion): Promise<void> {
    return this.pods.rememberDeletion(token, pending);
  }

  async takeDeletion(token: string): Promise<PendingDeletion | null> {
    return this.pods.takeDeletion(token);
  }

  async removePod(podId: string): Promise<void> {
    return this.pods.removePod(podId);
  }

  async removeLink(linkId: string): Promise<void> {
    return this.pods.removeLink(linkId);
  }

  /** Ends the account: grants given up, every record gone. */
  async erase(): Promise<void> {
    return this.pods.erase();
  }

  async accessToken(linkId: string, refresh: boolean): Promise<AccessToken> {
    return this.tokens.accessToken(linkId, refresh);
  }
}
