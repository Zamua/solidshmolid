import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { copyPod } from '../app/storage/migrate.js';
import { Pod } from '../app/pods/pod.js';
import { NO_CONDITIONS } from '../domain/pods/requests.js';
import { DropboxFileStore } from '../runtime/adapters/dropbox.js';
import { DropboxAuthError, authorizeUrl, exchangeCode, pkce, refreshAccess } from '../runtime/adapters/dropboxOAuth.js';
import { StorageLinks } from '../runtime/adapters/storageLinks.js';
import { FakeDropbox } from './support/fakeDropbox.js';
import { ALICE, BASE, newPod, sqliteIndex, streamOf, textOf } from './support/fakes.js';

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
const KEY = btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i)));

function sql() {
  const db = new DatabaseSync(':memory:');
  return {
    db,
    runner: {
      exec(query: string, ...args: unknown[]) {
        if (args.length === 0 && query.split(';').filter((s) => s.trim()).length > 1) {
          db.exec(query);
          return { toArray: () => [] };
        }
        const rows = db.prepare(query).all(...(args as never[])) as Record<string, unknown>[];
        return { toArray: () => rows };
      },
    },
  };
}

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

describe('stored links', () => {
  it('keeps the refresh token encrypted and bound to its pod', async () => {
    const { db, runner } = sql();
    const links = new StorageLinks(runner, KEY, 'alice');
    await links.save({ provider: 'dropbox', account: 'dbid:1', refreshToken: 'secret-refresh', cursor: 'c1' });
    const raw = db.prepare('SELECT refresh FROM storage_link').get() as { refresh: string };
    expect(raw.refresh).not.toContain('secret-refresh');
    expect((await links.current())?.refreshToken).toBe('secret-refresh');
    await expect(new StorageLinks(runner, KEY, 'mallory').current()).rejects.toThrow();
  });

  it('lets a pending link be taken once, before it expires', async () => {
    const { runner } = sql();
    let nowMs = 100_000;
    const links = new StorageLinks(runner, KEY, 'alice', () => nowMs);
    await links.remember('n1', { verifier: 'v', webid: ALICE });
    nowMs += 1000;
    expect(await links.take('n1')).toEqual({ verifier: 'v', webid: ALICE });
    expect(await links.take('n1')).toBeNull();
    await links.remember('n2', { verifier: 'v', webid: ALICE });
    nowMs += 16 * 60 * 1000;
    expect(await links.take('n2')).toBeNull();
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
