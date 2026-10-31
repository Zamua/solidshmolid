import { describe, expect, it } from 'vitest';
import { InsufficientStorage, StorageUnavailable } from '../app/shared/errors.js';
import { Pod } from '../app/pods/pod.js';
import { RevisionConflict } from '../app/storage/ports.js';
import { NO_CONDITIONS } from '../domain/pods/requests.js';
import { type DriveNodes, MemoryDriveNodes, SqlDriveNodes } from '../runtime/adapters/driveNodes.js';
import { DriveFileStore, quote, segmentsOf } from '../runtime/adapters/googleDrive.js';
import { FakeGoogleDrive } from './support/fakeGoogleDrive.js';
import { ALICE, BASE, PROFILE, sqlRunner, sqliteIndex, streamOf, textOf } from './support/fakes.js';

function store(fake = new FakeGoogleDrive(), options: { chunkSize?: number; root?: string; nodes?: DriveNodes } = {}) {
  const refreshes: boolean[] = [];
  let current = 'stale-token';
  const files = new DriveFileStore({
    fetch: fake.fetch,
    accessToken: async (refresh) => {
      refreshes.push(refresh);
      if (refresh) current = fake.validToken;
      return current;
    },
    nodes: options.nodes ?? new MemoryDriveNodes(),
    root: options.root ?? 'pod1',
    sleep: async () => {},
    chunkSize: options.chunkSize ?? 8,
  });
  return { fake, files, refreshes };
}

const bytes = (s: string) => new TextEncoder().encode(s);
const kinds = (entries: { kind: string; path: string }[]) => entries.map((e) => [e.kind, e.path]);

describe('DriveFileStore', () => {
  it('splits paths into names and quotes them for queries', () => {
    expect(segmentsOf('')).toEqual([]);
    expect(segmentsOf('a/')).toEqual(['a']);
    expect(segmentsOf('a/b.ttl')).toEqual(['a', 'b.ttl']);
    expect(quote("it's a \\ path")).toBe("it\\'s a \\\\ path");
  });

  it('writes, reads and ranges a file in the pod folder, refreshing the token once', async () => {
    const { fake, files, refreshes } = store();
    const info = await files.write("notes/it's café.txt", bytes('0123456789'));
    expect(fake.files()["solidshmolid/pod1/notes/it's café.txt"]).toBe('0123456789');
    expect(refreshes.slice(0, 2)).toEqual([false, true]);
    const whole = await files.read("notes/it's café.txt");
    expect(whole?.rev).toBe(info.rev);
    expect(await textOf(whole!.body)).toBe('0123456789');
    const part = await files.read("notes/it's café.txt", { start: 3, end: 5 });
    expect(await textOf(part!.body)).toBe('345');
    expect(part!.size).toBe(10);
    expect(await files.read('missing.txt')).toBeNull();
    expect(await files.read('notes/')).toBeNull();
  });

  it('keeps every pod under one app folder', async () => {
    const fake = new FakeGoogleDrive();
    await store(fake, { root: 'pod1' }).files.write('a.txt', bytes('1'));
    await store(fake, { root: 'pod2' }).files.write('a.txt', bytes('2'));
    expect(fake.files()).toEqual({ 'solidshmolid/pod1/a.txt': '1', 'solidshmolid/pod2/a.txt': '2' });
  });

  it('enforces revision preconditions', async () => {
    const { files } = store();
    const first = await files.write('a.txt', bytes('1'), { ifRev: null });
    await expect(files.write('a.txt', bytes('2'), { ifRev: null })).rejects.toThrow(RevisionConflict);
    await expect(files.write('a.txt', bytes('2'), { ifRev: 'stale' })).rejects.toThrow(RevisionConflict);
    await expect(files.write('b.txt', bytes('2'), { ifRev: first.rev })).rejects.toThrow(RevisionConflict);
    const second = await files.write('a.txt', bytes('2'), { ifRev: first.rev });
    expect(second.rev).not.toBe(first.rev);
    await files.write('a.txt', bytes('3'));
  });

  it('streams a large body through a resumable session in fixed pieces, new or replacing', async () => {
    const { fake, files } = store(new FakeGoogleDrive(), { chunkSize: 4 });
    await files.makeFolder('');
    fake.calls.length = 0;
    const text = 'abcdefghijklmnopqrstuvwxyz';
    const info = await files.write('big.bin', streamOf(text));
    expect(fake.files()['solidshmolid/pod1/big.bin']).toBe(text);
    expect(info.size).toBe(26);
    expect(fake.calls.filter((c) => c.includes('upload') || c.includes('/session/')).map((c) => c.replace(/s\d+$/u, 'N'))).toEqual([
      'POST /upload/drive/v3/files',
      ...Array(7).fill('PUT /session/N'),
    ]);
    await files.write('big.bin', streamOf(text.toUpperCase()));
    expect(fake.files()['solidshmolid/pod1/big.bin']).toBe(text.toUpperCase());
  });

  it('uploads a short stream in one call', async () => {
    const { fake, files } = store(new FakeGoogleDrive(), { chunkSize: 64 });
    await files.write('small.txt', streamOf('tiny'));
    await files.write('small.txt', streamOf('tinier'));
    expect(fake.calls.filter((c) => c.includes('upload'))).toEqual(['POST /upload/drive/v3/files', 'PATCH /upload/drive/v3/files/f3']);
    expect(fake.files()['solidshmolid/pod1/small.txt']).toBe('tinier');
  });

  it('waits out rate limits and reports a full account', async () => {
    const { fake, files } = store();
    fake.rateLimited = 2;
    await files.write('c.txt', bytes('x'));
    expect(fake.files()['solidshmolid/pod1/c.txt']).toBe('x');
    fake.freeSpace = 0;
    await expect(files.write('d.txt', bytes('x'))).rejects.toThrow(InsufficientStorage);
  });

  it('reports a revoked link as unavailable storage', async () => {
    const fake = new FakeGoogleDrive();
    const files = new DriveFileStore({ fetch: fake.fetch, accessToken: async () => 'revoked', nodes: new MemoryDriveNodes(), root: 'pod1', sleep: async () => {} });
    await expect(files.write('e.txt', bytes('x'))).rejects.toThrow(StorageUnavailable);
  });

  it('treats existing folders and missing files as done, and trashes what it removes', async () => {
    const { fake, files } = store();
    await files.makeFolder('a/b/');
    await files.makeFolder('a/b/');
    await files.makeFolder('');
    await files.remove('never.txt');
    await files.removeFolder('nowhere/');
    await expect(files.removeFolder('')).rejects.toThrow();
    await files.write('a/b/c.txt', bytes('c'));
    await files.remove('a/b/c.txt');
    expect(fake.files()).toEqual({});
    await files.write('a/b/c.txt', bytes('c'));
    await files.removeFolder('a/');
    expect(fake.files()).toEqual({});
    expect(await files.read('a/b/c.txt')).toBeNull();
  });

  it('serves the oldest of same-named files', async () => {
    const { fake, files } = store();
    await files.write('dup.txt', bytes('first'));
    fake.createOutOfBand('solidshmolid/pod1', 'dup.txt', 'second');
    expect(await textOf((await files.read('dup.txt'))!.body)).toBe('first');
    expect(kinds((await files.listAll()).entries)).toEqual([['file', 'dup.txt']]);
  });

  it('lists everything, then only what changed', async () => {
    const fake = new FakeGoogleDrive();
    const { files } = store(fake);
    await files.write('x/1.txt', bytes('1'));
    await files.write('x/2.txt', bytes('2'));
    await files.write('y/3.txt', bytes('3'));
    await store(fake, { root: 'pod2' }).files.write('elsewhere.txt', bytes('not this pod'));
    const all = await files.listAll();
    expect(kinds(all.entries)).toEqual([
      ['folder', 'x/'],
      ['folder', 'y/'],
      ['file', 'x/1.txt'],
      ['file', 'x/2.txt'],
      ['file', 'y/3.txt'],
    ]);
    fake.editOutOfBand('solidshmolid/pod1/x/1.txt', 'one');
    fake.trashOutOfBand('solidshmolid/pod1/x/2.txt');
    fake.renameOutOfBand('solidshmolid/pod1/y', 'z');
    await store(fake, { root: 'pod2' }).files.write('more.txt', bytes('still not this pod'));
    const changes = await files.changes(all.cursor);
    expect(kinds(changes.entries)).toEqual([
      ['file', 'x/1.txt'],
      ['deleted', 'x/2.txt'],
      ['deleted', 'y'],
      ['folder', 'z/'],
      ['file', 'z/3.txt'],
    ]);
    expect(changes.entries[0]).toMatchObject({ kind: 'file', rev: '2' });
    expect(kinds((await files.changes(changes.cursor)).entries)).toEqual([]);
  });

  it('places a new folder from the feed before or after its files', async () => {
    const fake = new FakeGoogleDrive();
    const { files } = store(fake);
    await files.makeFolder('');
    const { cursor } = await files.listAll();
    const other = store(fake).files;
    await other.write('new/deep/file.txt', bytes('hi'));
    const changes = await files.changes(cursor);
    expect(kinds(changes.entries)).toEqual([
      ['folder', 'new/'],
      ['folder', 'new/deep/'],
      ['file', 'new/deep/file.txt'],
    ]);
  });

  it('follows the feed across instances through the pod SQLite', async () => {
    const fake = new FakeGoogleDrive();
    const sql = sqlRunner();
    const first = store(fake, { nodes: new SqlDriveNodes(sql) }).files;
    await first.write('keep.txt', bytes('k'));
    await first.write('gone.txt', bytes('g'));
    const { cursor } = await first.listAll();
    fake.trashOutOfBand('solidshmolid/pod1/gone.txt');
    const later = store(fake, { nodes: new SqlDriveNodes(sql) }).files;
    expect(kinds((await later.changes(cursor)).entries)).toEqual([['deleted', 'gone.txt']]);
  });

  it('reports the whole pod gone when its folder is trashed', async () => {
    const fake = new FakeGoogleDrive();
    const { files } = store(fake);
    await files.write('a/1.txt', bytes('1'));
    await files.write('b.txt', bytes('b'));
    const { cursor } = await files.listAll();
    fake.trashOutOfBand('solidshmolid/pod1');
    expect(kinds((await files.changes(cursor)).entries)).toEqual([
      ['deleted', 'a'],
      ['deleted', 'b.txt'],
    ]);
  });
});

describe('a pod on Google Drive', () => {
  it('provisions and serves resources from the pod folder', async () => {
    const { fake, files } = store();
    let id = 0;
    const pod = new Pod({ index: sqliteIndex(), files, base: BASE, now: () => new Date(), newId: () => `i${++id}` });
    await pod.provision(ALICE, PROFILE);
    await pod.put('/notes/a.ttl', { webid: ALICE }, { stream: streamOf('<#a> <#b> "c".') }, 'text/turtle', NO_CONDITIONS);
    expect(Object.keys(fake.files()).sort()).toEqual([
      'solidshmolid/pod1/.acl',
      'solidshmolid/pod1/notes/a.ttl',
      'solidshmolid/pod1/profile/card$.ttl',
      'solidshmolid/pod1/profile/card.acl',
    ]);
    const read = await pod.read('/notes/a.ttl', { webid: ALICE }, { accept: 'text/turtle', range: null, head: false });
    expect(await textOf(read.body)).toContain('<#b>');
  });
});
