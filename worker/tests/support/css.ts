// A stock Community Solid Server for tests: started on a free port, with a
// helper that signs up an account and gets a DPoP-bound token for its WebID.

import { type ChildProcess, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';

export const CSS_BIN = process.env.COMPAT_CSS_BIN;

export async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });
}

export interface RunningCss {
  base: string;
  process: ChildProcess;
  stop(): void;
}

/** Starts CSS with `args` and waits until `readyPath` answers 2xx. */
export async function startCss(args: string[], readyPath: string): Promise<RunningCss> {
  return startCssOn(await freePort(), args, readyPath);
}

export async function startCssOn(port: number, args: string[], readyPath: string): Promise<RunningCss> {
  const base = `http://localhost:${port}/`;
  const child = spawn('node', [CSS_BIN!, ...args, '-p', String(port), '-b', base, '-l', 'warn'], {
    stdio: 'inherit',
    // Not the test runner's env: NODE_ENV=test makes CSS's OIDC stack reach for
    // jest, and CSS reads every CSS_* variable as an option.
    env: { PATH: process.env.PATH, HOME: process.env.HOME },
  });
  for (const deadline = Date.now() + 60_000; ; ) {
    if (await fetch(`${base}${readyPath}`).then((r) => r.ok, () => false)) break;
    if (Date.now() > deadline) {
      child.kill();
      throw new Error('CSS did not start');
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return { base, process: child, stop: () => child.kill() };
}

export interface SolidSession {
  webid: string;
  accessToken: string;
  /** A fresh DPoP proof for one request. */
  proof(htm: string, htu: string, jti?: string): Promise<string>;
}

/** Signs up on a CSS identity provider and returns a client-credentials
 * session for the new pod's WebID. */
export async function signUp(base: string, name: string): Promise<SolidSession> {
  const json = async (url: string, init: RequestInit = {}) => {
    const res = await fetch(url, init);
    if (!res.ok) throw new Error(`${url}: ${res.status} ${await res.text()}`);
    return res.json() as Promise<Record<string, any>>;
  };
  const post = (auth: string | null, body: unknown): RequestInit => ({
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(auth ? { authorization: `CSS-Account-Token ${auth}` } : {}) },
    body: JSON.stringify(body),
  });
  const { controls } = await json(`${base}.account/`);
  const { authorization } = await json(controls.account.create, post(null, {}));
  const signedIn = (await json(`${base}.account/`, { headers: { authorization: `CSS-Account-Token ${authorization}` } })).controls;
  await json(signedIn.password.create, post(authorization, { email: `${name}@example.test`, password: crypto.randomUUID() }));
  const { webId } = await json(signedIn.account.pod, post(authorization, { name }));
  const { id, secret } = await json(signedIn.account.clientCredentials, post(authorization, { name: 'test', webId }));

  const keys = await generateKeyPair('ES256', { extractable: true });
  const jwk = await exportJWK(keys.publicKey);
  const proof = (htm: string, htu: string, jti = crypto.randomUUID()) =>
    new SignJWT({ htm, htu, jti, iat: Math.floor(Date.now() / 1000) })
      .setProtectedHeader({ alg: 'ES256', typ: 'dpop+jwt', jwk })
      .sign(keys.privateKey);
  const { token_endpoint: tokenUrl } = await json(`${base}.well-known/openid-configuration`);
  const token = await json(tokenUrl, {
    method: 'POST',
    headers: {
      authorization: `Basic ${btoa(`${encodeURIComponent(id)}:${encodeURIComponent(secret)}`)}`,
      'content-type': 'application/x-www-form-urlencoded',
      dpop: await proof('POST', tokenUrl),
    },
    body: 'grant_type=client_credentials&scope=webid',
  });
  if (token.token_type !== 'DPoP') throw new Error(`expected a DPoP token, got ${token.token_type}`);
  return { webid: webId, accessToken: token.access_token, proof };
}
