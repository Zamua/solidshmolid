import { describe, expect, it } from 'vitest';
import { InvalidRdf, parseRdf, serializeRdf } from '../domain/rdf.js';

const BASE = 'https://alice.example/a';
const nt = async (text: string, type: string) =>
  (await serializeRdf(await parseRdf(text, type, BASE), 'application/n-triples')).trim().split('\n').sort();

describe('RDF formats', () => {
  it('reads Turtle and JSON-LD to the same graph', async () => {
    const ttl = '<#me> <http://xmlns.com/foaf/0.1/name> "Alice"; <http://xmlns.com/foaf/0.1/knows> <https://bob.example/#me>.';
    const jsonld = JSON.stringify({
      '@context': { foaf: 'http://xmlns.com/foaf/0.1/', knows: { '@id': 'foaf:knows', '@type': '@id' } },
      '@id': '#me',
      'foaf:name': 'Alice',
      knows: 'https://bob.example/#me',
    });
    expect(await nt(jsonld, 'application/ld+json')).toEqual(await nt(ttl, 'text/turtle'));
  });

  it('round-trips through its own JSON-LD', async () => {
    const ttl = '<#s> <http://example.org/p> "o"@en, 3; <http://example.org/q> <#t>.';
    const quads = await parseRdf(ttl, 'text/turtle', BASE);
    const jsonld = await serializeRdf(quads, 'application/ld+json');
    expect(await nt(jsonld, 'application/ld+json')).toEqual(await nt(ttl, 'text/turtle'));
  });

  it('refuses to fetch a remote context', async () => {
    const doc = JSON.stringify({ '@context': 'https://example.org/context.jsonld', '@id': '#x', name: 'x' });
    await expect(parseRdf(doc, 'application/ld+json', BASE)).rejects.toThrow(InvalidRdf);
  });

  it.each([
    ['text/turtle', '<a> <b'],
    ['application/ld+json', '{"@id": '],
    ['application/n-triples', '<a> <b> .'],
  ])('rejects malformed %s', async (type, text) => {
    await expect(parseRdf(text, type, BASE)).rejects.toThrow(InvalidRdf);
  });
});
