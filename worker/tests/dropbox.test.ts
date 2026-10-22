import { describe, expect, it } from 'vitest';
import { InsufficientStorage, StorageUnavailable } from '../app/errors.js';
import { NO_CONDITIONS, Pod } from '../app/pod.js';
import { RevisionConflict } from '../app/ports.js';
import { DropboxFileStore, dropboxPath, headerJson } from '../runtime/adapters/dropbox.js';
import { FakeDropbox } from './support/fakeDropbox.js';
import { ALICE, BASE, PROFILE, sqliteIndex, streamOf, textOf } from './support/fakes.js';

function store(fake = new FakeDropbox(), chunkSize = 8) {
  const refreshes: boolean[] = [];
  let current = 'stale-token';
  const files = new DropboxFileStore({
    fetch: fake.fetch,
    accessToken: async (refresh) => {
      refreshes.push(refresh);
      if (refresh) current = fake.validToken;
      return current;
    },
    sleep: async () => {},
    chunkSize,
  });
  return { fake, files, refreshes };
}

const bytes = (s: string) => new TextEncoder().encode(s);

describe('DropboxFileStore', () => {
  it('maps folder-relative paths to Dropbox paths', () => {
    expect(dropboxPath('')).toBe('');
    expect(dropboxPath('a/')).toBe('/a');
    expect(dropboxPath('a/b.ttl')).toBe('/a/b.ttl');
  });

  it('escapes non-ASCII in the API argument header', () => {
    expect(headerJson({ path: '/café' })).toBe('{"path":"/caf\\u00e9"}');
  });

  it('writes, reads and ranges a file, refreshing the token once', async () => {
    const { fake, files, refreshes } = store();
    const info = await files.write('notes/café.txt', bytes('0123456789'));
    expect(fake.files()['/notes/café.txt']).toBe('0123456789');
    expect(refreshes).toEqual([false, true]);
    const whole = await files.read('notes/café.txt');
    expect(whole?.rev).toBe(info.rev);
    expect(await textOf(whole!.body)).toBe('0123456789');
    const part = await files.read('notes/café.txt', { start: 3, end: 5 });
    expect(await textOf(part!.body)).toBe('345');
    expect(part!.size).toBe(10);
    expect(await files.read('missing.txt')).toBeNull();
  });

  it('enforces revision preconditions', async () => {
    const { files } = store();
    const first = await files.write('a.txt', bytes('1'), { ifRev: null });
    await expect(files.write('a.txt', bytes('2'), { ifRev: null })).rejects.toThrow(RevisionConflict);
    await expect(files.write('a.txt', bytes('2'), { ifRev: 'stale' })).rejects.toThrow(RevisionConflict);
    const second = await files.write('a.txt', bytes('2'), { ifRev: first.rev });
    expect(second.rev).not.toBe(first.rev);
    await files.write('a.txt', bytes('3'));
  });

  it('streams a large body through an upload session in fixed pieces', async () => {
    const { fake, files } = store(new FakeDropbox(), 4);
    await files.makeFolder('warm/');
    fake.calls.length = 0;
    const text = 'abcdefghijklmnopqrstuvwxyz';
    const info = await files.write('big.bin', streamOf(text));
    expect(fake.files()['/big.bin']).toBe(text);
    expect(info.size).toBe(26);
    expect(fake.calls.filter((c) => c.startsWith('files/upload_session/'))).toEqual([
      'files/upload_session/start',
      ...Array(6).fill('files/upload_session/append_v2'),
      'files/upload_session/finish',
    ]);
  });

  it('uploads a short stream in one call', async () => {
    const { fake, files } = store(new FakeDropbox(), 64);
    await files.write('small.txt', streamOf('tiny'));
    expect(fake.calls.filter((c) => c.startsWith('files/upload'))).toEqual(['files/upload', 'files/upload']);
  });

  it('retries write contention and reports a full account', async () => {
    const { fake, files } = store();
    fake.contention = 2;
    await files.write('c.txt', bytes('x'));
    expect(fake.files()['/c.txt']).toBe('x');
    fake.freeSpace = 0;
    await expect(files.write('d.txt', bytes('x'))).rejects.toThrow(InsufficientStorage);
  });

  it('reports a revoked link as unavailable storage', async () => {
    const fake = new FakeDropbox();
    const files = new DropboxFileStore({ fetch: fake.fetch, accessToken: async () => 'revoked', sleep: async () => {} });
    await expect(files.write('e.txt', bytes('x'))).rejects.toThrow(StorageUnavailable);
  });

  it('treats existing folders and missing files as done', async () => {
    const { files } = store();
    await files.makeFolder('a/b/');
    await files.makeFolder('a/b/');
    await files.makeFolder('');
    await files.remove('never.txt');
    await expect(files.removeFolder('')).rejects.toThrow();
  });

  it('lists everything, then only what changed', async () => {
    const { fake, files } = store();
    await files.write('x/1.txt', bytes('1'));
    const all = await files.listAll();
    expect(all.entries.map((e) => [e.kind, e.path]).sort()).toEqual([
      ['file', 'x/1.txt'],
      ['folder', 'x/'],
    ]);
    fake.editOutOfBand('/x/2.txt', '2');
    await files.remove('x/1.txt');
    const changes = await files.listChanges(all.cursor);
    expect(changes.entries.map((e) => [e.kind, e.path])).toEqual([
      ['file', 'x/2.txt'],
      ['deleted', 'x/1.txt'],
    ]);
  });
});

describe('a pod on Dropbox', () => {
  it('provisions, stores and refuses a case collision Dropbox would merge', async () => {
    const { fake, files } = store();
    let id = 0;
    const pod = new Pod({ index: sqliteIndex(), files, base: BASE, now: () => new Date(), newId: () => `i${++id}` });
    await pod.provision(ALICE, PROFILE);
    await pod.put('/Notes/a.ttl', { webid: ALICE }, { stream: streamOf('<#a> <#b> "c".') }, 'text/turtle', NO_CONDITIONS);
    expect(Object.keys(fake.files()).sort()).toEqual(['/.acl', '/Notes/a.ttl', '/profile/card$.ttl', '/profile/card.acl']);
    await expect(
      pod.put('/notes/a.ttl', { webid: ALICE }, { stream: streamOf('<#x> <#y> "z".') }, 'text/turtle', NO_CONDITIONS),
    ).rejects.toThrow(/different case/);
  });
});
