// Connecting a pod to the user's storage, and keeping its view of that
// storage fresh.
//
// On connection, an app folder with no files receives a copy of the pod; one
// that already holds files is adopted as the pod. Either way the folder is the
// truth afterwards.

import type { Pod } from '../pods/pod.js';
import type { PodIndex } from '../pods/ports.js';
import { copyPod } from './migrate.js';
import type { FileLister, FileStore, LinkStore, StorageAuthorization, StorageOpener } from './ports.js';

export class NotAllowed extends Error {}
export class LinkExpired extends Error {}

export type LinkOutcome = 'copied' | 'adopted';

export interface LinkingDeps {
  pod: Pod;
  /** The same pod served from other storage. */
  podOn: (storage: FileStore) => Pod;
  index: PodIndex;
  /** Where the pod's files are now (before linking). */
  current: FileStore;
  links: LinkStore;
  authorization: StorageAuthorization;
  opener: StorageOpener;
  newNonce: () => string;
}

export class StorageLinking {
  constructor(private readonly deps: LinkingDeps) {}

  /** Starts the provider's consent flow; only a controller of the pod root may. */
  async begin(webid: string | null, redirectUri: string, handle: string): Promise<string> {
    if (!webid || !(await this.deps.pod.modes('/', { webid })).has('control')) throw new NotAllowed('only the pod owner can link storage');
    const { verifier, challenge } = await this.deps.authorization.pkce();
    const nonce = this.deps.newNonce();
    await this.deps.links.remember(nonce, { verifier, webid });
    return this.deps.authorization.authorizeUrl(redirectUri, `${handle}.${nonce}`, challenge);
  }

  /** Finishes the flow; returns the pod as now served from the linked storage. */
  async complete(nonce: string, code: string, redirectUri: string): Promise<{ outcome: LinkOutcome; storage: FileStore & FileLister; pod: Pod }> {
    const pending = await this.deps.links.take(nonce);
    if (!pending) throw new LinkExpired('this link attempt expired; start again');
    const grant = await this.deps.authorization.exchange(code, pending.verifier, redirectUri);
    const link = { provider: this.deps.authorization.provider, account: grant.accountId, refreshToken: grant.refreshToken, cursor: null };
    const storage = this.deps.opener.open(link, grant);

    let listing = await storage.listAll();
    const outcome: LinkOutcome = listing.entries.some((e) => e.kind === 'file') ? 'adopted' : 'copied';
    if (outcome === 'copied') {
      await copyPod(this.deps.index, this.deps.current, storage);
      listing = await storage.listAll();
    }
    await this.deps.links.save({ ...link, cursor: listing.cursor });
    const pod = this.deps.podOn(storage);
    await pod.adopt(pending.webid, listing.entries);
    return { outcome, storage, pod };
  }
}

/** Folds in edits made directly in the storage, at most once per interval. */
export class FolderSync {
  private last = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly pod: Pod,
    private readonly links: LinkStore,
    private readonly lister: FileLister,
    private readonly intervalMs: number,
    private readonly nowMs: () => number,
  ) {}

  /** Returns the number of changes applied; throws when the provider fails,
   * and the caller decides whether that blocks the request. */
  async syncIfStale(): Promise<number> {
    if (this.nowMs() - this.last < this.intervalMs) return 0;
    this.last = this.nowMs();
    const link = await this.links.current();
    if (!link?.cursor) return 0;
    const listing = await this.lister.changes(link.cursor);
    if (listing.entries.length > 0) await this.pod.applyChanges(listing.entries);
    await this.links.setCursor(listing.cursor);
    return listing.entries.length;
  }
}
