import { describe, expect, it } from 'vitest';
import { negotiate } from '../domain/pods/conneg.js';

const RDF = ['text/turtle', 'application/n-triples'];

describe('negotiate', () => {
  it('serves the stored type when the client accepts anything', () => {
    expect(negotiate(null, RDF)).toBe('text/turtle');
    expect(negotiate('*/*', RDF)).toBe('text/turtle');
  });

  it('honours q-values over preference order', () => {
    expect(negotiate('text/turtle;q=0.5, application/n-triples', RDF)).toBe('application/n-triples');
  });

  it('lets the most specific range set the quality', () => {
    expect(negotiate('text/*;q=0, text/turtle', RDF)).toBe('text/turtle');
    expect(negotiate('text/turtle;q=0, */*', RDF)).toBe('application/n-triples');
  });

  it('returns null when nothing is acceptable', () => {
    expect(negotiate('image/png', RDF)).toBeNull();
  });
});
