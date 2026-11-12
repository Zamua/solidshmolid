// The operator's routes: recovery of an object's state, and the directory
// export. They exist only on a deployment that sets OPERATOR_KEY, only on the
// account site, and only for a POST that carries the key. Anything else is
// the same "not found" every unknown path gets, so nothing tells a visitor
// the routes are there.

import { isPodId } from '../../domain/accounts/podIds.js';
import type { Env } from '../env.js';
import { readAll } from '../../app/shared/streams.js';

const PREFIX = '/operator/';
const BODY_LIMIT = 1024;
const ACCOUNT_KEY = /^[A-Za-z0-9_-]{8,128}$/u;

/** Null for a path that is not the operator's. */
export async function operatorRoute(request: Request, env: Env, url: URL): Promise<Response | null> {
  if (!url.pathname.startsWith(PREFIX)) return null;
  if (!env.OPERATOR_KEY || request.method !== 'POST' || !(await sameKey(bearer(request), env.OPERATOR_KEY))) return notFound();
  let ask: Ask;
  try {
    ask = JSON.parse(new TextDecoder().decode(await readAll(request.body ?? new Response('{}').body!, BODY_LIMIT))) as Ask;
    if (ask === null || typeof ask !== 'object') throw new Error('not an object');
  } catch {
    return answer(400, { error: 'the body is JSON of at most 1 KiB' });
  }
  try {
    switch (url.pathname.slice(PREFIX.length)) {
      case 'export':
        return answer(200, await env.DIRECTORY.get(env.DIRECTORY.idFromName('directory')).export());
      case 'bookmark': {
        if (typeof ask.at !== 'number') return answer(400, { error: '"at" is a time in milliseconds' });
        const object = objectFor(env, ask);
        return object ? answer(200, { bookmark: await object.bookmark(ask.at) }) : answer(400, { error: NAMING });
      }
      case 'restore': {
        if (typeof ask.bookmark !== 'string') return answer(400, { error: '"bookmark" is a bookmark' });
        const object = objectFor(env, ask);
        return object ? answer(200, { undo: await object.restore(ask.bookmark) }) : answer(400, { error: NAMING });
      }
      default:
        return notFound();
    }
  } catch (e) {
    return answer(502, { error: String((e as Error)?.message ?? e) });
  }
}

interface Ask {
  object?: unknown;
  id?: unknown;
  at?: unknown;
  bookmark?: unknown;
}

interface Recoverable {
  bookmark(at: number): Promise<string>;
  restore(bookmark: string): Promise<string>;
}

const NAMING = '"object" is "directory", or "pod" or "account" with its "id"';

function objectFor(env: Env, ask: Ask): Recoverable | null {
  if (ask.object === 'directory') return env.DIRECTORY.get(env.DIRECTORY.idFromName('directory'));
  if (typeof ask.id !== 'string') return null;
  if (ask.object === 'pod' && isPodId(ask.id)) return env.POD.get(env.POD.idFromName(ask.id));
  if (ask.object === 'account' && ACCOUNT_KEY.test(ask.id)) return env.ACCOUNT.get(env.ACCOUNT.idFromName(ask.id));
  return null;
}

function bearer(request: Request): string {
  return /^Bearer (.+)$/u.exec(request.headers.get('Authorization') ?? '')?.[1] ?? '';
}

/** Compares digests, so the time taken says nothing about the key. */
async function sameKey(given: string, key: string): Promise<boolean> {
  const digest = async (s: string) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
  const [a, b] = await Promise.all([digest(given), digest(key)]);
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i]! ^ b[i]!;
  return difference === 0;
}

function notFound(): Response {
  return new Response('not found\n', { status: 404 });
}

function answer(status: number, body: unknown): Response {
  return new Response(`${JSON.stringify(body)}\n`, { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}
