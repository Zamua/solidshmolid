// RDF parsing and serialization for the media types a pod converts between.

import { JsonLdParser } from 'jsonld-streaming-parser';
import { JsonLdSerializer } from 'jsonld-streaming-serializer';
import { Parser, Writer, type Quad } from 'n3';
import { bareType } from './mediaTypes.js';
import { PREFIXES } from './vocab.js';

export const TURTLE = 'text/turtle';
export const JSON_LD = 'application/ld+json';
export const N_TRIPLES = 'application/n-triples';
export const N3 = 'text/n3';

/** Types stored as RDF documents and offered in each other's place. */
export const RDF_TYPES = [TURTLE, JSON_LD, N_TRIPLES] as const;

export class InvalidRdf extends Error {}

// A remote @context would make every parse an outbound fetch to a URL the
// client chose.
const NO_REMOTE_CONTEXTS = {
  load: async (url: string): Promise<never> => {
    throw new InvalidRdf(`remote JSON-LD contexts are not loaded (${url}); inline the context`);
  },
};

export function isRdfType(contentType: string): boolean {
  return (RDF_TYPES as readonly string[]).includes(bareType(contentType));
}

export async function parseRdf(text: string, contentType: string, baseIRI: string): Promise<Quad[]> {
  const type = bareType(contentType);
  if (type === JSON_LD) return parseJsonLd(text, baseIRI);
  try {
    return new Parser({ baseIRI, format: type === N_TRIPLES ? 'N-Triples' : 'Turtle' }).parse(text);
  } catch (e) {
    throw new InvalidRdf((e as Error).message);
  }
}

function parseJsonLd(text: string, baseIRI: string): Promise<Quad[]> {
  return new Promise((resolve, reject) => {
    const parser = new JsonLdParser({ baseIRI, documentLoader: NO_REMOTE_CONTEXTS });
    const quads: Quad[] = [];
    parser.on('data', (q: Quad) => quads.push(q));
    parser.on('error', (e: Error) => reject(e instanceof InvalidRdf ? e : new InvalidRdf(e.message)));
    parser.on('end', () => resolve(quads));
    parser.write(text);
    parser.end();
  });
}

export async function serializeRdf(quads: Quad[], contentType: string, baseIRI?: string): Promise<string> {
  const type = bareType(contentType);
  if (type === JSON_LD) return serializeJsonLd(quads, baseIRI);
  const writer =
    type === N_TRIPLES
      ? new Writer({ format: 'N-Triples' })
      : new Writer({ format: 'Turtle', prefixes: PREFIXES, ...(baseIRI ? { baseIRI } : {}) });
  writer.addQuads(quads);
  return new Promise((resolve, reject) => writer.end((error, result) => (error ? reject(error) : resolve(result))));
}

function serializeJsonLd(quads: Quad[], baseIRI?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const serializer = new JsonLdSerializer({ space: '  ', ...(baseIRI ? { baseIRI } : {}) });
    let out = '';
    serializer.on('data', (chunk: string) => (out += chunk));
    serializer.on('error', reject);
    serializer.on('end', () => resolve(out));
    for (const q of quads) serializer.write(q);
    serializer.end();
  });
}
