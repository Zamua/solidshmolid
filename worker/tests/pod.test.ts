import { describe, expect, it } from 'vitest';
import {
  BadRequest,
  Conflict,
  Forbidden,
  MethodNotAllowed,
  NotAcceptable,
  NotFound,
  PreconditionFailed,
  RangeNotSatisfiable,
  StorageUnavailable,
  Unauthenticated,
  Unprocessable,
  UnsupportedMediaType,
} from '../app/shared/errors.js';
import { type Agent, Pod, type ReadOptions } from '../app/pods/pod.js';
import { Serial } from '../app/shared/serial.js';
import { allowedMethods } from '../domain/pods/methods.js';
import { profileDocument } from '../domain/pods/profile.js';
import { NO_CONDITIONS } from '../domain/pods/requests.js';
import { ALICE, BASE, BOB, type MemoryFileStore, newPod, streamOf, textOf } from './support/fakes.js';

const alice: Agent = { webid: ALICE };
const bob: Agent = { webid: BOB };
const anon: Agent = { webid: null };
const GET: ReadOptions = { accept: null, range: null, head: false };
const body = (s: string) => ({ stream: streamOf(s) });
const TTL = 'text/turtle';
const N3 = 'text/n3';
const PRE = '@prefix solid: <http://www.w3.org/ns/solid/terms#>. @prefix ex: <http://example.org/>.\n';

async function read(pod: Awaited<ReturnType<typeof newPod>>['pod'], path: string, agent = alice, options = GET) {
  const r = await pod.read(path, agent, options);
  return { ...r, text: await textOf(r.body) };
}

describe('provisioning', () => {
  it('writes the root ACL and a public profile in the CSS layout', async () => {
    const { files } = await newPod();
    expect([...files.files.keys()].sort()).toEqual(['.acl', 'profile/card$.ttl', 'profile/card.acl']);
    expect([...files.folders].sort()).toEqual(['', 'profile/']);
  });

  it('serves the profile to anyone and the root to its owner only', async () => {
    const { pod } = await newPod();
    expect((await read(pod, '/profile/card', anon)).text).toContain('PersonalProfileDocument');
    await expect(pod.read('/', anon, GET)).rejects.toThrow(Unauthenticated);
    await expect(pod.read('/', bob, GET)).rejects.toThrow(Forbidden);
    const root = await read(pod, '/');
    expect(root.text).toContain('<profile/>');
    expect(root.text).toContain('pim:Storage');
    expect(root.text).not.toContain('.acl');
  });

  it('refuses a second provisioning', async () => {
    const { pod } = await newPod();
    await expect(pod.provision(ALICE, '')).rejects.toThrow(Conflict);
  });
});

describe('a file changed in the storage', () => {
  const edit = (files: MemoryFileStore, file: string, text: string) => files.files.set(file, { bytes: new TextEncoder().encode(text), rev: 'edited', modified: new Date(0).toISOString() });

  it('goes out under its new validator and size before sync has seen it', async () => {
    const { pod, files } = await newPod();
    await pod.put('/a.txt', alice, body('01'), 'text/plain', NO_CONDITIONS);
    const before = await read(pod, '/a.txt');
    edit(files, 'a.txt', 'edited in the storage, much longer');
    const whole = await read(pod, '/a.txt');
    expect(whole.text).toBe('edited in the storage, much longer');
    expect(whole.size).toBe(34);
    expect(whole.etag).not.toBe(before.etag);
    const part = await read(pod, '/a.txt', alice, { ...GET, range: { start: 1, end: null } });
    expect(part.text).toBe('dited in the storage, much longer');
    expect(part.size).toBe(34);
    expect(part.range).toEqual({ start: 1, end: 33 });
    expect(part.etag).toBe(whole.etag);
  });

  it('into RDF that does not parse is still read as stored, and says so to anything that needs its triples', async () => {
    const { pod, files, index } = await newPod();
    await pod.put('/notes.ttl', alice, body('<#a> <#b> <#c>.'), TTL, NO_CONDITIONS);
    edit(files, 'notes.ttl', '<#a> <#b> oops');
    index.setCachedText('/notes.ttl', null);
    expect((await read(pod, '/notes.ttl', alice, { ...GET, accept: 'application/ld+json, text/turtle;q=0.5' })).text).toBe('<#a> <#b> oops');
    await expect(pod.read('/notes.ttl', alice, { ...GET, accept: 'application/ld+json' })).rejects.toThrow(NotAcceptable);
    const insert = `${PRE}_:p a solid:InsertDeletePatch; solid:inserts { <#x> ex:p "1" }.`;
    await expect(pod.patch('/notes.ttl', alice, insert, N3, NO_CONDITIONS)).rejects.toThrow(/does not parse as text\/turtle/u);
    await expect(pod.patch('/notes.ttl', alice, insert, N3, NO_CONDITIONS)).rejects.toThrow(Conflict);
  });
});

describe('documents and containers', () => {
  it('creates intermediate containers on PUT and lists members', async () => {
    const { pod, files } = await newPod();
    const r = await pod.put('/notes/2026/a.ttl', alice, body('<#a> <#b> <#c>.'), TTL, NO_CONDITIONS);
    expect(r).toEqual({ path: '/notes/2026/a.ttl', created: true });
    expect(files.text('notes/2026/a.ttl')).toBe('<#a> <#b> <#c>.');
    expect(files.folders.has('notes/2026/')).toBe(true);
    expect((await read(pod, '/notes/')).text).toContain('<2026/>');
    expect((await read(pod, '/notes/2026/')).text).toContain('<a.ttl>');
  });

  it('replaces on a second PUT and changes the ETag', async () => {
    const { pod } = await newPod();
    await pod.put('/a.txt', alice, body('one'), 'text/plain', NO_CONDITIONS);
    const before = (await read(pod, '/a.txt')).etag;
    const r = await pod.put('/a.txt', alice, body('two'), 'text/plain', NO_CONDITIONS);
    expect(r.created).toBe(false);
    const after = await read(pod, '/a.txt');
    expect(after.text).toBe('two');
    expect(after.etag).not.toBe(before);
  });

  it('moves the file when the content type changes', async () => {
    const { pod, files } = await newPod();
    await pod.put('/x', alice, body('<#a> <#b> <#c>.'), TTL, NO_CONDITIONS);
    expect(files.files.has('x$.ttl')).toBe(true);
    await pod.put('/x', alice, body('plain'), 'text/plain', NO_CONDITIONS);
    expect(files.files.has('x$.ttl')).toBe(false);
    expect(files.text('x$.txt')).toBe('plain');
    expect((await read(pod, '/x')).contentType).toBe('text/plain');
  });

  it('keeps an unknown type in a metadata file', async () => {
    const { pod, files } = await newPod();
    await pod.put('/blob', alice, body('?'), 'application/x-unheard-of', NO_CONDITIONS);
    expect(files.files.has('blob$.unknown')).toBe(true);
    expect(files.text('blob.meta')).toContain('"application/x-unheard-of"');
    expect((await read(pod, '/blob')).contentType).toBe('application/x-unheard-of');
    await pod.put('/blob', alice, body('!'), 'text/plain', NO_CONDITIONS);
    expect(files.files.has('blob.meta')).toBe(false);
  });

  it('refuses invalid Turtle and keeps nothing', async () => {
    const { pod, files } = await newPod();
    await expect(pod.put('/bad.ttl', alice, body('<a> <b'), TTL, NO_CONDITIONS)).rejects.toThrow(BadRequest);
    expect(files.files.has('bad.ttl')).toBe(false);
  });

  it.each([
    ['a document over an existing container', '/c/', '/c'],
    ['a container over an existing document', '/c', '/c/'],
    ['a child under a document', '/c', '/c/d'],
    ['a different spelling of an existing name', '/Notes.txt', '/notes.txt'],
  ])('refuses %s', async (_label, first, second) => {
    const { pod } = await newPod();
    const put = (p: string) => pod.put(p, alice, body('x'), 'text/plain', NO_CONDITIONS);
    await put(first);
    await expect(put(second)).rejects.toThrow(Conflict);
  });

  it('converts RDF on request and serves ranges of stored bytes', async () => {
    const { pod } = await newPod();
    await pod.put('/a.ttl', alice, body('<#s> <#p> "o".'), TTL, NO_CONDITIONS);
    const nt = await read(pod, '/a.ttl', alice, { ...GET, accept: 'application/n-triples' });
    expect(nt.text.trim()).toBe(`<${BASE}/a.ttl#s> <${BASE}/a.ttl#p> "o" .`);
    expect(nt.etag).toMatch(/\+application-n-triples$/);
    await expect(pod.read('/a.ttl', alice, { ...GET, accept: 'image/png' })).rejects.toThrow(NotAcceptable);

    await pod.put('/b.bin', alice, body('0123456789'), 'application/octet-stream', NO_CONDITIONS);
    const part = await read(pod, '/b.bin', alice, { ...GET, range: { start: 2, end: 4 } });
    expect(part.text).toBe('234');
    expect(part.range).toEqual({ start: 2, end: 4 });
    expect((await read(pod, '/b.bin', alice, { ...GET, range: { suffix: 3 } })).text).toBe('789');
    await expect(pod.read('/b.bin', alice, { ...GET, range: { start: 10, end: null } })).rejects.toThrow(RangeNotSatisfiable);
  });

  it('stores JSON-LD as sent and converts it on request', async () => {
    const { pod, files } = await newPod();
    const doc = JSON.stringify({ '@id': '#x', 'http://example.org/p': 'v' });
    await pod.put('/j.jsonld', alice, body(doc), 'application/ld+json', NO_CONDITIONS);
    expect(files.text('j.jsonld')).toBe(doc);
    const ttl = await read(pod, '/j.jsonld', alice, { ...GET, accept: 'text/turtle' });
    expect(ttl.text).toContain('"v"');
    const container = await read(pod, '/', alice, { ...GET, accept: 'application/ld+json' });
    expect(container.contentType).toBe('application/ld+json');
    expect(JSON.parse(container.text)).toBeTruthy();
    await pod.patch('/j.jsonld', alice, `${PRE}_:p a solid:InsertDeletePatch; solid:inserts { <#x> ex:n 1 }.`, N3, NO_CONDITIONS);
    expect(JSON.parse(files.text('j.jsonld')!)).toBeTruthy();
    expect((await read(pod, '/j.jsonld', alice, { ...GET, accept: 'application/n-triples' })).text).toContain('<http://example.org/n>');
  });

  it('forgets a resource whose file vanished from storage', async () => {
    const { pod, files, index } = await newPod();
    await pod.put('/gone.bin', alice, body('x'), 'application/octet-stream', NO_CONDITIONS);
    files.files.delete('gone.bin');
    await expect(pod.read('/gone.bin', alice, GET)).rejects.toThrow(NotFound);
    expect(index.get('/gone.bin')).toBeNull();
  });

  it('answers PUT on the root as a write to an existing container', async () => {
    const { pod } = await newPod();
    await expect(pod.put('/', alice, body(''), null, NO_CONDITIONS)).rejects.toThrow(Conflict);
    await expect(pod.put('/', bob, body(''), null, NO_CONDITIONS)).rejects.toThrow(Forbidden);
    await expect(pod.put('/', anon, body(''), null, NO_CONDITIONS)).rejects.toThrow(Unauthenticated);
  });
});

describe('conditional requests', () => {
  it('honours If-Match and If-None-Match', async () => {
    const { pod } = await newPod();
    const put = (s: string, c = NO_CONDITIONS) => pod.put('/c.txt', alice, body(s), 'text/plain', c);
    await expect(put('a', { ifMatch: '*', ifNoneMatch: null })).rejects.toThrow(PreconditionFailed);
    await put('a', { ifMatch: null, ifNoneMatch: '*' });
    await expect(put('b', { ifMatch: null, ifNoneMatch: '*' })).rejects.toThrow(PreconditionFailed);
    const { etag } = await read(pod, '/c.txt');
    await expect(put('b', { ifMatch: ['"stale"'], ifNoneMatch: null })).rejects.toThrow(PreconditionFailed);
    await put('b', { ifMatch: [`"${etag}"`], ifNoneMatch: null });
    await expect(put('c', { ifMatch: [`"${etag}"`], ifNoneMatch: null })).rejects.toThrow(PreconditionFailed);
  });

  it('accepts the ETag of a converted representation', async () => {
    const { pod } = await newPod();
    await pod.put('/a.ttl', alice, body('<#s> <#p> 1.'), TTL, NO_CONDITIONS);
    const { etag } = await read(pod, '/a.ttl', alice, { ...GET, accept: 'application/n-triples' });
    await pod.put('/a.ttl', alice, body('<#s> <#p> 2.'), TTL, { ifMatch: [`"${etag}"`], ifNoneMatch: null });
  });

});

describe('POST', () => {
  it('names the child from the Slug and avoids collisions', async () => {
    const { pod } = await newPod();
    await pod.put('/inbox/', alice, body(''), null, NO_CONDITIONS);
    const a = await pod.post('/inbox/', alice, body('x'), 'text/plain', 'note.txt', false);
    const b = await pod.post('/inbox/', alice, body('y'), 'text/plain', 'note.txt', false);
    expect(a.path).toBe('/inbox/note.txt');
    expect(b.path).toMatch(/^\/inbox\/note\.txt-id\d+$/);
    const c = await pod.post('/inbox/', alice, body(''), null, 'sub', true);
    expect(c.path).toBe('/inbox/sub/');
    const d = await pod.post('/inbox/', alice, body('z'), 'text/plain', '../x.acl', false);
    expect(d.path).toBe('/inbox/..-x.acl-');
  });

  it('cuts a long Slug between characters, and names it by the rules after the cut', async () => {
    const { pod } = await newPod();
    await pod.put('/inbox/', alice, body(''), null, NO_CONDITIONS);
    const emoji = await pod.post('/inbox/', alice, body('x'), 'text/plain', `a${'😀'.repeat(300)}`, false);
    expect([...decodeURIComponent(emoji.path.slice('/inbox/'.length))]).toHaveLength(200);
    const reserved = await pod.post('/inbox/', alice, body('x'), 'text/plain', `${'b'.repeat(196)}.aclXYZ`, false);
    expect(reserved.path).toBe(`/inbox/${'b'.repeat(196)}.acl-`);
  });

  it('refuses POST to a document', async () => {
    const { pod } = await newPod();
    await pod.put('/a.txt', alice, body('x'), 'text/plain', NO_CONDITIONS);
    await expect(pod.post('/a.txt', alice, body('y'), 'text/plain', null, false)).rejects.toThrow(MethodNotAllowed);
  });
});

describe('PATCH', () => {
  it('creates and then edits a document', async () => {
    const { pod } = await newPod();
    await pod.patch('/p.ttl', alice, `${PRE}_:p a solid:InsertDeletePatch; solid:inserts { <#x> ex:n 1 }.`, N3, NO_CONDITIONS);
    await pod.patch(
      '/p.ttl',
      alice,
      `${PRE}_:p a solid:InsertDeletePatch; solid:where { ?s ex:n ?v }; solid:deletes { ?s ex:n ?v }; solid:inserts { ?s ex:n 2 }.`,
      N3,
      NO_CONDITIONS,
    );
    const out = await read(pod, '/p.ttl', alice, { ...GET, accept: 'application/n-triples' });
    expect(out.text).toContain('"2"^^');
    expect(out.text).not.toContain('"1"^^');
  });

  it('maps patch failures to their outcomes', async () => {
    const { pod } = await newPod();
    await pod.put('/b.txt', alice, body('x'), 'text/plain', NO_CONDITIONS);
    const insert = `${PRE}_:p a solid:InsertDeletePatch; solid:inserts { <#x> ex:n 1 }.`;
    await expect(pod.patch('/p.ttl', alice, insert, 'application/sparql-query', NO_CONDITIONS)).rejects.toThrow(UnsupportedMediaType);
    await expect(pod.patch('/b.txt', alice, insert, N3, NO_CONDITIONS)).rejects.toThrow(UnsupportedMediaType);
    await expect(pod.patch('/p.ttl', alice, `${PRE}<#x> ex:n 1.`, N3, NO_CONDITIONS)).rejects.toThrow(Unprocessable);
    const del = `${PRE}_:p a solid:InsertDeletePatch; solid:deletes { <#x> ex:n 9 }.`;
    await expect(pod.patch('/p.ttl', alice, del, N3, NO_CONDITIONS)).rejects.toThrow(Conflict);
  });
});

describe('DELETE', () => {
  it('removes documents, then their emptied container, with their ACLs', async () => {
    const { pod, files, index } = await newPod();
    await pod.put('/d/a.txt', alice, body('x'), 'text/plain', NO_CONDITIONS);
    const ownerOnly = `@prefix acl: <http://www.w3.org/ns/auth/acl#>.
<#o> a acl:Authorization; acl:agent <${ALICE}>; acl:accessTo <./>; acl:default <./>; acl:mode acl:Read, acl:Write, acl:Control.`;
    await pod.put('/d/.acl', alice, body(ownerOnly), TTL, NO_CONDITIONS);
    await expect(pod.remove('/d/', alice, NO_CONDITIONS)).rejects.toThrow(Conflict);
    await pod.remove('/d/a.txt', alice, NO_CONDITIONS);
    await pod.remove('/d/', alice, NO_CONDITIONS);
    expect(files.files.has('d/.acl')).toBe(false);
    expect(index.get('/d/.acl')).toBeNull();
    expect((await read(pod, '/')).text).not.toContain('<d/>');
  });

  it('refuses to delete the root', async () => {
    const { pod } = await newPod();
    await expect(pod.remove('/', alice, NO_CONDITIONS)).rejects.toThrow(MethodNotAllowed);
  });
});

describe('access control', () => {
  const shareWithBob = (modes: string) => `@prefix acl: <http://www.w3.org/ns/auth/acl#>.
<#owner> a acl:Authorization; acl:agent <${ALICE}>; acl:accessTo <./>; acl:default <./>; acl:mode acl:Read, acl:Write, acl:Control.
<#bob> a acl:Authorization; acl:agent <${BOB}>; acl:accessTo <./>; acl:default <./>; acl:mode ${modes}.`;

  it('lets a container ACL share its contents', async () => {
    const { pod } = await newPod();
    await pod.put('/shared/doc.txt', alice, body('hi'), 'text/plain', NO_CONDITIONS);
    await pod.put('/shared/.acl', alice, body(shareWithBob('acl:Read')), TTL, NO_CONDITIONS);
    expect((await read(pod, '/shared/doc.txt', bob)).text).toBe('hi');
    await expect(pod.put('/shared/doc.txt', bob, body('no'), 'text/plain', NO_CONDITIONS)).rejects.toThrow(Forbidden);
    await expect(pod.read('/shared/doc.txt', anon, GET)).rejects.toThrow(Unauthenticated);
    await expect(pod.read('/notshared', bob, GET)).rejects.toThrow(Forbidden);
    const access = await pod.access('/shared/doc.txt', bob);
    expect([...access.user]).toEqual(['read']);
    expect([...access.public]).toEqual([]);
  });

  it('lets Append create but not replace', async () => {
    const { pod } = await newPod();
    await pod.put('/drop/.keep', alice, body('x'), 'text/plain', NO_CONDITIONS);
    await pod.put('/drop/.acl', alice, body(shareWithBob('acl:Append')), TTL, NO_CONDITIONS);
    const r = await pod.post('/drop/', bob, body('from bob'), 'text/plain', 'msg', false);
    expect(r.path).toBe('/drop/msg');
    await expect(pod.put('/drop/msg', bob, body('again'), 'text/plain', NO_CONDITIONS)).rejects.toThrow(Forbidden);
    await expect(pod.remove('/drop/msg', bob, NO_CONDITIONS)).rejects.toThrow(Forbidden);
  });

  it('requires Control to read or change an ACL', async () => {
    const { pod } = await newPod();
    await pod.put('/shared/doc.txt', alice, body('hi'), 'text/plain', NO_CONDITIONS);
    await pod.put('/shared/.acl', alice, body(shareWithBob('acl:Read, acl:Write')), TTL, NO_CONDITIONS);
    await expect(pod.read('/shared/.acl', bob, GET)).rejects.toThrow(Forbidden);
    await expect(pod.put('/shared/.acl', bob, body(shareWithBob('acl:Control')), TTL, NO_CONDITIONS)).rejects.toThrow(Forbidden);
    await expect(pod.put('/nothing.acl', alice, body(''), TTL, NO_CONDITIONS)).rejects.toThrow(Conflict);
    await expect(pod.put('/shared/doc.txt.acl', alice, body('x'), 'text/plain', NO_CONDITIONS)).rejects.toThrow(UnsupportedMediaType);
  });

  it('fails closed on an ACL that no longer parses', async () => {
    const { pod, files, index } = await newPod();
    await pod.put('/shared/doc.txt', alice, body('hi'), 'text/plain', NO_CONDITIONS);
    await pod.put('/shared/.acl', alice, body(shareWithBob('acl:Read')), TTL, NO_CONDITIONS);
    expect((await read(pod, '/shared/doc.txt', bob)).text).toBe('hi');
    // An out-of-band edit, as reconcile would record it.
    await files.write('shared/.acl', new TextEncoder().encode('this is not turtle'));
    const row = index.get('/shared/.acl')!;
    index.upsert({ ...row, etag: 'edited' });
    index.setCachedText('/shared/.acl', null);
    await expect(pod.read('/shared/doc.txt', bob, GET)).rejects.toThrow(Forbidden);
  });

  it('requires Append on the container to POST into it', async () => {
    const { pod } = await newPod();
    await pod.put('/shared/', alice, body(''), null, NO_CONDITIONS);
    await pod.put('/shared/.acl', alice, body(shareWithBob('acl:Read')), TTL, NO_CONDITIONS);
    await expect(pod.post('/shared/', bob, body('x'), 'text/plain', 'msg', false)).rejects.toThrow(Forbidden);
    await expect(pod.post('/shared/', bob, body(''), null, 'sub', true)).rejects.toThrow(Forbidden);
    expect(await pod.listing('/shared/', alice)).toEqual([]);
  });

  it('lets Append insert triples by PATCH but not delete them', async () => {
    const { pod } = await newPod();
    await pod.put('/drop/d.ttl', alice, body('<#a> <http://example.org/n> 1.'), TTL, NO_CONDITIONS);
    await pod.put('/drop/.acl', alice, body(shareWithBob('acl:Append')), TTL, NO_CONDITIONS);
    const deletes = `${PRE}_:p a solid:InsertDeletePatch; solid:deletes { <#a> ex:n 1 }.`;
    await expect(pod.patch('/drop/d.ttl', bob, deletes, N3, NO_CONDITIONS)).rejects.toThrow(Forbidden);
    await pod.patch('/drop/d.ttl', bob, `${PRE}_:p a solid:InsertDeletePatch; solid:inserts { <#b> ex:n 2 }.`, N3, NO_CONDITIONS);
    const out = (await read(pod, '/drop/d.ttl', alice, { ...GET, accept: 'application/n-triples' })).text;
    expect(out).toContain('"1"^^');
    expect(out).toContain('"2"^^');
  });

  it('requires Write on the container as well as the document to DELETE', async () => {
    const { pod, index } = await newPod();
    await pod.put('/shared/doc.txt', alice, body('hi'), 'text/plain', NO_CONDITIONS);
    await pod.put('/shared/.acl', alice, body(shareWithBob('acl:Read')), TTL, NO_CONDITIONS);
    const writeForBob = `@prefix acl: <http://www.w3.org/ns/auth/acl#>.
<#owner> a acl:Authorization; acl:agent <${ALICE}>; acl:accessTo <doc.txt>; acl:mode acl:Read, acl:Write, acl:Control.
<#bob> a acl:Authorization; acl:agent <${BOB}>; acl:accessTo <doc.txt>; acl:mode acl:Read, acl:Write.`;
    await pod.put('/shared/doc.txt.acl', alice, body(writeForBob), TTL, NO_CONDITIONS);
    await pod.put('/shared/doc.txt', bob, body('from bob'), 'text/plain', NO_CONDITIONS);
    await expect(pod.remove('/shared/doc.txt', bob, NO_CONDITIONS)).rejects.toThrow(Forbidden);
    expect(index.get('/shared/doc.txt')).not.toBeNull();
  });

  it('refuses requests for metadata files, whoever asks', async () => {
    const { pod, files } = await newPod();
    await pod.put('/blob', alice, body('?'), 'application/x-unheard-of', NO_CONDITIONS);
    const meta = files.text('blob.meta');
    await expect(pod.put('/blob.meta', alice, body('x'), 'text/plain', NO_CONDITIONS)).rejects.toThrow(MethodNotAllowed);
    await expect(pod.put('/new.meta', alice, body('x'), 'text/plain', NO_CONDITIONS)).rejects.toThrow(MethodNotAllowed);
    await expect(pod.remove('/blob.meta', alice, NO_CONDITIONS)).rejects.toThrow(MethodNotAllowed);
    // Not found even for someone who may read nothing here: the path is never a resource.
    await expect(pod.read('/blob.meta', anon, GET)).rejects.toThrow(NotFound);
    await expect(pod.read('/blob.meta', alice, GET)).rejects.toThrow(NotFound);
    expect(files.text('blob.meta')).toBe(meta);
  });

  it('requires Read to list a container', async () => {
    const { pod } = await newPod();
    await pod.put('/shared/doc.txt', alice, body('hi'), 'text/plain', NO_CONDITIONS);
    await pod.put('/shared/.acl', alice, body(shareWithBob('acl:Append')), TTL, NO_CONDITIONS);
    await expect(pod.listing('/shared/', bob)).rejects.toThrow(Forbidden);
    await expect(pod.listing('/shared/', anon)).rejects.toThrow(Unauthenticated);
    expect((await pod.listing('/shared/', alice)).map((e) => e.path)).toEqual(['/shared/doc.txt']);
  });
});

describe('concurrent writes', () => {
  /** Makes every storage write wait a turn, as a call to a remote provider does. */
  function slowWrites(files: MemoryFileStore) {
    const write = files.write.bind(files);
    files.write = async (...args) => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      return write(...args);
    };
  }

  it('lets exactly one of two simultaneous creations of one path through', async () => {
    const { pod, files } = await newPod();
    slowWrites(files);
    const create = (s: string) => pod.put('/race.txt', alice, body(s), 'text/plain', { ifMatch: null, ifNoneMatch: '*' });
    const results = await Promise.allSettled([create('a'), create('b')]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected']);
    expect((results[1] as PromiseRejectedResult).reason).toBeInstanceOf(PreconditionFailed);
    expect((await read(pod, '/race.txt')).text).toBe('a');
  });

  it('keeps both of two simultaneous patches to one document', async () => {
    const { pod, files } = await newPod();
    await pod.put('/p.ttl', alice, body('<#a> <http://example.org/n> 0.'), TTL, NO_CONDITIONS);
    slowWrites(files);
    const insert = (n: number) => pod.patch('/p.ttl', alice, `${PRE}_:p a solid:InsertDeletePatch; solid:inserts { <#a> ex:n ${n} }.`, N3, NO_CONDITIONS);
    await Promise.all([insert(1), insert(2)]);
    const out = (await read(pod, '/p.ttl', alice, { ...GET, accept: 'application/n-triples' })).text;
    expect(out).toContain('"1"^^');
    expect(out).toContain('"2"^^');
  });
});

describe('outsiders', () => {
  const where = (n: number) =>
    `${PRE}_:p a solid:InsertDeletePatch; solid:where { ${Array.from({ length: n }, (_, i) => `?s${i} ?p${i} ?o${i}.`).join(' ')} }.`;

  it('cannot patch, or make a pod parse, a document they may only read', async () => {
    const { pod, index } = await newPod();
    const before = index.get('/profile/card')!.etag;
    await expect(pod.patch('/profile/card', anon, where(1), N3, NO_CONDITIONS)).rejects.toThrow(Unauthenticated);
    await expect(pod.patch('/profile/card', anon, 'not even n3 {{{', N3, NO_CONDITIONS)).rejects.toThrow(Unauthenticated);
    expect(index.get('/profile/card')!.etag).toBe(before);
  });

  it('a patch that only tests its where clause changes nothing', async () => {
    const { pod, index } = await newPod();
    const before = index.get('/profile/card')!.etag;
    await pod.patch('/profile/card', alice, `${PRE}_:p a solid:InsertDeletePatch; solid:where { <#me> a <http://xmlns.com/foaf/0.1/Person> }.`, N3, NO_CONDITIONS);
    expect(index.get('/profile/card')!.etag).toBe(before);
  });

  it('refuses a where clause that would match in too many ways, quickly', async () => {
    const { pod } = await newPod();
    const started = Date.now();
    await expect(pod.patch('/profile/card', alice, where(12), N3, NO_CONDITIONS)).rejects.toThrow(Conflict);
    expect(Date.now() - started).toBeLessThan(500);
    await expect(pod.patch('/profile/card', alice, where(65), N3, NO_CONDITIONS)).rejects.toThrow(Unprocessable);
  });

  it('cannot learn whether a private resource exists from preconditions', async () => {
    const { pod } = await newPod();
    await pod.put('/private/a.txt', alice, body('secret'), 'text/plain', NO_CONDITIONS);
    const exists = { ifMatch: null, ifNoneMatch: '*' as const };
    await expect(pod.put('/private/a.txt', anon, body('x'), 'text/plain', exists)).rejects.toThrow(Unauthenticated);
    await expect(pod.put('/private/none.txt', anon, body('x'), 'text/plain', exists)).rejects.toThrow(Unauthenticated);
    await expect(pod.remove('/private/a.txt', anon, { ifMatch: ['nope'], ifNoneMatch: null })).rejects.toThrow(Unauthenticated);
  });
});

describe('two views of one pod', () => {
  // A pod's object builds a second `Pod` while it is placed in storage; both must wait their turn.
  it('write one at a time through the queue they share', async () => {
    const { index, files } = await newPod();
    const writes = new Serial();
    let open = 0;
    let most = 0;
    const write = files.write.bind(files);
    files.write = async (...args) => {
      most = Math.max(most, ++open);
      await new Promise((done) => setTimeout(done, 1));
      open--;
      return write(...args);
    };
    let id = 0;
    const view = () => new Pod({ index, files, base: BASE, now: () => new Date(), newId: () => `v${++id}`, writes });
    const put = (pod: Pod, path: string) => pod.put(path, { webid: ALICE }, { stream: streamOf('x') }, 'text/plain', NO_CONDITIONS);
    await Promise.all([put(view(), '/a.txt'), put(view(), '/b.txt'), put(view(), '/c.txt')]);
    expect(most).toBe(1);
  });
});

const OWNER_ONLY = (subject: string) =>
  `@prefix acl: <http://www.w3.org/ns/auth/acl#>.\n<#o> a acl:Authorization; acl:agent <${ALICE}>; acl:accessTo <${subject}>; acl:default <${subject}>; acl:mode acl:Read, acl:Write, acl:Control.`;

describe('what an outsider can learn from a refusal', () => {
  it('is nothing: POST and ACL writes ask for access before they look', async () => {
    const { pod } = await newPod();
    await pod.put('/private/doc.txt', alice, body('x'), 'text/plain', NO_CONDITIONS);
    for (const target of ['/private/', '/nothere/', '/private/doc.txt', '/private/nope.txt']) {
      await expect(pod.post(target, anon, body('x'), 'text/plain', null, false)).rejects.toThrow(Unauthenticated);
    }
    for (const acl of ['/private/doc.txt.acl', '/private/nope.txt.acl']) {
      await expect(pod.put(acl, anon, body(OWNER_ONLY('./doc.txt')), TTL, NO_CONDITIONS)).rejects.toThrow(Unauthenticated);
      await expect(pod.patch(acl, anon, `${PRE}_:p a solid:InsertDeletePatch; solid:inserts { <#a> ex:b 1 }.`, N3, NO_CONDITIONS)).rejects.toThrow(Unauthenticated);
    }
    // The owner still gets the plain answers.
    await expect(pod.post('/nothere/', alice, body('x'), 'text/plain', null, false)).rejects.toThrow(NotFound);
    await expect(pod.put('/private/nope.txt.acl', alice, body(OWNER_ONLY('./nope.txt')), TTL, NO_CONDITIONS)).rejects.toThrow(Conflict);
  });
});

describe('the root ACL', () => {
  it('cannot be deleted, and says so in Allow', async () => {
    const { pod } = await newPod();
    await expect(pod.remove('/.acl', alice, NO_CONDITIONS)).rejects.toThrow(MethodNotAllowed);
    expect(allowedMethods('/.acl')).not.toContain('DELETE');
    expect(allowedMethods('/notes/.acl')).toContain('DELETE');
    expect((await pod.modes('/', alice)).has('control')).toBe(true);
  });

  it('cannot be replaced by one that leaves nobody Control over the root', async () => {
    const { pod } = await newPod();
    const readOnly = `@prefix acl: <http://www.w3.org/ns/auth/acl#>.\n<#o> a acl:Authorization; acl:agent <${ALICE}>; acl:accessTo <./>; acl:default <./>; acl:mode acl:Read.`;
    await expect(pod.put('/.acl', alice, body(readOnly), TTL, NO_CONDITIONS)).rejects.toThrow(Conflict);
    await expect(pod.put('/.acl', alice, body(OWNER_ONLY('./').replace(`acl:agent <${ALICE}>`, 'acl:agentClass acl:AuthenticatedAgent')), TTL, NO_CONDITIONS)).rejects.toThrow(Conflict);
    await pod.put('/.acl', alice, body(OWNER_ONLY('./')), TTL, NO_CONDITIONS);
    expect((await pod.modes('/', alice)).has('control')).toBe(true);
  });
});

describe('deleting', () => {
  it('takes the resource before its ACL, so a failure never leaves it under an inherited ACL', async () => {
    const { pod, files } = await newPod();
    await pod.put('/pub/secret.txt', alice, body('the secret'), 'text/plain', NO_CONDITIONS);
    await pod.put('/pub/secret.txt.acl', alice, body(OWNER_ONLY('./secret.txt')), TTL, NO_CONDITIONS);
    const remove = files.remove.bind(files);
    files.remove = async (file) => {
      if (file === 'pub/secret.txt') throw new Error('storage is down');
      return remove(file);
    };
    await expect(pod.remove('/pub/secret.txt', alice, NO_CONDITIONS)).rejects.toThrow('storage is down');
    expect([...files.files.keys()]).toContain('pub/secret.txt.acl');
    files.remove = async (file) => {
      if (file === 'pub/secret.txt.acl') throw new Error('storage is down');
      return remove(file);
    };
    await expect(pod.remove('/pub/secret.txt', alice, NO_CONDITIONS)).rejects.toThrow('storage is down');
    expect([...files.files.keys()]).not.toContain('pub/secret.txt');
  });

  it('leaves a container whose folder holds files the pod does not list', async () => {
    const { pod, files } = await newPod();
    await pod.put('/box/', alice, body(''), null, NO_CONDITIONS);
    await pod.put('/box/.acl', alice, body(OWNER_ONLY('./')), TTL, NO_CONDITIONS);
    await files.write('box/bad%ZZname.txt', new TextEncoder().encode('kept by its owner'));
    await expect(pod.remove('/box/', alice, NO_CONDITIONS)).rejects.toThrow(Conflict);
    expect(files.text('box/bad%ZZname.txt')).toBe('kept by its owner');
    await files.remove('box/bad%ZZname.txt');
    await pod.remove('/box/', alice, NO_CONDITIONS);
    expect([...files.files.keys()].filter((f) => f.startsWith('box/'))).toEqual([]);
    await expect(pod.read('/box/', alice, GET)).rejects.toThrow(NotFound);
  });
});

describe('names a case-blind disk would read as .acl or .meta', () => {
  it('are refused, and never chosen for a POST', async () => {
    const { pod } = await newPod();
    await pod.put('/inbox/', alice, body(''), null, NO_CONDITIONS);
    for (const path of ['/inbox/.ACL', '/inbox/note.Acl', '/inbox/x.META', '/inbox/.ACL/', '/inbox/a.ACL/b.txt']) {
      await expect(pod.put(path, alice, body('x'), 'text/plain', NO_CONDITIONS)).rejects.toThrow(BadRequest);
    }
    await expect(pod.patch('/inbox/.ACL', alice, `${PRE}_:p a solid:InsertDeletePatch; solid:inserts { <#a> ex:b 1 }.`, N3, NO_CONDITIONS)).rejects.toThrow(BadRequest);
    const made = await pod.post('/inbox/', alice, body('x'), 'text/plain', '.ACL', false);
    expect(made.path.toLowerCase().endsWith('.acl')).toBe(false);
    await pod.put('/inbox/.acl', alice, body(OWNER_ONLY('./')), TTL, NO_CONDITIONS);
  });
});

describe('the WebID profile', () => {
  const ISSUER = 'https://id.example/';
  const withIssuer = async () => {
    const made = await newPod();
    await made.pod.put('/profile/card', alice, body(profileDocument(`${BASE}/`, ISSUER)), TTL, NO_CONDITIONS);
    return made;
  };
  const N3_PATCH = (clause: string) => `${PRE}_:p a solid:InsertDeletePatch; ${clause}.`;

  it('keeps who signs its owner in, whatever a request asks', async () => {
    const { pod } = await withIssuer();
    const without = profileDocument(`${BASE}/`, null);
    await expect(pod.put('/profile/card', alice, body(without), TTL, NO_CONDITIONS)).rejects.toThrow(Conflict);
    await expect(pod.put('/profile/card', alice, body(profileDocument(`${BASE}/`, 'https://other.example/')), TTL, NO_CONDITIONS)).rejects.toThrow(Conflict);
    await expect(pod.put('/profile/card', alice, body('a picture'), 'image/png', NO_CONDITIONS)).rejects.toThrow(Conflict);
    await expect(pod.patch('/profile/card', alice, N3_PATCH(`solid:deletes { <${ALICE}> solid:oidcIssuer <${ISSUER}> }`), N3, NO_CONDITIONS)).rejects.toThrow(Conflict);
    await expect(pod.patch('/profile/card', alice, N3_PATCH(`solid:inserts { <${ALICE}> solid:oidcIssuer <https://other.example/> }`), N3, NO_CONDITIONS)).rejects.toThrow(Conflict);
    await expect(pod.remove('/profile/card', alice, NO_CONDITIONS)).rejects.toThrow(Conflict);
    expect((await read(pod, '/profile/card')).text).toContain(ISSUER);
  });

  it('takes every other edit, and an issuer where none was stated', async () => {
    const { pod } = await withIssuer();
    await pod.patch('/profile/card', alice, N3_PATCH(`solid:inserts { <${ALICE}> ex:nick "al" }`), N3, NO_CONDITIONS);
    await pod.put('/profile/card', alice, body(`${profileDocument(`${BASE}/`, ISSUER)}\n<${ALICE}> <http://example.org/nick> "ali".`), TTL, NO_CONDITIONS);
    expect((await read(pod, '/profile/card')).text).toContain('ali');
    const bare = await newPod();
    await bare.pod.put('/profile/card', alice, body(profileDocument(`${BASE}/`, ISSUER)), TTL, NO_CONDITIONS);
  });
});

describe('an ACL that names its resource by another spelling of its URL', () => {
  it('governs it all the same', async () => {
    const { pod } = await newPod();
    const path = '/notes/2026-11-12T10%3A00%3A00.txt';
    await pod.put(path, alice, body('x'), 'text/plain', NO_CONDITIONS);
    const acl = `@prefix acl: <http://www.w3.org/ns/auth/acl#>.
<#o> a acl:Authorization; acl:agent <${ALICE}>; acl:accessTo <${BASE}/notes/2026-11-12T10:00:00.txt>; acl:mode acl:Read, acl:Write, acl:Control.`;
    await pod.put(`${path}.acl`, alice, body(acl), TTL, NO_CONDITIONS);
    expect([...(await pod.modes(path, alice))].sort()).toEqual(['append', 'control', 'read', 'write']);
    expect((await pod.modes(path, bob)).size).toBe(0);
    await pod.put(`${path}.acl`, alice, body(acl), TTL, NO_CONDITIONS);
  });
});

describe('a name ending the way a stored file marks its type', () => {
  it('is refused as a request would spell it, for documents and containers', async () => {
    const { pod } = await newPod();
    for (const path of ['/a%24.ttl', '/dir/b%24.txt', '/x%24.ttl/', '/x%24.ttl/inner.txt']) {
      await expect(pod.put(path, alice, body('<#a> <#b> 1.'), TTL, NO_CONDITIONS)).rejects.toThrow(BadRequest);
    }
    const made = await pod.post('/', alice, body('x'), 'text/plain', 'c$.ttl', false);
    expect(/%24\.\w+$/u.test(made.path)).toBe(false);
    await pod.put('/price%24', alice, body('1'), 'text/plain', NO_CONDITIONS);
  });
});

const PUBLIC_READ = (subject: string) =>
  `@prefix acl: <http://www.w3.org/ns/auth/acl#>.
<#o> a acl:Authorization; acl:agent <${ALICE}>; acl:accessTo <${subject}>; acl:default <${subject}>; acl:mode acl:Read, acl:Write, acl:Control.
<#p> a acl:Authorization; acl:agentClass <http://xmlns.com/foaf/0.1/Agent>; acl:accessTo <${subject}>; acl:default <${subject}>; acl:mode acl:Read.`;

describe('a pod whose folder has not answered lately', () => {
  const stale = async () => {
    const { index, files, pod: owner } = await newPod();
    await owner.put('/public/', alice, body(''), null, NO_CONDITIONS);
    await owner.put('/public/.acl', alice, body(PUBLIC_READ('./')), TTL, NO_CONDITIONS);
    await owner.put('/public/doc.ttl', alice, body('<#a> <#b> "cached".'), TTL, NO_CONDITIONS);
    let fresh = true;
    let id = 0;
    const pod = new Pod({ index, files, base: BASE, now: () => new Date(), newId: () => `s${++id}`, fresh: () => fresh });
    await pod.read('/public/doc.ttl', anon, GET);
    return { pod, files, goStale: () => void (fresh = false) };
  };

  it('serves and decides from its cached copies while it is fresh', async () => {
    const { pod, files } = await stale();
    files.read = async () => {
      throw new StorageUnavailable('down');
    };
    expect(await textOf((await pod.read('/public/doc.ttl', anon, GET)).body)).toContain('cached');
  });

  it('asks the folder instead, and fails as it fails', async () => {
    const { pod, files, goStale } = await stale();
    goStale();
    expect(await textOf((await pod.read('/public/doc.ttl', anon, GET)).body)).toContain('cached');
    files.read = async () => {
      throw new StorageUnavailable('the link was revoked');
    };
    await expect(pod.read('/public/doc.ttl', anon, GET)).rejects.toThrow(StorageUnavailable);
    await expect(pod.modes('/public/doc.ttl', anon)).rejects.toThrow(StorageUnavailable);
  });

  it('takes an ACL edited in the folder as it stands there', async () => {
    const { pod, files, goStale } = await stale();
    await files.write('public/.acl', new TextEncoder().encode(OWNER_ONLY('./')));
    expect((await pod.modes('/public/doc.ttl', anon)).has('read')).toBe(true);
    goStale();
    expect((await pod.modes('/public/doc.ttl', anon)).size).toBe(0);
  });
});
