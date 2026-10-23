// The resource-server side of Solid-OIDC: turns `Authorization: DPoP <token>`
// plus a `DPoP` proof into a verified WebID.
//
// Every URL fetched here (the issuer, its JWKS, the WebID document) is chosen
// by whoever sent the request, so each fetch is time-boxed, size-capped and
// cached.

import {
  EmbeddedJWK,
  type JWTPayload,
  type JWTVerifyGetKey,
  base64url,
  calculateJwkThumbprint,
  createLocalJWKSet,
  decodeJwt,
  errors,
  jwtVerify,
} from 'jose';
import { parseRdf } from '../../domain/shared/rdf.js';
import { SOLID } from '../../domain/shared/vocab.js';

export class InvalidCredentials extends Error {}

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
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  /** Milliseconds since the epoch. */
  now: () => number;
}

const ALGORITHMS = ['ES256', 'ES384', 'ES512', 'PS256', 'PS384', 'PS512', 'RS256', 'RS384', 'RS512', 'EdDSA'];
/** How far a proof's `iat` may sit from our clock. */
export const PROOF_WINDOW_S = 300;
const CACHE_MS = 5 * 60_000;
const FETCH_TIMEOUT_MS = 5_000;
const FETCH_LIMIT = 256 * 1024;

interface Cached<T> {
  at: number;
  value: T;
}

export class SolidOidcVerifier {
  private readonly keys = new Map<string, Cached<JWTVerifyGetKey>>();
  private readonly webids = new Map<string, Cached<string[]>>();

  constructor(private readonly deps: VerifierDeps) {}

  /** The verified agent, or null for a request without credentials. */
  async verify(request: AuthRequest): Promise<VerifiedAgent | null> {
    if (!request.authorization) return null;
    const m = /^DPoP\s+([\w-]+\.[\w-]+\.[\w-]+)$/iu.exec(request.authorization.trim());
    if (!m) throw new InvalidCredentials('expected a DPoP-bound access token');
    if (!request.dpop) throw new InvalidCredentials('missing DPoP proof');
    const token = m[1]!;
    const now = new Date(this.deps.now());

    let issuer: string;
    try {
      const claims = decodeJwt(token);
      if (typeof claims.iss !== 'string' || !/^https?:\/\//u.test(claims.iss)) throw new Error();
      issuer = claims.iss;
    } catch {
      throw new InvalidCredentials('malformed access token');
    }

    const payload = await this.verifyToken(token, issuer, now);
    const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!audiences.includes('solid')) throw new InvalidCredentials('token audience lacks "solid"');
    const webid = payload.webid;
    if (typeof webid !== 'string' || !/^https?:\/\//u.test(webid)) throw new InvalidCredentials('token has no webid');
    const jkt = (payload.cnf as { jkt?: unknown } | undefined)?.jkt;
    if (typeof jkt !== 'string') throw new InvalidCredentials('token is not DPoP-bound');

    const proof = await this.verifyProof(request, token, jkt, now);

    if (!(await this.issuersOf(webid)).some((i) => sameIssuer(i, issuer))) {
      throw new InvalidCredentials(`${webid} does not name ${issuer} as its issuer`);
    }
    const clientId = typeof payload.client_id === 'string' ? payload.client_id : typeof payload.azp === 'string' ? payload.azp : null;
    return { webid, issuer, clientId, jti: proof.jti, jtiExpires: proof.iat + PROOF_WINDOW_S };
  }

  private async verifyToken(token: string, issuer: string, now: Date): Promise<JWTPayload> {
    const attempt = async (fresh: boolean) =>
      (await jwtVerify(token, await this.keysOf(issuer, fresh), { issuer, algorithms: ALGORITHMS, currentDate: now, clockTolerance: 30 }))
        .payload;
    try {
      return await attempt(false);
    } catch (e) {
      // A key we have not seen may be a rotation: refetch the set once.
      if (e instanceof errors.JWKSNoMatchingKey) {
        try {
          return await attempt(true);
        } catch (again) {
          throw new InvalidCredentials(`access token: ${(again as Error).message}`);
        }
      }
      if (e instanceof InvalidCredentials) throw e;
      throw new InvalidCredentials(`access token: ${(e as Error).message}`);
    }
  }

  private async verifyProof(request: AuthRequest, token: string, jkt: string, now: Date): Promise<{ jti: string; iat: number }> {
    let payload: JWTPayload;
    let jwk;
    try {
      const verified = await jwtVerify(request.dpop!, EmbeddedJWK, { typ: 'dpop+jwt', algorithms: ALGORITHMS, currentDate: now });
      payload = verified.payload;
      jwk = verified.protectedHeader.jwk!;
    } catch (e) {
      throw new InvalidCredentials(`DPoP proof: ${(e as Error).message}`);
    }
    if ((await calculateJwkThumbprint(jwk, 'sha256')) !== jkt) throw new InvalidCredentials('DPoP key does not match the token');
    if (payload.htm !== request.method) throw new InvalidCredentials('DPoP htm does not match the method');
    if (typeof payload.htu !== 'string' || stripQuery(payload.htu) !== stripQuery(request.url)) {
      throw new InvalidCredentials('DPoP htu does not match the URL');
    }
    const iat = payload.iat;
    if (typeof iat !== 'number' || Math.abs(now.getTime() / 1000 - iat) > PROOF_WINDOW_S) {
      throw new InvalidCredentials('DPoP proof is stale');
    }
    if (typeof payload.jti !== 'string' || payload.jti === '') throw new InvalidCredentials('DPoP proof has no jti');
    if (payload.ath !== undefined) {
      const ath = base64url.encode(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))));
      if (payload.ath !== ath) throw new InvalidCredentials('DPoP ath does not match the token');
    }
    return { jti: payload.jti, iat };
  }

  private async keysOf(issuer: string, fresh: boolean): Promise<JWTVerifyGetKey> {
    const hit = this.keys.get(issuer);
    if (hit && !fresh && this.deps.now() - hit.at < CACHE_MS) return hit.value;
    const config = await this.fetchJson(`${issuer.replace(/\/$/u, '')}/.well-known/openid-configuration`);
    if (!sameIssuer(String(config.issuer), issuer) || typeof config.jwks_uri !== 'string') {
      throw new InvalidCredentials(`${issuer} has no usable OpenID configuration`);
    }
    const set = createLocalJWKSet((await this.fetchJson(config.jwks_uri)) as never);
    this.keys.set(issuer, { at: this.deps.now(), value: set });
    return set;
  }

  /** The issuers a WebID document trusts (`solid:oidcIssuer`). */
  private async issuersOf(webid: string): Promise<string[]> {
    const hit = this.webids.get(webid);
    if (hit && this.deps.now() - hit.at < CACHE_MS) return hit.value;
    const doc = webid.split('#')[0]!;
    const res = await this.get(doc, 'text/turtle');
    const quads = await parseRdf(await limitedText(res), res.headers.get('Content-Type') ?? 'text/turtle', doc).catch(() => {
      throw new InvalidCredentials(`${webid}: profile does not parse`);
    });
    const issuers = quads.filter((q) => q.subject.value === webid && q.predicate.value === SOLID('oidcIssuer')).map((q) => q.object.value);
    this.webids.set(webid, { at: this.deps.now(), value: issuers });
    return issuers;
  }

  private async fetchJson(url: string): Promise<Record<string, unknown>> {
    const res = await this.get(url, 'application/json');
    try {
      return JSON.parse(await limitedText(res)) as Record<string, unknown>;
    } catch {
      throw new InvalidCredentials(`${url} is not JSON`);
    }
  }

  private async get(url: string, accept: string): Promise<Response> {
    if (!/^https?:\/\//u.test(url)) throw new InvalidCredentials(`${url} is not an http(s) URL`);
    let res: Response;
    try {
      res = await this.deps.fetch(url, { headers: { Accept: accept }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: 'follow' });
    } catch (e) {
      throw new InvalidCredentials(`${url}: ${(e as Error).message}`);
    }
    if (!res.ok) throw new InvalidCredentials(`${url}: HTTP ${res.status}`);
    return res;
  }
}

async function limitedText(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > FETCH_LIMIT) {
      await reader.cancel();
      throw new InvalidCredentials(`${res.url} is larger than ${FETCH_LIMIT} bytes`);
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(await new Blob(chunks).arrayBuffer());
}

function stripQuery(url: string): string {
  const u = new URL(url);
  return `${u.origin}${u.pathname}`;
}

function sameIssuer(a: string, b: string): boolean {
  return a.replace(/\/$/u, '') === b.replace(/\/$/u, '');
}
