// The account API on the apex host (contracts/account-api.md), and the
// storage provider's callback. Translation only: who is asking comes from the
// session, everything else from the accounts service.
//
// Pages post plain HTML forms here; those get a redirect, scripts get JSON.

import { LinkExpired, NoStorageYet, NotSignedUp } from '../../app/accounts/accounts.js';
import type { AccountState } from '../../app/accounts/ports.js';
import { accounts } from '../composition.js';
import type { Env } from '../env.js';
import { hostsFor } from '../hosts.js';
import { escapeHtml, page } from './pages/shell.js';

export async function apiRoute(request: Request, env: Env, url: URL, person: string | null): Promise<Response | null> {
  const provider = env.STORAGE;
  const callback = `/link/${provider}/callback`;
  const routes: Record<string, { method: string; run: (person: string) => Promise<Response> }> = {
    '/api/me': { method: 'GET', run: (person) => me(env, url, person) },
    '/api/signup': { method: 'POST', run: (person) => signup(request, env, url, person) },
    '/api/pods': { method: 'POST', run: (person) => addPod(request, env, url, person) },
    [`/api/storage/${provider}/start`]: { method: 'POST', run: (person) => start(request, env, url, person, callback) },
    [callback]: { method: 'GET', run: (person) => finish(env, url, person, callback) },
  };
  const route = routes[url.pathname];
  if (!route) return null;
  if (request.method !== route.method) return error(405, 'method_not_allowed', `use ${route.method}`);
  if (route.method === 'POST' && request.headers.get('Origin') !== url.origin) {
    return error(403, 'cross_origin', 'requests must come from this site');
  }
  if (!person) {
    return wantsHtml(request) ? redirect(`/sign-in?return=${encodeURIComponent(url.pathname === callback ? url.href : '/')}`) : error(401, 'signed_out', 'sign in first');
  }
  try {
    return await route.run(person);
  } catch (e) {
    if (e instanceof NotSignedUp) return error(404, 'not_signed_up', e.message);
    if (e instanceof LinkExpired) return error(400, 'link_expired', e.message);
    if (e instanceof NoStorageYet) return error(409, 'no_storage', e.message);
    throw e;
  }
}

async function me(env: Env, url: URL, person: string): Promise<Response> {
  const account = await accounts(env, hostsFor(env, url)).mine(person);
  return Response.json({ person, account: account && view(account, env, url) });
}

async function signup(request: Request, env: Env, url: URL, person: string): Promise<Response> {
  const account = await accounts(env, hostsFor(env, url)).signup(person);
  return wantsHtml(request) ? redirect('/') : Response.json(view(account, env, url), { status: 201 });
}

async function addPod(request: Request, env: Env, url: URL, person: string): Promise<Response> {
  const account = await accounts(env, hostsFor(env, url)).addPod(person);
  return wantsHtml(request) ? redirect('/') : Response.json(view(account, env, url), { status: 201 });
}

async function start(request: Request, env: Env, url: URL, person: string, callback: string): Promise<Response> {
  const authorizeUrl = await accounts(env, hostsFor(env, url)).beginLink(person, `${url.origin}${callback}`);
  return wantsHtml(request) ? redirect(authorizeUrl) : Response.json({ authorizeUrl });
}

async function finish(env: Env, url: URL, person: string, callback: string): Promise<Response> {
  const [accountKey, nonce] = (url.searchParams.get('state') ?? '').split('.');
  const code = url.searchParams.get('code');
  if (!accountKey || !nonce) return notConnected('The connection request was not recognised.');
  if (!code) return notConnected(`Storage was not connected (${url.searchParams.get('error') ?? 'no code'}).`);
  try {
    await accounts(env, hostsFor(env, url)).completeLink(person, accountKey, nonce, code, `${url.origin}${callback}`);
  } catch (e) {
    if (e instanceof LinkExpired) return notConnected(e.message);
    throw e;
  }
  return redirect('/');
}

/** An account as the API shows it: pod URLs instead of bare ids, and no key. */
function view(a: AccountState, env: Env, url: URL) {
  const hosts = hostsFor(env, url);
  return {
    webid: a.webid,
    pods: a.pods.map((p) => ({ id: p.podId, url: `${hosts.podOrigin(p.podId)}/`, connected: p.linkId !== null })),
    storage: a.links.map((l) => ({ id: l.linkId, provider: l.provider })),
  };
}

function wantsHtml(request: Request): boolean {
  return (request.headers.get('Accept') ?? '').includes('text/html');
}

function redirect(location: string): Response {
  return new Response(null, { status: 303, headers: { Location: location, 'Cache-Control': 'no-store' } });
}

function error(status: number, code: string, message: string): Response {
  return Response.json({ error: code, message }, { status });
}

function notConnected(reason: string): Response {
  return page('Not connected', `<h1>Not connected</h1><p class="lede">${escapeHtml(reason)}</p><p><a href="/">Back</a></p>`, 400);
}
