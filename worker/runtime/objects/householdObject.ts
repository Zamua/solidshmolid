// One household per Durable Object, keyed by household id. A thin shell over
// its SQLite records; it alone holds the household's storage grants, and
// hands its pods short-lived access tokens over RPC.

import { DurableObject } from 'cloudflare:workers';
import type { HouseholdState, LinkSummary, PendingLink, PodPlacement } from '../../app/households/ports.js';
import type { Member } from '../../domain/households/household.js';
import { type AccessToken, LinkTokens } from '../adapters/linkTokens.js';
import { Sealer } from '../adapters/sealing.js';
import type { SqlRunner } from '../adapters/sql.js';
import { SqlHousehold } from '../adapters/sqlHousehold.js';
import { storageRefreshers } from '../composition.js';
import type { Env } from '../env.js';

export class HouseholdObject extends DurableObject<Env> {
  private readonly store: SqlHousehold;
  private readonly tokens: LinkTokens;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.store = new SqlHousehold(ctx.storage.sql as SqlRunner, new Sealer(env.TOKEN_KEY), (fn) => ctx.storage.transactionSync(fn));
    this.tokens = new LinkTokens((linkId) => this.store.grant(linkId), storageRefreshers(env));
  }

  async load(): Promise<HouseholdState | null> {
    return this.store.load();
  }

  async create(state: HouseholdState): Promise<HouseholdState> {
    return this.store.create(state);
  }

  async addMember(member: Member, pod: PodPlacement): Promise<void> {
    return this.store.addMember(member, pod);
  }

  async addLink(link: LinkSummary, refreshToken: string): Promise<void> {
    return this.store.addLink(link, refreshToken);
  }

  async placePod(podId: string, linkId: string): Promise<void> {
    return this.store.placePod(podId, linkId);
  }

  async rememberPending(nonce: string, pending: PendingLink): Promise<void> {
    return this.store.rememberPending(nonce, pending);
  }

  async takePending(nonce: string): Promise<PendingLink | null> {
    return this.store.takePending(nonce);
  }

  async accessToken(linkId: string, refresh: boolean): Promise<AccessToken> {
    return this.tokens.accessToken(linkId, refresh);
  }
}
