// The apex home page, for whoever is looking at it.

import { NoStorageYet } from '../../app/accounts/accounts.js';
import type { AccountState, FileContent } from '../../app/accounts/ports.js';
import { PodError } from '../../app/shared/errors.js';
import { providerDisplayName } from '../../domain/accounts/deletion.js';
import { accounts, provider, storageProviders } from '../composition.js';
import type { Env } from '../env.js';
import { hostsFor } from '../hosts.js';
import { connectPage, connectionsPage, deletePage, filesPage, newPodPage, podsPage, removeAppPage, welcomePage } from './pages/home.js';
import { PAGE_SCRIPT, PAGE_SCRIPT_PATH } from './assets/pageScript.js';
import { privacyPage } from './pages/privacy.js';
import { problemPage } from './pages/problem.js';

export async function homeRoute(request: Request, env: Env, url: URL, person: string | null): Promise<Response | null> {
  if (request.method !== 'GET') return null;
  if (url.pathname === '/privacy') return privacyPage(env.SUPPORT_EMAIL ?? null);
  if (url.pathname === PAGE_SCRIPT_PATH) {
    return new Response(PAGE_SCRIPT, { headers: { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'max-age=300' } });
  }
  if (url.pathname === '/apps/remove') {
    if (!person) return Response.redirect(`${url.origin}/sign-in?return=%2F`, 302);
    const app = (await (await provider(env, `${url.origin}/`)).apps(person)).find((a) => a.clientId === url.searchParams.get('client'));
    return app ? removeAppPage(app) : Response.redirect(`${url.origin}/`, 302);
  }
  const deletingPod = /^\/pods\/([a-z0-9]{1,32})\/delete$/u.exec(url.pathname)?.[1];
  const [, browsing, browseAction] = /^\/pods\/([a-z0-9]{1,32})\/(files|download)$/u.exec(url.pathname) ?? [];
  if (url.pathname !== '/' && url.pathname !== '/account/delete' && url.pathname !== '/pods/new' && url.pathname !== '/connections' && !deletingPod && !browsing) return null;
  if (!person) return url.pathname === '/' ? welcomePage(storageProviders(env)) : Response.redirect(`${url.origin}/sign-in?return=${encodeURIComponent(url.pathname)}`, 302);
  const hosts = hostsFor(env, url);
  const state = await accounts(env, hosts).mine(person);
  // A signed-in person without a pod gets one on their first visit, so
  // sign-up goes straight on to choosing storage. Repeating it is harmless.
  if (!state) {
    if (url.pathname !== '/') return Response.redirect(`${url.origin}/`, 302);
    await accounts(env, hosts).signup(person);
    return connectPage(storageProviders(env));
  }
  if (deletingPod) {
    const pod = state.pods.find((p) => p.podId === deletingPod);
    if (!pod || pod === state.pods[0]) return Response.redirect(`${url.origin}/`, 302);
    const index = state.pods.indexOf(pod);
    return deletePage('pod', `/api/pods/${pod.podId}/delete`, providerNames(state, [pod.linkId]), { index, host: new URL(hosts.podOrigin(pod.podId)).host });
  }
  if (browsing) {
    const path = url.searchParams.get('path') ?? '/';
    try {
      if (browseAction === 'download') return download(await accounts(env, hosts).file(person, browsing, path), path);
      return filesPage(state, browsing, path, await accounts(env, hosts).files(person, browsing, path), hosts);
    } catch (e) {
      if (e instanceof NoStorageYet || e instanceof PodError) {
        return problemPage('Not found', 'That file or folder is not there.', 404, { way: { href: `/pods/${browsing}/files`, label: 'Back to the pod' } });
      }
      throw e;
    }
  }
  if (url.pathname === '/account/delete') return deletePage('account', '/api/account/delete', providerNames(state, state.pods.map((p) => p.linkId)));
  if (state.links.length === 0) return connectPage(storageProviders(env));
  if (url.pathname === '/pods/new') return newPodPage(state, storageProviders(env));
  if (url.pathname === '/connections') return connectionsPage(state, storageProviders(env));
  return podsPage(state, await (await provider(env, `${url.origin}/`)).apps(person), hosts, storageProviders(env));
}

/** A file handed to the browser to save, never to render: pods hold
 * anything, and the account site must not run it. */
function download(file: FileContent, path: string): Response {
  const last = path.split('/').pop() || 'file';
  let name = last;
  try {
    name = decodeURIComponent(last);
  } catch {
    // keep the raw segment
  }
  const headers = new Headers({
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "sandbox; default-src 'none'",
    'Cache-Control': 'private, no-store',
  });
  if (file.size !== null) headers.set('Content-Length', String(file.size));
  return new Response(file.body, { headers });
}

/** The providers holding these links, as the delete page names them; null when none. */
function providerNames(state: AccountState, linkIds: (string | null)[]): string | null {
  const names = [...new Set(state.links.filter((l) => linkIds.includes(l.linkId)).map((l) => providerDisplayName(l.provider)))];
  return names.length ? names.join(' and ') : null;
}
