// Dropbox OAuth 2 with PKCE and offline access. With PKCE, Dropbox issues a
// refresh token and accepts refreshes without a client secret, so the service
// holds no app secret at all.

import type { Grant, StorageAuthorization } from '../../app/storage/ports.js';

const AUTHORIZE = 'https://www.dropbox.com/oauth2/authorize';
const TOKEN = 'https://api.dropboxapi.com/oauth2/token';

export class DropboxAuthError extends Error {}

export interface PkcePair {
  verifier: string;
  challenge: string;
}

export async function pkce(): Promise<PkcePair> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(48)));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  return { verifier, challenge: base64url(digest) };
}

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

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export async function exchangeCode(
  fetcher: Fetch,
  appKey: string,
  redirectUri: string,
  code: string,
  verifier: string,
  now: number,
): Promise<Grant> {
  const body = await tokenCall(fetcher, {
    grant_type: 'authorization_code',
    code,
    client_id: appKey,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  });
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
  const body = await tokenCall(fetcher, { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: appKey });
  return { accessToken: String(body.access_token), expiresAt: now + Number(body.expires_in ?? 0) * 1000 };
}

/** Gives up a grant: Dropbox revokes the token and the app's access with it. */
export async function revokeGrant(fetcher: Fetch, appKey: string, refreshToken: string, now: number): Promise<void> {
  const { accessToken } = await refreshAccess(fetcher, appKey, refreshToken, now);
  const res = await fetcher('https://api.dropboxapi.com/2/auth/token/revoke', { method: 'POST', headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new DropboxAuthError(`Dropbox answered ${res.status} to the revoke`);
}

async function tokenCall(fetcher: Fetch, form: Record<string, string>): Promise<Record<string, unknown>> {
  const res = await fetcher(TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
  });
  const text = await res.text();
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new DropboxAuthError(`Dropbox token endpoint answered ${res.status}`);
  }
  if (!res.ok || typeof body.access_token !== 'string') {
    // invalid_grant on refresh means the user revoked the app.
    throw new DropboxAuthError(String(body.error_description ?? body.error ?? `HTTP ${res.status}`));
  }
  return body;
}

function base64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
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
