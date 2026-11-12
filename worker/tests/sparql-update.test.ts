import { describe, expect, it } from 'vitest';
import { Conflict, Forbidden, Unprocessable } from '../app/shared/errors.js';
import type { Agent, ReadOptions } from '../app/pods/pod.js';
import { InvalidPatch, modesForPatch, parsePatch } from '../domain/pods/n3patch.js';
import { applyUpdate, modesForUpdate, parseUpdate } from '../domain/pods/sparqlUpdate.js';
import { NO_CONDITIONS } from '../domain/pods/requests.js';
import { N3, SPARQL_UPDATE, parseRdf, serializeRdf } from '../domain/shared/rdf.js';
import { handleSolid } from '../runtime/http/solid.js';
import { ALICE, BASE, BOB, newPod, streamOf, textOf } from './support/fakes.js';

const DOC = 'https://alice.example/notes/a.ttl';
const doc = (ttl: string) => parseRdf(`@prefix ex: <http://example.org/>.\n${ttl}`, 'text/turtle', DOC);
const nt = async (quads: Awaited<ReturnType<typeof doc>>) => (await serializeRdf(quads, 'application/n-triples')).trim().split('\n').filter(Boolean).sort();
const after = async (ttl: string, update: string) => nt(applyUpdate(await doc(ttl), parseUpdate(update, DOC)).quads);
const X = `<${DOC}#x>`;
const EX = 'http://example.org/';

describe('SPARQL Update with ground triples', () => {
  it('applies the body a client library sends to save a document it read', async () => {
    // The shape @inrupt/solid-client writes: one DELETE DATA, one INSERT DATA,
    // full IRIs, each closed with a semicolon.
    const body = `DELETE DATA {<${DOC}#x> <${EX}name> "old".\n}; INSERT DATA {<${DOC}#x> <${EX}name> "new".\n<${DOC}#x> <${EX}n> "2"^^<http://www.w3.org/2001/XMLSchema#integer>.\n};`;
    expect(await after('<#x> ex:name "old"; ex:kept true.', body)).toEqual(
      await nt(await doc('<#x> ex:name "new"; ex:n 2; ex:kept true.')),
    );
  });

  it('takes prefixes, a base, relative IRIs, comments and a block without its last full stop', async () => {
    const update = `# save
      BASE <${DOC}>
      prefix ex: <${EX}>
      INSERT DATA { <#x> ex:name "a } b" ; ex:home <#h> }   # no stop
      ;
      Delete Data { <#x> ex:gone 'never there' . }`;
    expect(await after('', update)).toEqual([`${X} <${EX}home> <${DOC}#h> .`, `${X} <${EX}name> "a } b" .`]);
  });

  it('applies operations in order, and deleting what is absent changes nothing', async () => {
    const update = `PREFIX ex: <${EX}> INSERT DATA { <#x> ex:n 1 }; DELETE DATA { <#x> ex:n 1 }; DELETE DATA { <#x> ex:n 7 }`;
    const result = applyUpdate(await doc('<#y> ex:n 5.'), parseUpdate(update, DOC));
    expect(await nt(result.quads)).toEqual(await nt(await doc('<#y> ex:n 5.')));
    expect(applyUpdate(await doc('<#y> ex:n 5.'), parseUpdate(`PREFIX ex: <${EX}> INSERT DATA { <#y> ex:n 5 }`, DOC)).changed).toBe(false);
    expect(parseUpdate('  # nothing\n', DOC).steps).toEqual([]);
  });

  it.each([
    ['a WHERE form', `DELETE { ?s ?p ?o } WHERE { ?s ?p ?o }`],
    ['a variable', `INSERT DATA { ?s <${EX}p> 1 }`],
    ['a graph', `INSERT DATA { GRAPH <${EX}g> { <${EX}s> <${EX}p> 1 } }`],
    ['another operation', `CLEAR ALL`],
    ['LOAD', `LOAD <${EX}elsewhere>`],
    ['a blank node to delete', `DELETE DATA { _:b <${EX}p> 1 }`],
    ['an open block', `INSERT DATA { <${EX}s> <${EX}p> 1`],
    ['operations run together', `INSERT DATA { <${EX}s> <${EX}p> 1 } DELETE DATA { <${EX}s> <${EX}p> 1 }`],
    ['triples that do not parse', `INSERT DATA { <${EX}s> <${EX}p> }`],
    ['an undeclared prefix', `INSERT DATA { ex:s ex:p 1 }`],
  ])('refuses %s', (_name, update) => {
    expect(() => parseUpdate(update, DOC)).toThrow(InvalidPatch);
  });

  it('needs the access an N3 Patch with the same inserts and deletes needs', () => {
    const n3 = (parts: string) => parsePatch(`@prefix solid: <http://www.w3.org/ns/solid/terms#>. @prefix ex: <${EX}>.\n_:p a solid:InsertDeletePatch; ${parts}.`, DOC);
    const sparql = (operations: string) => parseUpdate(`PREFIX ex: <${EX}> ${operations}`, DOC);
    const same = (a: string, b: string) => expect(new Set(modesForUpdate(sparql(b)))).toEqual(new Set(modesForPatch(n3(a))));
    same('solid:inserts { <#x> ex:n 1 }', 'INSERT DATA { <#x> ex:n 1 }');
    same('solid:deletes { <#x> ex:n 1 }', 'DELETE DATA { <#x> ex:n 1 }');
    same('solid:deletes { <#x> ex:n 1 }; solid:inserts { <#x> ex:n 2 }', 'DELETE DATA { <#x> ex:n 1 }; INSERT DATA { <#x> ex:n 2 }');
    expect(modesForUpdate(sparql('INSERT DATA { <#x> ex:n 1 }'))).toEqual(['append']);
    expect(new Set(modesForUpdate(sparql('DELETE DATA { <#x> ex:n 1 }')))).toEqual(new Set(['read', 'write']));
    expect(modesForUpdate(sparql('INSERT DATA { }; DELETE DATA { }'))).toEqual([]);
  });
});

describe('PATCH with application/sparql-update', () => {
  const alice: Agent = { webid: ALICE };
  const bob: Agent = { webid: BOB };
  const GET: ReadOptions = { accept: 'application/n-triples', range: null, head: false };
  const P = `PREFIX ex: <${EX}> `;
  const N3P = `@prefix solid: <http://www.w3.org/ns/solid/terms#>. @prefix ex: <${EX}>.\n_:p a solid:InsertDeletePatch; `;
  const read = async (pod: Awaited<ReturnType<typeof newPod>>['pod'], path: string) => textOf((await pod.read(path, alice, GET)).body);
  const acl = (modes: string) => `@prefix acl: <http://www.w3.org/ns/auth/acl#>.
<#o> a acl:Authorization; acl:agent <${ALICE}>; acl:accessTo <./a.ttl>; acl:mode acl:Read, acl:Write, acl:Control.
<#b> a acl:Authorization; acl:agent <${BOB}>; acl:accessTo <./a.ttl>; acl:mode ${modes}.`;

  it('creates a document, changes it, and keeps its stored type', async () => {
    const { pod } = await newPod();
    expect(await pod.patch('/n/a.ttl', alice, `${P}INSERT DATA { <#x> ex:n 1 }`, SPARQL_UPDATE, NO_CONDITIONS)).toEqual({ path: '/n/a.ttl', created: true });
    const before = await pod.read('/n/a.ttl', alice, { ...GET, head: true });
    expect(await pod.patch('/n/a.ttl', alice, `${P}DELETE DATA { <#x> ex:n 1 }; INSERT DATA { <#x> ex:n 2 }`, `${SPARQL_UPDATE}; charset=utf-8`, NO_CONDITIONS)).toEqual({ path: '/n/a.ttl', created: false });
    const text = await read(pod, '/n/a.ttl');
    expect(text).toContain('"2"^^');
    expect(text).not.toContain('"1"^^');
    const head = await pod.read('/n/a.ttl', alice, { ...GET, accept: null, head: true });
    expect(head.contentType).toBe('text/turtle');
    expect(head.etag).not.toBe(before.etag);
  });

  it('writes nothing when nothing changes, and creates nothing from a delete', async () => {
    const { pod } = await newPod();
    await pod.patch('/a.ttl', alice, `${P}INSERT DATA { <#x> ex:n 1 }`, SPARQL_UPDATE, NO_CONDITIONS);
    const before = (await pod.read('/a.ttl', alice, { ...GET, head: true })).etag;
    await pod.patch('/a.ttl', alice, `${P}DELETE DATA { <#x> ex:n 9 }; INSERT DATA { <#x> ex:n 1 }`, SPARQL_UPDATE, NO_CONDITIONS);
    expect((await pod.read('/a.ttl', alice, { ...GET, head: true })).etag).toBe(before);
    expect(await pod.patch('/none.ttl', alice, `${P}DELETE DATA { <#x> ex:n 9 }`, SPARQL_UPDATE, NO_CONDITIONS)).toEqual({ path: '/none.ttl', created: false });
    await expect(pod.read('/none.ttl', alice, GET)).rejects.toThrow();
  });

  it('is 422 outside the subset, where an N3 Patch deleting an absent triple is 409', async () => {
    const { pod } = await newPod();
    await expect(pod.patch('/a.ttl', alice, 'DELETE { ?s ?p ?o } WHERE { ?s ?p ?o }', SPARQL_UPDATE, NO_CONDITIONS)).rejects.toThrow(Unprocessable);
    await expect(pod.patch('/a.ttl', alice, `${N3P}solid:deletes { <#x> ex:n 9 }.`, N3, NO_CONDITIONS)).rejects.toThrow(Conflict);
  });

  it.each([
    ['acl:Append', true, false],
    ['acl:Read', false, false],
    ['acl:Read, acl:Append', true, false],
    ['acl:Write', true, false],
    ['acl:Read, acl:Write', true, true],
  ])('with %s, lets through what the same N3 Patch gets through', async (modes, inserts, deletes) => {
    const { pod } = await newPod();
    await pod.put('/n/a.ttl', alice, { stream: streamOf(`@prefix ex: <${EX}>. <#x> ex:n 1.`) }, 'text/turtle', NO_CONDITIONS);
    await pod.put('/n/a.ttl.acl', alice, { stream: streamOf(acl(modes)) }, 'text/turtle', NO_CONDITIONS);
    const outcome = (text: string, type: string) => pod.patch('/n/a.ttl', bob, text, type, NO_CONDITIONS).then(() => true, (e: unknown) => (e instanceof Forbidden ? false : Promise.reject(e)));
    // Each pair leaves the document as it found it, so the next pair sees the same one.
    const pairs: [string, string, boolean][] = [
      [`${P}INSERT DATA { <#x> ex:m 1 }`, `${N3P}solid:inserts { <#x> ex:m 2 }.`, inserts],
      [`${P}DELETE DATA { <#x> ex:n 1 }; INSERT DATA { <#x> ex:n 1 }`, `${N3P}solid:deletes { <#x> ex:n 1 }; solid:inserts { <#x> ex:n 1 }.`, deletes],
      [`${P}DELETE DATA { <#x> ex:n 1 }`, `${N3P}solid:deletes { <#x> ex:n 1 }.`, deletes],
    ];
    for (const [sparql, n3, allowed] of pairs) {
      expect([sparql, await outcome(sparql, SPARQL_UPDATE)]).toEqual([sparql, allowed]);
      if (sparql.endsWith('ex:n 1 }') && !sparql.includes('INSERT') && allowed) await pod.patch('/n/a.ttl', alice, `${P}INSERT DATA { <#x> ex:n 1 }`, SPARQL_UPDATE, NO_CONDITIONS);
      expect([n3, await outcome(n3, N3)]).toEqual([n3, allowed]);
    }
  });

  it('is advertised, and answers over HTTP', async () => {
    const { pod } = await newPod();
    const send = (method: string, init: RequestInit = {}) => handleSolid(pod, new Request(`${BASE}/h.ttl`, { method, ...init }), alice);
    const patch = (body: string) => send('PATCH', { body, headers: { 'Content-Type': SPARQL_UPDATE } });
    expect((await patch(`INSERT DATA { <#x> <${EX}n> 1 }`)).status).toBe(201);
    expect((await patch(`DELETE DATA { <#x> <${EX}n> 1 }; INSERT DATA { <#x> <${EX}n> 2 };`)).status).toBe(204);
    expect((await patch('CLEAR ALL')).status).toBe(422);
    expect((await send('OPTIONS')).headers.get('Accept-Patch')).toBe('text/n3, application/sparql-update');
    expect((await send('PATCH', { body: '{}', headers: { 'Content-Type': 'application/json' } })).status).toBe(415);
  });
});
