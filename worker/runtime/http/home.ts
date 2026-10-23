// The apex home page, for whoever is looking at it.

import { households, sessions } from '../composition.js';
import type { Env } from '../env.js';
import { hostsFor } from '../hosts.js';
import { connectPage, householdPage, signupPage, welcomePage } from './pages/home.js';

export async function homeRoute(request: Request, env: Env, url: URL): Promise<Response | null> {
  if (url.pathname !== '/' || request.method !== 'GET') return null;
  const person = await sessions(env).personOf(request);
  if (!person) return welcomePage();
  const hosts = hostsFor(env, url);
  const state = await households(env, hosts).mine(person);
  if (!state) return signupPage();
  if (state.pods.some((p) => p.owner === person && p.linkId === null)) return connectPage(env.STORAGE);
  return householdPage(state, person, hosts);
}
