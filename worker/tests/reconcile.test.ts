import { describe, expect, it } from 'vitest';
import { NotFound } from '../app/shared/errors.js';
import { type Agent, Pod, type ReadOptions } from '../app/pods/pod.js';
import { NO_CONDITIONS } from '../domain/pods/requests.js';
import { ALICE, BASE, BOB, MemoryFileStore, PROFILE, newPod, sqliteIndex, streamOf, textOf } from './support/fakes.js';

const alice: Agent = { webid: ALICE };
const GET: ReadOptions = { accept: null, range: null, head: false };
const body = (s: string) => ({ stream: streamOf(s) });

/** A second pod over the same folder with an empty index: what a re-link sees. */
function sameFolder(files: MemoryFileStore) {
  let id = 0;
  return new Pod({ index: sqliteIndex(), files, base: BASE, now: () => new Date('2026-10-23T00:00:00Z'), newId: () => `r${++id}` });
}

async function snapshot(pod: Pod, paths: string[], agent: Agent = alice) {
  const out: Record<string, string> = {};
  for (const p of paths) {
    const r = await pod.read(p, agent, { ...GET, accept: 'application/n-triples, */*;q=0.5' }).catch((e) => e);
    // Container modification times are not in the folder, so a rebuild resets them.
    const text = r instanceof Error ? '' : (await textOf(r.body)).split('\n').filter((l) => !l.includes('/dc/terms/modified')).join('\n');
    out[p] = r instanceof Error ? r.name : `${r.contentType} ${text}`;
  }
  return out;
}

describe('adopting an existing folder', () => {
  it('rebuilds an index that serves what the original pod served', async () => {
    const { pod, files } = await newPod();
    await pod.put('/notes/a.ttl', alice, body('<#a> <#b> "c".'), 'text/turtle', NO_CONDITIONS);
    await pod.put('/notes/odd', alice, body('?'), 'application/x-odd', NO_CONDITIONS);
    await pod.put('/a%3Ab/c.txt', alice, body('colon'), 'text/plain', NO_CONDITIONS);
    await pod.put('/empty/', alice, body(''), null, NO_CONDITIONS);
    const shared = `@prefix acl: <http://www.w3.org/ns/auth/acl#>.
<#o> a acl:Authorization; acl:agent <${ALICE}>; acl:accessTo <./>; acl:default <./>; acl:mode acl:Read, acl:Write, acl:Control.
<#b> a acl:Authorization; acl:agent <${BOB}>; acl:accessTo <./>; acl:default <./>; acl:mode acl:Read.`;
    await pod.put('/notes/.acl', alice, body(shared), 'text/turtle', NO_CONDITIONS);
    const paths = ['/', '/notes/', '/notes/a.ttl', '/notes/odd', '/a%3Ab/', '/a%3Ab/c.txt', '/empty/', '/profile/card', '/notes/.acl'];

    const adopted = sameFolder(files);
    const report = await adopted.adopt(ALICE, files.listing());
    expect(report.skipped).toEqual([]);
    expect(adopted.isProvisioned()).toBe(true);
    expect(await snapshot(adopted, paths)).toEqual(await snapshot(pod, paths));
    expect(await snapshot(adopted, ['/notes/a.ttl', '/'], { webid: BOB })).toEqual(await snapshot(pod, ['/notes/a.ttl', '/'], { webid: BOB }));
  });

  it('skips what it cannot map and what belongs to another server', async () => {
    const files = new MemoryFileStore();
    for (const [f, t] of [
      ['card$.ttl', '<#a> <#b> 1.'],
      ['card$.txt', 'shadow'],
      ['bad%zz', 'x'],
      ['.internal/setup/x$.json', '{}'],
    ]) {
      await files.write(f!, new TextEncoder().encode(t));
    }
    const pod = sameFolder(files);
    const report = await pod.adopt(ALICE, files.listing());
    expect(report.skipped.map((s) => s.file).sort()).toEqual(['bad%zz', 'card$.txt']);
    await expect(pod.read('/.internal/', alice, GET)).rejects.toThrow();
  });
});

describe('changes made outside the server', () => {
  it('serves an edited file, forgets a deleted one and lists a new one', async () => {
    const { pod, files } = await newPod();
    await pod.put('/n/a.txt', alice, body('one'), 'text/plain', NO_CONDITIONS);
    await pod.put('/n/b.txt', alice, body('bee'), 'text/plain', NO_CONDITIONS);
    const before = await pod.read('/n/', alice, GET);

    const edited = await files.write('n/a.txt', new TextEncoder().encode('two'));
    await files.remove('n/b.txt');
    const added = await files.write('n/c.ttl', new TextEncoder().encode('<#c> <#d> 1.'));
    await pod.applyChanges([
      { kind: 'file', path: 'n/a.txt', rev: edited.rev, size: 3, modified: null },
      { kind: 'deleted', path: 'n/b.txt' },
      { kind: 'file', path: 'n/c.ttl', rev: added.rev, size: 12, modified: null },
    ]);

    expect(await textOf((await pod.read('/n/a.txt', alice, GET)).body)).toBe('two');
    await expect(pod.read('/n/b.txt', alice, GET)).rejects.toThrow(NotFound);
    const after = await pod.read('/n/', alice, GET);
    expect(after.etag).not.toBe(before.etag);
    const listed = await textOf(after.body);
    expect(listed).toContain('<c.ttl>');
    expect(listed).not.toContain('<b.txt>');
  });

  it('reads the index once for a folder deleted file by file, whatever its size', async () => {
    const { pod, index } = await newPod();
    const names = Array.from({ length: 40 }, (_, i) => `photos/p${i}.txt`);
    for (const name of names) await pod.put(`/${name}`, alice, body('x'), 'text/plain', NO_CONDITIONS);
    await pod.put('/keep/k.txt', alice, body('k'), 'text/plain', NO_CONDITIONS);
    let listings = 0;
    const children = index.children.bind(index);
    index.children = (container) => {
      listings++;
      return children(container);
    };
    const report = await pod.applyChanges([...names.map((path) => ({ kind: 'deleted' as const, path })), { kind: 'deleted', path: 'photos' }]);
    expect(report.removed).toBe(41);
    // One walk of the four containers, not one per deleted entry.
    expect(listings).toBeLessThan(10);
    await expect(pod.read('/photos/', alice, GET)).rejects.toThrow(NotFound);
    expect(await textOf((await pod.read('/keep/k.txt', alice, GET)).body)).toBe('k');
  });

  it('a read that finds a newer file takes its revision into the index', async () => {
    const { pod, files } = await newPod();
    await pod.put('/n/a.txt', alice, body('one'), 'text/plain', NO_CONDITIONS);
    const before = (await pod.read('/n/a.txt', alice, { ...GET, head: true })).etag;
    await files.write('n/a.txt', new TextEncoder().encode('two!'));
    const got = await pod.read('/n/a.txt', alice, GET);
    expect(got.etag).not.toBe(before);
    const head = await pod.read('/n/a.txt', alice, { ...GET, head: true });
    expect([head.etag, head.size]).toEqual([got.etag, 4]);
  });

  it('drops a whole deleted folder', async () => {
    const { pod } = await newPod();
    await pod.put('/tree/x/y.txt', alice, body('y'), 'text/plain', NO_CONDITIONS);
    await pod.applyChanges([{ kind: 'deleted', path: 'tree' }]);
    await expect(pod.read('/tree/x/y.txt', alice, GET)).rejects.toThrow(NotFound);
    await expect(pod.read('/tree/', alice, GET)).rejects.toThrow(NotFound);
  });
});

describe('a name that differs from a held one only in case', () => {
  const merging = async () => {
    const files = new MemoryFileStore(true);
    let id = 0;
    const index = sqliteIndex();
    const pod = new Pod({ index, files, base: BASE, now: () => new Date('2026-10-23T00:00:00Z'), newId: () => `m${++id}` });
    await pod.provision(ALICE, PROFILE);
    return { pod, files };
  };
  const entry = (path: string, rev: string) => ({ kind: 'file' as const, path, rev, size: 1, modified: null });

  it('is the same file renamed, where the storage merges case: the resource moves', async () => {
    const { pod, files } = await merging();
    await pod.put('/n/Foo.txt', alice, body('one'), 'text/plain', NO_CONDITIONS);
    files.files.set('n/foo.txt', files.files.get('n/Foo.txt')!);
    files.files.delete('n/Foo.txt');
    const edited = await files.write('n/foo.txt', new TextEncoder().encode('two'));
    const report = await pod.applyChanges([entry('n/foo.txt', edited.rev)]);
    expect(report).toMatchObject({ updated: 1, skipped: [] });
    expect(await textOf((await pod.read('/n/foo.txt', alice, GET)).body)).toBe('two');
    await expect(pod.read('/n/Foo.txt', alice, GET)).rejects.toThrow(NotFound);
  });

  it('goes under the folder as the pod already spells it', async () => {
    const { pod, files } = await merging();
    await pod.put('/Photos/a.txt', alice, body('a'), 'text/plain', NO_CONDITIONS);
    const added = await files.write('photos/b.txt', new TextEncoder().encode('b'));
    const report = await pod.applyChanges([{ kind: 'folder', path: 'photos/' }, entry('photos/b.txt', added.rev)]);
    expect(report).toMatchObject({ updated: 1, skipped: [] });
    expect(await textOf((await pod.read('/Photos/b.txt', alice, GET)).body)).toBe('b');
    expect((await pod.applyChanges([{ kind: 'deleted', path: 'PHOTOS' }])).removed).toBe(3);
    await expect(pod.read('/Photos/', alice, GET)).rejects.toThrow(NotFound);
  });

  it('is another file where the storage tells them apart: skipped, and the rest still applied', async () => {
    const { pod, files } = await newPod();
    await pod.put('/n/Foo.txt', alice, body('one'), 'text/plain', NO_CONDITIONS);
    const twin = await files.write('n/foo.txt', new TextEncoder().encode('twin'));
    const later = await files.write('n/later.txt', new TextEncoder().encode('later'));
    const report = await pod.applyChanges([entry('n/foo.txt', twin.rev), entry('N/x.txt', 'r0'), entry('n/later.txt', later.rev)]);
    expect(report.skipped.map((s) => s.file)).toEqual(['n/foo.txt', 'N/x.txt']);
    expect(await textOf((await pod.read('/n/Foo.txt', alice, GET)).body)).toBe('one');
    expect(await textOf((await pod.read('/n/later.txt', alice, GET)).body)).toBe('later');
  });

  it('does not stop a folder that holds both from being adopted', async () => {
    const { files } = await newPod();
    for (const f of ['A.txt', 'a.txt', 'Dir/x.txt', 'dir/y.txt']) await files.write(f, new TextEncoder().encode(f));
    const pod = sameFolder(files);
    const report = await pod.adopt(ALICE, files.listing());
    // Which of two files keeps the name is the listing's order; one does.
    expect(report.skipped.map((s) => s.file.toLowerCase()).sort()).toEqual(['a.txt', 'dir/', 'dir/y.txt']);
    const [a, A] = await Promise.all(['/a.txt', '/A.txt'].map((p) => pod.read(p, alice, GET).then(() => 1, () => 0)));
    expect(a! + A!).toBe(1);
    expect(await textOf((await pod.read('/Dir/x.txt', alice, GET)).body)).toBe('Dir/x.txt');
  });

  it('one entry the index cannot take is reported, not thrown', async () => {
    const { pod, index, files } = await newPod();
    const upsert = index.upsert.bind(index);
    index.upsert = (row) => {
      if (row.path === '/bad.txt') throw new Error('no');
      upsert(row);
    };
    const good = await files.write('good.txt', new TextEncoder().encode('g'));
    const report = await pod.applyChanges([entry('bad.txt', 'r0'), entry('good.txt', good.rev)]);
    expect(report.skipped).toEqual([{ file: 'bad.txt', reason: 'no' }]);
    expect(await textOf((await pod.read('/good.txt', alice, GET)).body)).toBe('g');
  });
});
