// The Dropbox adapter against real Dropbox. Needs DROPBOX_LIVE_TOKEN, an
// access token for the app folder (the App Console's "Generate access token"
// gives one for your own account). Works in a scratch subfolder it removes.

import { afterAll, describe, expect, it } from 'vitest';
import { RevisionConflict } from '../app/ports.js';
import { DropboxFileStore } from '../runtime/adapters/dropbox.js';
import { streamOf, textOf } from './support/fakes.js';

const TOKEN = process.env.DROPBOX_LIVE_TOKEN;
const DIR = `live-test-${Date.now().toString(36)}`;
const bytes = (s: string) => new TextEncoder().encode(s);

describe.skipIf(!TOKEN)('DropboxFileStore on real Dropbox', () => {
  const files = new DropboxFileStore({ fetch: (u, i) => fetch(u, i), accessToken: async () => TOKEN!, chunkSize: 4 * 1024 * 1024 });

  afterAll(async () => {
    if (TOKEN) await files.removeFolder(`${DIR}/`);
  });

  it('round-trips a file with ranges and revisions', async () => {
    const first = await files.write(`${DIR}/café notes/a b.txt`, bytes('0123456789'), { ifRev: null });
    await expect(files.write(`${DIR}/café notes/a b.txt`, bytes('x'), { ifRev: null })).rejects.toThrow(RevisionConflict);
    const read = await files.read(`${DIR}/café notes/a b.txt`, { start: 2, end: 4 });
    expect(await textOf(read!.body)).toBe('234');
    expect(read!.rev).toBe(first.rev);
    const second = await files.write(`${DIR}/café notes/a b.txt`, bytes('new'), { ifRev: first.rev });
    await expect(files.write(`${DIR}/café notes/a b.txt`, bytes('stale'), { ifRev: first.rev })).rejects.toThrow(RevisionConflict);
    expect(second.size).toBe(3);
    expect(await files.read(`${DIR}/missing.txt`)).toBeNull();
  });

  it('streams a body larger than one upload piece', async () => {
    const big = 'z'.repeat(9 * 1024 * 1024 + 7);
    const info = await files.write(`${DIR}/big.bin`, streamOf(big));
    expect(info.size).toBe(big.length);
    const tail = await files.read(`${DIR}/big.bin`, { start: big.length - 3, end: big.length - 1 });
    expect(await textOf(tail!.body)).toBe('zzz');
  });

  it('lists the folder and then reports changes', async () => {
    await files.makeFolder(`${DIR}/listed/`);
    await files.write(`${DIR}/listed/one.txt`, bytes('1'));
    const all = await files.listAll();
    expect(all.entries.some((e) => e.path === `${DIR}/listed/one.txt` && e.kind === 'file')).toBe(true);
    await files.remove(`${DIR}/listed/one.txt`);
    await files.write(`${DIR}/listed/two.txt`, bytes('2'));
    const changes = await files.changes(all.cursor);
    const seen = changes.entries.map((e) => `${e.kind} ${e.path.toLowerCase()}`);
    expect(seen).toContain(`deleted ${DIR}/listed/one.txt`.toLowerCase());
    expect(seen).toContain(`file ${DIR}/listed/two.txt`.toLowerCase());
  });
});
