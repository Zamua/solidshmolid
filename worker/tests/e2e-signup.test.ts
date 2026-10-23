// End to end against a running dev server: a person signs in (dev sign-in
// standing in for Clerk), signs up, connects storage (the dev provider
// standing in for Dropbox) and gets a working pod at a random id.
// Needs E2E_APEX_URL (e.g. http://localhost:8799); `make e2e` sets it.

import { describe, expect, it } from 'vitest';
import { isPodId } from '../domain/accounts/podIds.js';

const APEX = process.env.E2E_APEX_URL?.replace(/\/$/u, '');

describe.skipIf(!APEX)('sign up and connect storage', () => {
  it('gives a new person a pod in their storage, served at a random id', async () => {
    const person = `e2e_${crypto.randomUUID().slice(0, 8)}`;
    const signin = await fetch(`${APEX}/dev/sign-in?person=${person}`, { redirect: 'manual' });
    const cookie = signin.headers.get('set-cookie')!.split(';')[0]!;
    const post = (path: string) => fetch(`${APEX}${path}`, { method: 'POST', headers: { cookie, origin: APEX! }, redirect: 'manual' });

    expect((await fetch(`${APEX}/api/me`)).status).toBe(401);
    expect((await fetch(`${APEX}/api/signup`, { method: 'POST', headers: { cookie, origin: 'https://evil.example' } })).status).toBe(403);

    const signup = await post('/api/signup');
    expect(signup.status).toBe(201);
    const account = (await signup.json()) as { webid: string; pods: { id: string; url: string; connected: boolean }[] };
    const [pod] = account.pods;
    expect(isPodId(pod!.id)).toBe(true);
    expect(pod!.connected).toBe(false);
    expect((await post('/api/signup').then((r) => r.json())) as unknown).toEqual(account);
    expect((await fetch(pod!.url)).status).toBe(404);

    const { authorizeUrl } = (await (await post('/api/storage/dev/start')).json()) as { authorizeUrl: string };
    const finished = await fetch(authorizeUrl, { headers: { cookie }, redirect: 'manual' });
    expect(finished.status).toBe(303);
    expect((await fetch(authorizeUrl, { headers: { cookie }, redirect: 'manual' })).status).toBe(400);

    const me = (await (await fetch(`${APEX}/api/me`, { headers: { cookie } })).json()) as { account: { pods: { connected: boolean }[] } };
    expect(me.account.pods[0]!.connected).toBe(true);

    const webid = account.webid;
    const profile = await fetch(new URL('/profile/card', pod!.url));
    expect(profile.status).toBe(200);
    expect(await profile.text()).toContain(`${APEX}/`);
    expect((await fetch(pod!.url)).status).toBe(401);
    expect((await fetch(pod!.url, { headers: { 'X-Dev-WebID': webid } })).status).toBe(200);

    const home = await (await fetch(`${APEX}/`, { headers: { cookie } })).text();
    expect(home).toContain('Your pods');
    expect(home).toContain(new URL(pod!.url).host);

    // A second pod: owned by the same WebID, without a profile of its own,
    // and listed as a storage in the WebID's profile.
    const added = await fetch(`${APEX}/api/pods`, { method: 'POST', headers: { cookie, origin: APEX! } });
    expect(added.status).toBe(201);
    const after = (await added.json()) as { pods: { id: string; url: string; connected: boolean }[] };
    const second = after.pods[1]!;
    expect(isPodId(second.id) && second.connected).toBe(true);
    for (const [who, status] of [[webid, 200], ['https://stranger.example/#me', 403]] as const) {
      expect((await fetch(second.url, { headers: { 'X-Dev-WebID': who } })).status).toBe(status);
    }
    expect((await fetch(second.url)).status).toBe(401);
    expect((await fetch(new URL('/profile/card', second.url), { headers: { 'X-Dev-WebID': webid } })).status).toBe(404);
    expect(await (await fetch(new URL('/profile/card', pod!.url))).text()).toContain(second.url);
  });
});
