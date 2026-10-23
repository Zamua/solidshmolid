import { describe, expect, it } from 'vitest';
import { SqlDirectory } from '../runtime/adapters/sqlDirectory.js';
import { sqlRunner } from './support/fakes.js';

function directory() {
  let now = 1_000_000;
  let n = 0;
  const d = new SqlDirectory(sqlRunner(), () => now, () => `k${++n}`);
  return { d, advance: (s: number) => (now += s) };
}

describe('directory', () => {
  it('gives each person one stable account key', () => {
    const { d } = directory();
    const k = d.accountKeyFor('clerk_a');
    expect(d.accountKeyFor('clerk_a')).toBe(k);
    expect(d.accountKeyFor('clerk_b')).not.toBe(k);
  });

  it('keeps handles unique, and held for 90 days after release', () => {
    const { d, advance } = directory();
    expect(d.reserveHandle('dana', 'h1')).toBe(true);
    expect(d.reserveHandle('dana', 'h1')).toBe(true);
    expect(d.reserveHandle('dana', 'h2')).toBe(false);
    d.releaseHandle('dana');
    advance(89 * 24 * 3600);
    expect(d.reserveHandle('dana', 'h2')).toBe(false);
    advance(2 * 24 * 3600);
    expect(d.reserveHandle('dana', 'h2')).toBe(true);
  });

  it('stores registered clients under their own id', () => {
    const { d } = directory();
    const id = d.registerClient({ redirect_uris: ['https://a.example/cb'], client_name: 'A' });
    expect(id).toMatch(/^reg_/u);
    expect(d.registeredClient(id)).toMatchObject({ client_id: id, client_name: 'A' });
    expect(d.registeredClient('reg_nope')).toBeNull();
  });
});
