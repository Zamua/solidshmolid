import { describe, expect, it } from 'vitest';
import { Pod } from '../app/pods/pod.js';
import { Conflict, StorageUnavailable } from '../app/shared/errors.js';
import { type PlacementEvent, type PlacementState, nextPlacement, placePod } from '../app/storage/placement.js';
import { FolderSync, neverSynced } from '../app/storage/sync.js';
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

  it.each([2, 3])('finishes a first placement that stopped at write %i, so the WebID profile is public', async (failing) => {
    const { folder, storage, cursor } = setup();
    let writes = 0;
    const flaky = Object.assign(Object.create(storage) as DropboxFileStore, {
      write: async (...args: Parameters<DropboxFileStore['write']>) => {
        if (++writes === failing) throw new StorageUnavailable('Dropbox 503');
        return storage.write(...args);
      },
    });
    const index = sqliteIndex();
    let id = 0;
    const deps = { index, base: BASE, now: () => new Date(), newId: () => `r${++id}` };
    await expect(placePod(new Pod({ ...deps, files: flaky }), flaky, cursor, TARGET, { owner: ALICE, profile: PROFILE })).rejects.toThrow(StorageUnavailable);
    expect(cursor.value.state).toBe('placing');
    const acl = folder.files()['/k3x9fqm7/.acl'];

    const again = new Pod({ ...deps, files: storage });
    expect(await placePod(again, storage, cursor, TARGET, { owner: ALICE, profile: PROFILE })).toBe('created');
    expect(Object.keys(folder.files()).sort()).toEqual(['/k3x9fqm7/.acl', '/k3x9fqm7/profile/card$.ttl', '/k3x9fqm7/profile/card.acl']);
    expect(folder.files()['/k3x9fqm7/.acl']).toEqual(acl);
    expect((await again.modes('/profile/card', { webid: null })).has('read')).toBe(true);
    expect((await again.modes('/', { webid: ALICE })).has('control')).toBe(true);
    expect((await again.modes('/', { webid: null })).size).toBe(0);
  });

  it('finishes it from a fresh index too, as after connecting again', async () => {
    const { folder, storage, cursor } = setup();
    folder.editOutOfBand('/k3x9fqm7/.acl', 'left by the first attempt');
    const { pod } = setup(folder);
    expect(await placePod(pod, storage, cursor, { ...TARGET, linkId: 'l2' }, { owner: ALICE, profile: PROFILE })).toBe('created');
    expect(Object.keys(folder.files()).sort()).toEqual(['/k3x9fqm7/.acl', '/k3x9fqm7/profile/card$.ttl', '/k3x9fqm7/profile/card.acl']);
    expect(pod.isProvisioned()).toBe(true);
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

  it('keeps the interval across a sync that is built again', async () => {
    const { folder, storage, pod, cursor } = setup();
    await placePod(pod, storage, cursor, TARGET, { owner: ALICE, profile: PROFILE });
    const clock = neverSynced();
    const rebuilt = () => new FolderSync(pod, cursor, storage, 30_000, () => 5_000, clock);
    folder.editOutOfBand('/k3x9fqm7/notes/a.txt', 'one');
    expect(await rebuilt().syncIfStale()).toBeGreaterThan(0);
    folder.editOutOfBand('/k3x9fqm7/notes/a.txt', 'two');
    expect(await rebuilt().syncIfStale()).toBe(0);
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
    expect(run({ state: 'unplaced' }, [place, { kind: 'listed', listing: listing(['.acl', 'notes/a.txt']) }, { kind: 'ready' }]).steps).toEqual(['list', 'adopt', 'done']);
  });

  it('finishes, not adopts, a folder holding only what a new pod starts with', () => {
    const place = { kind: 'place', target: TARGET } as const;
    for (const left of [['.acl'], ['.acl', 'profile/card$.ttl'], ['.acl', 'profile/card$.ttl', 'profile/card.acl']]) {
      const { state, steps } = run({ state: 'unplaced' }, [place, { kind: 'listed', listing: listing(left) }]);
      expect(steps, left.join()).toEqual(['list', 'provision']);
      expect(state).toMatchObject({ state: 'writing', outcome: 'created' });
    }
    expect(run({ state: 'unplaced' }, [place, { kind: 'listed', listing: listing(['profile/card$.ttl', 'profile/photo.jpg']) }]).steps).toEqual(['list', 'adopt']);
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
