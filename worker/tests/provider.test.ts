import { SignJWT, calculateJwkThumbprint, exportJWK, generateKeyPair } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { Provider } from '../app/identity/provider.js';
import { OidcError, PUBLIC_CLIENT, clientFromDocument, publicClient } from '../domain/identity/oidc.js';
import { SqlAccountStore } from '../runtime/adapters/sqlAccountStore.js';
import { SolidOidcVerifier } from '../runtime/adapters/solidOidcVerifier.js';
import { newSigningJwk, signerFromJwk, type Signer } from '../runtime/adapters/tokenSigner.js';
import { sqlRunner } from './support/fakes.js';

const ISSUER = 'https://idp.example/';
const WEBID = 'https://sam.idp.example/profile/card#me';
const CLIENT = 'https://app.example/id';
const REDIRECT = 'https://app.example/cb';
const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';

let signer: Signer;
beforeAll(async () => {
  signer = await signerFromJwk(await newSigningJwk());
});

type Keys = Awaited<ReturnType<typeof generateKeyPair>>;
const thumb = async (k: Keys) => calculateJwkThumbprint(await exportJWK(k.publicKey), 'sha256');

function world() {
  let clock = 1_800_000_000;
  let n = 0;
  const accounts = new Map<string, SqlAccountStore>();
  const byKey = new Map<string, SqlAccountStore>();
  const accountFor = async (person: string) => {
    let a = accounts.get(person);
    if (!a) {
      a = new SqlAccountStore(sqlRunner(), () => `acct${++n}`, () => clock);
      accounts.set(person, a);
      byKey.set(a.key, a);
    }
    return a;
  };
  const provider = new Provider({
    issuer: ISSUER,
    accounts: { forPerson: accountFor, byKey: async (k) => byKey.get(k) ?? null },
    clients: {
      resolve: async (id) =>
        id === CLIENT ? clientFromDocument(CLIENT, { client_id: CLIENT, client_name: 'Sketchpad', redirect_uris: [REDIRECT] }) : publicClient(),
      register: async () => `reg_${++n}`,
    },
    signer,
    clock: { now: () => clock },
    secrets: { random: () => `r${++n}x${Math.random().toString(36).slice(2)}`, hash: async (s) => `h:${s}` },
  });
  return { provider, accountFor, tick: (s: number) => (clock += s), now: () => clock };
}

const authQuery = (over: Record<string, string> = {}) =>
  new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT,
    redirect_uri: REDIRECT,
    scope: 'openid webid offline_access',
    code_challenge: CHALLENGE,
    code_challenge_method: 'S256',
    state: 'st',
    nonce: 'nn',
    ...over,
  });

async function signedInWithPod(w: ReturnType<typeof world>) {
  (await w.accountFor('clerk_sam')).bindWebid(WEBID);
}

async function code(w: ReturnType<typeof world>): Promise<string> {
  const out = await w.provider.authorize(authQuery(), 'clerk_sam');
  if (out.kind !== 'consent') throw new Error(out.kind);
  const location = new URL(await w.provider.decide('clerk_sam', out.pendingId, true));
  return location.searchParams.get('code')!;
}

const exchange = (w: ReturnType<typeof world>, c: string, jkt: string, over: Record<string, string> = {}) =>
  w.provider.token(new URLSearchParams({ grant_type: 'authorization_code', code: c, client_id: CLIENT, redirect_uri: REDIRECT, code_verifier: VERIFIER, ...over }), jkt);

describe('authorize', () => {
  it('sends a signed-out person to sign in and a podless one to sign up', async () => {
    const w = world();
    expect((await w.provider.authorize(authQuery(), null)).kind).toBe('sign-in');
    expect((await w.provider.authorize(authQuery(), 'clerk_new')).kind).toBe('no-pod');
  });

  it('never redirects to an unregistered redirect_uri', async () => {
    const w = world();
    await expect(w.provider.authorize(authQuery({ redirect_uri: 'https://evil.example/cb' }), 'clerk_sam')).rejects.toThrow(OidcError);
  });

  it('asks once, then remembers the approval unless prompt=consent', async () => {
    const w = world();
    await signedInWithPod(w);
    const first = await w.provider.authorize(authQuery(), 'clerk_sam');
    expect(first).toMatchObject({ kind: 'consent', webid: WEBID });
    const back = new URL(await w.provider.decide('clerk_sam', (first as { pendingId: string }).pendingId, true));
    expect(back.origin + back.pathname).toBe(REDIRECT);
    expect(back.searchParams.get('state')).toBe('st');
    expect(back.searchParams.get('iss')).toBe(ISSUER);
    expect((await w.provider.authorize(authQuery(), 'clerk_sam')).kind).toBe('redirect');
    expect((await w.provider.authorize(authQuery({ prompt: 'consent' }), 'clerk_sam')).kind).toBe('consent');
  });

  it('never skips consent for the shared public client, and names where the code goes', async () => {
    const w = world();
    await signedInWithPod(w);
    const pub = (redirect: string) => authQuery({ client_id: PUBLIC_CLIENT, redirect_uri: redirect });
    const first = await w.provider.authorize(pub('https://notes.example/cb'), 'clerk_sam');
    if (first.kind !== 'consent') throw new Error(first.kind);
    await w.provider.decide('clerk_sam', first.pendingId, true);
    const again = await w.provider.authorize(pub('https://evil.example/cb'), 'clerk_sam');
    expect(again).toMatchObject({ kind: 'consent', redirectUri: 'https://evil.example/cb' });
  });

  it('returns access_denied when the person declines', async () => {
    const w = world();
    await signedInWithPod(w);
    const out = await w.provider.authorize(authQuery(), 'clerk_sam');
    const back = new URL(await w.provider.decide('clerk_sam', (out as { pendingId: string }).pendingId, false));
    expect(back.searchParams.get('error')).toBe('access_denied');
    expect(back.searchParams.get('code')).toBeNull();
  });

  it('will not let one person answer another person\'s consent', async () => {
    const w = world();
    await signedInWithPod(w);
    const out = await w.provider.authorize(authQuery(), 'clerk_sam');
    await expect(w.provider.decide('clerk_mallory', (out as { pendingId: string }).pendingId, true)).rejects.toThrow(OidcError);
  });
});

describe('token', () => {
  it('issues DPoP-bound tokens that the pod verifier accepts', async () => {
    const w = world();
    await signedInWithPod(w);
    const dpop = await generateKeyPair('ES256', { extractable: true });
    const tokens = await exchange(w, await code(w), await thumb(dpop));
    expect(tokens).toMatchObject({ token_type: 'DPoP', scope: 'openid webid offline_access' });
    expect(typeof tokens.refresh_token).toBe('string');

    // Close the loop: our resource-server verifier, fed our discovery, keys and a profile naming us.
    const fetcher = async (url: string) => {
      if (url === 'https://idp.example/.well-known/openid-configuration') return Response.json({ issuer: ISSUER, jwks_uri: 'https://idp.example/.oidc/jwks' });
      if (url === 'https://idp.example/.oidc/jwks') return Response.json(signer.jwks());
      if (url === 'https://sam.idp.example/profile/card') return new Response(`<${WEBID}> <http://www.w3.org/ns/solid/terms#oidcIssuer> <${ISSUER}>.`, { headers: { 'Content-Type': 'text/turtle' } });
      return new Response('', { status: 404 });
    };
    const url = 'https://sam.idp.example/notes/x';
    const proof = await new SignJWT({ htm: 'GET', htu: url, jti: 'p1', iat: Math.floor(Date.now() / 1000) })
      .setProtectedHeader({ alg: 'ES256', typ: 'dpop+jwt', jwk: await exportJWK(dpop.publicKey) })
      .sign(dpop.privateKey);
    const agent = await new SolidOidcVerifier({ fetch: fetcher, now: () => Date.now() }).verify({
      method: 'GET',
      url,
      authorization: `DPoP ${tokens.access_token}`,
      dpop: proof,
    });
    expect(agent?.webid).toBe(WEBID);
  });

  it.each([
    ['a wrong PKCE verifier', { code_verifier: `${VERIFIER.slice(0, -1)}A` }],
    ['another redirect_uri', { redirect_uri: 'https://app.example/other' }],
    ['another client_id', { client_id: 'https://evil.example/id' }],
  ])('refuses %s', async (_l, over) => {
    const w = world();
    await signedInWithPod(w);
    await expect(exchange(w, await code(w), 'jkt', over)).rejects.toMatchObject({ code: 'invalid_grant' });
  });

  it('refuses an expired code', async () => {
    const w = world();
    await signedInWithPod(w);
    const c = await code(w);
    w.tick(61);
    await expect(exchange(w, c, 'jkt')).rejects.toMatchObject({ code: 'invalid_grant' });
  });

  it('treats a reused code as theft: refused, and its refresh token revoked', async () => {
    const w = world();
    await signedInWithPod(w);
    const c = await code(w);
    const first = await exchange(w, c, 'jkt');
    await expect(exchange(w, c, 'jkt')).rejects.toMatchObject({ code: 'invalid_grant' });
    await expect(
      w.provider.token(new URLSearchParams({ grant_type: 'refresh_token', refresh_token: String(first.refresh_token) }), 'jkt'),
    ).rejects.toMatchObject({ code: 'invalid_grant' });
  });

  it('rotates refresh tokens and kills the family when an old one returns', async () => {
    const w = world();
    await signedInWithPod(w);
    const first = await exchange(w, await code(w), 'jkt');
    const refresh = (t: unknown, jkt = 'jkt') => w.provider.token(new URLSearchParams({ grant_type: 'refresh_token', refresh_token: String(t) }), jkt);
    const second = await refresh(first.refresh_token);
    expect(second.refresh_token).not.toBe(first.refresh_token);
    await expect(refresh(second.refresh_token, 'other-key')).rejects.toMatchObject({ code: 'invalid_dpop_proof' });
    await expect(refresh(first.refresh_token)).rejects.toMatchObject({ code: 'invalid_grant' });
    await expect(refresh(second.refresh_token)).rejects.toMatchObject({ code: 'invalid_grant' });
  });

  it('lets only one of two simultaneous refreshes with the same token through', async () => {
    const w = world();
    await signedInWithPod(w);
    const first = await exchange(w, await code(w), 'jkt');
    const refresh = (t: unknown) => w.provider.token(new URLSearchParams({ grant_type: 'refresh_token', refresh_token: String(t) }), 'jkt');
    const results = await Promise.allSettled([refresh(first.refresh_token), refresh(first.refresh_token)]);
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    const winner = results.find((r) => r.status === 'fulfilled') as PromiseFulfilledResult<Record<string, unknown>>;
    expect((await refresh(winner.value.refresh_token)).access_token).toBeTruthy();
  });

  it('revoking an app ends its refresh tokens', async () => {
    const w = world();
    await signedInWithPod(w);
    const first = await exchange(w, await code(w), 'jkt');
    expect((await w.provider.apps('clerk_sam')).map((a) => [a.clientId, a.clientName, a.site, a.webid])).toEqual([[CLIENT, 'Sketchpad', new URL(CLIENT).host, WEBID]]);
    await w.provider.revokeApp('clerk_sam', CLIENT);
    expect(await w.provider.apps('clerk_sam')).toEqual([]);
    await expect(
      w.provider.token(new URLSearchParams({ grant_type: 'refresh_token', refresh_token: String(first.refresh_token) }), 'jkt'),
    ).rejects.toMatchObject({ code: 'invalid_grant' });
    expect((await w.provider.authorize(authQuery(), 'clerk_sam')).kind).toBe('consent');
  });
});

describe('stored approvals', () => {
  it('take the site column on a table made before it existed', async () => {
    const sql = sqlRunner();
    sql.exec('CREATE TABLE approval(client_id TEXT NOT NULL, webid TEXT NOT NULL, client_name TEXT, approved INTEGER NOT NULL, PRIMARY KEY (client_id, webid))');
    sql.exec("INSERT INTO approval VALUES ('reg_old', 'https://w.example/#me', 'old', 1)");
    const store = new SqlAccountStore(sql, () => 'k', () => 2);
    new SqlAccountStore(sql, () => 'k', () => 2);
    await store.approve({ clientId: 'reg_new', name: 'new', site: 'new.example' }, 'https://w.example/#me');
    expect((await store.approvals()).map((a) => [a.clientId, a.site])).toEqual([['reg_new', 'new.example'], ['reg_old', null]]);
  });
});
