// Google OAuth 2 for Drive: PKCE, offline access, and only the drive.file
// scope. Unlike Dropbox, Google's web clients refresh only with the client
// secret, so this provider holds one.

import { type Grant, GrantRefused, type StorageAuthorization } from '../../app/storage/ports.js';
import { type PkcePair, pkce } from './pkce.js';

const AUTHORIZE = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN = 'https://oauth2.googleapis.com/token';
const REVOKE = 'https://oauth2.googleapis.com/revoke';
const ABOUT = 'https://www.googleapis.com/drive/v3/about?fields=user(permissionId)';
export const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

export class GoogleAuthError extends GrantRefused {}

export interface GoogleClient {
  id: string;
  secret: string;
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export function googleAuthorizeUrl(clientId: string, redirectUri: string, state: string, challenge: string): string {
  const q = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: DRIVE_FILE_SCOPE,
    access_type: 'offline',
    // Without it, a second consent returns no refresh token.
    prompt: 'consent',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
  });
  return `${AUTHORIZE}?${q}`;
}

export async function exchangeGoogleCode(fetcher: Fetch, client: GoogleClient, redirectUri: string, code: string, verifier: string, now: number): Promise<Grant> {
  const body = await tokenCall(fetcher, {
    grant_type: 'authorization_code',
    code,
    client_id: client.id,
    client_secret: client.secret,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  });
  if (typeof body.refresh_token !== 'string') throw new GoogleAuthError('Google did not grant offline access');
  // Google lets people untick a scope on the consent screen.
  if (!String(body.scope ?? '').split(' ').includes(DRIVE_FILE_SCOPE)) {
    throw new GoogleAuthError('Google Drive access was not granted; allow solidshmolid to use its own files in your Drive');
  }
  const accessToken = String(body.access_token);
  const about = await fetcher(ABOUT, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!about.ok) throw new GoogleAuthError(`Google Drive answered ${about.status} when asked whose Drive it is`);
  const { user } = (await about.json()) as { user?: { permissionId?: string } };
  if (!user?.permissionId) throw new GoogleAuthError('Google Drive did not say whose Drive it is');
  return { accessToken, expiresAt: now + Number(body.expires_in ?? 0) * 1000, refreshToken: body.refresh_token, accountId: user.permissionId };
}

export async function refreshGoogleAccess(fetcher: Fetch, client: GoogleClient, refreshToken: string, now: number): Promise<{ accessToken: string; expiresAt: number }> {
  const body = await tokenCall(fetcher, { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: client.id, client_secret: client.secret });
  return { accessToken: String(body.access_token), expiresAt: now + Number(body.expires_in ?? 0) * 1000 };
}

/** Gives up a grant; one Google already dropped counts as given up. */
export async function revokeGoogleGrant(fetcher: Fetch, refreshToken: string): Promise<void> {
  const res = await fetcher(REVOKE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: refreshToken }).toString(),
  });
  if (res.ok) return;
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  if (body.error !== 'invalid_token') throw new GoogleAuthError(`Google answered ${res.status} to the revoke`);
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
    throw new GoogleAuthError(`Google's token endpoint answered ${res.status}`);
  }
  if (!res.ok || typeof body.access_token !== 'string') {
    // invalid_grant on refresh means the person removed the app's access.
    throw new GoogleAuthError(String(body.error_description ?? body.error ?? `HTTP ${res.status}`));
  }
  return body;
}

/** Google Drive behind the StorageAuthorization port. */
export class GoogleDriveAuthorization implements StorageAuthorization {
  readonly provider = 'google-drive';

  constructor(
    private readonly client: GoogleClient,
    private readonly fetcher: Fetch,
  ) {}

  pkce(): Promise<PkcePair> {
    return pkce();
  }

  authorizeUrl(redirectUri: string, state: string, challenge: string): string {
    return googleAuthorizeUrl(this.client.id, redirectUri, state, challenge);
  }

  exchange(code: string, verifier: string, redirectUri: string): Promise<Grant> {
    return exchangeGoogleCode(this.fetcher, this.client, redirectUri, code, verifier, Date.now());
  }
}
