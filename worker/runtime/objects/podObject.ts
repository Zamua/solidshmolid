// One pod per Durable Object: its index, its write queue, its storage link.
//
// Only the entry Worker can address this object, and it does so after
// resolving the handle and the agent; the internal headers below are set by
// the Worker and stripped from every inbound request before forwarding.

import { DurableObject } from 'cloudflare:workers';
import { Conflict, Forbidden, StorageUnavailable } from '../../app/errors.js';
import { copyPod } from '../../app/migrate.js';
import { Pod } from '../../app/pod.js';
import type { FileLister, FileStore } from '../../app/ports.js';
import { DevFileStore } from '../adapters/devFiles.js';
import { DropboxFileStore } from '../adapters/dropbox.js';
import { type Grant, authorizeUrl, exchangeCode, pkce, refreshAccess } from '../auth/dropboxOAuth.js';
import type { Env } from '../env.js';
import { handleSolid, withCors } from '../http.js';
import { SqlIndex, type SqlRunner } from '../sqlIndex.js';
import { type LinkRow, StorageLinks } from '../storageLink.js';

export const BASE_HEADER = 'x-solidshmolid-base';
export const HANDLE_HEADER = 'x-solidshmolid-handle';
export const AGENT_HEADER = 'x-solidshmolid-agent';
export const JTI_HEADER = 'x-solidshmolid-jti';
export const JTI_EXPIRES_HEADER = 'x-solidshmolid-jti-expires';
export const INTERNAL_PREFIX = 'x-solidshmolid-';

/** How stale a linked pod's view of its folder may get before a request
 * first asks the provider what changed. */
const SYNC_INTERVAL_MS = 30_000;

type LinkedStore = FileStore & FileLister;

export class PodObject extends DurableObject<Env> {
  private readonly index: SqlIndex;
  private pod: Pod | null = null;
  private podBase = '';
  private store: FileStore | null = null;
  private linked: LinkedStore | null = null;
  private access: { token: string; expiresAt: number } | null = null;
  private lastSync = 0;
  private links: StorageLinks | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.index = new SqlIndex(ctx.storage.sql, (fn) => ctx.storage.transactionSync(fn));
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS seen_proof(jti TEXT PRIMARY KEY, expires INTEGER NOT NULL)');
  }

  async fetch(request: Request): Promise<Response> {
    const base = request.headers.get(BASE_HEADER);
    const handle = request.headers.get(HANDLE_HEADER);
    if (!base || !handle) return new Response('missing pod base\n', { status: 500 });
    const origin = request.headers.get('Origin');
    const pod = await this.podAt(handle, base);
    if (!pod.isProvisioned()) return withCors(new Response('no such pod\n', { status: 404 }), request, origin);
    const jti = request.headers.get(JTI_HEADER);
    if (jti && !this.firstUse(jti, Number(request.headers.get(JTI_EXPIRES_HEADER)))) {
      return withCors(
        new Response('DPoP proof already used\n', { status: 401, headers: { 'WWW-Authenticate': 'DPoP error="invalid_dpop_proof"' } }),
        request,
        origin,
      );
    }
    await this.syncIfStale(pod, handle);
    return handleSolid(pod, request, { webid: request.headers.get(AGENT_HEADER) || null });
  }

  /** Creates the pod if it does not exist yet. */
  async ensureProvisioned(handle: string, base: string, owner: string, profile: string): Promise<void> {
    const pod = await this.podAt(handle, base);
    if (pod.isProvisioned()) return;
    try {
      await pod.provision(owner, profile);
    } catch (e) {
      if (!(e instanceof Conflict)) throw e;
    }
  }

  /** Starts linking Dropbox; `webid` must control the pod root. */
  async beginDropboxLink(handle: string, base: string, webid: string | null, redirectUri: string): Promise<string> {
    const pod = await this.podAt(handle, base);
    if (!pod.isProvisioned()) throw new Error('no such pod');
    if (!webid || !(await pod.modes('/', { webid })).has('control')) throw new Forbidden('only the pod owner can link storage');
    if (!this.env.DROPBOX_APP_KEY) throw new Error('DROPBOX_APP_KEY is not configured');
    const { verifier, challenge } = await pkce();
    const nonce = crypto.randomUUID().replaceAll('-', '');
    this.linksFor(handle).remember(nonce, { verifier, webid }, Math.floor(Date.now() / 1000));
    return authorizeUrl(this.env.DROPBOX_APP_KEY, redirectUri, `${handle}.${nonce}`, challenge);
  }

  /** Finishes linking: an empty app folder receives the pod, a folder that
   * already holds one becomes the pod. */
  async completeDropboxLink(handle: string, base: string, nonce: string, code: string, redirectUri: string): Promise<string> {
    const links = this.linksFor(handle);
    const pending = links.take(nonce, Math.floor(Date.now() / 1000));
    if (!pending) throw new Error('this link attempt expired; start again');
    const grant = await exchangeCode((u, i) => fetch(u, i), this.env.DROPBOX_APP_KEY!, redirectUri, code, pending.verifier, Date.now());
    const target = this.dropboxStore(grant.refreshToken, grant);
    const pod = await this.podAt(handle, base);

    let listing = await target.listAll();
    const outcome = listing.entries.some((e) => e.kind === 'file') ? 'adopted' : 'copied';
    if (outcome === 'copied') {
      await copyPod(this.index, this.store!, target);
      listing = await target.listAll();
    }
    await links.save({ provider: 'dropbox', account: grant.accountId, refreshToken: grant.refreshToken, cursor: listing.cursor }, new Date());
    this.useStore(handle, base, target);
    await this.pod!.adopt(pending.webid, listing.entries);
    void pod;
    return outcome;
  }

  private async podAt(handle: string, base: string): Promise<Pod> {
    if (!this.store) this.store = await this.storeFor(handle);
    if (!this.pod || this.podBase !== base) this.useStore(handle, base, this.store);
    return this.pod!;
  }

  private useStore(_handle: string, base: string, store: FileStore): void {
    this.store = store;
    this.podBase = base;
    this.pod = new Pod({
      index: this.index,
      files: store,
      base,
      now: () => new Date(),
      newId: () => crypto.randomUUID().replaceAll('-', ''),
    });
  }

  private async storeFor(handle: string): Promise<FileStore> {
    const link = await this.linksFor(handle).current();
    if (link?.provider === 'dropbox') return this.dropboxStore(link.refreshToken, null);
    if (this.env.STORAGE === 'dev' && this.env.DEV_MODE === '1') return new DevFileStore(this.ctx.storage.sql as SqlRunner);
    return new UnlinkedStore();
  }

  private dropboxStore(refreshToken: string, grant: Grant | null): LinkedStore {
    this.access = grant ? { token: grant.accessToken, expiresAt: grant.expiresAt } : null;
    const store = new DropboxFileStore({
      fetch: (u, i) => fetch(u, i),
      accessToken: async (refresh) => {
        if (!refresh && this.access && this.access.expiresAt - Date.now() > 60_000) return this.access.token;
        try {
          const fresh = await refreshAccess((u, i) => fetch(u, i), this.env.DROPBOX_APP_KEY!, refreshToken, Date.now());
          this.access = { token: fresh.accessToken, expiresAt: fresh.expiresAt };
          return fresh.accessToken;
        } catch (e) {
          throw new StorageUnavailable(`Dropbox refused the stored link (${(e as Error).message}); reconnect Dropbox`);
        }
      },
    });
    this.linked = store;
    return store;
  }

  /** Folds in edits made in Dropbox since the last look, at most every
   * SYNC_INTERVAL_MS. A failed sync leaves the request to proceed on the
   * index as it stands. */
  private async syncIfStale(pod: Pod, handle: string): Promise<void> {
    if (!this.linked || Date.now() - this.lastSync < SYNC_INTERVAL_MS) return;
    this.lastSync = Date.now();
    const links = this.linksFor(handle);
    const link: LinkRow | null = await links.current();
    if (!link?.cursor) return;
    try {
      const listing = await this.linked.changes(link.cursor);
      if (listing.entries.length > 0) await pod.applyChanges(listing.entries);
      links.setCursor(listing.cursor);
    } catch (e) {
      console.error(JSON.stringify({ level: 'warn', msg: 'sync failed', error: String((e as Error).message) }));
    }
  }

  private linksFor(handle: string): StorageLinks {
    this.links ??= new StorageLinks(this.ctx.storage.sql as SqlRunner, this.env.TOKEN_KEY, handle);
    return this.links;
  }

  /** Records a DPoP proof id; false if it was seen before. A proof names this
   * pod's host in its htu, so uniqueness per pod is uniqueness enough. */
  private firstUse(jti: string, expires: number): boolean {
    const sql = this.ctx.storage.sql;
    sql.exec('DELETE FROM seen_proof WHERE expires < ?', Math.floor(Date.now() / 1000));
    if (sql.exec('SELECT 1 FROM seen_proof WHERE jti = ?', jti).toArray().length > 0) return false;
    sql.exec('INSERT INTO seen_proof(jti, expires) VALUES (?, ?)', jti, Number.isFinite(expires) ? expires : 0);
    return true;
  }
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
