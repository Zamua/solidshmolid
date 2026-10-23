import { describe, expect, it } from 'vitest';
import {
  UnmappablePath,
  basePathOf,
  containerOfFolder,
  documentFile,
  metaFileOf,
  resourceOfFile,
} from '../domain/pods/layout.js';
import { canonicalPath } from '../domain/pods/paths.js';

// Expected file names follow Community Solid Server 7.2's ExtensionBasedMapper
// rules; compat.test.ts checks them against a running CSS.
describe('documentFile matches the CSS file layout', () => {
  it.each([
    ['/a/b.ttl', 'text/turtle', 'a/b.ttl'],
    ['/a/b.txt', 'text/plain; charset=utf-8', 'a/b.txt'],
    ['/profile/card', 'text/turtle', 'profile/card$.ttl'],
    ['/data.json', 'application/ld+json', 'data.json$.jsonld'],
    ['/photo', 'image/png', 'photo$.png'],
    ['/blob', 'application/octet-stream', 'blob'],
    ['/a/.acl', 'text/turtle', 'a/.acl'],
    ['/a/b.ttl.acl', 'text/turtle', 'a/b.ttl.acl'],
    ['/Upper.TTL', 'text/turtle', 'Upper.TTL'],
  ])('%s as %s -> %s', (path, type, file) => {
    expect(documentFile(path, type)).toEqual({ file, typeInMeta: false });
  });

  it('keeps a type with no extension in the metadata file', () => {
    expect(documentFile('/x', 'application/x-solidshmolid-test')).toEqual({
      file: 'x$.unknown',
      typeInMeta: true,
    });
  });

  it('refuses names that would read back as a different resource', () => {
    expect(() => documentFile('/a$.ttl', 'text/turtle')).toThrow(UnmappablePath);
  });

  it('keeps Windows-hostile characters encoded in file names', () => {
    const path = canonicalPath('/a:b/c%3Fd*e%25f');
    expect(basePathOf(path)).toBe('a%3Ab/c%3Fd%2Ae%25f');
    expect(resourceOfFile('a%3Ab/c%3Fd%2Ae%25f').path).toBe(path);
  });

  it('decodes ordinary characters into file names', () => {
    expect(basePathOf(canonicalPath('/my notes/caf%C3%A9.ttl'))).toBe('my notes/café.ttl');
  });
});

describe('reading the folder back', () => {
  it.each([
    ['a/b.ttl', '/a/b.ttl', 'text/turtle'],
    ['profile/card$.ttl', '/profile/card', 'text/turtle'],
    ['data.json$.jsonld', '/data.json', 'application/ld+json'],
    ['blob', '/blob', 'application/octet-stream'],
    ['x$.unknown', '/x', 'application/octet-stream'],
    ['my notes/café.ttl', '/my%20notes/caf%C3%A9.ttl', 'text/turtle'],
  ])('%s -> %s (%s)', (file, path, type) => {
    expect(resourceOfFile(file)).toEqual({ path, contentType: type });
  });

  it('round-trips documents through the layout', () => {
    for (const [path, type] of [
      ['/profile/card', 'text/turtle'],
      ['/a b/c.png', 'image/png'],
      ['/q', 'text/html'],
    ] as const) {
      const canonical = canonicalPath(path);
      const { file } = documentFile(canonical, type);
      expect(resourceOfFile(file)).toEqual({ path: canonical, contentType: type });
    }
  });

  it('maps folders to containers', () => {
    expect(containerOfFolder('')).toBe('/');
    expect(containerOfFolder('a/b/')).toBe('/a/b/');
    expect(containerOfFolder('my notes')).toBe('/my%20notes/');
    expect(basePathOf('/a/b/')).toBe('a/b/');
  });

  it('names metadata files after the resource, not its stored file', () => {
    expect(metaFileOf('/profile/card')).toBe('profile/card.meta');
    expect(metaFileOf('/a/')).toBe('a/.meta');
    expect(metaFileOf('/')).toBe('.meta');
  });
});
