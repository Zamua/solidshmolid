import { describe, expect, it } from 'vitest';
import { SqlDirectory } from '../runtime/adapters/sqlDirectory.js';
import { sqlRunner } from './support/fakes.js';
import { isPodId } from '../domain/households/podIds.js';

function directory() {
  let n = 0;
  const d = new SqlDirectory(sqlRunner(), () => 1_000_000, () => `k${++n}`);
  return { d };
}

describe('directory', () => {
  it('gives each person one stable account key', () => {
    const { d } = directory();
    const k = d.accountKeyFor('clerk_a');
    expect(d.accountKeyFor('clerk_a')).toBe(k);
    expect(d.accountKeyFor('clerk_b')).not.toBe(k);
  });

  it('keeps a person in the first household they join', () => {
    const { d } = directory();
    expect(d.householdOf('clerk_a')).toBeNull();
    expect(d.join('clerk_a', 'h1')).toBe('h1');
    expect(d.join('clerk_a', 'h2')).toBe('h1');
    expect(d.householdOf('clerk_a')).toBe('h1');
  });

  it('never hands out the same pod id twice, even when the draw repeats', () => {
    const draws = [new Uint8Array(32).fill(7), new Uint8Array(32).fill(7), new Uint8Array(32).fill(250), new Uint8Array(32).fill(9)];
    const d = new SqlDirectory(sqlRunner(), () => 0, () => 'k', () => draws.shift()!);
    const first = d.allocatePodId('h1');
    const second = d.allocatePodId('h1');
    expect(first).toBe('99999999');
    expect(second).toBe('bbbbbbbb');
    expect(isPodId(first) && isPodId(second)).toBe(true);
  });

  it('stores registered clients under their own id', () => {
    const { d } = directory();
    const id = d.registerClient({ redirect_uris: ['https://a.example/cb'], client_name: 'A' });
    expect(id).toMatch(/^reg_/u);
    expect(d.registeredClient(id)).toMatchObject({ client_id: id, client_name: 'A' });
    expect(d.registeredClient('reg_nope')).toBeNull();
  });
});
