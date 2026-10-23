// Entry Worker: routes by host. Pod hosts go to that pod's Durable Object
// after the agent is verified; the apex carries the identity provider, the
// account API, the home page and (in development) stand-ins
// for sign-in.

import { isPodId } from '../domain/accounts/podIds.js';
import { handleFromHost } from '../domain/pods/handles.js';
import { profileDocument } from '../domain/pods/profile.js';
import { InvalidCredentials, type VerifiedAgent } from './adapters/solidOidcVerifier.js';
import { clerkChrome, isDev, sessions, tokenVerifier } from './composition.js';
import { hostsFor } from './hosts.js';
import type { Env } from './env.js';
import { devRoute } from './http/dev.js';
import { apiRoute } from './http/api.js';
import { withClerk } from './http/clerkChrome.js';
import { homeRoute } from './http/home.js';
import { signInRoute } from './http/signIn.js';
import { oidcRoute } from './http/oidc.js';
import { isNavigation, podLandingPage } from './http/pages/podPages.js';
import { withCors } from './http/solid.js';
import { AGENT_HEADER, BASE_HEADER, INTERNAL_PREFIX, JTI_EXPIRES_HEADER, JTI_HEADER } from './objects/podObject.js';

export { AccountObject } from './objects/accountObject.js';
export { DirectoryObject } from './objects/directoryObject.js';
export { PodObject } from './objects/podObject.js';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/healthz') {
      return new Response('ok\n', { headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' } });
    }
    const handle = handleFromHost(url.hostname, env.POD_HOST_TEMPLATE);
    if (handle !== null) return pod(request, env, url, handle);
    if (url.hostname === env.APEX_HOST) return apex(request, env, url);
    return new Response('not found\n', { status: 404 });
  },
} satisfies ExportedHandler<Env>;

/** The apex: who is signed in is settled once, before any route runs. */
async function apex(request: Request, env: Env, url: URL): Promise<Response> {
  const session = await sessions(env, url.origin).check(request);
  if (session.redirect) return session.redirect;
  let response =
    (await oidcRoute(request, env, url, session.person)) ??
    (await apiRoute(request, env, url, session.person)) ??
    (await homeRoute(request, env, url, session.person)) ??
    (await signInRoute(request, env, url)) ??
    (await devRoute(request, env, url)) ??
    new Response('not found\n', { status: 404 });
  if (session.headers) {
    response = new Response(response.body, response);
    for (const [name, value] of session.headers) response.headers.append(name, value);
  }
  const clerk = clerkChrome(env);
  return clerk ? withClerk(response, clerk) : response;
}

async function pod(request: Request, env: Env, url: URL, handle: string): Promise<Response> {
  const stub = env.POD.get(env.POD.idFromName(handle));
  const base = url.origin;
  // Named pods are a development convenience; pods with random ids belong to
  // accounts and exist once their storage is connected.
  if (isDev(env) && !isPodId(handle)) {
    await stub.ensureProvisioned(base, `${base}/profile/card#me`, profileDocument(`${base}/`, hostsFor(env, url).issuer));
  }

  const headers = new Headers(request.headers);
  for (const name of [...headers.keys()]) if (name.toLowerCase().startsWith(INTERNAL_PREFIX)) headers.delete(name);
  headers.set(BASE_HEADER, base);

  if (request.method !== 'OPTIONS') {
    let agent: VerifiedAgent | null;
    try {
      agent = await tokenVerifier().verify({
        method: request.method,
        url: request.url,
        authorization: request.headers.get('Authorization'),
        dpop: request.headers.get('DPoP'),
      });
    } catch (e) {
      if (!(e instanceof InvalidCredentials)) throw e;
      return withCors(invalidToken(e.message), request, request.headers.get('Origin'));
    }
    if (agent) {
      headers.set(AGENT_HEADER, agent.webid);
      headers.set(JTI_HEADER, agent.jti);
      headers.set(JTI_EXPIRES_HEADER, String(agent.jtiExpires));
    } else if (isDev(env)) {
      headers.set(AGENT_HEADER, request.headers.get('X-Dev-WebID') ?? '');
    }
  }
  const response = await stub.fetch(new Request(request, { headers }));
  if (isNavigation(request) && (response.status === 401 || response.status === 403 || response.status === 404)) {
    return podLandingPage(response.status, `${base}/`, hostsFor(env, url).issuer);
  }
  return response;
}

function invalidToken(reason: string): Response {
  const description = reason.replace(/["\\]/gu, "'");
  return new Response(`${reason}\n`, {
    status: 401,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'WWW-Authenticate': `DPoP algs="ES256 PS256 RS256", error="invalid_token", error_description="${description}"`,
    },
  });
}
