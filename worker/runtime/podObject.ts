// One pod per Durable Object: its index, its write queue, its storage link.
//
// Only the entry Worker can address this object, and it does so after
// resolving the handle and the agent; the internal headers below are set by
// the Worker and stripped from every inbound request before forwarding.

import { DurableObject } from 'cloudflare:workers';
import { Conflict, StorageUnavailable } from '../app/errors.js';
import { Pod } from '../app/pod.js';
import type { FileStore } from '../app/ports.js';
import { DevFileStore } from './adapters/devFiles.js';
import type { Env } from './env.js';
import { handleSolid, withCors } from './http.js';
import { SqlIndex, type SqlRunner } from './sqlIndex.js';

export const BASE_HEADER = 'x-solidshmolid-base';
export const AGENT_HEADER = 'x-solidshmolid-agent';
export const INTERNAL_PREFIX = 'x-solidshmolid-';

export class PodObject extends DurableObject<Env> {
  private readonly index: SqlIndex;
  private readonly files: FileStore;
  private pod: Pod | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.index = new SqlIndex(ctx.storage.sql, (fn) => ctx.storage.transactionSync(fn));
    this.files = fileStoreFor(env, ctx.storage.sql);
  }

  async fetch(request: Request): Promise<Response> {
    const base = request.headers.get(BASE_HEADER);
    if (!base) return new Response('missing pod base\n', { status: 500 });
    const pod = this.podAt(base);
    if (!pod.isProvisioned()) {
      return withCors(new Response('no such pod\n', { status: 404 }), request, request.headers.get('Origin'));
    }
    return handleSolid(pod, request, { webid: request.headers.get(AGENT_HEADER) || null });
  }

  /** Creates the pod if it does not exist yet. */
  async ensureProvisioned(base: string, owner: string, profile: string): Promise<void> {
    const pod = this.podAt(base);
    if (pod.isProvisioned()) return;
    try {
      await pod.provision(owner, profile);
    } catch (e) {
      if (!(e instanceof Conflict)) throw e;
    }
  }

  private podAt(base: string): Pod {
    if (this.pod?.url('') !== base) {
      this.pod = new Pod({
        index: this.index,
        files: this.files,
        base,
        now: () => new Date(),
        newId: () => crypto.randomUUID().replaceAll('-', ''),
      });
    }
    return this.pod;
  }
}

function fileStoreFor(env: Env, sql: SqlRunner): FileStore {
  if (env.STORAGE === 'dev' && env.DEV_MODE === '1') return new DevFileStore(sql);
  return new UnlinkedStore();
}

/** Storage for a pod whose owner has not linked a provider yet. */
class UnlinkedStore implements FileStore {
  private fail(): never {
    throw new StorageUnavailable('this pod has no linked storage');
  }
  read = async () => this.fail();
  write = async () => this.fail();
  remove = async () => this.fail();
  makeFolder = async () => this.fail();
  removeFolder = async () => this.fail();
}
