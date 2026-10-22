// RDF parsing and serialization for the media types a pod converts between.

import { Parser, Writer, type Quad } from 'n3';
import { bareType } from './layout.js';
import { PREFIXES } from './vocab.js';

export const TURTLE = 'text/turtle';
export const N_TRIPLES = 'application/n-triples';
export const N3 = 'text/n3';

/** Types stored as RDF documents and offered in each other's place. */
export const RDF_TYPES = [TURTLE, N_TRIPLES] as const;

export class InvalidRdf extends Error {}

export function isRdfType(contentType: string): boolean {
  return (RDF_TYPES as readonly string[]).includes(bareType(contentType));
}

export function parseRdf(text: string, contentType: string, baseIRI: string): Quad[] {
  const format = bareType(contentType) === N_TRIPLES ? 'N-Triples' : 'Turtle';
  try {
    return new Parser({ baseIRI, format }).parse(text);
  } catch (e) {
    throw new InvalidRdf((e as Error).message);
  }
}

export function serializeRdf(quads: Quad[], contentType: string, baseIRI?: string): string {
  const nTriples = bareType(contentType) === N_TRIPLES;
  const writer = nTriples
    ? new Writer({ format: 'N-Triples' })
    : new Writer({ format: 'Turtle', prefixes: PREFIXES, ...(baseIRI ? { baseIRI } : {}) });
  writer.addQuads(quads);
  let out = '';
  writer.end((error, result) => {
    if (error) throw error;
    out = result;
  });
  return out;
}
