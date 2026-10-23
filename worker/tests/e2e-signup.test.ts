// End to end against a running dev server: a person signs in (dev sign-in
// standing in for Clerk), signs up, connects storage (the dev provider
// standing in for Dropbox) and gets a working pod at a random id.
// Needs E2E_APEX_URL (e.g. http://localhost:8799); `make e2e` sets it.

import { describe, expect, it } from 'vitest';
import { isPodId } from '../domain/households/podIds.js';

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
    const household = (await signup.json()) as { pods: { id: string; url: string; connected: boolean }[]; members: { webid: string }[] };
    const [pod] = household.pods;
    expect(isPodId(pod!.id)).toBe(true);
    expect(pod!.connected).toBe(false);
    expect((await post('/api/signup').then((r) => r.json())) as unknown).toEqual(household);
    expect((await fetch(pod!.url)).status).toBe(404);

    const { authorizeUrl } = (await (await post('/api/storage/dev/start')).json()) as { authorizeUrl: string };
    const finished = await fetch(authorizeUrl, { headers: { cookie }, redirect: 'manual' });
    expect(finished.status).toBe(303);
    expect((await fetch(authorizeUrl, { headers: { cookie }, redirect: 'manual' })).status).toBe(400);

    const me = (await (await fetch(`${APEX}/api/me`, { headers: { cookie } })).json()) as { household: { pods: { connected: boolean }[] } };
    expect(me.household.pods[0]!.connected).toBe(true);

    const webid = household.members[0]!.webid;
    const profile = await fetch(new URL('/profile/card', pod!.url));
    expect(profile.status).toBe(200);
    expect(await profile.text()).toContain(`${APEX}/`);
    expect((await fetch(pod!.url)).status).toBe(401);
    expect((await fetch(pod!.url, { headers: { 'X-Dev-WebID': webid } })).status).toBe(200);

    const home = await (await fetch(`${APEX}/`, { headers: { cookie } })).text();
    expect(home).toContain('Your household');
    expect(home).toContain(new URL(pod!.url).host);

    // A child of the household: their own login, WebID and pod, owned by them
    // and fully open to the manager.
    expect((await fetch(`${APEX}/members/new`, { headers: { cookie } })).status).toBe(200);
    const json = { cookie, origin: APEX!, 'content-type': 'application/json' };
    expect((await fetch(`${APEX}/api/members`, { method: 'POST', headers: json, body: JSON.stringify({ name: ' ' }) })).status).toBe(400);
    const added = await fetch(`${APEX}/api/members`, { method: 'POST', headers: json, body: JSON.stringify({ name: 'Leo' }) });
    expect(added.status).toBe(201);
    const after = (await added.json()) as { members: { name: string; kind: string; webid: string; pod: string }[]; pods: { id: string; url: string; connected: boolean }[] };
    const leo = after.members.find((m) => m.name === 'Leo')!;
    expect(leo.kind).toBe('managed');
    const leoPod = after.pods.find((p) => p.id === leo.pod)!;
    expect(leoPod.connected).toBe(true);
    expect((await fetch(new URL('/profile/card', leoPod.url))).status).toBe(200);
    for (const [who, status] of [[leo.webid, 200], [webid, 200], ['https://stranger.example/#me', 403]] as const) {
      expect((await fetch(leoPod.url, { headers: { 'X-Dev-WebID': who } })).status).toBe(status);
    }
    expect((await fetch(leoPod.url)).status).toBe(401);
  });
});
