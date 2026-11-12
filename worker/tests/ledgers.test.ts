// What the service remembers so a credential cannot be used twice, and how
// that memory stays bounded.

import { describe, expect, it } from 'vitest';
import type { CodeGrant, RefreshFamily } from '../app/identity/ports.js';
import { OidcError } from '../domain/identity/oidc.js';
import { HttpClientRegistry } from '../runtime/adapters/clientRegistry.js';
import { ProofLedger } from '../runtime/adapters/proofLedger.js';
import { SqlAccountStore } from '../runtime/adapters/sqlAccountStore.js';
import type { DirectoryObject } from '../runtime/objects/directoryObject.js';
import { sqlRunner } from './support/fakes.js';

const count = (sql: ReturnType<typeof sqlRunner>, table: string) => Number(sql.exec(`SELECT COUNT(*) AS n FROM ${table}`).toArray()[0]!.n);

describe('the proof ledger', () => {
  it('knows a proof only once it is recorded, and until it runs out', () => {
    const ledger = new ProofLedger(sqlRunner());
    expect(ledger.seen('j1', 100)).toBe(false);
    expect(ledger.seen('j1', 100)).toBe(false);
    ledger.record('j1', 400);
    ledger.record('j1', 400);
    expect(ledger.seen('j1', 400)).toBe(true);
    expect(ledger.seen('j1', 401)).toBe(false);
  });

  it('takes a proof once', () => {
    const ledger = new ProofLedger(sqlRunner());
    expect(ledger.firstUse('j1', 400, 100)).toBe(true);
    expect(ledger.firstUse('j1', 400, 100)).toBe(false);
  });

  it('drops what ran out by index, not by reading every row', () => {
    const sql = sqlRunner();
    new ProofLedger(sql);
    const plan = sql.exec('EXPLAIN QUERY PLAN DELETE FROM seen_proof WHERE expires < 5').toArray();
    expect(JSON.stringify(plan)).toContain('seen_proof_expires');
  });
});

describe("an account's grants", () => {
  const grant = (expires: number): CodeGrant => ({ clientId: 'https://app.example/id', redirectUri: 'https://app.example/cb', webid: 'https://w.example/#me', codeChallenge: 'c', nonce: null, scopes: ['openid'], expires });
  const family = (id: string, fromCode: string, expires: number): RefreshFamily => ({ id, clientId: 'https://app.example/id', webid: 'https://w.example/#me', jkt: 'jkt', scopes: ['openid'], currentHash: `h-${id}`, fromCode, expires });
  const account = () => {
    const sql = sqlRunner();
    const clock = { now: 1_000_000 };
    return { sql, clock, store: new SqlAccountStore(sql, () => 'k1', () => clock.now) };
  };

  it('spends a token request proof once', async () => {
    const { store, clock } = account();
    expect(await store.spendProof('j1', clock.now + 300)).toBe(true);
    expect(await store.spendProof('j1', clock.now + 300)).toBe(false);
    clock.now += 301;
    expect(await store.spendProof('j1', clock.now + 300)).toBe(true);
  });

  it('keeps a code a day past its expiry, so a replay is still known, then drops it', async () => {
    const { store, sql, clock } = account();
    await store.saveCode('old', grant(clock.now + 60));
    clock.now += 60 + 24 * 3600;
    await store.saveCode('newer', grant(clock.now + 60));
    expect((await store.presentCode('old'))?.effect).toBe('issue');
    clock.now += 1;
    await store.saveCode('newest', grant(clock.now + 60));
    expect(await store.presentCode('old')).toBeNull();
    expect(count(sql, 'code')).toBe(2);
  });

  it('drops a code stored before codes carried their expiry', async () => {
    const { store, sql, clock } = account();
    sql.exec('INSERT INTO code(hash, grant_json) VALUES (?, ?)', 'legacy', JSON.stringify(grant(clock.now - 2 * 24 * 3600)));
    sql.exec('INSERT INTO code(hash, grant_json) VALUES (?, ?)', 'legacy-live', JSON.stringify(grant(clock.now + 60)));
    await store.saveCode('new', grant(clock.now + 60));
    expect(await store.presentCode('legacy')).toBeNull();
    expect(await store.presentCode('legacy-live')).not.toBeNull();
  });

  it('drops refresh families that expired or were revoked, and keeps the live ones', async () => {
    const { store, sql, clock } = account();
    for (const id of ['live', 'revoked', 'expired']) {
      await store.saveCode(`code-${id}`, grant(clock.now + 60));
      await store.presentCode(`code-${id}`);
      expect(await store.saveFamily(family(id, `code-${id}`, id === 'expired' ? clock.now + 10 : clock.now + 10_000))).toBe(true);
    }
    await store.revokeFamily('revoked');
    clock.now += 11;
    await store.saveCode('next', grant(clock.now + 60));
    expect(sql.exec('SELECT id FROM family').toArray().map((r) => r.id)).toEqual(['live']);
    expect(await store.family('live')).not.toBeNull();
  });
});

describe('client documents', () => {
  const registry = (answer: () => Response, clock: { now: number }) => {
    const fetched: string[] = [];
    const clients = new HttpClientRegistry({} as DurableObjectStub<DirectoryObject>, async (url) => (fetched.push(url), answer()), () => clock.now);
    return { clients, fetched };
  };

  it('are not fetched again within a minute of failing, and say nothing of what the URL answered', async () => {
    const clock = { now: 5_000_000 };
    let status = 503;
    const { clients, fetched } = registry(() => (status === 200 ? Response.json({ client_id: 'https://flaky.example/id', redirect_uris: ['https://flaky.example/cb'] }) : new Response('secret upstream words', { status })), clock);
    const refusal = await clients.resolve('https://flaky.example/id').catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(OidcError);
    expect((refusal as Error).message).toBe('client document could not be read');
    status = 200;
    await expect(clients.resolve('https://flaky.example/id')).rejects.toThrow('client document could not be read');
    expect(fetched).toHaveLength(1);
    clock.now += 60_000;
    expect((await clients.resolve('https://flaky.example/id')).clientId).toBe('https://flaky.example/id');
    expect(fetched).toHaveLength(2);
  });
});
