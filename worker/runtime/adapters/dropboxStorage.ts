// Opens a linked Dropbox: an access token kept in memory and refreshed from
// the stored grant shortly before it expires.

import { StorageUnavailable } from '../../app/shared/errors.js';
import type { FileLister, FileStore, Grant, StorageLink, StorageOpener } from '../../app/storage/ports.js';
import { DropboxFileStore } from './dropbox.js';
import { refreshAccess } from './dropboxOAuth.js';

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

const REFRESH_MARGIN_MS = 60_000;

export class DropboxOpener implements StorageOpener {
  constructor(
    private readonly appKey: string,
    private readonly fetcher: Fetch,
    private readonly root = '',
  ) {}

  open(link: StorageLink, grant?: Grant): FileStore & FileLister {
    let access = grant ? { token: grant.accessToken, expiresAt: grant.expiresAt } : null;
    return new DropboxFileStore({
      fetch: this.fetcher,
      root: this.root,
      accessToken: async (forceRefresh) => {
        if (!forceRefresh && access && access.expiresAt - Date.now() > REFRESH_MARGIN_MS) return access.token;
        try {
          const fresh = await refreshAccess(this.fetcher, this.appKey, link.refreshToken, Date.now());
          access = { token: fresh.accessToken, expiresAt: fresh.expiresAt };
          return fresh.accessToken;
        } catch (e) {
          throw new StorageUnavailable(`Dropbox refused the stored link (${(e as Error).message}); reconnect Dropbox`);
        }
      },
    });
  }
}
