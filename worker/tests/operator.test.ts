// The operator's routes exist only for a POST to the account site that
// carries the deployment's key, and recovery is reachable no other way.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Env } from '../runtime/env.js';
import worker from '../runtime/worker.js';

const POD_ID = 'k3x9fqm7';
const KEY = 'operator-key-for-tests-0123456789';
const BOOKMARK = '0000007b-0000b26e-00001538-0c3e87bb37b3db5cc52eedb93cd3b96b';

function world(vars: Partial<Env> = { OPERATOR_KEY: KEY }) {
  const calls: string[] = [];
  const object = (kind: string) => (name: string) => ({
    fetch: async () => (calls.push(`${kind} ${name} fetch`), new Response('needs credentials\n', { status: 401 })),
    bookmark: async (at: number) => (calls.push(`${kind} ${name} bookmark ${at}`), BOOKMARK),
    restore: async (bookmark: string) => (calls.push(`${kind} ${name} restore ${bookmark}`), 'undo-bookmark'),
    export: async () => (calls.push(`${kind} ${name} export`), { people: [], podIds: [] }),
  });
  const namespace = (kind: string) => ({ idFromName: (name: string) => name, get: object(kind) });
  const env = {
    POD: namespace('pod'),
    ACCOUNT: namespace('account'),
    DIRECTORY: namespace('directory'),
    POD_HOST_TEMPLATE: '{handle}.pods.example',
    APEX_HOST: 'account.example',
    STORAGE: 'dropbox',
    ...vars,
  } as unknown as Env;
  const send = (url: string, init: RequestInit = {}) => worker.fetch(new Request(url, init), env);
  const ask = (action: string, body: unknown, key: string | null = KEY, method = 'POST') =>
    send(`https://account.example/operator/${action}`, {
      method,
      headers: key === null ? {} : { Authorization: `Bearer ${key}` },
      body: method === 'POST' ? JSON.stringify(body) : undefined,
    });
  const recoveries = () => calls.filter((c) => / (bookmark|restore|export)/u.test(c));
  return { send, ask, calls, recoveries };
}

const RESTORE = { object: 'pod', id: POD_ID, bookmark: BOOKMARK };
const unknown = async (res: Response) => [res.status, await res.text()];
const NOT_FOUND = [404, 'not found\n'];

describe("the operator's routes", () => {
  it('do not exist on a deployment without the key, even for a request that sends one', async () => {
    for (const vars of [{}, { OPERATOR_KEY: '' }]) {
      const { ask, recoveries } = world(vars);
      for (const action of ['restore', 'bookmark', 'export']) {
        expect(await unknown(await ask(action, RESTORE))).toEqual(NOT_FOUND);
        expect(await unknown(await ask(action, RESTORE, ''))).toEqual(NOT_FOUND);
        expect(await unknown(await ask(action, RESTORE, null))).toEqual(NOT_FOUND);
      }
      expect(recoveries()).toEqual([]);
    }
  });

  it('are not found with a wrong key, no key, or the key anywhere but the Authorization header', async () => {
    const { ask, send, recoveries } = world();
    for (const key of ['wrong', `${KEY}x`, KEY.slice(0, -1), '', null]) expect(await unknown(await ask('restore', RESTORE, key))).toEqual(NOT_FOUND);
    expect(await unknown(await send(`https://account.example/operator/restore?key=${KEY}`, { method: 'POST', body: JSON.stringify(RESTORE) }))).toEqual(NOT_FOUND);
    expect(await unknown(await send('https://account.example/operator/restore', { method: 'POST', headers: { Cookie: `operator=${KEY}`, Authorization: `Basic ${KEY}` }, body: JSON.stringify(RESTORE) }))).toEqual(NOT_FOUND);
    expect(recoveries()).toEqual([]);
  });

  it('are not found for GET and every other method, with the right key', async () => {
    const { ask, recoveries } = world();
    for (const method of ['GET', 'HEAD', 'PUT', 'DELETE', 'OPTIONS', 'PATCH']) {
      for (const action of ['restore', 'bookmark', 'export']) expect([method, (await ask(action, RESTORE, KEY, method)).status]).toEqual([method, 404]);
    }
    expect(recoveries()).toEqual([]);
  });

  it('with the key: name a bookmark, restore to it, and export the directory', async () => {
    const { ask, calls } = world();
    const at = Date.parse('2026-11-01T00:00:00Z');
    expect(await (await ask('bookmark', { object: 'account', id: 'acct_key_12345678', at })).json()).toEqual({ bookmark: BOOKMARK });
    expect(await (await ask('restore', RESTORE)).json()).toEqual({ undo: 'undo-bookmark' });
    expect(await (await ask('restore', { object: 'directory', bookmark: BOOKMARK })).json()).toEqual({ undo: 'undo-bookmark' });
    const exported = await ask('export', {});
    expect([exported.headers.get('Cache-Control'), await exported.json()]).toEqual(['no-store, no-transform', { people: [], podIds: [] }]);
    expect(calls).toEqual([`account acct_key_12345678 bookmark ${at}`, `pod ${POD_ID} restore ${BOOKMARK}`, `directory directory restore ${BOOKMARK}`, 'directory directory export']);
  });

  it('refuse a request that does not say which object, and unknown actions', async () => {
    const { ask, recoveries } = world();
    for (const body of [{}, { object: 'pod' }, { object: 'pod', id: 'Not A Pod' }, { object: 'account', id: '../x' }, { object: 'everything', id: POD_ID }, null, 'restore']) {
      expect([(await ask('restore', { ...(body as object), bookmark: BOOKMARK })).status]).toEqual([400]);
    }
    expect((await ask('restore', { object: 'directory' })).status).toBe(400);
    expect((await ask('bookmark', { object: 'directory', at: 'yesterday' })).status).toBe(400);
    expect((await ask('restore', 'x'.repeat(2000))).status).toBe(400);
    expect(await unknown(await ask('wipe', RESTORE))).toEqual(NOT_FOUND);
    expect(recoveries()).toEqual([]);
  });
});

describe('recovery', () => {
  it('is not reachable through any pod URL, whatever it carries', async () => {
    const { send, calls, recoveries } = world();
    const init = { method: 'POST', headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(RESTORE) };
    for (const path of ['/operator/restore', '/operator/bookmark', '/operator/export', '/restore', '/.internal/restore', '/_internal/restore', '/.well-known/solid']) {
      await send(`https://${POD_ID}.pods.example${path}`, init);
    }
    expect(recoveries()).toEqual([]);
    // The pod object saw them as ordinary requests for those names, if at all.
    expect(calls.every((c) => c === `pod ${POD_ID} fetch`)).toBe(true);
  });

  it('is not reachable through any other account-site URL', async () => {
    const { send, recoveries } = world({ OPERATOR_KEY: KEY, DEV_MODE: '1' });
    const init = { method: 'POST', headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(RESTORE) };
    for (const path of ['/operator', '/operatorx/restore', '/api/operator/restore', '/api/restore', '/api/pods/restore', `/api/pods/${POD_ID}/restore`, '/.oidc/restore', '/dev/restore', '/Operator/restore', '/operator%2Frestore']) {
      const res = await send(`https://account.example${path}`, init).catch(() => new Response(null, { status: 500 }));
      expect([path, res.status === 200]).toEqual([path, false]);
    }
    expect(recoveries()).toEqual([]);
  });

  it('is called from the operator route and from nowhere else in the Worker', () => {
    const root = join(import.meta.dirname, '..');
    const sources = (dir: string): string[] => readdirSync(join(root, dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? sources(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : []));
    const callers = ['runtime', 'app', 'domain']
      .flatMap(sources)
      .filter((file) => /\.(restore|bookmark|export)\(|restoreTo\(|onNextSessionRestoreBookmark\(/u.test(readFileSync(join(root, file), 'utf8')))
      .sort();
    expect(callers).toEqual(['runtime/adapters/restore.ts', 'runtime/http/operator.ts', 'runtime/objects/accountObject.ts', 'runtime/objects/directoryObject.ts', 'runtime/objects/podObject.ts']);
  });
});
