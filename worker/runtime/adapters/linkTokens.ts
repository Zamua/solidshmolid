// Short-lived access tokens for an account's storage links, minted from the
// stored refresh token and kept in memory until shortly before they expire.
// Concurrent askers share one refresh.

import { StorageUnavailable } from '../../app/shared/errors.js';
import { GrantRefused } from '../../app/storage/ports.js';

export interface AccessToken {
  token: string;
  /** Epoch milliseconds. */
  expiresAt: number;
}

/** What the service can do with a provider's grant. */
export interface GrantKeeper {
  /** Mints an access token from the refresh token. */
  refresh(refreshToken: string): Promise<AccessToken>;
  /** Gives the grant up with the provider. */
  revoke(refreshToken: string): Promise<void>;
}

const MARGIN_MS = 60_000;
const RECONNECT = "the pod's owner can connect the storage again from their account";

export class LinkTokens {
  private readonly cache = new Map<string, Promise<AccessToken>>();

  constructor(
    private readonly grant: (linkId: string) => Promise<{ provider: string; refreshToken: string } | null>,
    private readonly keepers: Record<string, GrantKeeper>,
    private readonly nowMs: () => number = () => Date.now(),
    /** Told when a link's grant turns out to be gone for good. */
    private readonly lost: (linkId: string) => void = () => {},
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

  /** Forgets the access token minted from a link's previous grant. */
  forget(linkId: string): void {
    this.cache.delete(linkId);
  }

  /** Gives the link's grant up with its provider. Best effort: a provider
   * that is down or already revoked it, or a grant that can no longer be
   * read, must not keep the link alive here. */
  async revoke(linkId: string): Promise<void> {
    this.cache.delete(linkId);
    const warn = (e: Error, provider?: string) => console.error(JSON.stringify({ level: 'warn', msg: 'revoke failed', provider, error: e.message }));
    const grant = await this.grant(linkId).catch((e: Error) => (warn(e), null));
    const keeper = grant && this.keepers[grant.provider];
    if (!grant || !keeper) return;
    await keeper.revoke(grant.refreshToken).catch((e: Error) => warn(e, grant.provider));
  }

  private async mint(linkId: string): Promise<AccessToken> {
    const grant = await this.grant(linkId).catch((e: Error) => {
      // Sealed under a key this deployment does not hold: as gone as a revoked one.
      console.error(JSON.stringify({ level: 'error', msg: 'stored grant does not open', error: e.message }));
      this.lost(linkId);
      throw new StorageUnavailable(`the stored link can no longer be used; ${RECONNECT}`);
    });
    if (!grant) throw new StorageUnavailable('this storage link no longer exists');
    const keeper = this.keepers[grant.provider];
    if (!keeper) throw new StorageUnavailable(`no way to reach ${grant.provider} storage here`);
    try {
      return await keeper.refresh(grant.refreshToken);
    } catch (e) {
      const gone = e instanceof GrantRefused && e.gone;
      if (gone) this.lost(linkId);
      throw new StorageUnavailable(`${grant.provider} refused the stored link (${(e as Error).message})${gone ? `; ${RECONNECT}` : ''}`);
    }
  }
}
