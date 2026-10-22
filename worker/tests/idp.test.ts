// Tokens from a real Solid identity provider: a stock Community Solid Server
// issues a DPoP-bound access token by client credentials, and our verifier
// accepts it. Needs COMPAT_CSS_BIN, as compat.test.ts does.

import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InvalidCredentials, SolidOidcVerifier } from '../runtime/auth/solidOidc.js';
import { CSS_BIN, type RunningCss, type SolidSession, signUp, startCss } from './support/css.js';

describe.skipIf(!CSS_BIN)('a CSS-issued token', () => {
  let css: RunningCss;
  let session: SolidSession;
  const url = 'https://alice.solidshmolid.example/notes/a.ttl';
  const verifier = () => new SolidOidcVerifier({ fetch: (u, i) => fetch(u, i), now: () => Date.now() });

  beforeAll(async () => {
    css = await startCss(['-c', '@css:config/default.json'], '.account/');
    session = await signUp(css.base, 'alice');
  }, 90_000);

  afterAll(() => css?.stop());

  it('verifies to the WebID CSS issued it for', async () => {
    const agent = await verifier().verify({
      method: 'GET',
      url,
      authorization: `DPoP ${session.accessToken}`,
      dpop: await session.proof('GET', url),
    });
    expect(agent?.webid).toBe(session.webid);
    expect(agent?.issuer.replace(/\/$/u, '')).toBe(css.base.replace(/\/$/u, ''));
  });

  it('refuses the same token behind a proof from another key', async () => {
    const other = await generateKeyPair('ES256', { extractable: true });
    const forged = await new SignJWT({ htm: 'GET', htu: url, jti: 'x', iat: Math.floor(Date.now() / 1000) })
      .setProtectedHeader({ alg: 'ES256', typ: 'dpop+jwt', jwk: await exportJWK(other.publicKey) })
      .sign(other.privateKey);
    await expect(
      verifier().verify({ method: 'GET', url, authorization: `DPoP ${session.accessToken}`, dpop: forged }),
    ).rejects.toThrow(InvalidCredentials);
  });
});
