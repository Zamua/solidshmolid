import { describe, expect, it } from 'vitest';
import { SqlDirectory, UNUSED_CLIENT_TTL_S } from '../runtime/adapters/sqlDirectory.js';
import { sqlRunner } from './support/fakes.js';
import { isPodId } from '../domain/accounts/podIds.js';

function directory() {
  let n = 0;
  const d = new SqlDirectory(sqlRunner(), () => 1_000_000, () => `k${++n}`);
  return { d };
}

describe('directory', () => {
  it('holds only so many registrations no one signed in through, dropping the oldest', () => {
    let now = 1_000_000;
    let n = 0;
    const d = new SqlDirectory(sqlRunner(), () => now++, () => `k${++n}`, undefined, 3);
    const used = d.registerClient({ redirect_uris: ['https://used.example/cb'] });
    d.clientSignedIn(used);
    const ids = Array.from({ length: 5 }, (_, i) => d.registerClient({ redirect_uris: [`https://c${i}.example/cb`] }));
    expect(ids.map((id) => d.registeredClient(id) !== null)).toEqual([false, false, true, true, true]);
    expect(d.registeredClient(used)).not.toBeNull();
  });

  it('gives each person one stable account key', () => {
    const { d } = directory();
    const k = d.accountKeyFor('clerk_a');
    expect(d.accountKeyFor('clerk_a')).toBe(k);
    expect(d.accountKeyFor('clerk_b')).not.toBe(k);
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

  it('never hands out a retired pod id again', () => {
    const draws = [new Uint8Array(32).fill(7), new Uint8Array(32).fill(7), new Uint8Array(32).fill(9)];
    const d = new SqlDirectory(sqlRunner(), () => 0, () => 'k', () => draws.shift()!);
    const first = d.allocatePodId('h1');
    d.retirePodId(first);
    const second = d.allocatePodId('h2');
    expect(first).toBe('99999999');
    expect(second).toBe('bbbbbbbb');
  });

  it('stores registered clients under their own id', () => {
    const { d } = directory();
    const id = d.registerClient({ redirect_uris: ['https://a.example/cb'], client_name: 'A' });
    expect(id).toMatch(/^reg_/u);
    expect(d.registeredClient(id)).toMatchObject({ client_id: id, client_name: 'A' });
    expect(d.registeredClient('reg_nope')).toBeNull();
  });

  it('drops registrations no one signed in through once they age out', () => {
    let now = 1_000_000;
    let n = 0;
    const d = new SqlDirectory(sqlRunner(), () => now, () => `k${++n}`);
    const idle = d.registerClient({ redirect_uris: ['https://a.example/cb'] });
    const used = d.registerClient({ redirect_uris: ['https://b.example/cb'] });
    d.clientSignedIn(used);
    now += UNUSED_CLIENT_TTL_S;
    d.registerClient({ redirect_uris: ['https://c.example/cb'] });
    expect(d.registeredClient(idle)).not.toBeNull();
    now += 1;
    d.registerClient({ redirect_uris: ['https://c.example/cb'] });
    expect(d.registeredClient(idle)).toBeNull();
    expect(d.registeredClient(used)).not.toBeNull();
  });
});
