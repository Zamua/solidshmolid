import { describe, expect, it } from 'vitest';
import { InvalidPatch, PatchConflict, applyPatch, modesForPatch, parsePatch } from '../domain/n3patch.js';
import { parseRdf, serializeRdf } from '../domain/rdf.js';

const BASE = 'https://alice.example/notes/a.ttl';
const PRE = '@prefix solid: <http://www.w3.org/ns/solid/terms#>. @prefix ex: <http://example.org/>.\n';
const doc = (ttl: string) => parseRdf(`@prefix ex: <http://example.org/>.\n${ttl}`, 'text/turtle', BASE);
const patch = (n3: string) => parsePatch(PRE + n3, BASE);
const nt = (quads: ReturnType<typeof doc>) => serializeRdf(quads, 'application/n-triples').trim().split('\n').sort();

describe('N3 Patch', () => {
  it('inserts into an empty document with Append only', () => {
    const p = patch(`_:p a solid:InsertDeletePatch; solid:inserts { <#x> ex:name "x" }.`);
    expect(modesForPatch(p)).toEqual(['append']);
    expect(nt(applyPatch([], p))).toEqual(['<https://alice.example/notes/a.ttl#x> <http://example.org/name> "x" .']);
  });

  it('replaces a value found by where', () => {
    const p = patch(`_:p a solid:InsertDeletePatch;
      solid:where { ?s ex:count ?n };
      solid:deletes { ?s ex:count ?n };
      solid:inserts { ?s ex:count 2 }.`);
    expect(new Set(modesForPatch(p))).toEqual(new Set(['read', 'write', 'append']));
    const out = applyPatch(doc(`<#c> ex:count 1.`), p);
    expect(nt(out)).toEqual([
      '<https://alice.example/notes/a.ttl#c> <http://example.org/count> "2"^^<http://www.w3.org/2001/XMLSchema#integer> .',
    ]);
  });

  it('refuses a where that matches more than once', () => {
    const p = patch(`_:p a solid:InsertDeletePatch; solid:where { ?s ex:t ex:A }; solid:inserts { ?s ex:seen true }.`);
    expect(() => applyPatch(doc(`<#a> ex:t ex:A. <#b> ex:t ex:A.`), p)).toThrow(PatchConflict);
  });

  it('refuses a where that matches nothing', () => {
    const p = patch(`_:p a solid:InsertDeletePatch; solid:where { ?s ex:t ex:Z }; solid:inserts { ?s ex:seen true }.`);
    expect(() => applyPatch(doc(`<#a> ex:t ex:A.`), p)).toThrow(PatchConflict);
  });

  it('refuses to delete a triple that is not there', () => {
    const p = patch(`_:p a solid:InsertDeletePatch; solid:deletes { <#a> ex:t ex:B }.`);
    expect(() => applyPatch(doc(`<#a> ex:t ex:A.`), p)).toThrow(PatchConflict);
  });

  it.each([
    ['no patch resource', `<#x> ex:y ex:z.`],
    ['two patch resources', `_:a a solid:InsertDeletePatch. _:b a solid:InsertDeletePatch.`],
    ['an unbound variable', `_:p a solid:InsertDeletePatch; solid:inserts { ?s ex:y ex:z }.`],
    ['a blank node in deletes', `_:p a solid:InsertDeletePatch; solid:deletes { _:b ex:y ex:z }.`],
    ['two inserts formulae', `_:p a solid:InsertDeletePatch; solid:inserts { <#a> ex:y 1 }, { <#a> ex:y 2 }.`],
    ['malformed N3', `_:p a solid:InsertDeletePatch; solid:inserts { <#a> ex:y`],
  ])('rejects %s', (_label, body) => {
    expect(() => patch(body)).toThrow(InvalidPatch);
  });
});
