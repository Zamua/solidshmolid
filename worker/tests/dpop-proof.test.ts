import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { describe, expect, it } from 'vitest';
import { discovery } from '../domain/identity/oidc.js';
import { InvalidDpopProof, verifyDpopProof } from '../runtime/adapters/dpopProof.js';

const URL_ = 'https://alice.example/notes/a.ttl';
const NOW_S = 1_800_000_000;
const at = { method: 'GET', url: URL_, nowS: NOW_S };

async function proof(alg: string, over: Record<string, unknown> = {}) {
  const k = await generateKeyPair(alg, { extractable: true, ...(alg === 'EdDSA' ? { crv: 'Ed25519' } : {}) });
  return new SignJWT({ htm: 'GET', htu: URL_, jti: 'j1', iat: NOW_S, ...over })
    .setProtectedHeader({ alg, typ: 'dpop+jwt', jwk: await exportJWK(k.publicKey) })
    .sign(k.privateKey);
}

describe('DPoP proofs', () => {
  it('verifies a proof in every algorithm discovery advertises', async () => {
    const algs = discovery('https://idp.example/').dpop_signing_alg_values_supported as string[];
    for (const alg of algs) expect((await verifyDpopProof(await proof(alg), at)).jti).toBe('j1');
  });

  it('refuses an htu that is not a URL as a bad proof', async () => {
    await expect(verifyDpopProof(await proof('ES256', { htu: 'not a url' }), at)).rejects.toThrow(InvalidDpopProof);
  });

  it('checks ath only against an access token sent beside the proof', async () => {
    const p = await proof('ES256', { ath: 'AAAA' });
    await expect(verifyDpopProof(p, at)).resolves.toMatchObject({ jti: 'j1' });
    await expect(verifyDpopProof(p, { ...at, accessToken: 'a.b.c' })).rejects.toThrow(InvalidDpopProof);
  });
});
