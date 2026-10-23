// End to end against a running dev server: a person signs in (dev sign-in
// standing in for Clerk), signs up, connects storage (the dev provider
// standing in for Dropbox) and gets a working pod at a random id.
// Needs E2E_APEX_URL (e.g. http://localhost:8799); `make e2e` sets it.

import { request } from 'node:http';
import { describe, expect, it } from 'vitest';
import { isPodId } from '../domain/accounts/podIds.js';

const APEX = process.env.E2E_APEX_URL?.replace(/\/$/u, '');

/** A browser's top-level navigation. fetch() drops Sec-* headers, so this
 * goes through node:http. */
function navigate(url: string): Promise<{ status: number; type: string | undefined; body: string }> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = request(
      { hostname: target.hostname, port: target.port, path: target.pathname, headers: { 'Sec-Fetch-Mode': 'navigate', accept: 'text/html' } },
      (res) => {
        let body = '';
        res.on('data', (c: Buffer) => (body += c.toString()));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, type: res.headers['content-type'], body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

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

    // A browser opening the pod gets a page for people; apps keep the protocol's answers.
    const privatePage = await navigate(pod!.url);
    expect([privatePage.status, privatePage.type]).toEqual([401, 'text/html; charset=utf-8']);
    expect(privatePage.body).toContain('This pod is private');
    const nowhere = await navigate(pod!.url.replace(pod!.id, 'zzzzzzzz'));
    expect([nowhere.status, nowhere.body]).toEqual([404, expect.stringContaining("There's no pod here")]);
    expect((await fetch(pod!.url, { headers: { accept: 'text/html' } })).headers.get('content-type')).toContain('text/plain');

    // Browsing on the account site: folders and files of the person's own pods.
    expect((await fetch(`${pod!.url}notes/hello.txt`, { method: 'PUT', headers: { 'X-Dev-WebID': webid, 'content-type': 'text/plain' }, body: 'hello <b>' })).status).toBe(201);
    const root = await (await fetch(`${APEX}/pods/${pod!.id}/files`, { headers: { cookie } })).text();
    expect(root).toContain(`/pods/${pod!.id}/files?path=%2Fnotes%2F`);
    const notes = await (await fetch(`${APEX}/pods/${pod!.id}/files?path=%2Fnotes%2F`, { headers: { cookie } })).text();
    expect(notes).toContain('hello.txt');
    const got = await fetch(`${APEX}/pods/${pod!.id}/download?path=%2Fnotes%2Fhello.txt`, { headers: { cookie } });
    expect([got.status, got.headers.get('content-type'), got.headers.get('content-disposition'), await got.text()]).toEqual([
      200,
      'application/octet-stream',
      "attachment; filename*=UTF-8''hello.txt",
      'hello <b>',
    ]);
    expect((await fetch(`${APEX}/pods/zzzzzzzz/files`, { headers: { cookie } })).status).toBe(404);
    const missing = await fetch(`${APEX}/pods/${pod!.id}/files?path=%2Fnope%2F`, { headers: { cookie } });
    expect([missing.status, await missing.text()]).toEqual([404, expect.stringContaining('That file or folder is not there.')]);
    const lost = await navigate(`${APEX}/no-such-page`);
    expect([lost.status, lost.type]).toEqual([404, 'text/html; charset=utf-8']);

    // The profile, as a person opening the WebID sees it.
    const profileView = await navigate(new URL('/profile/card', pod!.url).href);
    expect([profileView.status, profileView.type]).toEqual([200, 'text/html; charset=utf-8']);
    expect(profileView.body).toContain(new URL(pod!.url).host);

    const home = await (await fetch(`${APEX}/`, { headers: { cookie } })).text();
    expect(home).toContain('Your pods');
    expect(home).toContain('class="account-menu"');
    expect(home).toContain(new URL(pod!.url).host);
    expect(home).toContain(`data-copy="${new URL('/profile/card#me', pod!.url).href}"`);

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

    // Deleting: files need the exact sentence; the WebID pod goes only with
    // the account; storage holding pods cannot be disconnected.
    const api = (path: string, body: unknown) =>
      fetch(`${APEX}${path}`, { method: 'POST', headers: { cookie, origin: APEX!, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    expect(await (await fetch(`${APEX}/api/apps`, { headers: { cookie } })).json()).toEqual([]);
    const ask = (await (await api(`/api/pods/${second.id}/delete`, { deleteFiles: true })).json()) as { confirmToken: string; sentence: string };
    expect(ask.sentence).toBe('yes, delete my data in development storage');
    expect((await api('/api/deletions/confirm', { token: ask.confirmToken, typed: 'yes' })).status).toBe(400);
    expect((await fetch(second.url, { headers: { 'X-Dev-WebID': webid } })).status).toBe(200);
    expect((await api(`/api/pods/${second.id}/delete`, { deleteFiles: false })).status).toBe(200);
    expect((await fetch(second.url, { headers: { 'X-Dev-WebID': webid } })).status).toBe(404);
    expect(await (await fetch(new URL('/profile/card', pod!.url))).text()).not.toContain(second.url);
    expect((await api(`/api/pods/${pod!.id}/delete`, { deleteFiles: false })).status).toBe(409);
    const storage = ((await (await fetch(`${APEX}/api/me`, { headers: { cookie } })).json()) as { account: { storage: { id: string }[] } }).account.storage;
    const refused = await api(`/api/storage/${storage[0]!.id}/disconnect`, {});
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { pods: string[] }).pods).toEqual([pod!.id]);

    expect((await api('/api/account/delete', { deleteFiles: false })).status).toBe(200);
    expect(((await (await fetch(`${APEX}/api/me`, { headers: { cookie } })).json()) as { account: unknown }).account).toBeNull();
    expect((await fetch(pod!.url, { headers: { 'X-Dev-WebID': webid } })).status).toBe(404);
  });
});
