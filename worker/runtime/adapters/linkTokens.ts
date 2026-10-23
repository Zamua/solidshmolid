// Short-lived access tokens for an account's storage links, minted from the
// stored refresh token and kept in memory until shortly before they expire.
// Concurrent askers share one refresh.

import { StorageUnavailable } from '../../app/shared/errors.js';

export interface AccessToken {
  token: string;
  /** Epoch milliseconds. */
  expiresAt: number;
}

/** Mints an access token from a refresh token, per provider. */
export type Refresher = (refreshToken: string) => Promise<AccessToken>;

const MARGIN_MS = 60_000;

export class LinkTokens {
  private readonly cache = new Map<string, Promise<AccessToken>>();

  constructor(
    private readonly grant: (linkId: string) => Promise<{ provider: string; refreshToken: string } | null>,
    private readonly refreshers: Record<string, Refresher>,
    private readonly nowMs: () => number = () => Date.now(),
  ) {}

  async accessToken(linkId: string, refresh: boolean): Promise<AccessToken> {
    const cached = this.cache.get(linkId);
    if (cached && !refresh) {
      const token = await cached.catch(() => null);
      if (token && token.expiresAt - this.nowMs() > MARGIN_MS) return token;
    }
    const fresh = this.mint(linkId);
    this.cache.set(linkId, fresh);
    fresh.catch(() => this.cache.get(linkId) === fresh && this.cache.delete(linkId));
    return fresh;
  }

  private async mint(linkId: string): Promise<AccessToken> {
    const grant = await this.grant(linkId);
    if (!grant) throw new StorageUnavailable('this storage link no longer exists');
    const refresher = this.refreshers[grant.provider];
    if (!refresher) throw new StorageUnavailable(`no way to reach ${grant.provider} storage here`);
    try {
      return await refresher(grant.refreshToken);
    } catch (e) {
      throw new StorageUnavailable(`${grant.provider} refused the stored link (${(e as Error).message}); reconnect storage`);
    }
  }
}
