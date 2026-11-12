// SPARQL Update, as much of it as changes a document with triples written
// out: any number of `INSERT DATA { ... }` and `DELETE DATA { ... }`
// operations, applied in order. No variables, no WHERE, no graphs. This is
// what client libraries send when they save a document they read.
//
// Unlike an N3 Patch, deleting a triple that is not there changes nothing.

import { Parser, Store, type Quad } from 'n3';
import { InvalidPatch } from './n3patch.js';
import type { Mode } from './wac.js';

export interface Update {
  steps: Step[];
}

interface Step {
  deletes: boolean;
  quads: Quad[];
}

const SUPPORTED = 'only INSERT DATA and DELETE DATA are supported';

export function parseUpdate(text: string, baseIRI: string): Update {
  const steps: Step[] = [];
  let prologue = '';
  let at = 0;
  const skip = () => {
    at = match(text, at, /(?:\s+|#[^\n]*)*/y)!.end;
  };
  for (skip(); at < text.length; skip()) {
    const declaration = match(text, at, /(?:PREFIX\s+[^\s:<]*:\s*|BASE\s*)<[^<>\s]*>/iy);
    if (declaration) {
      prologue += `${declaration.text}\n`;
      at = declaration.end;
      continue;
    }
    const operation = match(text, at, /(INSERT|DELETE)\s+DATA\s*\{/iy);
    if (!operation) throw new InvalidPatch(SUPPORTED);
    const close = closingBrace(text, operation.end);
    const deletes = operation.text[0]!.toUpperCase() === 'D';
    const quads = triples(prologue, text.slice(operation.end, close), baseIRI);
    if (deletes && quads.some((q) => [q.subject, q.object].some((t) => t.termType === 'BlankNode'))) {
      throw new InvalidPatch('blank nodes are not allowed in DELETE DATA');
    }
    steps.push({ deletes, quads });
    at = close + 1;
    skip();
    if (at === text.length) break;
    if (text[at] !== ';') throw new InvalidPatch('operations are separated by ";"');
    at++;
  }
  return { steps };
}

/** The access modes the update needs on its target: what an N3 Patch with
 * the same inserts and deletes needs. */
export function modesForUpdate(update: Update): Mode[] {
  const modes = new Set<Mode>();
  for (const step of update.steps) {
    if (step.quads.length === 0) continue;
    if (!step.deletes) modes.add('append');
    else {
      modes.add('read');
      modes.add('write');
    }
  }
  return [...modes];
}

/** The target graph after the update, and whether it differs. */
export function applyUpdate(target: Quad[], update: Update): { quads: Quad[]; changed: boolean } {
  const store = new Store(target);
  let changed = false;
  for (const step of update.steps) {
    for (const q of step.quads) {
      const had = store.has(q);
      if (step.deletes && had) store.removeQuad(q);
      if (!step.deletes && !had) store.addQuad(q);
      changed ||= step.deletes === had;
    }
  }
  return { quads: store.getQuads(null, null, null, null), changed };
}

function match(text: string, at: number, pattern: RegExp): { text: string; end: number } | null {
  pattern.lastIndex = at;
  const found = pattern.exec(text);
  return found ? { text: found[0], end: at + found[0].length } : null;
}

/** IRIs, strings and comments: where a brace is not a brace. */
const OPAQUE = /<[^<>\s]*>|"""(?:[^"\\]|\\.|"(?!""))*"""|'''(?:[^'\\]|\\.|'(?!''))*'''|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|#[^\n]*/sy;

function closingBrace(text: string, from: number): number {
  for (let at = from; at < text.length; at++) {
    const opaque = match(text, at, OPAQUE);
    if (opaque) at = opaque.end - 1;
    else if (text[at] === '}') return at;
    else if (text[at] === '{') throw new InvalidPatch(`${SUPPORTED}, without GRAPH`);
  }
  throw new InvalidPatch('an operation is not closed');
}

/** The triples of a data block. It is Turtle, but for the last full stop,
 * which SPARQL lets a block leave out. */
function triples(prologue: string, block: string, baseIRI: string): Quad[] {
  const parse = (body: string) => new Parser({ baseIRI, format: 'text/turtle' }).parse(`${prologue}${body}`);
  try {
    return parse(block);
  } catch (e) {
    try {
      return parse(`${block}\n.`);
    } catch {
      throw new InvalidPatch(`not valid triples: ${(e as Error).message}`);
    }
  }
}
