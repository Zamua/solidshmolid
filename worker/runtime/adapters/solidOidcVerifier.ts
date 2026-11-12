// The resource-server side of Solid-OIDC: turns `Authorization: DPoP <token>`
// plus a `DPoP` proof into a verified WebID.
//
// Every URL fetched here (the issuer, its JWKS, the WebID document) is chosen
// by whoever sent the request, so each fetch is time-boxed, size-capped and
// cached, failures included; redirects are followed by hand, each hop checked
// like the first; and what a fetch found is logged, never told to the caller.

import { type JWTPayload, type JWTVerifyGetKey, createLocalJWKSet, decodeJwt, errors, jwtVerify } from 'jose';
import { SIGNING_ALGORITHMS } from '../../domain/identity/oidc.js';
import { parseRdf } from '../../domain/shared/rdf.js';
import { SOLID } from '../../domain/shared/vocab.js';
import { type Fetch, limitedText } from './http.js';
import { InvalidDpopProof, PROOF_WINDOW_S, type VerifiedProof, verifyDpopProof } from './dpopProof.js';

/** `message` is what the caller is told. `detail` is for the log only: what a
 * lookup on the caller's behalf found is not theirs to read. */
export class InvalidCredentials extends Error {
  constructor(
    message: string,
    readonly detail?: string,
  ) {
    super(message);
  }
}

export interface VerifiedAgent {
  webid: string;
  issuer: string;
  clientId: string | null;
  /** The proof's id and expiry (epoch seconds), for the pod's replay check. */
  jti: string;
  jtiExpires: number;
}

export interface AuthRequest {
  method: string;
  url: string;
  authorization: string | null;
  dpop: string | null;
}

export interface VerifierDeps {
  /** Milliseconds since the epoch. */
  now: () => number;
  /** Local development only: issuers and WebIDs on plain http and loopback hosts. */
  insecure?: boolean;
}

const CACHE_MS = 5 * 60_000;
const FETCH_TIMEOUT_MS = 5_000;
const FETCH_LIMIT = 256 * 1024;
/** Issuers and WebIDs are the caller's choice, so the caches stay bounded. */
const CACHE_ENTRIES = 256;
const JWKS_KEYS = 20;
/** How long a failed lookup is remembered, and how often a key set is
 * refetched for a key it lacks: a caller cannot make us fetch faster. */
const RETRY_MS = 60_000;
const WEBID_REDIRECTS = 3;

const UNREACHABLE_ISSUER = 'the token issuer could not be reached';
const UNREADABLE_PROFILE = 'the WebID profile could not be read';

interface Cached<T> {
  at: number;
  value: T;
}

export class SolidOidcVerifier {
  private readonly keys = new Map<string, Cached<JWTVerifyGetKey>>();
  private readonly webids = new Map<string, Cached<string[]>>();
  private readonly failures = new Map<string, Cached<InvalidCredentials>>();

  constructor(private readonly deps: VerifierDeps) {}

  /** The verified agent, or null for a request without credentials. */
  async verify(request: AuthRequest, fetch: Fetch): Promise<VerifiedAgent | null> {
    if (!request.authorization) return null;
    const m = /^DPoP\s+([\w-]+\.[\w-]+\.[\w-]+)$/iu.exec(request.authorization.trim());
    if (!m) throw new InvalidCredentials('expected a DPoP-bound access token');
    if (!request.dpop) throw new InvalidCredentials('missing DPoP proof');
    const token = m[1]!;
    const now = new Date(this.deps.now());

    let issuer: string;
    try {
      const claims = decodeJwt(token);
      if (typeof claims.iss !== 'string' || !this.allowed(claims.iss)) throw new Error();
      issuer = claims.iss;
    } catch {
      throw new InvalidCredentials('malformed access token');
    }

    const payload = await this.verifyToken(token, issuer, now, fetch);
    const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!audiences.includes('solid')) throw new InvalidCredentials('token audience lacks "solid"');
    const webid = payload.webid;
    if (typeof webid !== 'string' || !this.allowed(webid)) throw new InvalidCredentials('token has no webid');
    const jkt = (payload.cnf as { jkt?: unknown } | undefined)?.jkt;
    if (typeof jkt !== 'string') throw new InvalidCredentials('token is not DPoP-bound');

    const proof = await this.verifyProof(request, token, now);
    if (proof.jkt !== jkt) throw new InvalidCredentials('DPoP key does not match the token');

    if (!(await this.issuersOf(webid, fetch)).some((i) => sameIssuer(i, issuer))) {
      throw new InvalidCredentials('the WebID does not name the token issuer');
    }
    const clientId = typeof payload.client_id === 'string' ? payload.client_id : typeof payload.azp === 'string' ? payload.azp : null;
    return { webid, issuer, clientId, jti: proof.jti, jtiExpires: proof.iat + PROOF_WINDOW_S };
  }

  private async verifyToken(token: string, issuer: string, now: Date, fetch: Fetch): Promise<JWTPayload> {
    const attempt = async (fresh: boolean) =>
      (await jwtVerify(token, await this.keysOf(issuer, fresh, fetch), { issuer, algorithms: SIGNING_ALGORITHMS, currentDate: now, clockTolerance: 30, requiredClaims: ['exp'] }))
        .payload;
    try {
      return await attempt(false);
    } catch (e) {
      // A key we have not seen may be a rotation: refetch the set, unless it was fetched just now.
      if (e instanceof errors.JWKSNoMatchingKey) {
        try {
          return await attempt(true);
        } catch (again) {
          if (again instanceof InvalidCredentials) throw again;
          throw new InvalidCredentials(`access token: ${(again as Error).message}`);
        }
      }
      if (e instanceof InvalidCredentials) throw e;
      throw new InvalidCredentials(`access token: ${(e as Error).message}`);
    }
  }

  private async verifyProof(request: AuthRequest, token: string, now: Date): Promise<VerifiedProof> {
    try {
      return await verifyDpopProof(request.dpop!, { method: request.method, url: request.url, nowS: now.getTime() / 1000, accessToken: token });
    } catch (e) {
      if (e instanceof InvalidDpopProof) throw new InvalidCredentials(`DPoP proof: ${e.message}`);
      throw e;
    }
  }

  private async keysOf(issuer: string, fresh: boolean, fetch: Fetch): Promise<JWTVerifyGetKey> {
    const hit = this.keys.get(issuer);
    if (hit && this.deps.now() - hit.at < (fresh ? RETRY_MS : CACHE_MS)) return hit.value;
    return this.orRemembered(`issuer ${issuer}`, async () => {
      const config = await this.fetchJson(`${issuer.replace(/\/$/u, '')}/.well-known/openid-configuration`, fetch, UNREACHABLE_ISSUER);
      if (!sameIssuer(String(config.issuer), issuer) || typeof config.jwks_uri !== 'string') {
        throw new InvalidCredentials('the token issuer has no usable OpenID configuration');
      }
      const jwks = await this.fetchJson(config.jwks_uri, fetch, UNREACHABLE_ISSUER);
      if (!Array.isArray(jwks.keys) || jwks.keys.length > JWKS_KEYS) throw new InvalidCredentials('the token issuer publishes an unusable key set');
      const set = createLocalJWKSet(jwks as never);
      remember(this.keys, issuer, { at: this.deps.now(), value: set });
      return set;
    });
  }

  /** The issuers a WebID document trusts (`solid:oidcIssuer`). */
  private async issuersOf(webid: string, fetch: Fetch): Promise<string[]> {
    const hit = this.webids.get(webid);
    if (hit && this.deps.now() - hit.at < CACHE_MS) return hit.value;
    return this.orRemembered(`webid ${webid}`, async () => {
      const doc = webid.split('#')[0]!;
      const res = await this.get(doc, 'text/turtle', fetch, UNREADABLE_PROFILE, WEBID_REDIRECTS);
      const text = await limitedText(res, FETCH_LIMIT, () => new InvalidCredentials(UNREADABLE_PROFILE, 'larger than the limit'));
      const quads = await parseRdf(text, res.headers.get('Content-Type') ?? 'text/turtle', doc).catch(() => {
        throw new InvalidCredentials(UNREADABLE_PROFILE, 'does not parse');
      });
      const issuers = quads.filter((q) => q.subject.value === webid && q.predicate.value === SOLID('oidcIssuer')).map((q) => q.object.value);
      remember(this.webids, webid, { at: this.deps.now(), value: issuers });
      return issuers;
    });
  }

  /** Runs a lookup, answering with its last failure while that is recent. */
  private async orRemembered<T>(key: string, lookup: () => Promise<T>): Promise<T> {
    const failed = this.failures.get(key);
    if (failed && this.deps.now() - failed.at < RETRY_MS) throw failed.value;
    try {
      const value = await lookup();
      this.failures.delete(key);
      return value;
    } catch (e) {
      if (e instanceof InvalidCredentials) remember(this.failures, key, { at: this.deps.now(), value: e });
      throw e;
    }
  }

  private async fetchJson(url: string, fetch: Fetch, refusal: string): Promise<Record<string, unknown>> {
    const res = await this.get(url, 'application/json', fetch, refusal, 0);
    try {
      return JSON.parse(await limitedText(res, FETCH_LIMIT, () => new InvalidCredentials(refusal, `${originOf(url)}: larger than the limit`))) as Record<string, unknown>;
    } catch (e) {
      if (e instanceof InvalidCredentials) throw e;
      throw new InvalidCredentials(refusal, `${originOf(url)}: not JSON`);
    }
  }

  /** Fetches `url`, following up to `redirects` redirects to URLs as acceptable as the first. */
  private async get(url: string, accept: string, fetch: Fetch, refusal: string, redirects: number): Promise<Response> {
    if (!this.allowed(url)) throw new InvalidCredentials(refusal, `${originOf(url)}: not a URL to fetch`);
    let res: Response;
    try {
      res = await fetch(url, { headers: { Accept: accept }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: 'manual' });
    } catch (e) {
      throw new InvalidCredentials(refusal, `${originOf(url)}: ${(e as Error).message}`);
    }
    const next = res.status >= 300 && res.status < 400 ? res.headers.get('Location') : null;
    if (next !== null) {
      await res.body?.cancel();
      if (redirects === 0 || !URL.canParse(next, url)) throw new InvalidCredentials(refusal, `${originOf(url)}: redirect not followed`);
      return this.get(new URL(next, url).toString(), accept, fetch, refusal, redirects - 1);
    }
    if (!res.ok) throw new InvalidCredentials(refusal, `${originOf(url)}: HTTP ${res.status}`);
    return res;
  }

  /** Whether a URL the caller chose may be fetched: https on a named host. */
  private allowed(url: string): boolean {
    if (!URL.canParse(url)) return false;
    const { protocol, hostname, username, password } = new URL(url);
    if (this.deps.insecure) return protocol === 'https:' || protocol === 'http:';
    return protocol === 'https:' && username === '' && password === '' && !isAddress(hostname);
  }
}

/** An IP literal or a loopback name: never where an issuer or a profile lives. */
function isAddress(hostname: string): boolean {
  return /^\d+(\.\d+){3}$/u.test(hostname) || hostname.startsWith('[') || hostname === 'localhost' || hostname.endsWith('.localhost');
}

/** For the log: where a lookup went, without the path, which may name a person. */
function originOf(url: string): string {
  return URL.canParse(url) ? new URL(url).origin : '(not a URL)';
}

/** Caches an entry, dropping the oldest once the cache is full. */
function remember<T>(cache: Map<string, T>, key: string, value: T): void {
  cache.delete(key);
  if (cache.size >= CACHE_ENTRIES) cache.delete(cache.keys().next().value!);
  cache.set(key, value);
}

function sameIssuer(a: string, b: string): boolean {
  return a.replace(/\/$/u, '') === b.replace(/\/$/u, '');
}
