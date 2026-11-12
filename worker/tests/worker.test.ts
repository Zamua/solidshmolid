// The Worker entry, driven through `fetch` with a constructed Env: what a
// deployment (no DEV_MODE) must never do, next to what the dev config does.

import { describe, expect, it } from 'vitest';
import type { Env } from '../runtime/env.js';
import { AGENT_HEADER } from '../runtime/objects/podObject.js';
import worker from '../runtime/worker.js';

const POD_ID = 'k3x9fqm7';

function world(vars: Partial<Env> = {}) {
  const reached: { name: string; request: Request }[] = [];
  const provisioned: string[] = [];
  const namespace = (answer: (name: string) => object) => ({ idFromName: (name: string) => name, get: (name: string) => answer(name) });
  const env = {
    POD: namespace((name) => ({
      fetch: async (request: Request) => {
        reached.push({ name, request });
        return new Response('needs credentials\n', { status: 401 });
      },
      ensureProvisioned: async () => void provisioned.push(name),
    })),
    ACCOUNT: namespace(() => ({})),
    DIRECTORY: namespace(() => ({})),
    POD_HOST_TEMPLATE: '{handle}.pods.example',
    APEX_HOST: 'account.example',
    STORAGE: 'dropbox',
    ...vars,
  } as unknown as Env;
  const get = (url: string, headers: Record<string, string> = {}) => worker.fetch(new Request(url, { headers }), env);
  const send = (url: string, init: RequestInit) => worker.fetch(new Request(url, init), env);
  return { get, send, reached, provisioned };
}

describe('a deployment (no DEV_MODE)', () => {
  it('has no dev sign-in', async () => {
    const { get } = world();
    expect((await get('https://account.example/dev/sign-in?person=x')).status).toBe(404);
  });

  it('does not take the dev cookie for a session', async () => {
    const { get } = world();
    const response = await get('https://account.example/api/me', { Cookie: 'dev_person=x' });
    expect(response.status).toBe(401);
  });

  it('turns a named pod host away before any pod object exists', async () => {
    const { get, reached, provisioned } = world();
    expect((await get('https://alice.pods.example/')).status).toBe(404);
    expect(reached).toHaveLength(0);
    expect(provisioned).toHaveLength(0);
  });

  it('never takes the agent from a request header', async () => {
    const { get, reached, provisioned } = world();
    const owner = `https://${POD_ID}.pods.example/profile/card#me`;
    const response = await get(`https://${POD_ID}.pods.example/private/`, { 'X-Dev-WebID': owner, [AGENT_HEADER]: owner, 'x-solidshmolid-base': 'https://elsewhere.example' });
    expect(response.status).toBe(401);
    expect(reached).toHaveLength(1);
    const forwarded = reached[0]!.request.headers;
    expect(forwarded.get(AGENT_HEADER)).toBeNull();
    expect(forwarded.get('x-solidshmolid-base')).toBe(`https://${POD_ID}.pods.example`);
    expect(provisioned).toHaveLength(0);
  });

  it('answers only on https at the default port, and says so', async () => {
    const { get, reached } = world();
    const moved = await get(`http://${POD_ID}.pods.example/notes/?a=1`);
    expect(moved.status).toBe(301);
    expect(moved.headers.get('Location')).toBe(`https://${POD_ID}.pods.example/notes/?a=1`);
    expect((await get('https://account.example:8443/sign-in')).headers.get('Location')).toBe('https://account.example/sign-in');
    expect(reached).toHaveLength(0);
    expect((await get(`https://${POD_ID}.pods.example/`)).headers.get('Strict-Transport-Security')).toMatch(/^max-age=\d+$/u);
  });

  it('is not found on a host that is not its own', async () => {
    const { get } = world();
    expect((await get('https://other.example/')).status).toBe(404);
  });
});

const signingKey = async () => {
  const { privateKey } = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  return JSON.stringify({ ...(await crypto.subtle.exportKey('jwk', privateKey)), kid: 'k1', alg: 'ES256' });
};
const keys = async () => ({
  TOKEN_KEY: btoa('k'.repeat(32)),
  OIDC_SIGNING_JWK: await signingKey(),
  CLERK_PUBLISHABLE_KEY: 'pk_test_x',
  CLERK_SECRET_KEY: 'sk_test_x',
  DROPBOX_APP_KEY: 'app',
});

describe('bodies the account site reads into memory', () => {
  it('are refused past a few kilobytes, before anything is parsed', async () => {
    // No Clerk keys: nobody is signed in, which these routes do not need.
    const { send } = world({ ...(await keys()), CLERK_PUBLISHABLE_KEY: undefined, CLERK_SECRET_KEY: undefined });
    const big = 'x'.repeat(17 * 1024);
    const token = await send('https://account.example/.oidc/token', { method: 'POST', body: big });
    expect([token.status, ((await token.json()) as { error: string }).error]).toEqual([413, 'invalid_request']);
    const registration = await send('https://account.example/.oidc/reg', { method: 'POST', body: big });
    expect(registration.status).toBe(413);
  });
});

describe('probes', () => {
  it('report the release', async () => {
    const { get } = world({ RELEASE: 'v1.2.3' });
    const health = await get('https://account.example/healthz');
    expect([health.status, await health.text(), health.headers.get('X-Release')]).toEqual([200, 'ok\n', 'v1.2.3']);
  });

  it('are reads of the account site: on a pod the same names are ordinary resources', async () => {
    const { get, send, reached } = world();
    await get(`https://${POD_ID}.pods.example/healthz`);
    await send(`https://${POD_ID}.pods.example/readyz`, { method: 'PUT', body: 'x' });
    expect(reached.map((r) => new URL(r.request.url).pathname)).toEqual(['/healthz', '/readyz']);
    expect((await get('https://elsewhere.example/healthz')).status).toBe(404);
  });

  it('are ready with every key in place', async () => {
    const { get } = world(await keys());
    const ready = await get('https://account.example/readyz');
    expect([ready.status, await ready.text()]).toEqual([200, 'ready\n']);
  });

  it.each(['TOKEN_KEY', 'OIDC_SIGNING_JWK', 'CLERK_SECRET_KEY', 'DROPBOX_APP_KEY'] as const)('are not ready without %s, and do not say which', async (missing) => {
    const { get } = world({ ...(await keys()), [missing]: undefined });
    const ready = await get('https://account.example/readyz');
    expect([ready.status, await ready.text()]).toEqual([503, 'not ready\n']);
  });

  it('are not ready with a sealing key of the wrong length', async () => {
    const { get } = world({ ...(await keys()), TOKEN_KEY: btoa('short') });
    expect((await get('https://account.example/readyz')).status).toBe(503);
  });
});

describe('the dev config (DEV_MODE)', () => {
  it('trusts X-Dev-WebID, creates named pods on first request and stays on http', async () => {
    const { get, reached, provisioned } = world({ DEV_MODE: '1', APEX_HOST: 'localhost', POD_HOST_TEMPLATE: '{handle}.localhost', STORAGE: 'dev' });
    const response = await get('http://alice.localhost:8787/private/', { 'X-Dev-WebID': 'http://alice.localhost:8787/profile/card#me', [AGENT_HEADER]: 'http://mallory.example/#me' });
    expect(response.status).toBe(401);
    expect(response.headers.get('Strict-Transport-Security')).toBeNull();
    expect(provisioned).toEqual(['alice']);
    expect(reached[0]!.request.headers.get(AGENT_HEADER)).toBe('http://alice.localhost:8787/profile/card#me');
  });
});
