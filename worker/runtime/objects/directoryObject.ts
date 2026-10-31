// The one global object. A thin shell over SqlDirectory: every lookup here is
// keyed, so one object serves them all.

import { DurableObject } from 'cloudflare:workers';
import type { SqlRunner } from '../adapters/sql.js';
import { SqlDirectory } from '../adapters/sqlDirectory.js';
import type { Env } from '../env.js';

export class DirectoryObject extends DurableObject<Env> {
  private readonly directory: SqlDirectory;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.directory = new SqlDirectory(ctx.storage.sql as SqlRunner);
  }

  async accountKeyFor(person: string): Promise<string> {
    return this.directory.accountKeyFor(person);
  }

  async allocatePodId(accountKey: string): Promise<string> {
    return this.directory.allocatePodId(accountKey);
  }

  async retirePodId(podId: string): Promise<void> {
    this.directory.retirePodId(podId);
  }

  async forget(person: string): Promise<void> {
    this.directory.forget(person);
  }

  async registerClient(doc: Record<string, unknown>): Promise<string> {
    return this.directory.registerClient(doc);
  }

  async registeredClient(id: string): Promise<Record<string, unknown> | null> {
    return this.directory.registeredClient(id);
  }

  async clientSignedIn(id: string): Promise<void> {
    this.directory.clientSignedIn(id);
  }
}
