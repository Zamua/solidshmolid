// Dropbox OAuth 2 with PKCE and offline access. With PKCE, Dropbox issues a
// refresh token and accepts refreshes without a client secret, so the service
// holds no app secret at all.

import { type Grant, GrantRefused, type StorageAuthorization } from '../../app/storage/ports.js';
import { type Fetch, tokenCall } from './http.js';
import { type PkcePair, pkce } from './pkce.js';

const AUTHORIZE = 'https://www.dropbox.com/oauth2/authorize';
const TOKEN = 'https://api.dropboxapi.com/oauth2/token';

export class DropboxAuthError extends GrantRefused {}

// invalid_grant on refresh means the user revoked the app.
const refused = (message: string) => new DropboxAuthError(`Dropbox: ${message}`);

export function authorizeUrl(appKey: string, redirectUri: string, state: string, challenge: string): string {
  const q = new URLSearchParams({
    client_id: appKey,
    response_type: 'code',
    token_access_type: 'offline',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    redirect_uri: redirectUri,
    state,
  });
  return `${AUTHORIZE}?${q}`;
}


export async function exchangeCode(
  fetcher: Fetch,
  appKey: string,
  redirectUri: string,
  code: string,
  verifier: string,
  now: number,
): Promise<Grant> {
  const body = await tokenCall(fetcher, TOKEN, {
    grant_type: 'authorization_code',
    code,
    client_id: appKey,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  }, refused);
  if (typeof body.refresh_token !== 'string' || typeof body.account_id !== 'string') {
    throw new DropboxAuthError('Dropbox did not grant offline access');
  }
  return {
    accessToken: String(body.access_token),
    expiresAt: now + Number(body.expires_in ?? 0) * 1000,
    refreshToken: body.refresh_token,
    accountId: body.account_id,
  };
}

export async function refreshAccess(
  fetcher: Fetch,
  appKey: string,
  refreshToken: string,
  now: number,
): Promise<{ accessToken: string; expiresAt: number }> {
  const body = await tokenCall(fetcher, TOKEN, { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: appKey }, refused);
  return { accessToken: String(body.access_token), expiresAt: now + Number(body.expires_in ?? 0) * 1000 };
}

/** Gives up a grant: Dropbox revokes the token and the app's access with it. */
export async function revokeGrant(fetcher: Fetch, appKey: string, refreshToken: string, now: number): Promise<void> {
  const { accessToken } = await refreshAccess(fetcher, appKey, refreshToken, now);
  const res = await fetcher('https://api.dropboxapi.com/2/auth/token/revoke', { method: 'POST', headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new DropboxAuthError(`Dropbox answered ${res.status} to the revoke`);
}

/** Dropbox behind the StorageAuthorization port. */
export class DropboxAuthorization implements StorageAuthorization {
  readonly provider = 'dropbox';

  constructor(
    private readonly appKey: string,
    private readonly fetcher: Fetch,
  ) {}

  pkce(): Promise<PkcePair> {
    return pkce();
  }

  authorizeUrl(redirectUri: string, state: string, challenge: string): string {
    return authorizeUrl(this.appKey, redirectUri, state, challenge);
  }

  exchange(code: string, verifier: string, redirectUri: string): Promise<Grant> {
    return exchangeCode(this.fetcher, this.appKey, redirectUri, code, verifier, Date.now());
  }
}
