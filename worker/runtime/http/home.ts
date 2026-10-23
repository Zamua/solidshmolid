// The apex home page, for whoever is looking at it.

import { accounts } from '../composition.js';
import type { Env } from '../env.js';
import { hostsFor } from '../hosts.js';
import { connectPage, podsPage, signupPage, welcomePage } from './pages/home.js';

export async function homeRoute(request: Request, env: Env, url: URL, person: string | null): Promise<Response | null> {
  if (request.method !== 'GET') return null;
  if (url.pathname !== '/') return null;
  if (!person) return welcomePage();
  const hosts = hostsFor(env, url);
  const state = await accounts(env, hosts).mine(person);
  if (!state) return signupPage();
  if (state.links.length === 0) return connectPage(env.STORAGE);
  return podsPage(state, hosts);
}
