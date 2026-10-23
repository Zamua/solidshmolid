// The account API on the apex host (contracts/account-api.md), and the
// storage providers' callbacks. Translation only: who is asking comes from the
// session, everything else from the accounts service.
//
// Pages post plain HTML forms here; those get a redirect, scripts get JSON.

import { type DeletionStep, HoldsWebid, LinkExpired, NoStorageYet, NotConfirmed, NotFound, NotSignedUp, StorageInUse } from '../../app/accounts/accounts.js';
import type { AccountState } from '../../app/accounts/ports.js';
import { GrantRefused } from '../../app/storage/ports.js';
import { accounts, provider } from '../composition.js';
import type { Env } from '../env.js';
import { hostsFor } from '../hosts.js';
import { confirmDeletionPage, refusalPage } from './pages/home.js';
import { problemPage, sentenceOf } from './pages/problem.js';

interface Route {
  method: 'GET' | 'POST';
  path: RegExp;
  run: (person: string, params: string[]) => Promise<Response>;
}

export async function apiRoute(request: Request, env: Env, url: URL, person: string | null): Promise<Response | null> {
  const html = wantsHtml(request);
  const service = () => accounts(env, hostsFor(env, url));
  const routes: Route[] = [
    { method: 'GET', path: /^\/api\/me$/u, run: (p) => me(env, url, p) },
    { method: 'POST', path: /^\/api\/signup$/u, run: async (p) => done(html, '/', view(await service().signup(p), env, url), 201) },
    { method: 'POST', path: /^\/api\/pods$/u, run: async (p) => done(html, '/', view(await service().addPod(p, (await fields(request)).link ?? null), env, url), 201) },
    {
      method: 'POST',
      path: /^\/api\/storage\/([\w-]{1,64})\/start$/u,
      run: async (p, [provider]) => start(html, env, url, p, provider!, (await fields(request)).newPod === 'true'),
    },
    { method: 'GET', path: /^\/link\/([\w-]{1,64})\/callback$/u, run: (p, [provider]) => finish(env, url, p, provider!) },
    { method: 'GET', path: /^\/api\/apps$/u, run: async (p) => Response.json(await (await identityProvider(env, url)).apps(p)) },
    {
      method: 'POST',
      path: /^\/api\/apps\/revoke$/u,
      run: async (p) => {
        await (await identityProvider(env, url)).revokeApp(p, (await fields(request)).clientId ?? '');
        return done(html, '/', null, 204);
      },
    },
    { method: 'POST', path: /^\/api\/pods\/([a-z0-9]{1,32})\/delete$/u, run: async (p, [podId]) => deletion(html, '/', await service().deletePod(p, podId!, await wantsFilesGone(request))) },
    { method: 'POST', path: /^\/api\/account\/delete$/u, run: async (p) => deletion(html, '/sign-out', await service().deleteAccount(p, await wantsFilesGone(request))) },
    {
      method: 'POST',
      path: /^\/api\/deletions\/confirm$/u,
      run: async (p) => {
        const form = await fields(request);
        const what = await service().confirmDeletion(p, form.token ?? '', form.typed ?? '');
        return done(html, what === 'account' ? '/sign-out' : '/', null, 204);
      },
    },
    {
      method: 'POST',
      path: /^\/api\/storage\/([\w-]{1,64})\/disconnect$/u,
      run: async (p, [linkId]) => done(html, '/', view(await service().disconnect(p, linkId!), env, url), 200),
    },
  ];
  const route = routes.find((r) => r.path.test(url.pathname));
  if (!route) return null;
  if (request.method !== route.method) return error(405, 'method_not_allowed', `use ${route.method}`);
  if (route.method === 'POST' && request.headers.get('Origin') !== url.origin) {
    return error(403, 'cross_origin', 'requests must come from this site');
  }
  if (!person) {
    return html ? redirect(`/sign-in?return=${encodeURIComponent(/^\/link\//u.test(url.pathname) ? url.href : '/')}`) : error(401, 'signed_out', 'sign in first');
  }
  try {
    return await route.run(person, route.path.exec(url.pathname)!.slice(1));
  } catch (e) {
    const failure = refusal(e);
    if (!failure) throw e;
    return html ? refusalPage(failure.title, failure.message, failure.status) : error(failure.status, failure.code, failure.message, failure.extra);
  }
}

/** The service's refusals, as HTTP answers. */
function refusal(e: unknown): { status: number; code: string; title: string; message: string; extra?: Record<string, unknown> } | null {
  if (e instanceof NotSignedUp) return { status: 404, code: 'not_signed_up', title: 'No pod yet', message: e.message };
  if (e instanceof LinkExpired) return { status: 400, code: 'link_expired', title: 'Not connected', message: e.message };
  if (e instanceof NoStorageYet) return { status: 409, code: 'no_storage', title: 'Connect storage first', message: e.message };
  if (e instanceof NotFound) return { status: 404, code: 'not_found', title: 'Not found', message: e.message };
  if (e instanceof HoldsWebid) return { status: 409, code: 'holds_webid', title: 'Not deleted', message: e.message };
  if (e instanceof NotConfirmed) return { status: 400, code: 'not_confirmed', title: 'Nothing was deleted', message: e.message };
  if (e instanceof StorageInUse) return { status: 409, code: 'storage_in_use', title: 'Still in use', message: e.message, extra: { pods: e.podIds } };
  return null;
}

/** A finished request: pages go to `location`, scripts get `body` as JSON. */
function done(html: boolean, location: string, body: unknown, status: number): Response {
  if (html) return redirect(location);
  return body === null ? new Response(null, { status }) : Response.json(body, { status });
}

/** A deletion step: finished, or the typed confirmation to ask for. */
function deletion(html: boolean, location: string, step: DeletionStep): Response {
  if ('done' in step) return done(html, location, { deleted: true }, 200);
  return html ? confirmDeletionPage(step.confirm.token, step.confirm.sentence) : Response.json({ confirmToken: step.confirm.token, sentence: step.confirm.sentence });
}

async function wantsFilesGone(request: Request): Promise<boolean> {
  return (await fields(request)).deleteFiles === 'true';
}

/** Form or JSON fields, as strings. */
async function fields(request: Request): Promise<Record<string, string | undefined>> {
  if ((request.headers.get('Content-Type') ?? '').includes('application/json')) {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(body).map(([k, v]) => [k, typeof v === 'string' || typeof v === 'boolean' ? String(v) : undefined]));
  }
  const form = await request.formData().catch(() => new FormData());
  return Object.fromEntries([...form.entries()].map(([k, v]) => [k, typeof v === 'string' ? v : undefined]));
}

function identityProvider(env: Env, url: URL) {
  return provider(env, `${url.origin}/`);
}

async function me(env: Env, url: URL, person: string): Promise<Response> {
  const account = await accounts(env, hostsFor(env, url)).mine(person);
  return Response.json({ person, account: account && view(account, env, url) });
}

async function start(html: boolean, env: Env, url: URL, person: string, provider: string, newPod: boolean): Promise<Response> {
  const authorizeUrl = await accounts(env, hostsFor(env, url)).beginLink(person, provider, callbackUrl(url, provider), newPod);
  return html ? redirect(authorizeUrl) : Response.json({ authorizeUrl });
}

/** Where a provider sends the person back; each provider's app lists it. */
function callbackUrl(url: URL, provider: string): string {
  return `${url.origin}/link/${provider}/callback`;
}

async function finish(env: Env, url: URL, person: string, provider: string): Promise<Response> {
  const [accountKey, nonce] = (url.searchParams.get('state') ?? '').split('.');
  const code = url.searchParams.get('code');
  if (!accountKey || !nonce) return notConnected('This is not a connection we started. Start again from your pods page.');
  const refused = url.searchParams.get('error');
  if (!code) return notConnected(refused === 'access_denied' ? 'Access was not allowed, so nothing was connected.' : 'Nothing was connected.', refused ?? undefined);
  try {
    await accounts(env, hostsFor(env, url)).completeLink(person, provider, accountKey, nonce, code, callbackUrl(url, provider));
  } catch (e) {
    if (e instanceof LinkExpired || e instanceof GrantRefused) return notConnected(e.message);
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

function error(status: number, code: string, message: string, extra: Record<string, unknown> = {}): Response {
  return Response.json({ error: code, message, ...extra }, { status });
}

function notConnected(reason: string, detail?: string): Response {
  return problemPage('Storage not connected', sentenceOf(reason), 400, { detail, way: { href: '/', label: 'Back to your pods' } });
}
