// A DPoP proof (RFC 9449), as the token endpoint and the resource server both
// receive it. Only a resource request carries an access token for `ath` to bind.

import { EmbeddedJWK, type JWTPayload, calculateJwkThumbprint, jwtVerify } from 'jose';
import { SIGNING_ALGORITHMS } from '../../domain/identity/oidc.js';
import { base64url } from '../../domain/shared/base64url.js';

/** How far a proof's `iat` may sit from our clock. */
export const PROOF_WINDOW_S = 300;

export class InvalidDpopProof extends Error {}

export interface ProofContext {
  method: string;
  url: string;
  nowS: number;
  /** The access token sent beside the proof, at a resource. */
  accessToken?: string;
}

export interface VerifiedProof {
  /** The thumbprint of the key that signed the proof. */
  jkt: string;
  jti: string;
  iat: number;
}

export async function verifyDpopProof(proof: string, context: ProofContext): Promise<VerifiedProof> {
  let payload: JWTPayload;
  let jwk;
  try {
    const verified = await jwtVerify(proof, EmbeddedJWK, { typ: 'dpop+jwt', algorithms: SIGNING_ALGORITHMS, currentDate: new Date(context.nowS * 1000) });
    payload = verified.payload;
    jwk = verified.protectedHeader.jwk!;
  } catch (e) {
    throw new InvalidDpopProof((e as Error).message);
  }
  if (payload.htm !== context.method) throw new InvalidDpopProof('htm does not match the method');
  if (typeof payload.htu !== 'string' || withoutQuery(payload.htu) !== withoutQuery(context.url)) throw new InvalidDpopProof('htu does not match the URL');
  const { iat, jti } = payload;
  if (typeof iat !== 'number' || Math.abs(context.nowS - iat) > PROOF_WINDOW_S) throw new InvalidDpopProof('proof is stale');
  if (typeof jti !== 'string' || jti === '') throw new InvalidDpopProof('proof has no jti');
  // RFC 9449 requires ath at a resource, but Solid clients predating it omit
  // it and CSS's verifier accepts them; one that is sent must match.
  if (context.accessToken !== undefined && payload.ath !== undefined && payload.ath !== (await tokenHash(context.accessToken))) {
    throw new InvalidDpopProof('ath does not match the token');
  }
  return { jkt: await calculateJwkThumbprint(jwk, 'sha256'), jti, iat };
}

async function tokenHash(token: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))));
}

function withoutQuery(url: string): string | null {
  if (!URL.canParse(url)) return null;
  const u = new URL(url);
  return `${u.origin}${u.pathname}`;
}
