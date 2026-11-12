import { SignJWT, base64url, calculateJwkThumbprint, exportJWK, generateKeyPair } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { InvalidCredentials, SolidOidcVerifier } from '../runtime/adapters/solidOidcVerifier.js';

const ISS = 'https://idp.example/';
const WEBID = 'https://alice.example/profile/card#me';
const URL_ = 'https://alice.example/notes/a.ttl';
const NOW = 1_800_000_000_000;
const MINUTE = 60_000;

type Keys = Awaited<ReturnType<typeof generateKeyPair>>;
let issuerKeys: Keys;
let clientKeys: Keys;
let otherKeys: Keys;
let jwks: { keys: object[] };
let profile: string;
let discoveryIssuer: string;
let fetches: string[];

beforeAll(async () => {
  issuerKeys = await generateKeyPair('ES256', { extractable: true });
  clientKeys = await generateKeyPair('ES256', { extractable: true });
  otherKeys = await generateKeyPair('ES256', { extractable: true });
});

function reset() {
  fetches = [];
  redirects = {};
  discoveryIssuer = ISS;
  profile = `<${WEBID}> <http://www.w3.org/ns/solid/terms#oidcIssuer> <${ISS}>.`;
}

async function publish(keys: Keys, kid: string) {
  jwks = { keys: [{ ...(await exportJWK(keys.publicKey)), kid, alg: 'ES256' }] };
}

let redirects: Record<string, string>;

const fakeFetch = async (url: string) => {
  fetches.push(url);
  if (redirects[url]) return new Response(null, { status: 302, headers: { Location: redirects[url]! } });
  const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { 'Content-Type': 'application/json' } });
  if (url === 'https://idp.example/.well-known/openid-configuration') return json({ issuer: discoveryIssuer, jwks_uri: 'https://idp.example/jwks' });
  if (url === 'https://idp.example/jwks') return json(jwks);
  if (url === 'https://alice.example/profile/card') return new Response(profile, { headers: { 'Content-Type': 'text/turtle' } });
  return new Response('nope', { status: 404 });
};

const verifier = () => {
  const v = new SolidOidcVerifier({ now: () => NOW });
  return { verify: (request: Parameters<SolidOidcVerifier['verify']>[0]) => v.verify(request, fakeFetch) };
};

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

async function proof(over: Record<string, unknown> = {}, key = clientKeys, typ = 'dpop+jwt') {
  return new SignJWT({ htm: 'GET', htu: URL_, jti: 'j1', iat: NOW / 1000, ...over })
    .setProtectedHeader({ alg: 'ES256', typ, jwk: await exportJWK(key.publicKey) })
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

  type Make = () => Promise<{ method: string; url: string; authorization: string; dpop: string }>;
  const rejectsSaying: [string, RegExp, Make][] = [
    ['a token that never expires', /access token: .*"exp"/, async () => req(await token({ exp: undefined }), await proof())],
    [
      'a token signed with a shared secret',
      /access token: .*"alg".*not allowed/,
      async () => {
        const claims = { iss: ISS, aud: 'solid', iat: NOW / 1000, exp: NOW / 1000 + 300, webid: WEBID, cnf: { jkt: 'x' } };
        const forged = await new SignJWT(claims).setProtectedHeader({ alg: 'HS256', kid: 'k1' }).sign(new Uint8Array(32).fill(1));
        return req(forged, await proof());
      },
    ],
    [
      'an issuer whose discovery document names another issuer',
      /no usable OpenID configuration/,
      async () => {
        discoveryIssuer = 'https://other.example/';
        return req(await token(), await proof());
      },
    ],
    [
      'a profile where only another subject names the issuer',
      /does not name/,
      async () => {
        profile = `<https://alice.example/profile/card#bob> <http://www.w3.org/ns/solid/terms#oidcIssuer> <${ISS}>.`;
        return req(await token(), await proof());
      },
    ],
    ['a proof dated in the future', /DPoP proof: proof is dated in the future/, async () => req(await token(), await proof({ iat: NOW / 1000 + 600 }))],
    ['a proof typed as a plain JWT', /DPoP proof: .*"typ"/, async () => req(await token(), await proof({}, clientKeys, 'jwt'))],
  ];
  it.each(rejectsSaying)('rejects %s', async (_label, message, make) => {
    reset();
    await publish(issuerKeys, 'k1');
    const attempt = verifier().verify(await make());
    await expect(attempt).rejects.toThrow(InvalidCredentials);
    await expect(attempt).rejects.toThrow(message);
  });

  it('rejects a WebID that does not name the issuer', async () => {
    reset();
    await publish(issuerKeys, 'k1');
    profile = `<${WEBID}> <http://www.w3.org/ns/solid/terms#oidcIssuer> <https://other.example/>.`;
    await expect(verifier().verify(await req(await token(), await proof()))).rejects.toThrow(/does not name/);
  });

  it('refetches the key set for a rotated key, but not one it fetched within the minute', async () => {
    reset();
    await publish(issuerKeys, 'k1');
    let now = NOW;
    const v = new SolidOidcVerifier({ now: () => now });
    await v.verify(await req(await token(), await proof()), fakeFetch);
    const rotated = await generateKeyPair('ES256', { extractable: true });
    await publish(rotated, 'k2');
    const next = async (jti: string) => v.verify(await req(await token({}, rotated, 'k2'), await proof({ jti })), fakeFetch);
    await expect(next('j2')).rejects.toThrow(/access token: /);
    expect(fetches.filter((u) => u.endsWith('/jwks'))).toHaveLength(1);
    now += MINUTE;
    expect((await next('j3'))?.webid).toBe(WEBID);
    expect(fetches.filter((u) => u.endsWith('/jwks'))).toHaveLength(2);
  });

  it('looks things up through the fetch of the request at hand, not the first one it served', async () => {
    reset();
    await publish(issuerKeys, 'k1');
    let now = NOW;
    const v = new SolidOidcVerifier({ now: () => now });
    const unreachable = async () => new Response('', { status: 522 });
    await expect(v.verify(await req(await token(), await proof()), unreachable)).rejects.toThrow(InvalidCredentials);
    now += MINUTE;
    expect((await v.verify(await req(await token(), await proof({ jti: 'j2' })), fakeFetch))?.webid).toBe(WEBID);
  });
});

describe('lookups a caller can cause', () => {
  const failing = (answer: () => Response | Promise<Response>) => {
    const asked: string[] = [];
    return { asked, fetch: async (url: string) => (asked.push(url), answer()) };
  };

  it('tell the caller that a lookup failed, and only the log what it found', async () => {
    reset();
    const v = new SolidOidcVerifier({ now: () => NOW });
    const { fetch } = failing(() => new Response('internal words', { status: 503 }));
    const refusal = (await v.verify(await req(await token(), await proof()), fetch).catch((e: unknown) => e)) as InvalidCredentials;
    expect(refusal.message).toBe('the token issuer could not be reached');
    expect(refusal.detail).toBe('https://idp.example: HTTP 503');
  });

  it('are not repeated within a minute of failing', async () => {
    reset();
    await publish(issuerKeys, 'k1');
    let now = NOW;
    const v = new SolidOidcVerifier({ now: () => now });
    const down = failing(() => {
      throw new Error('connect failed');
    });
    for (const jti of ['a', 'b', 'c']) await expect(v.verify(await req(await token(), await proof({ jti })), down.fetch)).rejects.toThrow('the token issuer could not be reached');
    expect(down.asked).toHaveLength(1);
    // Nor does a working fetch get asked while the failure is remembered.
    await expect(v.verify(await req(await token(), await proof({ jti: 'd' })), fakeFetch)).rejects.toThrow(InvalidCredentials);
    expect(fetches).toEqual([]);
    now += MINUTE;
    expect((await v.verify(await req(await token(), await proof({ jti: 'e' })), fakeFetch))?.webid).toBe(WEBID);
  });

  it('remember an unreadable profile the same way', async () => {
    reset();
    await publish(issuerKeys, 'k1');
    profile = 'this is not turtle <';
    const v = new SolidOidcVerifier({ now: () => NOW });
    for (const jti of ['a', 'b']) await expect(v.verify(await req(await token(), await proof({ jti })), fakeFetch)).rejects.toThrow('the WebID profile could not be read');
    expect(fetches.filter((u) => u === 'https://alice.example/profile/card')).toHaveLength(1);
  });

  it('do not follow an issuer that redirects', async () => {
    reset();
    await publish(issuerKeys, 'k1');
    redirects['https://idp.example/.well-known/openid-configuration'] = 'https://internal.example/config';
    const refusal = (await verifier().verify(await req(await token(), await proof())).catch((e: unknown) => e)) as InvalidCredentials;
    expect(refusal.message).toBe('the token issuer could not be reached');
    expect(refusal.detail).toMatch(/redirect not followed/u);
    expect(fetches).toEqual(['https://idp.example/.well-known/openid-configuration']);
  });

  it('follow a profile that moved, a few hops and only to https', async () => {
    reset();
    await publish(issuerKeys, 'k1');
    redirects['https://alice.example/profile/card'] = '/moved/card';
    redirects['https://alice.example/moved/card'] = 'https://elsewhere.example/card';
    const elsewhere = async (url: string) => (url === 'https://elsewhere.example/card' ? (fetches.push(url), new Response(profile, { headers: { 'Content-Type': 'text/turtle' } })) : fakeFetch(url));
    const v = new SolidOidcVerifier({ now: () => NOW });
    expect((await v.verify(await req(await token(), await proof()), elsewhere))?.webid).toBe(WEBID);

    for (const target of ['http://alice.example/plain', 'https://127.0.0.1/card', 'https://localhost/card', 'https://[::1]/card']) {
      reset();
      redirects['https://alice.example/profile/card'] = target;
      await expect(verifier().verify(await req(await token(), await proof()))).rejects.toThrow('the WebID profile could not be read');
      expect(fetches).not.toContain(target);
    }

    reset();
    for (let i = 0; i < 5; i++) redirects[i === 0 ? 'https://alice.example/profile/card' : `https://alice.example/hop${i}`] = `https://alice.example/hop${i + 1}`;
    await expect(verifier().verify(await req(await token(), await proof()))).rejects.toThrow('the WebID profile could not be read');
    expect(fetches.filter((u) => u.includes('/hop'))).toHaveLength(3);
  });

  it('never go to plain http or to an address, for an issuer or a WebID', async () => {
    reset();
    await publish(issuerKeys, 'k1');
    for (const iss of ['http://idp.example/', 'https://10.0.0.1/', 'https://localhost/', 'https://user:pw@idp.example/']) {
      await expect(verifier().verify(await req(await token({ iss }), await proof()))).rejects.toThrow('malformed access token');
    }
    await expect(verifier().verify(await req(await token({ webid: 'http://alice.example/profile/card#me' }), await proof()))).rejects.toThrow('token has no webid');
    expect(fetches.filter((u) => !u.startsWith('https://idp.example/'))).toEqual([]);
  });

  it('go to plain http in local development', async () => {
    reset();
    const { publicKey } = issuerKeys;
    const local = async (url: string) => {
      const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { 'Content-Type': 'application/json' } });
      if (url === 'http://localhost:8787/.well-known/openid-configuration') return json({ issuer: 'http://localhost:8787/', jwks_uri: 'http://localhost:8787/jwks' });
      if (url === 'http://localhost:8787/jwks') return json({ keys: [{ ...(await exportJWK(publicKey)), kid: 'k1', alg: 'ES256' }] });
      return new Response('<http://sam.localhost:8787/profile/card#me> <http://www.w3.org/ns/solid/terms#oidcIssuer> <http://localhost:8787/>.', { headers: { 'Content-Type': 'text/turtle' } });
    };
    const v = new SolidOidcVerifier({ now: () => NOW, insecure: true });
    const t = await token({ iss: 'http://localhost:8787/', webid: 'http://sam.localhost:8787/profile/card#me' });
    expect((await v.verify(await req(t, await proof()), local))?.issuer).toBe('http://localhost:8787/');
  });
});
