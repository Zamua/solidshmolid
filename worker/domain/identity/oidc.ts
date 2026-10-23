// Solid-OIDC provider rules: what a valid authorization request is, which
// redirects a client may use, and the claims our tokens carry.

export const SOLID_OIDC = 'https://solidproject.org/TR/solid-oidc';
/** A client with no document or registration (Solid-OIDC "public client"). */
export const PUBLIC_CLIENT = 'http://www.w3.org/ns/solid/terms#PublicOidcClient';

export const ACCESS_TOKEN_TTL_S = 3600;
export const ID_TOKEN_TTL_S = 3600;
export const CODE_TTL_S = 60;

/** An OAuth error with its RFC 6749 code. */
export class OidcError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function discovery(issuer: string): Record<string, unknown> {
  const base = issuer.replace(/\/$/u, '');
  return {
    issuer: `${base}/`,
    authorization_endpoint: `${base}/.oidc/auth`,
    token_endpoint: `${base}/.oidc/token`,
    jwks_uri: `${base}/.oidc/jwks`,
    registration_endpoint: `${base}/.oidc/reg`,
    end_session_endpoint: `${base}/.oidc/session/end`,
    scopes_supported: ['openid', 'webid', 'offline_access'],
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    subject_types_supported: ['public'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    dpop_signing_alg_values_supported: ['ES256', 'PS256', 'RS256'],
    id_token_signing_alg_values_supported: ['ES256'],
    claims_supported: ['iss', 'sub', 'aud', 'exp', 'iat', 'webid', 'azp', 'nonce'],
    authorization_response_iss_parameter_supported: true,
    solid_oidc_supported: SOLID_OIDC,
  };
}

export interface AuthorizeRequest {
  clientId: string;
  redirectUri: string;
  scopes: string[];
  codeChallenge: string;
  state: string | null;
  nonce: string | null;
  prompt: string | null;
}

/** Parses /auth parameters. Errors before the redirect is trusted are thrown
 * as `invalid_request` and shown to the person, never sent to the redirect. */
export function parseAuthorizeRequest(q: URLSearchParams): AuthorizeRequest {
  const need = (k: string) => {
    const v = q.get(k);
    if (!v) throw new OidcError('invalid_request', `missing ${k}`);
    return v;
  };
  if (need('response_type') !== 'code') throw new OidcError('unsupported_response_type', 'only response_type=code');
  if (need('code_challenge_method') !== 'S256') throw new OidcError('invalid_request', 'PKCE with S256 is required');
  const codeChallenge = need('code_challenge');
  if (!/^[A-Za-z0-9_-]{43}$/u.test(codeChallenge)) throw new OidcError('invalid_request', 'malformed code_challenge');
  const scopes = need('scope').split(/\s+/u).filter(Boolean);
  if (!scopes.includes('openid') || !scopes.includes('webid')) throw new OidcError('invalid_scope', 'scope must include openid and webid');
  return {
    clientId: need('client_id'),
    redirectUri: need('redirect_uri'),
    scopes,
    codeChallenge,
    state: q.get('state'),
    nonce: q.get('nonce'),
    prompt: q.get('prompt'),
  };
}

export interface ClientInfo {
  clientId: string;
  name: string | null;
  redirectUris: string[];
  /** No document and no registration: any https (or localhost) redirect. */
  isPublic: boolean;
}

/** The site a client belongs to, as people would recognise it: its Client ID
 * Document's host, else its first redirect's host; null for the public client. */
export function clientSite(client: ClientInfo): string | null {
  if (client.isPublic) return null;
  for (const candidate of [client.clientId, client.redirectUris[0]]) {
    try {
      if (candidate) return new URL(candidate).host;
    } catch {
      // a registered client's id is not a URL
    }
  }
  return null;
}

/** Validates a dereferenced Client ID Document. Its `client_id` must equal
 * the URL it was fetched from, so a document cannot speak for another client. */
export function clientFromDocument(clientId: string, doc: unknown): ClientInfo {
  if (typeof doc !== 'object' || doc === null) throw new OidcError('invalid_client', 'client document is not a JSON object');
  const d = doc as Record<string, unknown>;
  if (d.client_id !== clientId) throw new OidcError('invalid_client', 'client document names a different client_id');
  const uris = d.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0 || !uris.every((u) => typeof u === 'string')) {
    throw new OidcError('invalid_client', 'client document has no redirect_uris');
  }
  return { clientId, name: typeof d.client_name === 'string' ? d.client_name : null, redirectUris: uris as string[], isPublic: false };
}

export interface Registration {
  redirect_uris: string[];
  client_name: string | null;
  token_endpoint_auth_method: 'none';
}

/** Bounds on a registration, which anyone may send and the directory keeps. */
export const REGISTRATION_LIMITS = { uris: 10, uriLength: 2048, nameLength: 100 };

/** Validates a dynamic registration request (RFC 7591): public clients only,
 * with a few http(s) redirect URIs. */
export function parseRegistration(body: unknown): Registration {
  const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  const uris = b.redirect_uris;
  const { uris: most, uriLength, nameLength } = REGISTRATION_LIMITS;
  if (
    !Array.isArray(uris) ||
    uris.length === 0 ||
    uris.length > most ||
    !uris.every((u) => typeof u === 'string' && u.length <= uriLength && /^https?:\/\//u.test(u))
  ) {
    throw new OidcError('invalid_redirect_uri', `redirect_uris must be 1 to ${most} http(s) URLs of at most ${uriLength} characters`);
  }
  const name = typeof b.client_name === 'string' ? b.client_name.slice(0, nameLength) : null;
  return { redirect_uris: uris as string[], client_name: name, token_endpoint_auth_method: 'none' };
}

export function publicClient(): ClientInfo {
  return { clientId: PUBLIC_CLIENT, name: null, redirectUris: [], isPublic: true };
}

/** Exact match for known clients; for the public client, any https URL or a
 * loopback http URL (native and local apps). */
export function redirectAllowed(client: ClientInfo, redirectUri: string): boolean {
  if (!client.isPublic) return client.redirectUris.includes(redirectUri);
  let u: URL;
  try {
    u = new URL(redirectUri);
  } catch {
    return false;
  }
  if (u.hash) return false;
  if (u.protocol === 'https:') return true;
  return u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname.endsWith('.localhost'));
}

/** RFC 7636 S256: base64url(sha256(verifier)) === challenge. */
export async function pkceMatches(verifier: string, challenge: string): Promise<boolean> {
  if (!/^[A-Za-z0-9._~-]{43,128}$/u.test(verifier)) return false;
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  return base64url(digest) === challenge;
}

export interface TokenContext {
  issuer: string;
  webid: string;
  clientId: string;
  /** Unix seconds. */
  now: number;
}

export function accessTokenClaims(c: TokenContext & { jkt: string; jti: string }): Record<string, unknown> {
  return {
    iss: c.issuer,
    aud: ['solid', c.clientId],
    sub: c.webid,
    webid: c.webid,
    client_id: c.clientId,
    azp: c.clientId,
    cnf: { jkt: c.jkt },
    iat: c.now,
    exp: c.now + ACCESS_TOKEN_TTL_S,
    jti: c.jti,
  };
}

export function idTokenClaims(c: TokenContext & { nonce: string | null }): Record<string, unknown> {
  return {
    iss: c.issuer,
    aud: c.clientId,
    sub: c.webid,
    webid: c.webid,
    azp: c.clientId,
    iat: c.now,
    exp: c.now + ID_TOKEN_TTL_S,
    ...(c.nonce ? { nonce: c.nonce } : {}),
  };
}

export function base64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
}
