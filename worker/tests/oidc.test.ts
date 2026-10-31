import { SignJWT, base64url, calculateJwkThumbprint, exportJWK, generateKeyPair } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { InvalidCredentials, SolidOidcVerifier } from '../runtime/adapters/solidOidcVerifier.js';

const ISS = 'https://idp.example/';
const WEBID = 'https://alice.example/profile/card#me';
const URL_ = 'https://alice.example/notes/a.ttl';
const NOW = 1_800_000_000_000;

type Keys = Awaited<ReturnType<typeof generateKeyPair>>;
let issuerKeys: Keys;
let clientKeys: Keys;
let otherKeys: Keys;
let jwks: { keys: object[] };
let profile: string;
let fetches: string[];

beforeAll(async () => {
  issuerKeys = await generateKeyPair('ES256', { extractable: true });
  clientKeys = await generateKeyPair('ES256', { extractable: true });
  otherKeys = await generateKeyPair('ES256', { extractable: true });
});

function reset() {
  fetches = [];
  profile = `<${WEBID}> <http://www.w3.org/ns/solid/terms#oidcIssuer> <${ISS}>.`;
}

async function publish(keys: Keys, kid: string) {
  jwks = { keys: [{ ...(await exportJWK(keys.publicKey)), kid, alg: 'ES256' }] };
}

const fakeFetch = async (url: string) => {
  fetches.push(url);
  const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { 'Content-Type': 'application/json' } });
  if (url === 'https://idp.example/.well-known/openid-configuration') return json({ issuer: ISS, jwks_uri: 'https://idp.example/jwks' });
  if (url === 'https://idp.example/jwks') return json(jwks);
  if (url === 'https://alice.example/profile/card') return new Response(profile, { headers: { 'Content-Type': 'text/turtle' } });
  return new Response('nope', { status: 404 });
};

const verifier = () => new SolidOidcVerifier({ fetch: fakeFetch, now: () => NOW });

async function token(over: Record<string, unknown> = {}, signer = issuerKeys, kid = 'k1') {
  const jkt = await calculateJwkThumbprint(await exportJWK(clientKeys.publicKey), 'sha256');
  const claims = {
    iss: ISS,
    aud: ['solid', 'https://app.example/id'],
    iat: NOW / 1000,
    exp: NOW / 1000 + 300,
    webid: WEBID,
    client_id: 'https://app.example/id',
    cnf: { jkt },
    ...over,
  };
  return new SignJWT(claims).setProtectedHeader({ alg: 'ES256', kid }).sign(signer.privateKey);
}

async function proof(over: Record<string, unknown> = {}, key = clientKeys) {
  return new SignJWT({ htm: 'GET', htu: URL_, jti: 'j1', iat: NOW / 1000, ...over })
    .setProtectedHeader({ alg: 'ES256', typ: 'dpop+jwt', jwk: await exportJWK(key.publicKey) })
    .sign(key.privateKey);
}

const req = async (t: string, p: string, method = 'GET', url = URL_) => ({ method, url, authorization: `DPoP ${t}`, dpop: p });

describe('Solid-OIDC verification', () => {
  it('returns the WebID for a valid token and proof', async () => {
    reset();
    await publish(issuerKeys, 'k1');
    const t = await token();
    const ath = base64url.encode(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t))));
    const agent = await verifier().verify(await req(t, await proof({ ath })));
    expect(agent).toMatchObject({ webid: WEBID, issuer: ISS, clientId: 'https://app.example/id', jti: 'j1', jtiExpires: NOW / 1000 + 300 });
  });

  it('treats a request without Authorization as anonymous', async () => {
    reset();
    expect(await verifier().verify({ method: 'GET', url: URL_, authorization: null, dpop: null })).toBeNull();
  });

  it('accepts a proof without ath, as Community Solid Server does', async () => {
    reset();
    await publish(issuerKeys, 'k1');
    expect((await verifier().verify(await req(await token(), await proof())))?.webid).toBe(WEBID);
  });

  it('ignores the query string when matching htu', async () => {
    reset();
    await publish(issuerKeys, 'k1');
    const agent = await verifier().verify(await req(await token(), await proof(), 'GET', `${URL_}?x=1`));
    expect(agent?.webid).toBe(WEBID);
  });

  const rejects: [string, () => Promise<{ method: string; url: string; authorization: string; dpop: string }>][] = [
    ['a bearer token', async () => ({ ...(await req(await token(), await proof())), authorization: `Bearer ${await token()}` })],
    ['a proof signed by another key', async () => req(await token(), await proof({}, otherKeys))],
    ['the wrong method', async () => req(await token(), await proof({ htm: 'PUT' }))],
    ['the wrong URL', async () => req(await token(), await proof({ htu: 'https://mallory.example/notes/a.ttl' }))],
    ['an htu that is not a URL', async () => req(await token(), await proof({ htu: 'not a url' }))],
    ['a stale proof', async () => req(await token(), await proof({ iat: NOW / 1000 - 600 }))],
    ['a proof without jti', async () => req(await token(), await proof({ jti: '' }))],
    ['an ath for another token', async () => req(await token(), await proof({ ath: 'AAAA' }))],
    ['an audience without solid', async () => req(await token({ aud: 'https://app.example/id' }), await proof())],
    ['an expired token', async () => req(await token({ exp: NOW / 1000 - 60 }), await proof())],
    ['a token from a key the issuer never published', async () => req(await token({}, otherKeys, 'k9'), await proof())],
    ['a token with no cnf', async () => req(await token({ cnf: undefined }), await proof())],
  ];
  it.each(rejects)('rejects %s', async (_label, make) => {
    reset();
    await publish(issuerKeys, 'k1');
    await expect(verifier().verify(await make())).rejects.toThrow(InvalidCredentials);
  });

  it('rejects a WebID that does not name the issuer', async () => {
    reset();
    await publish(issuerKeys, 'k1');
    profile = `<${WEBID}> <http://www.w3.org/ns/solid/terms#oidcIssuer> <https://other.example/>.`;
    await expect(verifier().verify(await req(await token(), await proof()))).rejects.toThrow(/does not name/);
  });

  it('refetches the key set once for a rotated key', async () => {
    reset();
    await publish(issuerKeys, 'k1');
    const v = verifier();
    await v.verify(await req(await token(), await proof()));
    const rotated = await generateKeyPair('ES256', { extractable: true });
    await publish(rotated, 'k2');
    const agent = await v.verify(await req(await token({}, rotated, 'k2'), await proof({ jti: 'j2' })));
    expect(agent?.webid).toBe(WEBID);
    expect(fetches.filter((u) => u.endsWith('/jwks'))).toHaveLength(2);
  });
});
