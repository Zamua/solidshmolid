// The apex home page, for whoever is looking at it.

import type { AccountState } from '../../app/accounts/ports.js';
import { providerDisplayName } from '../../domain/accounts/deletion.js';
import { accounts, provider } from '../composition.js';
import type { Env } from '../env.js';
import { hostsFor } from '../hosts.js';
import { connectPage, deletePage, podsPage, signupPage, welcomePage } from './pages/home.js';
import { privacyPage } from './pages/privacy.js';

export async function homeRoute(request: Request, env: Env, url: URL, person: string | null): Promise<Response | null> {
  if (request.method !== 'GET') return null;
  if (url.pathname === '/privacy') return privacyPage();
  const deletingPod = /^\/pods\/([a-z0-9]{1,32})\/delete$/u.exec(url.pathname)?.[1];
  if (url.pathname !== '/' && url.pathname !== '/account/delete' && !deletingPod) return null;
  if (!person) return url.pathname === '/' ? welcomePage() : Response.redirect(`${url.origin}/sign-in?return=${encodeURIComponent(url.pathname)}`, 302);
  const hosts = hostsFor(env, url);
  const state = await accounts(env, hosts).mine(person);
  if (!state) return url.pathname === '/' ? signupPage() : Response.redirect(`${url.origin}/`, 302);
  if (deletingPod) {
    const pod = state.pods.find((p) => p.podId === deletingPod);
    if (!pod || pod === state.pods[0]) return Response.redirect(`${url.origin}/`, 302);
    return deletePage('pod', `/api/pods/${pod.podId}/delete`, providerNames(state, [pod.linkId]));
  }
  if (url.pathname === '/account/delete') return deletePage('account', '/api/account/delete', providerNames(state, state.pods.map((p) => p.linkId)));
  if (state.links.length === 0) return connectPage(env.STORAGE);
  return podsPage(state, await (await provider(env, `${url.origin}/`)).apps(person), hosts);
}

/** The providers holding these links, as the delete page names them; null when none. */
function providerNames(state: AccountState, linkIds: (string | null)[]): string | null {
  const names = [...new Set(state.links.filter((l) => linkIds.includes(l.linkId)).map((l) => providerDisplayName(l.provider)))];
  return names.length ? names.join(' and ') : null;
}
