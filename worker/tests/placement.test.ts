import { describe, expect, it } from 'vitest';
import { Pod } from '../app/pods/pod.js';
import { placePod } from '../app/storage/placement.js';
import { FolderSync } from '../app/storage/sync.js';
import type { SyncCursor } from '../app/storage/ports.js';
import { NO_CONDITIONS } from '../domain/pods/requests.js';
import { DropboxFileStore } from '../runtime/adapters/dropbox.js';
import { FakeDropbox } from './support/fakeDropbox.js';
import { ALICE, BASE, BOB, PROFILE, sqliteIndex, streamOf, textOf } from './support/fakes.js';

const READ = { accept: null, range: null, head: false } as const;

class MemoryCursor implements SyncCursor {
  value: string | null = null;
  async cursor() {
    return this.value;
  }
  async setCursor(c: string) {
    this.value = c;
  }
}

function setup(folder = new FakeDropbox(), root = 'k3x9fqm7') {
  const storage = new DropboxFileStore({ fetch: folder.fetch, accessToken: async () => folder.validToken, sleep: async () => {}, root });
  let id = 0;
  const pod = new Pod({ index: sqliteIndex(), files: storage, base: BASE, now: () => new Date(), newId: () => `i${++id}` });
  return { folder, storage, pod, cursor: new MemoryCursor() };
}

describe('placing a pod in its folder', () => {
  it('creates a new pod with its WebID profile in an empty folder', async () => {
    const { folder, storage, pod, cursor } = setup();
    expect(await placePod(pod, storage, cursor, { owner: ALICE, profile: PROFILE })).toBe('created');
    expect(Object.keys(folder.files()).sort()).toEqual(['/k3x9fqm7/.acl', '/k3x9fqm7/profile/card$.ttl', '/k3x9fqm7/profile/card.acl']);
    expect(cursor.value).toBeTruthy();
    expect((await pod.modes('/', { webid: ALICE })).has('control')).toBe(true);
    expect((await pod.modes('/profile/card', { webid: null })).has('read')).toBe(true);
    expect((await pod.modes('/', { webid: null })).size).toBe(0);
    expect((await pod.modes('/', { webid: BOB })).size).toBe(0);
  });

  it('creates a further pod without a profile', async () => {
    const { folder, storage, pod, cursor } = setup();
    expect(await placePod(pod, storage, cursor, { owner: ALICE, profile: null })).toBe('created');
    expect(Object.keys(folder.files())).toEqual(['/k3x9fqm7/.acl']);
  });

  it('adopts the pod already in a folder, leaving its files as they are', async () => {
    const folder = new FakeDropbox();
    folder.editOutOfBand('/k3x9fqm7/.acl', `<#o> a <http://www.w3.org/ns/auth/acl#Authorization>; <http://www.w3.org/ns/auth/acl#agent> <${ALICE}>; <http://www.w3.org/ns/auth/acl#accessTo> <./>; <http://www.w3.org/ns/auth/acl#default> <./>; <http://www.w3.org/ns/auth/acl#mode> <http://www.w3.org/ns/auth/acl#Read>.`);
    folder.editOutOfBand('/k3x9fqm7/old/note.txt', 'from an earlier life');
    folder.editOutOfBand('/elsewhere/secret.txt', 'not this pod');
    const { storage, pod, cursor } = setup(folder);
    expect(await placePod(pod, storage, cursor, { owner: ALICE, profile: PROFILE })).toBe('adopted');
    expect(await textOf((await pod.read('/old/note.txt', { webid: ALICE }, READ)).body)).toBe('from an earlier life');
    expect(folder.files()['/k3x9fqm7/profile/card$.ttl']).toBeUndefined();
    expect((await pod.modes('/', { webid: BOB })).size).toBe(0);
    await expect(pod.read('/secret.txt', { webid: ALICE }, READ)).rejects.toThrow();
  });

  it('then folds in edits made in the folder, at most once per interval', async () => {
    const { folder, storage, pod, cursor } = setup();
    await placePod(pod, storage, cursor, { owner: ALICE, profile: PROFILE });
    await pod.put('/notes/a.txt', { webid: ALICE }, { stream: streamOf('v1') }, 'text/plain', NO_CONDITIONS);
    let now = 0;
    const sync = new FolderSync(pod, cursor, storage, 30_000, () => now);
    folder.editOutOfBand('/k3x9fqm7/notes/a.txt', 'edited in Dropbox');
    expect(await sync.syncIfStale()).toBeGreaterThan(0);
    folder.editOutOfBand('/k3x9fqm7/notes/a.txt', 'edited again');
    now += 10_000;
    expect(await sync.syncIfStale()).toBe(0);
    now += 30_000;
    expect(await sync.syncIfStale()).toBeGreaterThan(0);
    expect(await textOf((await pod.read('/notes/a.txt', { webid: ALICE }, READ)).body)).toBe('edited again');
  });
});
