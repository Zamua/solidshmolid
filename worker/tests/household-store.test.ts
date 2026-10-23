import { describe, expect, it } from 'vitest';
import type { HouseholdState } from '../app/households/ports.js';
import { StorageUnavailable } from '../app/shared/errors.js';
import { LinkTokens } from '../runtime/adapters/linkTokens.js';
import { Sealer } from '../runtime/adapters/sealing.js';
import { SqlHousehold } from '../runtime/adapters/sqlHousehold.js';
import { SqlPlacement } from '../runtime/adapters/sqlPlacement.js';
import { sqlRunner } from './support/fakes.js';

const KEY = btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i)));

const STATE: HouseholdState = {
  id: 'h1',
  members: [{ clerkUserId: 'user_dana', role: 'manager', webid: 'https://k3x9fqm7.pods.example/profile/card#me', handle: 'k3x9fqm7' }],
  pods: [{ podId: 'k3x9fqm7', owner: 'user_dana', linkId: null, folder: 'k3x9fqm7' }],
  links: [],
};

function store(nowMs = () => 100_000) {
  const sql = sqlRunner();
  const atomically = <T>(fn: () => T): T => {
    sql.db.exec('BEGIN');
    try {
      const out = fn();
      sql.db.exec('COMMIT');
      return out;
    } catch (e) {
      sql.db.exec('ROLLBACK');
      throw e;
    }
  };
  return { sql, household: new SqlHousehold(sql, new Sealer(KEY), atomically, nowMs) };
}

describe('a household store', () => {
  it('keeps the first household created', async () => {
    const { household } = store();
    expect(await household.load()).toBeNull();
    expect(await household.create(STATE)).toEqual(STATE);
    expect(await household.create({ ...STATE, id: 'h2', pods: [] })).toEqual(STATE);
  });

  it('records where pods live', async () => {
    const { household } = store();
    await household.create(STATE);
    await household.addLink({ linkId: 'l1', provider: 'dropbox', account: 'dbid:1' }, 'refresh-1');
    await household.placePod('k3x9fqm7', 'l1');
    const state = (await household.load())!;
    expect(state.links).toEqual([{ linkId: 'l1', provider: 'dropbox', account: 'dbid:1' }]);
    expect(state.pods[0]!.linkId).toBe('l1');
  });

  it('keeps refresh tokens sealed, bound to their household and link', async () => {
    const { sql, household } = store();
    await household.create(STATE);
    await household.addLink({ linkId: 'l1', provider: 'dropbox', account: 'dbid:1' }, 'secret-refresh');
    const raw = sql.db.prepare('SELECT refresh FROM link').get() as { refresh: string };
    expect(raw.refresh).not.toContain('secret-refresh');
    expect(await household.grant('l1')).toEqual({ provider: 'dropbox', refreshToken: 'secret-refresh' });
    sql.db.prepare("UPDATE link SET link_id = 'l2'").run();
    await expect(household.grant('l2')).rejects.toThrow();
    expect(await household.grant('nope')).toBeNull();
  });

  it('lets a pending link be taken once, before it expires', async () => {
    let now = 100_000;
    const { household } = store(() => now);
    await household.create(STATE);
    await household.rememberPending('n1', { verifier: 'v', person: 'user_dana' });
    now += 1000;
    expect(await household.takePending('n1')).toEqual({ verifier: 'v', person: 'user_dana' });
    expect(await household.takePending('n1')).toBeNull();
    await household.rememberPending('n2', { verifier: 'v', person: 'user_dana' });
    now += 16 * 60 * 1000;
    expect(await household.takePending('n2')).toBeNull();
  });
});

describe('link access tokens', () => {
  const grant = async (linkId: string) => (linkId === 'l1' ? { provider: 'dropbox', refreshToken: 'r1' } : null);

  it('mints once and shares the token until shortly before it expires', async () => {
    let now = 0;
    let minted = 0;
    const tokens = new LinkTokens(grant, { dropbox: async () => ({ token: `a${++minted}`, expiresAt: now + 4 * 3600_000 }) }, () => now);
    const [a, b] = await Promise.all([tokens.accessToken('l1', false), tokens.accessToken('l1', false)]);
    expect([a.token, b.token, minted]).toEqual(['a1', 'a1', 1]);
    now += 4 * 3600_000 - 30_000;
    expect((await tokens.accessToken('l1', false)).token).toBe('a2');
    expect((await tokens.accessToken('l1', true)).token).toBe('a3');
  });

  it('reports a refused or missing link as unavailable storage, and retries later', async () => {
    let fail = true;
    const tokens = new LinkTokens(grant, {
      dropbox: async () => {
        if (fail) throw new Error('invalid_grant');
        return { token: 'ok', expiresAt: Number.MAX_SAFE_INTEGER };
      },
    });
    await expect(tokens.accessToken('l1', false)).rejects.toThrow(StorageUnavailable);
    await expect(tokens.accessToken('l9', false)).rejects.toThrow(StorageUnavailable);
    fail = false;
    expect((await tokens.accessToken('l1', false)).token).toBe('ok');
  });
});

describe('a pod placement', () => {
  it('starts without a cursor and keeps the one the placement sets', async () => {
    const placement = new SqlPlacement(sqlRunner());
    expect(placement.current()).toBeNull();
    placement.save({ householdId: 'h1', linkId: 'l1', provider: 'dropbox', folder: 'k3x9fqm7' });
    expect(await placement.cursor()).toBeNull();
    await placement.setCursor('c1');
    expect(placement.current()).toEqual({ householdId: 'h1', linkId: 'l1', provider: 'dropbox', folder: 'k3x9fqm7', cursor: 'c1' });
  });
});
