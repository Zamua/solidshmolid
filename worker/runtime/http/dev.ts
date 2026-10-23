// Development-only routes on the apex: sign in as anyone, and give that
// person a pod, standing in for Clerk and signup until they exist.

import { DEV_PERSON_COOKIE } from '../adapters/sessions.js';
import { isDev } from '../composition.js';
import type { Env } from '../env.js';
import { isValidHandle } from '../../domain/pods/handles.js';
import { profileDocument } from '../../domain/pods/profile.js';
import { podBase } from './link.js';
import { page } from './pages/shell.js';

export async function devRoute(request: Request, env: Env, url: URL): Promise<Response | null> {
  if (!isDev(env)) return null;
  if (url.pathname === '/dev/sign-in') return signIn(env, url);
  if (url.pathname === '/sign-in') {
    return page('Sign in', `<h1>Sign in</h1><p class="lede">Development: <a href="/dev/sign-in?person=dana&amp;pod=dana&amp;return=${encodeURIComponent(url.searchParams.get('return') ?? '/')}">continue as dana</a>.</p>`);
  }
  return null;
}

/** `/dev/sign-in?person=<id>&pod=<handle>&return=<url>` */
async function signIn(env: Env, url: URL): Promise<Response> {
  const person = url.searchParams.get('person') ?? '';
  const handle = url.searchParams.get('pod') ?? '';
  if (!/^[\w-]{1,64}$/u.test(person) || !isValidHandle(handle)) return new Response('bad person or pod\n', { status: 400 });
  const base = podBase(env, url, handle);
  const webid = `${base}/profile/card#me`;
  await env.POD.get(env.POD.idFromName(handle)).ensureProvisioned(handle, base, webid, profileDocument(`${base}/`, `${url.origin}/`));
  const key = await env.DIRECTORY.get(env.DIRECTORY.idFromName('directory')).accountKeyFor(person);
  const account = env.ACCOUNT.get(env.ACCOUNT.idFromName(key));
  await account.ensure(key);
  await account.bindWebid(webid);
  const back = url.searchParams.get('return');
  const location = back && back.startsWith(url.origin) ? back : `${base}/`;
  return new Response(null, {
    status: 302,
    headers: { Location: location, 'Set-Cookie': `${DEV_PERSON_COOKIE}=${person}; Path=/; HttpOnly; SameSite=Lax` },
  });
}
