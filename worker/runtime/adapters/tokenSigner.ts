// The provider's signing key: one ES256 JWK from the OIDC_SIGNING_JWK secret.

import { type JWK, SignJWT, calculateJwkThumbprint, exportJWK, generateKeyPair, importJWK } from 'jose';

export interface Signer {
  sign(claims: Record<string, unknown>): Promise<string>;
  jwks(): { keys: JWK[] };
}

export async function signerFromJwk(privateJwk: JWK): Promise<Signer> {
  const key = await importJWK(privateJwk, 'ES256');
  const { d: _d, ...publicJwk } = privateJwk;
  const kid = privateJwk.kid ?? (await calculateJwkThumbprint(publicJwk, 'sha256'));
  const published: JWK = { ...publicJwk, kid, alg: 'ES256', use: 'sig' };
  return {
    sign: (claims) => new SignJWT(claims).setProtectedHeader({ alg: 'ES256', kid, typ: 'JWT' }).sign(key),
    jwks: () => ({ keys: [published] }),
  };
}

/** A fresh private JWK, for `make .dev.vars` and tests. */
export async function newSigningJwk(): Promise<JWK> {
  const { privateKey } = await generateKeyPair('ES256', { extractable: true });
  return exportJWK(privateKey);
}
