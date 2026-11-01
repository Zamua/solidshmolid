import { describe, expect, it } from 'vitest';
import { Pod } from '../app/pods/pod.js';
import { Conflict, StorageUnavailable } from '../app/shared/errors.js';
import { type PlacementEvent, type PlacementState, nextPlacement, placePod } from '../app/storage/placement.js';
import { FolderSync } from '../app/storage/sync.js';
import type { Placement, PlacementStore, PodPlacement } from '../app/storage/ports.js';
import { NO_CONDITIONS } from '../domain/pods/requests.js';
import { DropboxFileStore } from '../runtime/adapters/dropbox.js';
import { FakeDropbox } from './support/fakeDropbox.js';
import { ALICE, BASE, BOB, PROFILE, sqliteIndex, streamOf, textOf } from './support/fakes.js';

const READ = { accept: null, range: null, head: false } as const;

const TARGET: Placement = { accountKey: 'k1', linkId: 'l1', provider: 'dropbox', folder: 'k3x9fqm7' };

class MemoryPlacement implements PlacementStore {
  value: PodPlacement = { state: 'unplaced' };
  current() {
    return this.value;
  }
  save(p: PodPlacement) {
    this.value = p;
  }
}

const cursorOf = (p: PodPlacement) => (p.state === 'placed' ? p.cursor : null);

function setup(folder = new FakeDropbox(), root = 'k3x9fqm7') {
  const storage = new DropboxFileStore({ fetch: folder.fetch, accessToken: async () => folder.validToken, sleep: async () => {}, root });
  let id = 0;
  const pod = new Pod({ index: sqliteIndex(), files: storage, base: BASE, now: () => new Date(), newId: () => `i${++id}` });
  return { folder, storage, pod, cursor: new MemoryPlacement() };
}

describe('placing a pod in its folder', () => {
  it('creates a new pod with its WebID profile in an empty folder', async () => {
    const { folder, storage, pod, cursor } = setup();
    expect(await placePod(pod, storage, cursor, TARGET, { owner: ALICE, profile: PROFILE })).toBe('created');
    expect(Object.keys(folder.files()).sort()).toEqual(['/k3x9fqm7/.acl', '/k3x9fqm7/profile/card$.ttl', '/k3x9fqm7/profile/card.acl']);
    expect(cursorOf(cursor.value)).toBeTruthy();
    expect((await pod.modes('/', { webid: ALICE })).has('control')).toBe(true);
    expect((await pod.modes('/profile/card', { webid: null })).has('read')).toBe(true);
    expect((await pod.modes('/', { webid: null })).size).toBe(0);
    expect((await pod.modes('/', { webid: BOB })).size).toBe(0);
  });

  it('takes the cursor before writing, so no listing after provisioning can leave the pod half placed', async () => {
    const { storage, pod, cursor } = setup();
    let listings = 0;
    const flaky = Object.assign(Object.create(storage) as DropboxFileStore, {
      listAll: async () => {
        if (listings++ > 0) throw new StorageUnavailable('Dropbox is down');
        return storage.listAll();
      },
    });
    expect(await placePod(pod, flaky, cursor, TARGET, { owner: ALICE, profile: PROFILE })).toBe('created');
    expect(cursorOf(cursor.value)).toBeTruthy();
    const root = (await pod.read('/', { webid: ALICE }, READ)).etag;
    await new FolderSync(pod, cursor, storage, 0, () => 0).syncIfStale();
    expect((await pod.read('/', { webid: ALICE }, READ)).etag).toBe(root);
  });

  it('creates a further pod without a profile', async () => {
    const { folder, storage, pod, cursor } = setup();
    expect(await placePod(pod, storage, cursor, TARGET, { owner: ALICE, profile: null })).toBe('created');
    expect(Object.keys(folder.files())).toEqual(['/k3x9fqm7/.acl']);
  });

  it('adopts the pod already in a folder, leaving its files as they are', async () => {
    const folder = new FakeDropbox();
    folder.editOutOfBand('/k3x9fqm7/.acl', `<#o> a <http://www.w3.org/ns/auth/acl#Authorization>; <http://www.w3.org/ns/auth/acl#agent> <${ALICE}>; <http://www.w3.org/ns/auth/acl#accessTo> <./>; <http://www.w3.org/ns/auth/acl#default> <./>; <http://www.w3.org/ns/auth/acl#mode> <http://www.w3.org/ns/auth/acl#Read>.`);
    folder.editOutOfBand('/k3x9fqm7/old/note.txt', 'from an earlier life');
    folder.editOutOfBand('/elsewhere/secret.txt', 'not this pod');
    const { storage, pod, cursor } = setup(folder);
    expect(await placePod(pod, storage, cursor, TARGET, { owner: ALICE, profile: PROFILE })).toBe('adopted');
    expect(await textOf((await pod.read('/old/note.txt', { webid: ALICE }, READ)).body)).toBe('from an earlier life');
    expect(folder.files()['/k3x9fqm7/profile/card$.ttl']).toBeUndefined();
    expect((await pod.modes('/', { webid: BOB })).size).toBe(0);
    await expect(pod.read('/secret.txt', { webid: ALICE }, READ)).rejects.toThrow();
  });

  it('then folds in edits made in the folder, at most once per interval', async () => {
    const { folder, storage, pod, cursor } = setup();
    await placePod(pod, storage, cursor, TARGET, { owner: ALICE, profile: PROFILE });
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

describe('the placement lifecycle', () => {
  const listing = (files: string[]) => ({ cursor: 'c0', entries: files.map((path) => ({ kind: 'file' as const, path, rev: 'r', size: 1, modified: null })) });
  const run = (start: PlacementState, events: PlacementEvent[]) => {
    let state = start;
    const steps = events.map((e) => {
      const next = nextPlacement(state, e);
      state = next.state;
      return next.step.kind;
    });
    return { state, steps };
  };

  it('lists, then provisions an empty folder or adopts a full one, and keeps the first listing cursor', () => {
    const place = { kind: 'place', target: TARGET } as const;
    expect(run({ state: 'unplaced' }, [place, { kind: 'listed', listing: listing([]) }, { kind: 'ready' }])).toEqual({
      state: { state: 'placed', target: TARGET, cursor: 'c0' },
      steps: ['list', 'provision', 'done'],
    });
    expect(run({ state: 'unplaced' }, [place, { kind: 'listed', listing: listing(['.acl']) }, { kind: 'ready' }]).steps).toEqual(['list', 'adopt', 'done']);
  });

  it('starts over from an interrupted placement, and stores writing as placing', () => {
    const writing = run({ state: 'unplaced' }, [{ kind: 'place', target: TARGET }, { kind: 'listed', listing: listing([]) }]).state;
    expect(writing.state).toBe('writing');
    expect(run(writing, [{ kind: 'place', target: TARGET }])).toEqual({ state: { state: 'placing', target: TARGET }, steps: ['list'] });
  });

  it('is a no-op where it finished, refuses elsewhere, and advances the cursor on sync', () => {
    const placed: PlacementState = { state: 'placed', target: TARGET, cursor: 'c0' };
    expect(run(placed, [{ kind: 'place', target: TARGET }]).steps).toEqual(['done']);
    expect(() => nextPlacement(placed, { kind: 'place', target: { ...TARGET, linkId: 'l2' } })).toThrow(Conflict);
    expect(run(placed, [{ kind: 'synced', cursor: 'c1' }]).state).toEqual({ ...placed, cursor: 'c1' });
  });

  it('rejects events out of order', () => {
    expect(() => nextPlacement({ state: 'unplaced' }, { kind: 'ready' })).toThrow();
    expect(() => nextPlacement({ state: 'unplaced' }, { kind: 'synced', cursor: 'c' })).toThrow();
    expect(() => nextPlacement({ state: 'placing', target: TARGET }, { kind: 'ready' })).toThrow();
    expect(() => nextPlacement({ state: 'placed', target: TARGET, cursor: 'c' }, { kind: 'listed', listing: listing([]) })).toThrow();
  });
});
