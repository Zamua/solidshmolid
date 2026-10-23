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

  async reserveHandle(handle: string, owner: string): Promise<boolean> {
    return this.directory.reserveHandle(handle, owner);
  }

  async releaseHandle(handle: string): Promise<void> {
    this.directory.releaseHandle(handle);
  }

  async registerClient(doc: Record<string, unknown>): Promise<string> {
    return this.directory.registerClient(doc);
  }

  async registeredClient(id: string): Promise<Record<string, unknown> | null> {
    return this.directory.registeredClient(id);
  }
}
