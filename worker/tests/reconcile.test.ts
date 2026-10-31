import { describe, expect, it } from 'vitest';
import { NotFound } from '../app/shared/errors.js';
import { type Agent, Pod, type ReadOptions } from '../app/pods/pod.js';
import { NO_CONDITIONS } from '../domain/pods/requests.js';
import { ALICE, BASE, BOB, MemoryFileStore, newPod, sqliteIndex, streamOf, textOf } from './support/fakes.js';

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

  it('drops a whole deleted folder', async () => {
    const { pod } = await newPod();
    await pod.put('/tree/x/y.txt', alice, body('y'), 'text/plain', NO_CONDITIONS);
    await pod.applyChanges([{ kind: 'deleted', path: 'tree' }]);
    await expect(pod.read('/tree/x/y.txt', alice, GET)).rejects.toThrow(NotFound);
    await expect(pod.read('/tree/', alice, GET)).rejects.toThrow(NotFound);
  });
});
