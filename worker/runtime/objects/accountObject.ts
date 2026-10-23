// One person's provider state. Addressed by their account key, which the
// directory assigns; codes and refresh tokens carry that key.

import { DurableObject } from 'cloudflare:workers';
import type { CodeGrant, RefreshFamily } from '../../app/identity/ports.js';
import type { AuthorizeRequest, ClientInfo } from '../../domain/identity/oidc.js';
import { SqlAccountStore } from '../adapters/sqlAccountStore.js';
import type { Env } from '../env.js';
import type { SqlRunner } from '../adapters/sql.js';

export class AccountObject extends DurableObject<Env> {
  private store: SqlAccountStore | null = null;

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

  async approve(clientId: string, clientName: string | null, webid: string): Promise<void> {
    return this.open().approve(clientId, clientName, webid);
  }

  async approvals() {
    return this.open().approvals();
  }

  async revokeApp(clientId: string): Promise<void> {
    this.open().revokeApp(clientId);
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

  async rotateFamily(id: string, newHash: string, expires: number): Promise<void> {
    return this.open().rotateFamily(id, newHash, expires);
  }

  async revokeFamily(id: string): Promise<void> {
    return this.open().revokeFamily(id);
  }

  async revokeFromCode(codeHash: string): Promise<void> {
    return this.open().revokeFromCode(codeHash);
  }
}
