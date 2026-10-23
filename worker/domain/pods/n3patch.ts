// N3 Patch (Solid Protocol, "Modifying Resources Using N3 Patches").
//
// A patch names one solid:InsertDeletePatch with up to three cited formulae:
// `where` (conditions), `deletes` and `inserts`. Conditions must match the
// target in exactly one way; the deletes, after substituting that match, must
// all be present; then deletes are removed and inserts added.

import { DataFactory, Parser, Store, type Quad, type Term } from 'n3';
import type { Mode } from './wac.js';
import { RDF, SOLID } from '../shared/vocab.js';

const { quad: makeQuad } = DataFactory;

/** The document breaks the N3 Patch rules: 422. */
export class InvalidPatch extends Error {}
/** The patch is well formed but does not apply to the target: 409. */
export class PatchConflict extends Error {}

export interface Patch {
  where: Quad[];
  deletes: Quad[];
  inserts: Quad[];
}

type Binding = Map<string, Term>;

export function parsePatch(text: string, baseIRI: string): Patch {
  let quads: Quad[];
  try {
    quads = new Parser({ baseIRI, format: 'text/n3' }).parse(text);
  } catch (e) {
    throw new InvalidPatch(`not valid N3: ${(e as Error).message}`);
  }
  const top = quads.filter((q) => q.graph.termType === 'DefaultGraph');
  const patches = top.filter(
    (q) => q.predicate.value === RDF('type') && q.object.value === SOLID('InsertDeletePatch'),
  );
  if (patches.length !== 1) throw new InvalidPatch('expected exactly one solid:InsertDeletePatch');
  const subject = patches[0]!.subject;

  const formula = (predicate: string): Quad[] => {
    const refs = top.filter((q) => q.subject.equals(subject) && q.predicate.value === predicate);
    if (refs.length > 1) throw new InvalidPatch(`more than one ${predicate}`);
    if (refs.length === 0) return [];
    const graph = refs[0]!.object;
    if (graph.termType !== 'BlankNode') throw new InvalidPatch(`${predicate} must be a formula`);
    const inner = quads.filter((q) => q.graph.equals(graph));
    if (inner.some((q) => quads.some((n) => n.graph.equals(q.subject) || n.graph.equals(q.object)))) {
      throw new InvalidPatch('nested formulae are not allowed');
    }
    return inner.map((q) => makeQuad(q.subject, q.predicate, q.object));
  };

  const patch = { where: formula(SOLID('where')), deletes: formula(SOLID('deletes')), inserts: formula(SOLID('inserts')) };

  const bound = new Set(patch.where.flatMap(termsOf).filter(isVariable).map((t) => t.value));
  for (const q of [...patch.deletes, ...patch.inserts]) {
    for (const t of termsOf(q)) {
      if (isVariable(t) && !bound.has(t.value)) throw new InvalidPatch(`variable ?${t.value} is not bound by where`);
    }
  }
  if ([...patch.where, ...patch.deletes].some((q) => termsOf(q).some((t) => t.termType === 'BlankNode'))) {
    throw new InvalidPatch('blank nodes are not allowed in where or deletes');
  }
  return patch;
}

/** The access modes the patch needs on its target. */
export function modesForPatch(patch: Patch): Mode[] {
  const modes = new Set<Mode>();
  if (patch.where.length > 0) modes.add('read');
  if (patch.inserts.length > 0) modes.add('append');
  if (patch.deletes.length > 0) {
    modes.add('read');
    modes.add('write');
  }
  return [...modes];
}

/** The target graph after the patch. */
export function applyPatch(target: Quad[], patch: Patch): Quad[] {
  const store = new Store(target);
  const bindings = matchAll(store, patch.where, [new Map()]);
  if (bindings.length !== 1) {
    throw new PatchConflict(`where matched ${bindings.length} times; it must match exactly once`);
  }
  const binding = bindings[0]!;
  const deletes = patch.deletes.map((q) => substitute(q, binding));
  for (const d of deletes) {
    if (!store.has(d)) throw new PatchConflict('a triple to delete is not in the resource');
  }
  store.removeQuads(deletes);
  store.addQuads(patch.inserts.map((q) => substitute(q, binding)));
  return store.getQuads(null, null, null, null);
}

function matchAll(store: Store, patterns: Quad[], bindings: Binding[]): Binding[] {
  if (patterns.length === 0) return bindings;
  const [first, ...rest] = patterns;
  const next: Binding[] = [];
  for (const b of bindings) {
    const p = substitute(first!, b);
    const free = (t: Term) => (isVariable(t) ? null : t);
    for (const m of store.getQuads(free(p.subject) as never, free(p.predicate) as never, free(p.object) as never, null)) {
      const extended = new Map(b);
      if (bindVar(extended, p.subject, m.subject) && bindVar(extended, p.predicate, m.predicate) && bindVar(extended, p.object, m.object)) {
        next.push(extended);
      }
    }
  }
  return matchAll(store, rest, next);
}

function bindVar(b: Binding, pattern: Term, value: Term): boolean {
  if (!isVariable(pattern)) return true;
  const existing = b.get(pattern.value);
  if (existing) return existing.equals(value);
  b.set(pattern.value, value);
  return true;
}

function substitute(q: Quad, b: Binding): Quad {
  const s = (t: Term) => (isVariable(t) ? (b.get(t.value) ?? t) : t);
  return makeQuad(s(q.subject) as Quad['subject'], s(q.predicate) as Quad['predicate'], s(q.object) as Quad['object']);
}

function termsOf(q: Quad): Term[] {
  return [q.subject, q.predicate, q.object];
}

function isVariable(t: Term): boolean {
  return t.termType === 'Variable';
}
