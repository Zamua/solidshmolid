import { describe, expect, it } from 'vitest';
import {
  InvalidPath,
  aclPathOf,
  ancestorsOf,
  canonicalPath,
  foldKey,
  isAclPath,
  nameOf,
  otherKind,
  parentOf,
  subjectOfAcl,
} from '../domain/pods/paths.js';

describe('canonicalPath', () => {
  it('keeps plain paths as they are', () => {
    expect(canonicalPath('/')).toBe('/');
    expect(canonicalPath('/a/b/')).toBe('/a/b/');
    expect(canonicalPath('/a/b.ttl')).toBe('/a/b.ttl');
  });

  it('gives every spelling of a name one encoding', () => {
    expect(canonicalPath('/a%20b')).toBe('/a%20b');
    expect(canonicalPath('/a b')).toBe('/a%20b');
    expect(canonicalPath('/%61')).toBe('/a');
    expect(canonicalPath('/caf%C3%A9')).toBe('/caf%C3%A9');
  });

  it.each([
    ['//', 'empty segment'],
    ['/a//b', 'empty segment'],
    ['/a/../b', 'dot segment'],
    ['/a/%2E%2E/b', 'dot segment'],
    ['/a%2Fb', 'encoded delimiter'],
    ['/a%5Cb', 'encoded delimiter'],
    ['/a%00', 'control character'],
    ['/a%E0%A4%A', 'bad escape'],
    ['a', 'relative'],
  ])('refuses %s (%s)', (input) => {
    expect(() => canonicalPath(input)).toThrow(InvalidPath);
  });
});

describe('path relations', () => {
  it('walks up to the root', () => {
    expect(parentOf('/a/b/c.ttl')).toBe('/a/b/');
    expect(parentOf('/a/b/')).toBe('/a/');
    expect(parentOf('/a')).toBe('/');
    expect(parentOf('/')).toBeNull();
    expect(ancestorsOf('/a/b/c')).toEqual(['/', '/a/', '/a/b/']);
  });

  it('names and kinds', () => {
    expect(nameOf('/a/b/')).toBe('b');
    expect(nameOf('/a/b%20c')).toBe('b%20c');
    expect(otherKind('/a/b')).toBe('/a/b/');
    expect(otherKind('/a/b/')).toBe('/a/b');
  });

  it('pairs a resource with its ACL', () => {
    expect(aclPathOf('/a/')).toBe('/a/.acl');
    expect(aclPathOf('/a/b.ttl')).toBe('/a/b.ttl.acl');
    expect(subjectOfAcl('/a/.acl')).toBe('/a/');
    expect(subjectOfAcl('/a/b.ttl.acl')).toBe('/a/b.ttl');
    expect(isAclPath('/a/.acl')).toBe(true);
    expect(isAclPath('/a/.acl/')).toBe(false);
  });

  it('folds case and Unicode form for collision checks', () => {
    expect(foldKey('/Notes/A.ttl')).toBe(foldKey('/notes/a.ttl'));
    expect(foldKey(canonicalPath('/cafe%CC%81'))).toBe(foldKey(canonicalPath('/caf%C3%A9')));
  });
});
