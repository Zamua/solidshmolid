// End to end against a running dev server: a WebID from a real Solid identity
// provider reads and writes a pod it was granted, through the Worker, the
// verifier and the pod's Durable Object. Needs E2E_POD_URL (a dev pod, e.g.
// http://e2e.localhost:8787) and COMPAT_CSS_BIN; `make e2e` sets both.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CSS_BIN, type RunningCss, type SolidSession, signUp, startCss } from './support/css.js';

const POD = process.env.E2E_POD_URL?.replace(/\/$/u, '');

describe.skipIf(!CSS_BIN || !POD)('a CSS WebID on a dev pod', () => {
  let css: RunningCss;
  let guest: SolidSession;
  const owner = { 'X-Dev-WebID': `${POD}/profile/card#me` };
  const run = Math.random().toString(36).slice(2);
  const shared = `${POD}/shared-${run}/`;

  const as = async (session: SolidSession, method: string, url: string, init: RequestInit = {}, jti?: string) =>
    fetch(url, {
      ...init,
      method,
      headers: { ...(init.headers ?? {}), Authorization: `DPoP ${session.accessToken}`, DPoP: await session.proof(method, url, jti) },
    });

  beforeAll(async () => {
    css = await startCss(['-c', '@css:config/default.json'], '.account/');
    guest = await signUp(css.base, 'guest');
    const acl = `@prefix acl: <http://www.w3.org/ns/auth/acl#>.
<#owner> a acl:Authorization; acl:agent <${owner['X-Dev-WebID']}>; acl:accessTo <./>; acl:default <./>; acl:mode acl:Read, acl:Write, acl:Control.
<#guest> a acl:Authorization; acl:agent <${guest.webid}>; acl:accessTo <./>; acl:default <./>; acl:mode acl:Read, acl:Write.`;
    const put = (url: string, type: string, body: string) =>
      fetch(url, { method: 'PUT', headers: { ...owner, 'Content-Type': type }, body }).then((r) => expect(r.status, url).toBe(201));
    await put(`${shared}note.txt`, 'text/plain', 'hello guest');
    await put(`${shared}.acl`, 'text/turtle', acl);
  }, 90_000);

  afterAll(() => css?.stop());

  it('reads and writes what it was granted', async () => {
    const read = await as(guest, 'GET', `${shared}note.txt`);
    expect(read.status).toBe(200);
    expect(await read.text()).toBe('hello guest');
    expect(read.headers.get('WAC-Allow')).toContain('user="read append write"');
    const write = await as(guest, 'PUT', `${shared}note.txt`, { headers: { 'Content-Type': 'text/plain' }, body: 'hi owner' });
    expect(write.status).toBe(204);
  });

  it('is refused what it was not granted', async () => {
    expect((await as(guest, 'GET', `${POD}/`)).status).toBe(403);
    expect((await as(guest, 'PUT', `${shared}.acl`, { headers: { 'Content-Type': 'text/turtle' }, body: '' })).status).toBe(403);
  });

  it('cannot replay a proof', async () => {
    const jti = crypto.randomUUID();
    expect((await as(guest, 'GET', `${shared}note.txt`, {}, jti)).status).toBe(200);
    const again = await as(guest, 'GET', `${shared}note.txt`, {}, jti);
    expect(again.status).toBe(401);
  });

  it('turns away a forged token with invalid_token', async () => {
    const res = await fetch(`${shared}note.txt`, { headers: { Authorization: 'DPoP a.b.c', DPoP: 'x.y.z' } });
    expect(res.status).toBe(401);
    expect(res.headers.get('WWW-Authenticate')).toContain('invalid_token');
  });
});
