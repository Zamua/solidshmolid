// One pod per Durable Object. A thin shell: it owns the pod's SQLite and
// in-memory state, gets its services from the composition root, and turns
// requests and RPC calls into calls on them.
//
// Only the entry Worker can address this object, and it does so after
// resolving the handle and the agent; the internal headers below are set by
// the Worker and stripped from every inbound request before forwarding.

import { DurableObject } from 'cloudflare:workers';
import { Conflict } from '../../app/shared/errors.js';
import type { FolderSync, StorageLinking } from '../../app/storage/linking.js';
import type { Pod } from '../../app/pods/pod.js';
import { type PodServices, podServices } from '../composition.js';
import type { Env } from '../env.js';
import { handleSolid, withCors } from '../http/solid.js';
import { ProofLedger } from '../adapters/proofLedger.js';

export const BASE_HEADER = 'x-solidshmolid-base';
export const HANDLE_HEADER = 'x-solidshmolid-handle';
export const AGENT_HEADER = 'x-solidshmolid-agent';
export const JTI_HEADER = 'x-solidshmolid-jti';
export const JTI_EXPIRES_HEADER = 'x-solidshmolid-jti-expires';
export const INTERNAL_PREFIX = 'x-solidshmolid-';

export class PodObject extends DurableObject<Env> {
  private services: PodServices | null = null;
  private servicesFor = '';
  private readonly proofs: ProofLedger;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.proofs = new ProofLedger(ctx.storage.sql);
  }

  async fetch(request: Request): Promise<Response> {
    const base = request.headers.get(BASE_HEADER);
    const handle = request.headers.get(HANDLE_HEADER);
    if (!base || !handle) return new Response('missing pod base\n', { status: 500 });
    const origin = request.headers.get('Origin');
    const { pod, sync } = await this.open(handle, base);
    if (!pod.isProvisioned()) return withCors(new Response('no such pod\n', { status: 404 }), request, origin);

    const jti = request.headers.get(JTI_HEADER);
    if (jti && !this.proofs.firstUse(jti, Number(request.headers.get(JTI_EXPIRES_HEADER)))) {
      return withCors(
        new Response('DPoP proof already used\n', { status: 401, headers: { 'WWW-Authenticate': 'DPoP error="invalid_dpop_proof"' } }),
        request,
        origin,
      );
    }
    if (sync) {
      // A failed sync leaves the request to proceed on the index as it stands.
      await sync.syncIfStale().catch((e: Error) => console.error(JSON.stringify({ level: 'warn', msg: 'sync failed', error: e.message })));
    }
    return handleSolid(pod, request, { webid: request.headers.get(AGENT_HEADER) || null });
  }

  /** Creates the pod if it does not exist yet. */
  async ensureProvisioned(handle: string, base: string, owner: string, profile: string): Promise<void> {
    const { pod } = await this.open(handle, base);
    if (pod.isProvisioned()) return;
    try {
      await pod.provision(owner, profile);
    } catch (e) {
      if (!(e instanceof Conflict)) throw e;
    }
  }

  async beginDropboxLink(handle: string, base: string, webid: string | null, redirectUri: string): Promise<string> {
    const { linking } = await this.open(handle, base);
    return linking().begin(webid, redirectUri, handle);
  }

  async completeDropboxLink(handle: string, base: string, nonce: string, code: string, redirectUri: string): Promise<string> {
    const { linking } = await this.open(handle, base);
    const { outcome } = await linking().complete(nonce, code, redirectUri);
    // The pod now lives in Dropbox: rebuild its services around the link.
    this.services = null;
    return outcome;
  }

  private async open(handle: string, base: string): Promise<{ pod: Pod; sync: FolderSync | null; linking: () => StorageLinking }> {
    const key = `${handle} ${base}`;
    if (!this.services || this.servicesFor !== key) {
      this.services = await podServices(this.env, this.ctx.storage, handle, base);
      this.servicesFor = key;
    }
    return this.services;
  }
}
