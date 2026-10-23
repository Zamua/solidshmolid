import { describe, expect, it } from 'vitest';
import type { AccountState } from '../app/accounts/ports.js';
import { StorageUnavailable } from '../app/shared/errors.js';
import { LinkTokens } from '../runtime/adapters/linkTokens.js';
import { Sealer } from '../runtime/adapters/sealing.js';
import { SqlAccountPods } from '../runtime/adapters/sqlAccountPods.js';
import { SqlPlacement } from '../runtime/adapters/sqlPlacement.js';
import { sqlRunner } from './support/fakes.js';

const KEY = btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i)));

const STATE: AccountState = {
  key: 'k1',
  webid: 'https://k3x9fqm7.pods.example/profile/card#me',
  pods: [{ podId: 'k3x9fqm7', linkId: null, folder: 'k3x9fqm7' }],
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
  const ended = { revoked: [] as string[], wiped: 0 };
  const endings = {
    revoke: async (linkId: string) => void ended.revoked.push(linkId),
    wipe: async () => void ended.wiped++,
  };
  return { sql, ended, account: new SqlAccountPods(sql, new Sealer(KEY), atomically, endings, nowMs) };
}

describe("an account's pods", () => {
  it('keeps the first account created', async () => {
    const { account } = store();
    expect(await account.load()).toBeNull();
    expect(await account.create(STATE)).toEqual(STATE);
    expect(await account.create({ ...STATE, webid: 'https://other.example/#me', pods: [] })).toEqual(STATE);
  });

  it('adds pods in order', async () => {
    const { account } = store();
    await account.create(STATE);
    await account.addPod({ podId: 'p2', linkId: null, folder: 'p2' });
    expect((await account.load())!.pods.map((p) => p.podId)).toEqual(['k3x9fqm7', 'p2']);
    await expect(account.addPod({ podId: 'p2', linkId: null, folder: 'p2' })).rejects.toThrow();
  });

  it('records where pods live', async () => {
    const { account } = store();
    await account.create(STATE);
    await account.addLink({ linkId: 'l1', provider: 'dropbox', account: 'dbid:1' }, 'refresh-1');
    await account.placePod('k3x9fqm7', 'l1');
    const state = (await account.load())!;
    expect(state.links).toEqual([{ linkId: 'l1', provider: 'dropbox', account: 'dbid:1' }]);
    expect(state.pods[0]!.linkId).toBe('l1');
  });

  it('keeps refresh tokens sealed, bound to their account and link', async () => {
    const { sql, account } = store();
    await account.create(STATE);
    await account.addLink({ linkId: 'l1', provider: 'dropbox', account: 'dbid:1' }, 'secret-refresh');
    const raw = sql.db.prepare('SELECT refresh FROM storage_link').get() as { refresh: string };
    expect(raw.refresh).not.toContain('secret-refresh');
    expect(await account.grant('l1')).toEqual({ provider: 'dropbox', refreshToken: 'secret-refresh' });
    sql.db.prepare("UPDATE storage_link SET link_id = 'l2'").run();
    await expect(account.grant('l2')).rejects.toThrow();
    expect(await account.grant('nope')).toBeNull();
  });

  it('lets a pending link be taken once, before it expires', async () => {
    let now = 100_000;
    const { account } = store(() => now);
    await account.create(STATE);
    await account.rememberPending('n1', { verifier: 'v', provider: 'google-drive' });
    now += 1000;
    expect(await account.takePending('n1')).toEqual({ verifier: 'v', provider: 'google-drive' });
    expect(await account.takePending('n1')).toBeNull();
    await account.rememberPending('n2', { verifier: 'v', provider: 'dropbox' });
    now += 16 * 60 * 1000;
    expect(await account.takePending('n2')).toBeNull();
  });
});

describe('ending things', () => {
  it('lets a deletion request be answered once, before it expires', async () => {
    let now = 100_000;
    const { account } = store(() => now);
    await account.create(STATE);
    await account.rememberDeletion('t1', { podId: 'p2', sentence: 'yes, delete my data in Dropbox' });
    expect(await account.takeDeletion('t1')).toEqual({ podId: 'p2', sentence: 'yes, delete my data in Dropbox' });
    expect(await account.takeDeletion('t1')).toBeNull();
    await account.rememberDeletion('t2', { podId: null, sentence: 's' });
    now += 11 * 60 * 1000;
    expect(await account.takeDeletion('t2')).toBeNull();
  });

  it('gives a link up with its provider before forgetting it', async () => {
    const { account, ended } = store();
    await account.create(STATE);
    await account.addLink({ linkId: 'l1', provider: 'dropbox', account: 'dbid:1' }, 'r1');
    await account.removeLink('l1');
    expect(ended.revoked).toEqual(['l1']);
    expect((await account.load())!.links).toEqual([]);
  });

  it('gives every link up, then wipes, when the account is erased', async () => {
    const { account, ended } = store();
    await account.create(STATE);
    await account.addLink({ linkId: 'l1', provider: 'dropbox', account: 'a' }, 'r1');
    await account.addLink({ linkId: 'l2', provider: 'dropbox', account: 'b' }, 'r2');
    await account.removePod('k3x9fqm7');
    expect((await account.load())!.pods).toEqual([]);
    await account.erase();
    expect(ended.revoked.sort()).toEqual(['l1', 'l2']);
    expect(ended.wiped).toBe(1);
  });
});

describe('link access tokens', () => {
  const grant = async (linkId: string) => (linkId === 'l1' ? { provider: 'dropbox', refreshToken: 'r1' } : null);

  it('mints once and shares the token until shortly before it expires', async () => {
    let now = 0;
    let minted = 0;
    const tokens = new LinkTokens(grant, { dropbox: { refresh: async () => ({ token: `a${++minted}`, expiresAt: now + 4 * 3600_000 }), revoke: async () => {} } }, () => now);
    const [a, b] = await Promise.all([tokens.accessToken('l1', false), tokens.accessToken('l1', false)]);
    expect([a.token, b.token, minted]).toEqual(['a1', 'a1', 1]);
    now += 4 * 3600_000 - 30_000;
    expect((await tokens.accessToken('l1', false)).token).toBe('a2');
    expect((await tokens.accessToken('l1', true)).token).toBe('a3');
  });

  it('reports a refused or missing link as unavailable storage, and retries later', async () => {
    let fail = true;
    const tokens = new LinkTokens(grant, {
      dropbox: {
        refresh: async () => {
          if (fail) throw new Error('invalid_grant');
          return { token: 'ok', expiresAt: Number.MAX_SAFE_INTEGER };
        },
        revoke: async () => {},
      },
    });
    await expect(tokens.accessToken('l1', false)).rejects.toThrow(StorageUnavailable);
    await expect(tokens.accessToken('l9', false)).rejects.toThrow(StorageUnavailable);
    fail = false;
    expect((await tokens.accessToken('l1', false)).token).toBe('ok');
  });

  it('gives a grant up even when the provider refuses, so the link can still go', async () => {
    const revoked: string[] = [];
    const tokens = new LinkTokens(grant, {
      dropbox: {
        refresh: async () => ({ token: 'ok', expiresAt: Number.MAX_SAFE_INTEGER }),
        revoke: async (r) => {
          revoked.push(r);
          throw new Error('down');
        },
      },
    });
    await expect(tokens.revoke('l1')).resolves.toBeUndefined();
    await expect(tokens.revoke('l9')).resolves.toBeUndefined();
    expect(revoked).toEqual(['r1']);
  });
});

describe('a pod placement', () => {
  it('starts without a cursor and keeps the one the placement sets', async () => {
    const placement = new SqlPlacement(sqlRunner());
    expect(placement.current()).toBeNull();
    placement.save({ accountKey: 'k1', linkId: 'l1', provider: 'dropbox', folder: 'k3x9fqm7' });
    expect(await placement.cursor()).toBeNull();
    await placement.setCursor('c1');
    expect(placement.current()).toEqual({ accountKey: 'k1', linkId: 'l1', provider: 'dropbox', folder: 'k3x9fqm7', cursor: 'c1' });
  });
});
