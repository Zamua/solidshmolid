// The Solid-OIDC provider: authorization code flow with PKCE, DPoP-bound
// tokens, rotating refresh tokens.
//
// Codes and refresh tokens carry the key of the account they belong to, so
// the token endpoint can find the account without a global table. Their
// secret parts are stored only as hashes.

import {
  type AuthorizeRequest,
  CODE_TTL_S,
  type ClientInfo,
  OidcError,
  accessTokenClaims,
  idTokenClaims,
  parseAuthorizeRequest,
  pkceMatches,
  redirectAllowed,
} from '../domain/oidc.js';

/** What the provider needs to know about one person. */
export interface AccountStore {
  key: string;
  /** The WebID this person signs in as, or null before they have a pod. */
  webid(): Promise<string | null>;
  hasApproval(clientId: string, webid: string): Promise<boolean>;
  approve(clientId: string, clientName: string | null, webid: string): Promise<void>;
  /** A pending consent, so the decision can be checked against what was shown. */
  savePending(id: string, request: AuthorizeRequest, client: ClientInfo, expires: number): Promise<void>;
  takePending(id: string, now: number): Promise<{ request: AuthorizeRequest; client: ClientInfo } | null>;
  saveCode(hash: string, grant: CodeGrant): Promise<void>;
  /** Marks the code used and returns it; a second take returns it with `reused`. */
  takeCode(hash: string): Promise<(CodeGrant & { reused: boolean }) | null>;
  saveFamily(family: RefreshFamily): Promise<void>;
  family(id: string): Promise<RefreshFamily | null>;
  rotateFamily(id: string, newHash: string, expires: number): Promise<void>;
  revokeFamily(id: string): Promise<void>;
  /** Revokes every family that came from a given code. */
  revokeFromCode(codeHash: string): Promise<void>;
}

export interface CodeGrant {
  clientId: string;
  redirectUri: string;
  webid: string;
  codeChallenge: string;
  nonce: string | null;
  scopes: string[];
  expires: number;
}

export interface RefreshFamily {
  id: string;
  clientId: string;
  webid: string;
  jkt: string;
  scopes: string[];
  currentHash: string;
  fromCode: string;
  expires: number;
}

export interface ProviderDeps {
  issuer: string;
  /** The account for a signed-in person (Clerk user id), creating it if new. */
  accountFor: (personId: string) => Promise<AccountStore>;
  /** The account a code or refresh token names. */
  accountByKey: (key: string) => Promise<AccountStore | null>;
  resolveClient: (clientId: string) => Promise<ClientInfo>;
  sign: (claims: Record<string, unknown>) => Promise<string>;
  /** Unix seconds. */
  now: () => number;
  random: () => string;
  hash: (secret: string) => Promise<string>;
}

export type AuthorizeOutcome =
  | { kind: 'sign-in' }
  | { kind: 'no-pod' }
  | { kind: 'consent'; pendingId: string; client: ClientInfo; webid: string }
  | { kind: 'redirect'; location: string };

const REFRESH_TTL_S = 30 * 24 * 3600;
const PENDING_TTL_S = 10 * 60;

export class Provider {
  constructor(private readonly deps: ProviderDeps) {}

  /** Step one. `personId` is the signed-in Clerk user, or null. Errors before
   * the client and redirect are trusted throw OidcError (shown, not sent). */
  async authorize(query: URLSearchParams, personId: string | null): Promise<AuthorizeOutcome> {
    const request = parseAuthorizeRequest(query);
    const client = await this.deps.resolveClient(request.clientId);
    if (!redirectAllowed(client, request.redirectUri)) throw new OidcError('invalid_request', 'redirect_uri is not registered for this client');
    if (!personId) return { kind: 'sign-in' };
    const account = await this.deps.accountFor(personId);
    const webid = await account.webid();
    if (!webid) return { kind: 'no-pod' };
    if (request.prompt !== 'consent' && (await account.hasApproval(client.clientId, webid))) {
      return { kind: 'redirect', location: await this.issueCode(account, request, webid) };
    }
    const pendingId = this.deps.random();
    await account.savePending(pendingId, request, client, this.deps.now() + PENDING_TTL_S);
    return { kind: 'consent', pendingId, client, webid };
  }

  /** Step two: the person's answer on the consent page. */
  async decide(personId: string, pendingId: string, approve: boolean): Promise<string> {
    const account = await this.deps.accountFor(personId);
    const pending = await account.takePending(pendingId, this.deps.now());
    if (!pending) throw new OidcError('invalid_request', 'this sign-in request expired; start again from the app');
    const { request, client } = pending;
    if (!approve) return redirectWith(request.redirectUri, { error: 'access_denied', state: request.state, iss: this.deps.issuer });
    const webid = await account.webid();
    if (!webid) throw new OidcError('invalid_request', 'no pod for this account');
    await account.approve(client.clientId, client.name, webid);
    return this.issueCode(account, request, webid);
  }

  /** The token endpoint. `jkt` is the thumbprint of the request's verified
   * DPoP proof. */
  async token(form: URLSearchParams, jkt: string): Promise<Record<string, unknown>> {
    const grant = form.get('grant_type');
    if (grant === 'authorization_code') return this.redeemCode(form, jkt);
    if (grant === 'refresh_token') return this.refresh(form, jkt);
    throw new OidcError('unsupported_grant_type', `grant_type ${grant ?? '(none)'} is not supported`);
  }

  private async issueCode(account: AccountStore, request: AuthorizeRequest, webid: string): Promise<string> {
    const secret = this.deps.random();
    await account.saveCode(await this.deps.hash(secret), {
      clientId: request.clientId,
      redirectUri: request.redirectUri,
      webid,
      codeChallenge: request.codeChallenge,
      nonce: request.nonce,
      scopes: request.scopes,
      expires: this.deps.now() + CODE_TTL_S,
    });
    return redirectWith(request.redirectUri, { code: `${account.key}.${secret}`, state: request.state, iss: this.deps.issuer });
  }

  private async redeemCode(form: URLSearchParams, jkt: string): Promise<Record<string, unknown>> {
    const [key, secret] = splitToken(form.get('code'));
    const account = await this.deps.accountByKey(key);
    if (!account) throw new OidcError('invalid_grant', 'unknown code');
    const codeHash = await this.deps.hash(secret);
    const grant = await account.takeCode(codeHash);
    if (!grant) throw new OidcError('invalid_grant', 'unknown code');
    if (grant.reused) {
      // A code presented twice was intercepted or replayed: nothing it produced is trustworthy.
      await account.revokeFromCode(codeHash);
      throw new OidcError('invalid_grant', 'code already used');
    }
    if (grant.expires < this.deps.now()) throw new OidcError('invalid_grant', 'code expired');
    if (form.get('client_id') !== grant.clientId || form.get('redirect_uri') !== grant.redirectUri) {
      throw new OidcError('invalid_grant', 'client_id or redirect_uri does not match the authorization');
    }
    if (!(await pkceMatches(form.get('code_verifier') ?? '', grant.codeChallenge))) throw new OidcError('invalid_grant', 'PKCE verification failed');
    return this.tokens(account, grant.webid, grant.clientId, grant.scopes, grant.nonce, jkt, codeHash);
  }

  private async refresh(form: URLSearchParams, jkt: string): Promise<Record<string, unknown>> {
    const parts = (form.get('refresh_token') ?? '').split('.');
    if (parts.length !== 3) throw new OidcError('invalid_grant', 'malformed refresh token');
    const [key, familyId, secret] = parts as [string, string, string];
    const account = await this.deps.accountByKey(key);
    const family = account ? await account.family(familyId) : null;
    if (!account || !family) throw new OidcError('invalid_grant', 'unknown refresh token');
    if (family.expires < this.deps.now()) throw new OidcError('invalid_grant', 'refresh token expired');
    if ((await this.deps.hash(secret)) !== family.currentHash) {
      // An old token from this family came back: the family is compromised.
      await account.revokeFamily(familyId);
      throw new OidcError('invalid_grant', 'refresh token already used');
    }
    if (family.jkt !== jkt) throw new OidcError('invalid_dpop_proof', 'refresh token is bound to a different DPoP key');
    if (form.get('client_id') && form.get('client_id') !== family.clientId) throw new OidcError('invalid_grant', 'client_id does not match');
    const next = this.deps.random();
    await account.rotateFamily(familyId, await this.deps.hash(next), this.deps.now() + REFRESH_TTL_S);
    const access = await this.deps.sign(
      accessTokenClaims({ issuer: this.deps.issuer, webid: family.webid, clientId: family.clientId, now: this.deps.now(), jkt, jti: this.deps.random() }),
    );
    return {
      access_token: access,
      token_type: 'DPoP',
      expires_in: 3600,
      refresh_token: `${account.key}.${familyId}.${next}`,
      scope: family.scopes.join(' '),
    };
  }

  private async tokens(
    account: AccountStore,
    webid: string,
    clientId: string,
    scopes: string[],
    nonce: string | null,
    jkt: string,
    fromCode: string,
  ): Promise<Record<string, unknown>> {
    const now = this.deps.now();
    const base = { issuer: this.deps.issuer, webid, clientId, now };
    const out: Record<string, unknown> = {
      access_token: await this.deps.sign(accessTokenClaims({ ...base, jkt, jti: this.deps.random() })),
      token_type: 'DPoP',
      expires_in: 3600,
      id_token: await this.deps.sign(idTokenClaims({ ...base, nonce })),
      scope: scopes.join(' '),
    };
    if (scopes.includes('offline_access')) {
      const id = this.deps.random();
      const secret = this.deps.random();
      await account.saveFamily({ id, clientId, webid, jkt, scopes, currentHash: await this.deps.hash(secret), fromCode, expires: now + REFRESH_TTL_S });
      out.refresh_token = `${account.key}.${id}.${secret}`;
    }
    return out;
  }
}

function splitToken(value: string | null): [string, string] {
  const parts = (value ?? '').split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new OidcError('invalid_grant', 'malformed code');
  return [parts[0], parts[1]];
}

function redirectWith(uri: string, params: Record<string, string | null>): string {
  const u = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (v !== null) u.searchParams.set(k, v);
  return u.toString();
}
