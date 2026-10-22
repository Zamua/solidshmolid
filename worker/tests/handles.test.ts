import { describe, expect, it } from 'vitest';
import { handleFromHost, isValidHandle } from '../domain/handles.js';
import { parseRange } from '../runtime/http.js';

describe('handles', () => {
  it.each(['alice', 'a', 'a1-b2', 'x'.repeat(32)])('accepts %s', (h) => expect(isValidHandle(h)).toBe(true));
  it.each(['', '-a', 'a-', 'a--b', 'A', 'a.b', 'www', 'stg', 'stg-alice', 'x'.repeat(33)])('refuses %s', (h) =>
    expect(isValidHandle(h)).toBe(false),
  );

  it('reads the handle out of a pod host', () => {
    expect(handleFromHost('alice.solidshmolid.com', '{handle}.solidshmolid.com')).toBe('alice');
    expect(handleFromHost('Alice.SolidShmolid.com', '{handle}.solidshmolid.com')).toBe('alice');
    expect(handleFromHost('stg-alice.solidshmolid.com', 'stg-{handle}.solidshmolid.com')).toBe('alice');
  });

  it('does not let one environment serve the other', () => {
    expect(handleFromHost('stg-alice.solidshmolid.com', '{handle}.solidshmolid.com')).toBeNull();
    expect(handleFromHost('alice.solidshmolid.com', 'stg-{handle}.solidshmolid.com')).toBeNull();
    expect(handleFromHost('solidshmolid.com', '{handle}.solidshmolid.com')).toBeNull();
    expect(handleFromHost('a.b.solidshmolid.com', '{handle}.solidshmolid.com')).toBeNull();
  });
});

describe('parseRange', () => {
  it.each([
    ['bytes=0-9', { start: 0, end: 9 }],
    ['bytes=5-', { start: 5, end: null }],
    ['bytes=-3', { suffix: 3 }],
    ['bytes=9-2', null],
    ['bytes=0-1,4-5', null],
    ['items=0-1', null],
    [null, null],
  ])('%s', (header, expected) => expect(parseRange(header)).toEqual(expected));
});
