// A DPoP proof on its own (RFC 9449), as the token endpoint receives it:
// no access token yet, so no `ath` and no `cnf` to compare against.

import { EmbeddedJWK, calculateJwkThumbprint, jwtVerify } from 'jose';
import { OidcError } from '../../domain/identity/oidc.js';

const ALGORITHMS = ['ES256', 'ES384', 'PS256', 'RS256', 'EdDSA'];
const WINDOW_S = 300;

export async function verifyDpopProof(proof: string | null, method: string, url: string, nowS: number): Promise<{ jkt: string; jti: string }> {
  if (!proof) throw new OidcError('invalid_dpop_proof', 'a DPoP proof is required');
  let payload;
  let jwk;
  try {
    const verified = await jwtVerify(proof, EmbeddedJWK, { typ: 'dpop+jwt', algorithms: ALGORITHMS, currentDate: new Date(nowS * 1000) });
    payload = verified.payload;
    jwk = verified.protectedHeader.jwk!;
  } catch (e) {
    throw new OidcError('invalid_dpop_proof', (e as Error).message);
  }
  const strip = (u: string) => {
    const x = new URL(u);
    return `${x.origin}${x.pathname}`;
  };
  if (payload.htm !== method) throw new OidcError('invalid_dpop_proof', 'htm does not match');
  if (typeof payload.htu !== 'string' || strip(payload.htu) !== strip(url)) throw new OidcError('invalid_dpop_proof', 'htu does not match');
  if (typeof payload.iat !== 'number' || Math.abs(nowS - payload.iat) > WINDOW_S) throw new OidcError('invalid_dpop_proof', 'proof is stale');
  if (typeof payload.jti !== 'string' || !payload.jti) throw new OidcError('invalid_dpop_proof', 'proof has no jti');
  return { jkt: await calculateJwkThumbprint(jwk, 'sha256'), jti: payload.jti };
}
