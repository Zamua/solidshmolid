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
  Unauthenticated,
  Unprocessable,
  UnsupportedMediaType,
} from '../app/shared/errors.js';
import { type Agent, type ReadOptions } from '../app/pods/pod.js';
import { NO_CONDITIONS } from '../domain/pods/requests.js';
import { ALICE, BASE, BOB, newPod, streamOf, textOf } from './support/fakes.js';

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
    await expect(pod.patch('/p.ttl', alice, insert, 'application/sparql-update', NO_CONDITIONS)).rejects.toThrow(UnsupportedMediaType);
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
