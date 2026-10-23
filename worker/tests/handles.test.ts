import { describe, expect, it } from 'vitest';
import { handleFromHost, isValidHandle } from '../domain/pods/handles.js';
import { parseRange } from '../runtime/http/solid.js';

describe('handles', () => {
  it.each(['alice', 'a', 'a1-b2', 'x'.repeat(32)])('accepts %s', (h) => expect(isValidHandle(h)).toBe(true));
  it.each(['', '-a', 'a-', 'a--b', 'A', 'a.b', 'www', 'stg', 'x'.repeat(33)])('refuses %s', (h) =>
    expect(isValidHandle(h)).toBe(false),
  );

  it('reads the handle out of a pod host', () => {
    expect(handleFromHost('alice.pods.example', '{handle}.pods.example')).toBe('alice');
    expect(handleFromHost('Alice.Pods.Example', '{handle}.pods.example')).toBe('alice');
    expect(handleFromHost('alice-test.pods.example', '{handle}-test.pods.example')).toBe('alice');
  });

  it('refuses hosts outside the template', () => {
    expect(handleFromHost('alice.pods.example', '{handle}-test.pods.example')).toBeNull();
    expect(handleFromHost('pods.example', '{handle}.pods.example')).toBeNull();
    expect(handleFromHost('a.b.pods.example', '{handle}.pods.example')).toBeNull();
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
