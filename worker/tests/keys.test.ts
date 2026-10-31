import { describe, expect, it } from 'vitest';
import { isAccountKey, linkState, parseLinkState } from '../domain/accounts/keys.js';
import { randomHex } from '../runtime/adapters/system.js';

describe('account keys and link state', () => {
  it('recognizes the keys the directory draws', () => {
    expect(isAccountKey(randomHex())).toBe(true);
    expect(isAccountKey('../../etc')).toBe(false);
  });

  it('reads back the state it writes, and nothing else', () => {
    const key = randomHex();
    expect(parseLinkState(linkState(key, 'n1'))).toEqual({ accountKey: key, nonce: 'n1' });
    for (const bad of [null, '', 'k', 'k.', '.n', 'k.n.x']) expect(parseLinkState(bad)).toBeNull();
  });
});
