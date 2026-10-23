import { describe, expect, it } from 'vitest';
import { POD_ID_ALPHABET, isPodId, podIdFrom } from '../domain/accounts/podIds.js';
import { handleFromHost, isValidHandle } from '../domain/pods/handles.js';

describe('pod ids', () => {
  it('uses an alphabet without look-alike characters', () => {
    for (const c of '01ilo') expect(POD_ID_ALPHABET).not.toContain(c);
    expect(POD_ID_ALPHABET).toHaveLength(31);
  });

  it('draws eight characters, skipping biased bytes', () => {
    const id = podIdFrom(new Uint8Array([0, 255, 1, 2, 30, 31, 248, 62, 100, 200]));
    expect(id).toBe('234z229g');
    expect(isPodId(id!)).toBe(true);
  });

  it('asks for more bytes when they run out', () => {
    expect(podIdFrom(new Uint8Array([0, 1, 2]))).toBeNull();
    expect(podIdFrom(new Uint8Array(20).fill(250))).toBeNull();
  });

  it('spreads evenly enough over the alphabet', () => {
    const counts = new Map<string, number>();
    for (let i = 0; i < 2000; i++) {
      for (const c of podIdFrom(crypto.getRandomValues(new Uint8Array(32)))!) counts.set(c, (counts.get(c) ?? 0) + 1);
    }
    const expected = (2000 * 8) / 31;
    for (const c of POD_ID_ALPHABET) expect(Math.abs((counts.get(c) ?? 0) - expected)).toBeLessThan(expected * 0.25);
  });

  it('are valid pod hosts, in production and staging', () => {
    const id = podIdFrom(crypto.getRandomValues(new Uint8Array(32)))!;
    expect(isValidHandle(id)).toBe(true);
    expect(handleFromHost(`${id}.solidshmolid.com`, '{handle}.solidshmolid.com')).toBe(id);
    expect(handleFromHost(`stg-${id}.solidshmolid.com`, 'stg-{handle}.solidshmolid.com')).toBe(id);
    expect(isPodId('k3x9fqm0')).toBe(false);
    expect(isPodId('k3x9fqm')).toBe(false);
  });
});
