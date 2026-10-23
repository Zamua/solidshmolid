import { describe, expect, it } from 'vitest';
import { Pod } from '../app/pods/pod.js';
import { NO_CONDITIONS } from '../domain/pods/requests.js';
import { FolderSync, LinkExpired, NotAllowed, StorageLinking } from '../app/storage/linking.js';
import type { FileStore, Grant, LinkStore, PendingLink, StorageAuthorization, StorageLink } from '../app/storage/ports.js';
import { DropboxFileStore } from '../runtime/adapters/dropbox.js';
import { FakeDropbox } from './support/fakeDropbox.js';
import { ALICE, BASE, BOB, MemoryFileStore, PROFILE, sqliteIndex, streamOf, textOf } from './support/fakes.js';

class MemoryLinks implements LinkStore {
  link: StorageLink | null = null;
  pending = new Map<string, PendingLink>();
  async current() {
    return this.link;
  }
  async save(link: StorageLink) {
    this.link = link;
  }
  async setCursor(cursor: string) {
    if (this.link) this.link = { ...this.link, cursor };
  }
  async remember(nonce: string, p: PendingLink) {
    this.pending.set(nonce, p);
  }
  async take(nonce: string) {
    const p = this.pending.get(nonce) ?? null;
    this.pending.delete(nonce);
    return p;
  }
}

const fakeAuth = (grant: Grant): StorageAuthorization => ({
  provider: 'dropbox',
  pkce: async () => ({ verifier: 'v', challenge: 'c' }),
  authorizeUrl: (redirect, state, challenge) => `https://dropbox.example/authorize?redirect=${redirect}&state=${state}&c=${challenge}`,
  exchange: async () => grant,
});

async function setup(folder = new FakeDropbox()) {
  const index = sqliteIndex();
  const current = new MemoryFileStore();
  let id = 0;
  const podOn = (files: FileStore) => new Pod({ index, files, base: BASE, now: () => new Date(), newId: () => `i${++id}` });
  const pod = podOn(current);
  await pod.provision(ALICE, PROFILE);
  await pod.put('/notes/a.txt', { webid: ALICE }, { stream: streamOf('before linking') }, 'text/plain', NO_CONDITIONS);
  const links = new MemoryLinks();
  const opener = { open: () => new DropboxFileStore({ fetch: folder.fetch, accessToken: async () => folder.validToken, sleep: async () => {} }) };
  const linking = new StorageLinking({
    pod,
    podOn,
    index,
    current,
    links,
    authorization: fakeAuth({ refreshToken: 'r', accountId: 'dbid:1', accessToken: 'a', expiresAt: 0 }),
    opener,
    newNonce: () => 'nonce1',
  });
  return { pod, linking, links, folder, opener };
}

describe('linking storage', () => {
  it('lets only a controller of the pod start', async () => {
    const { linking } = await setup();
    await expect(linking.begin(BOB, 'https://x/cb', 'alice')).rejects.toThrow(NotAllowed);
    await expect(linking.begin(null, 'https://x/cb', 'alice')).rejects.toThrow(NotAllowed);
    expect(await linking.begin(ALICE, 'https://x/cb', 'alice')).toContain('state=alice.nonce1');
  });

  it('copies the pod into an empty folder and serves it from there', async () => {
    const { linking, links, folder } = await setup();
    await linking.begin(ALICE, 'https://x/cb', 'alice');
    const { outcome, pod } = await linking.complete('nonce1', 'code', 'https://x/cb');
    expect(outcome).toBe('copied');
    expect(folder.files()['/notes/a.txt']).toBe('before linking');
    expect(links.link).toMatchObject({ provider: 'dropbox', account: 'dbid:1', refreshToken: 'r' });
    expect(links.link?.cursor).toBeTruthy();
    expect(await textOf((await pod.read('/notes/a.txt', { webid: ALICE }, { accept: null, range: null, head: false })).body)).toBe('before linking');
  });

  it('adopts a folder that already holds a pod', async () => {
    const folder = new FakeDropbox();
    folder.editOutOfBand('/.acl', `<#o> a <http://www.w3.org/ns/auth/acl#Authorization>; <http://www.w3.org/ns/auth/acl#agent> <${ALICE}>; <http://www.w3.org/ns/auth/acl#accessTo> <./>; <http://www.w3.org/ns/auth/acl#default> <./>; <http://www.w3.org/ns/auth/acl#mode> <http://www.w3.org/ns/auth/acl#Read>.`);
    folder.editOutOfBand('/old/note.txt', 'from an earlier life');
    const { linking } = await setup(folder);
    await linking.begin(ALICE, 'https://x/cb', 'alice');
    const { outcome, pod } = await linking.complete('nonce1', 'code', 'https://x/cb');
    expect(outcome).toBe('adopted');
    expect(folder.files()['/notes/a.txt']).toBeUndefined();
    expect(await textOf((await pod.read('/old/note.txt', { webid: ALICE }, { accept: null, range: null, head: false })).body)).toBe('from an earlier life');
  });

  it('refuses a callback it did not start, and the same callback twice', async () => {
    const { linking } = await setup();
    await expect(linking.complete('nope', 'code', 'https://x/cb')).rejects.toThrow(LinkExpired);
    await linking.begin(ALICE, 'https://x/cb', 'alice');
    await linking.complete('nonce1', 'code', 'https://x/cb');
    await expect(linking.complete('nonce1', 'code', 'https://x/cb')).rejects.toThrow(LinkExpired);
  });
});

describe('folder sync', () => {
  it('folds in changes at most once per interval', async () => {
    const { linking, links, folder, opener } = await setup();
    await linking.begin(ALICE, 'https://x/cb', 'alice');
    const { pod } = await linking.complete('nonce1', 'code', 'https://x/cb');
    let now = 0;
    const sync = new FolderSync(pod, links, opener.open(), 30_000, () => now);
    folder.editOutOfBand('/notes/a.txt', 'edited in Dropbox');
    expect(await sync.syncIfStale()).toBe(1);
    folder.editOutOfBand('/notes/a.txt', 'edited again');
    now += 10_000;
    expect(await sync.syncIfStale()).toBe(0);
    now += 30_000;
    expect(await sync.syncIfStale()).toBe(1);
    expect(await textOf((await pod.read('/notes/a.txt', { webid: ALICE }, { accept: null, range: null, head: false })).body)).toBe('edited again');
  });
});
