// One pod per Durable Object. A thin shell: it owns the pod's SQLite and
// in-memory state, gets its services from the composition root, and turns
// requests and RPC calls into calls on them.
//
// Only the entry Worker can address this object, and it does so after
// resolving the handle and the agent; the internal headers below are set by
// the Worker and stripped from every inbound request before forwarding.

import { DurableObject } from 'cloudflare:workers';
import type { Placement } from '../../app/accounts/ports.js';
import type { FileContent, FileEntry } from '../../app/accounts/ports.js';
import { BadRequest, Conflict } from '../../app/shared/errors.js';
import { InvalidPath, canonicalPath } from '../../domain/pods/paths.js';
import { PROFILE_PATH, addStoragePatch, removeStoragePatch } from '../../domain/pods/profile.js';
import { NO_CONDITIONS } from '../../domain/pods/requests.js';
import { alreadyPlaced, placePod } from '../../app/storage/placement.js';
import type { PlacementOutcome } from '../../app/storage/ports.js';
import { ProofLedger } from '../adapters/proofLedger.js';
import { isBlank } from '../adapters/sql.js';
import { type PodServices, podServices, storageAround } from '../composition.js';
import type { Env } from '../env.js';
import { handleSolid, withCors } from '../http/solid.js';

export const BASE_HEADER = 'x-solidshmolid-base';
export const AGENT_HEADER = 'x-solidshmolid-agent';
export const JTI_HEADER = 'x-solidshmolid-jti';
export const JTI_EXPIRES_HEADER = 'x-solidshmolid-jti-expires';
export const INTERNAL_PREFIX = 'x-solidshmolid-';

export class PodObject extends DurableObject<Env> {
  private services: PodServices | null = null;
  private servicesFor = '';
  private proofs: ProofLedger | null = null;

  async fetch(request: Request): Promise<Response> {
    const base = request.headers.get(BASE_HEADER);
    if (!base) return new Response('missing pod base\n', { status: 500 });
    const origin = request.headers.get('Origin');
    // A pod id no one placed must not leave tables behind.
    if (isBlank(this.ctx.storage.sql)) return withCors(new Response('no such pod\n', { status: 404 }), request, origin);
    const { pod, sync } = this.open(base);
    if (!pod.isProvisioned()) return withCors(new Response('no such pod\n', { status: 404 }), request, origin);

    const jti = request.headers.get(JTI_HEADER);
    this.proofs ??= new ProofLedger(this.ctx.storage.sql);
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

  /** Development only: creates a named pod in the dev store if it does not exist yet. */
  async ensureProvisioned(base: string, owner: string, profile: string): Promise<void> {
    const { pod, placement } = this.open(base);
    if (pod.isProvisioned() || placement.current()) return;
    try {
      await pod.provision(owner, profile);
    } catch (e) {
      if (!(e instanceof Conflict)) throw e;
    }
  }

  /** Serves the pod from its folder in its account's storage. Repeating a
   * finished placement is a no-op; moving to other storage is not this call. */
  async place(base: string, placement: Placement, owner: string, profile: string | null): Promise<PlacementOutcome> {
    const services = this.open(base);
    if (alreadyPlaced(services.placement.current(), placement)) return 'adopted';
    services.placement.save(placement);
    try {
      const { pod, files } = services.podIn(placement);
      return await placePod(pod, files, services.placement, { owner, profile });
    } finally {
      // Built before the placement was saved, the services serve the old storage.
      this.services = null;
    }
  }

  /** Lists another of the owner's pods as a storage in this pod's profile. */
  async declareStorage(base: string, owner: string, storage: string): Promise<void> {
    const { pod } = this.open(base);
    await pod.patch(PROFILE_PATH, { webid: owner }, addStoragePatch(storage), 'text/n3', NO_CONDITIONS);
  }

  /** A folder's entries, for the owner browsing on the account site. */
  async list(base: string, owner: string, path: string): Promise<FileEntry[]> {
    return this.open(base).pod.listing(podPath(path), { webid: owner });
  }

  /** A file, for the owner browsing on the account site. */
  async readFile(base: string, owner: string, path: string): Promise<FileContent> {
    const read = await this.open(base).pod.read(podPath(path), { webid: owner }, { accept: null, range: null, head: false });
    if (read.kind !== 'document') throw new BadRequest(`${path} is a folder`);
    const body = typeof read.body === 'string' ? new Response(read.body).body! : read.body!;
    return { body, contentType: read.contentType, size: read.size };
  }

  /** Takes another of the owner's pods out of this pod's profile; already
   * gone is fine, so a retried deletion goes through. */
  async dropStorage(base: string, owner: string, storage: string): Promise<void> {
    const { pod } = this.open(base);
    try {
      await pod.patch(PROFILE_PATH, { webid: owner }, removeStoragePatch(storage), 'text/n3', NO_CONDITIONS);
    } catch (e) {
      if (!(e instanceof Conflict)) throw e;
    }
  }

  /** Stops serving the pod and forgets it; with `deleteFiles`, its folder is
   * deleted from storage first. Without, the folder stays a complete pod. */
  async retire(base: string, deleteFiles: boolean): Promise<void> {
    const placement = this.open(base).placement.current();
    if (deleteFiles && placement) await storageAround(this.env, placement)?.removeFolder(placement.folder);
    await this.ctx.storage.deleteAll();
    this.services = null;
    this.proofs = null;
  }

  private open(base: string): PodServices {
    if (!this.services || this.servicesFor !== base) {
      this.services = podServices(this.env, this.ctx.storage, base);
      this.servicesFor = base;
    }
    return this.services;
  }
}

function podPath(path: string): string {
  try {
    return canonicalPath(path);
  } catch (e) {
    if (e instanceof InvalidPath) throw new BadRequest(e.message);
    throw e;
  }
}
