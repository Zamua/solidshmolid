import { describe, expect, it } from 'vitest';
import { copyPod } from '../app/storage/migrate.js';
import { Pod } from '../app/pods/pod.js';
import { NO_CONDITIONS } from '../domain/pods/requests.js';
import { DropboxFileStore } from '../runtime/adapters/dropbox.js';
import { DropboxAuthError, authorizeUrl, exchangeCode, refreshAccess } from '../runtime/adapters/dropboxOAuth.js';
import { DRIVE_FILE_SCOPE, exchangeGoogleCode, googleAuthorizeUrl, refreshGoogleAccess, revokeGoogleGrant } from '../runtime/adapters/googleDriveOAuth.js';
import { pkce } from '../runtime/adapters/pkce.js';
import { GrantRefused } from '../app/storage/ports.js';
import { FakeDropbox } from './support/fakeDropbox.js';
import { ALICE, BASE, newPod, sqliteIndex, streamOf, textOf } from './support/fakes.js';

describe('Dropbox OAuth with PKCE', () => {
  it('builds an offline authorize URL around an S256 challenge', async () => {
    const { verifier, challenge } = await pkce();
    expect(verifier).toMatch(/^[\w-]{64}$/u);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
    expect(challenge).toBe(Buffer.from(digest).toString('base64url'));
    const url = new URL(authorizeUrl('KEY', 'https://example.com/cb', 'alice.n1', challenge));
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: 'KEY',
      token_access_type: 'offline',
      code_challenge_method: 'S256',
      code_challenge: challenge,
      redirect_uri: 'https://example.com/cb',
      state: 'alice.n1',
    });
  });

  it('exchanges a code and refreshes without a client secret', async () => {
    const forms: Record<string, string>[] = [];
    const fake = async (_url: string, init?: RequestInit) => {
      const form = Object.fromEntries(new URLSearchParams(String(init?.body)));
      forms.push(form);
      if (form.grant_type === 'authorization_code') {
        return Response.json({ access_token: 'a1', expires_in: 14400, refresh_token: 'r1', account_id: 'dbid:1' });
      }
      if (form.refresh_token === 'revoked') return Response.json({ error: 'invalid_grant' }, { status: 400 });
      return Response.json({ access_token: 'a2', expires_in: 14400 });
    };
    const grant = await exchangeCode(fake, 'KEY', 'https://example.com/cb', 'code1', 'v1', 1000);
    expect(grant).toEqual({ accessToken: 'a1', expiresAt: 1000 + 14_400_000, refreshToken: 'r1', accountId: 'dbid:1' });
    expect(await refreshAccess(fake, 'KEY', 'r1', 0)).toEqual({ accessToken: 'a2', expiresAt: 14_400_000 });
    await expect(refreshAccess(fake, 'KEY', 'revoked', 0)).rejects.toThrow(DropboxAuthError);
    expect(forms.every((f) => !('client_secret' in f))).toBe(true);
    expect(forms[0]).toMatchObject({ code_verifier: 'v1', client_id: 'KEY' });
  });
});

describe('Google Drive OAuth with PKCE', () => {
  const client = { id: 'CID', secret: 'CSECRET' };

  it('asks offline for drive.file alone, around an S256 challenge', () => {
    const url = new URL(googleAuthorizeUrl('CID', 'https://example.com/cb', 'alice.n1', 'chal'));
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: 'CID',
      scope: DRIVE_FILE_SCOPE,
      access_type: 'offline',
      prompt: 'consent',
      code_challenge: 'chal',
      code_challenge_method: 'S256',
      redirect_uri: 'https://example.com/cb',
      state: 'alice.n1',
    });
  });

  it('exchanges a code with the client secret, names the Drive, refreshes and revokes', async () => {
    const forms: Record<string, string>[] = [];
    let scope = DRIVE_FILE_SCOPE;
    const fake = async (url: string, init?: RequestInit) => {
      if (url.includes('/drive/v3/about')) {
        expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer a1');
        return Response.json({ user: { permissionId: 'perm1' } });
      }
      const form = Object.fromEntries(new URLSearchParams(String(init?.body)));
      forms.push(form);
      if (url.endsWith('/revoke')) return form.token === 'gone' ? Response.json({ error: 'invalid_token' }, { status: 400 }) : new Response(null);
      if (form.grant_type === 'authorization_code') return Response.json({ access_token: 'a1', expires_in: 3599, refresh_token: 'r1', scope });
      if (form.refresh_token === 'revoked') return Response.json({ error: 'invalid_grant' }, { status: 400 });
      return Response.json({ access_token: 'a2', expires_in: 3599 });
    };
    const grant = await exchangeGoogleCode(fake, client, 'https://example.com/cb', 'code1', 'v1', 1000);
    expect(grant).toEqual({ accessToken: 'a1', expiresAt: 1000 + 3_599_000, refreshToken: 'r1', accountId: 'perm1' });
    expect(forms[0]).toMatchObject({ code_verifier: 'v1', client_id: 'CID', client_secret: 'CSECRET' });
    expect(await refreshGoogleAccess(fake, client, 'r1', 0)).toEqual({ accessToken: 'a2', expiresAt: 3_599_000 });
    await expect(refreshGoogleAccess(fake, client, 'revoked', 0)).rejects.toThrow(GrantRefused);
    await revokeGoogleGrant(fake, 'r1');
    await revokeGoogleGrant(fake, 'gone');
    scope = 'openid';
    await expect(exchangeGoogleCode(fake, client, 'https://example.com/cb', 'code2', 'v2', 0)).rejects.toThrow(/not granted/);
  });
});

describe('moving a pod into Dropbox', () => {
  it('copies every file, and the copy adopts to the same pod', async () => {
    const { pod, index, files } = await newPod();
    await pod.put('/notes/a.ttl', { webid: ALICE }, { stream: streamOf('<#a> <#b> "c".') }, 'text/turtle', NO_CONDITIONS);
    await pod.put('/odd', { webid: ALICE }, { stream: streamOf('?') }, 'application/x-odd', NO_CONDITIONS);
    const fake = new FakeDropbox();
    const dropbox = new DropboxFileStore({ fetch: fake.fetch, accessToken: async () => fake.validToken, sleep: async () => {} });
    expect(await copyPod(index, files, dropbox)).toBe(6);
    expect(Object.keys(fake.files()).sort()).toEqual([
      '/.acl',
      '/notes/a.ttl',
      '/odd$.unknown',
      '/odd.meta',
      '/profile/card$.ttl',
      '/profile/card.acl',
    ]);
    let id = 0;
    const moved = new Pod({ index: sqliteIndex(), files: dropbox, base: BASE, now: () => new Date(), newId: () => `m${++id}` });
    await moved.adopt(ALICE, (await dropbox.listAll()).entries);
    const odd = await moved.read('/odd', { webid: ALICE }, { accept: null, range: null, head: false });
    expect(odd.contentType).toBe('application/x-odd');
    expect(await textOf(odd.body)).toBe('?');
  });
});
