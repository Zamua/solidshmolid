// Sign-in, sign-up and sign-out on the apex. With Clerk configured, sign-in
// mounts Clerk's component and sign-up is our own form (the boot script runs
// both); the dev config adds a one-tap stand-in.

import { DEV_PERSON_COOKIE } from '../adapters/sessions.js';
import { clerkChrome, isDev } from '../composition.js';
import type { Env } from '../env.js';
import { CLERK_BOOT, CLERK_BOOT_PATH } from './assets/clerkBoot.js';
import { signUpPage } from './pages/home.js';
import { escapeHtml, page } from './pages/shell.js';

export async function signInRoute(request: Request, env: Env, url: URL): Promise<Response | null> {
  if (request.method !== 'GET') return null;
  if (url.pathname === CLERK_BOOT_PATH) {
    return new Response(CLERK_BOOT, { headers: { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'max-age=300' } });
  }
  const clerk = clerkChrome(env) !== null;
  const back = returnTo(url);
  switch (url.pathname) {
    case '/sign-in':
      if (!clerk && !isDev(env)) return null;
      return page(
        'Sign in',
        `${clerk ? `<div class="clerk-mount"><div data-clerk-mount="sign-in" data-return="${escapeHtml(back)}"></div></div>` : '<h1 style="margin-top:40px">Sign in</h1>'}
${isDev(env) ? `<p class="small center" style="margin-top:16px">Development: <a href="/dev/sign-in?person=dana&amp;return=${encodeURIComponent(back)}">continue as dana</a></p>` : ''}`,
      );
    case '/sign-up':
      if (!clerk) return isDev(env) ? new Response(null, { status: 302, headers: { Location: `/sign-in${url.search}` } }) : null;
      return signUpPage(back);
    case '/sso-callback':
      if (!clerk) return null;
      return page('Signing in', `<h1 style="margin-top:40px">Signing in</h1><div data-clerk-mount="sso-callback" data-return="${escapeHtml(back)}"></div>`);
    case '/sign-out': {
      const response = clerk
        ? page('Signing out', '<h1 style="margin-top:40px">Signing out</h1><div data-clerk-mount="sign-out"></div>')
        : new Response(null, { status: 302, headers: { Location: '/' } });
      if (isDev(env)) response.headers.append('Set-Cookie', `${DEV_PERSON_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
      return response;
    }
    default:
      return null;
  }
}

/** Where to go after signing in: a page on this site, never elsewhere. */
function returnTo(url: URL): string {
  const asked = url.searchParams.get('return') ?? '/';
  try {
    const target = new URL(asked, url.origin);
    return target.origin === url.origin ? target.href : `${url.origin}/`;
  } catch {
    return `${url.origin}/`;
  }
}
