// End to end against a running dev server: a scripted Solid client signs in
// through our provider (dev sign-in standing in for Clerk), gets DPoP-bound
// tokens, and uses its pod; then a stock CSS accepts the same kind of token.
// Needs E2E_APEX_URL (e.g. http://localhost:8799); `make e2e` sets it.

import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CSS_BIN, type RunningCss, startCss } from './support/css.js';

const APEX = process.env.E2E_APEX_URL?.replace(/\/$/u, '');
const PUBLIC_CLIENT = 'http://www.w3.org/ns/solid/terms#PublicOidcClient';
const REDIRECT = 'http://localhost:9/callback';

type Keys = Awaited<ReturnType<typeof generateKeyPair>>;

async function proof(keys: Keys, htm: string, htu: string): Promise<string> {
  return new SignJWT({ htm, htu, jti: crypto.randomUUID(), iat: Math.floor(Date.now() / 1000) })
    .setProtectedHeader({ alg: 'ES256', typ: 'dpop+jwt', jwk: await exportJWK(keys.publicKey) })
    .sign(keys.privateKey);
}

function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

/** Signs `person` in with a pod named `handle`, then runs the code flow. */
async function signIn(person: string, handle: string, keys: Keys) {
  const signin = await fetch(`${APEX}/dev/sign-in?person=${person}&pod=${handle}`, { redirect: 'manual' });
  const cookie = signin.headers.get('set-cookie')!.split(';')[0]!;
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  const auth = new URL(`${APEX}/.oidc/auth`);
  for (const [k, v] of Object.entries({
    response_type: 'code',
    client_id: PUBLIC_CLIENT,
    redirect_uri: REDIRECT,
    scope: 'openid webid offline_access',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'xyz',
  })) auth.searchParams.set(k, v);

  // The first sign-in shows consent; later ones redirect straight back.
  let answer = await fetch(auth, { headers: { cookie }, redirect: 'manual' });
  if (answer.status === 200) {
    const pending = /name="pending" value="([^"]+)"/u.exec(await answer.text())![1]!;
    answer = await fetch(`${APEX}/.oidc/auth/decision`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: `pending=${pending}&approve=yes`,
      redirect: 'manual',
    });
  }
  expect(answer.status).toBe(302);
  const back = new URL(answer.headers.get('location')!);
  expect(back.searchParams.get('state')).toBe('xyz');

  const tokenUrl = `${APEX}/.oidc/token`;
  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', DPoP: await proof(keys, 'POST', tokenUrl) },
    body: new URLSearchParams({ grant_type: 'authorization_code', code: back.searchParams.get('code')!, client_id: PUBLIC_CLIENT, redirect_uri: REDIRECT, code_verifier: verifier }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as { access_token: string; refresh_token: string; id_token: string };
}

describe.skipIf(!APEX)('signing in through our provider', () => {
  let keys: Keys;
  const pod = () => APEX!.replace('://localhost', `://e2esam.localhost`);

  beforeAll(async () => {
    keys = await generateKeyPair('ES256', { extractable: true });
  });

  it('gives a Solid client tokens its own pod accepts', async () => {
    const tokens = await signIn('e2esam', 'e2esam', keys);
    const url = `${pod()}/`;
    const res = await fetch(url, { headers: { Authorization: `DPoP ${tokens.access_token}`, DPoP: await proof(keys, 'GET', url) } });
    expect(res.status).toBe(200);
    expect(res.headers.get('WAC-Allow')).toContain('user="read append write control"');
  });

  it('refuses the same access token from a different key', async () => {
    const tokens = await signIn('e2esam', 'e2esam', keys);
    const other = await generateKeyPair('ES256', { extractable: true });
    const url = `${pod()}/`;
    const res = await fetch(url, { headers: { Authorization: `DPoP ${tokens.access_token}`, DPoP: await proof(other, 'GET', url) } });
    expect(res.status).toBe(401);
  });

  describe.skipIf(!CSS_BIN)('a stock CSS as the resource server', () => {
    let css: RunningCss;
    let dir: string;

    beforeAll(async () => {
      dir = await mkdtemp(join(tmpdir(), 'solidshmolid-interop-'));
      const webid = `${pod()}/profile/card#me`;
      await writeFile(
        join(dir, '.acl'),
        `@prefix acl: <http://www.w3.org/ns/auth/acl#>.\n<#sam> a acl:Authorization; acl:agent <${webid}>; acl:accessTo <./>; acl:default <./>; acl:mode acl:Read, acl:Write.\n`,
      );
      await writeFile(join(dir, 'hello.txt'), 'served by CSS');
      const config = new URL('./compat/css-file-root-dpop.json', import.meta.url).pathname;
      css = await startCss(['-c', config, '-f', dir], 'hello.txt');
    }, 90_000);

    afterAll(async () => {
      css?.stop();
      if (dir) await rm(dir, { recursive: true, force: true });
    });

    it('accepts a token our provider issued', async () => {
      const tokens = await signIn('e2esam', 'e2esam', keys);
      const url = `${css.base}hello.txt`;
      const res = await fetch(url, { headers: { Authorization: `DPoP ${tokens.access_token}`, DPoP: await proof(keys, 'GET', url) } });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('served by CSS');
      const anonymous = await fetch(url);
      expect(anonymous.status).toBe(401);
    });
  });
});
