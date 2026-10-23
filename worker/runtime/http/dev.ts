// Development-only routes on the apex: sign in as anyone, standing in for
// Clerk. `pod=<name>` also gives that person a named dev pod to sign in to
// apps as, without signing up.

import { DEV_PERSON_COOKIE } from '../adapters/sessions.js';
import { isDev } from '../composition.js';
import type { Env } from '../env.js';
import { isPodId } from '../../domain/accounts/podIds.js';
import { isValidHandle } from '../../domain/pods/handles.js';
import { rpcIdentities } from '../adapters/accountRpc.js';
import { profileDocument } from '../../domain/pods/profile.js';
import { hostsFor } from '../hosts.js';

export async function devRoute(request: Request, env: Env, url: URL): Promise<Response | null> {
  if (!isDev(env)) return null;
  if (url.pathname === '/dev/sign-in') return signIn(env, url);
  return null;
}

/** `/dev/sign-in?person=<id>[&pod=<name>][&return=<url>]` */
async function signIn(env: Env, url: URL): Promise<Response> {
  const person = url.searchParams.get('person') ?? '';
  const handle = url.searchParams.get('pod');
  if (!/^[\w-]{1,64}$/u.test(person) || (handle !== null && (!isValidHandle(handle) || isPodId(handle)))) {
    return new Response('bad person or pod\n', { status: 400 });
  }
  const hosts = hostsFor(env, url);
  let landing = '/';
  if (handle !== null) {
    const base = hosts.podOrigin(handle);
    const webid = hosts.webidOf(handle);
    await env.POD.get(env.POD.idFromName(handle)).ensureProvisioned(base, webid, profileDocument(`${base}/`, hosts.issuer));
    await rpcIdentities(env).bind(person, webid);
    landing = `${base}/`;
  }
  const back = url.searchParams.get('return');
  const location = back && (back.startsWith(`${url.origin}/`) || (back.startsWith('/') && !back.startsWith('//'))) ? back : landing;
  return new Response(null, {
    status: 302,
    headers: { Location: location, 'Set-Cookie': `${DEV_PERSON_COOKIE}=${person}; Path=/; HttpOnly; SameSite=Lax` },
  });
}
