// Entry Worker: routes by host. Pod hosts go to that pod's Durable Object
// after the agent is verified; the apex carries the identity provider, the
// account API, the home page and (in development) stand-ins
// for sign-in.

import { isPodId } from '../domain/accounts/podIds.js';
import { DPOP_CHALLENGE } from '../domain/identity/oidc.js';
import { handleFromHost } from '../domain/pods/handles.js';
import { profileDocument } from '../domain/pods/profile.js';
import { InvalidCredentials, type VerifiedAgent } from './adapters/solidOidcVerifier.js';
import { accounts, clerkChrome, isDev, sessions, tokenVerifier } from './composition.js';
import { hostsFor } from './hosts.js';
import { withOwnHosts } from './ownHosts.js';
import type { Env } from './env.js';
import { devRoute } from './http/dev.js';
import { apiRoute } from './http/api.js';
import { withClerk } from './http/clerkChrome.js';
import { homeRoute } from './http/home.js';
import { signInRoute } from './http/signIn.js';
import { oidcRoute } from './http/oidc.js';
import { appIconRoute } from './http/assets/appIcons.js';
import { PAGE_SCRIPT_PATH } from './http/assets/pageScript.js';
import { accountMenu } from './http/pages/home.js';
import { problemPage } from './http/pages/problem.js';
import { isNavigation, podLandingPage, publicProfilePage } from './http/pages/podPages.js';
import { summarizeProfile } from '../domain/pods/profile.js';
import { parseRdf } from '../domain/shared/rdf.js';
import { withCors } from './http/solid.js';
import { AGENT_HEADER, BASE_HEADER, INTERNAL_PREFIX, JTI_EXPIRES_HEADER, JTI_HEADER } from './objects/podObject.js';

export { AccountObject } from './objects/accountObject.js';
export { DirectoryObject } from './objects/directoryObject.js';
export { PodObject } from './objects/podObject.js';

const worker = {
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

export default worker;

/** The apex: who is signed in is settled once, before any route runs. */
async function apex(request: Request, env: Env, url: URL): Promise<Response> {
  const icon = appIconRoute(request, url);
  if (icon) return icon;
  const session = await sessions(env, url.origin).check(request);
  if (session.redirect) return session.redirect;
  let response =
    (await oidcRoute(request, env, url, session.person)) ??
    (await apiRoute(request, env, url, session.person)) ??
    (await homeRoute(request, env, url, session.person)) ??
    (await signInRoute(request, env, url)) ??
    (await devRoute(request, env, url)) ??
    (isNavigation(request) ? problemPage('Not found', 'There is nothing at this address.', 404, { way: { href: '/', label: 'Go to the front page' } }) : new Response('not found\n', { status: 404 }));
  if (session.headers) {
    response = new Response(response.body, response);
    for (const [name, value] of session.headers) response.headers.append(name, value);
  }
  if (session.person && isHtml(response)) response = await withAccountMenu(response, env, url, session.person);
  const clerk = clerkChrome(env);
  return clerk ? withClerk(response, clerk) : response;
}

function isHtml(response: Response): boolean {
  return (response.headers.get('Content-Type') ?? '').startsWith('text/html');
}

/** Puts the account menu in the masthead of a signed-in person's page. */
async function withAccountMenu(response: Response, env: Env, url: URL, person: string): Promise<Response> {
  const state = await accounts(env, hostsFor(env, url)).mine(person);
  if (!state) return response;
  const menu = accountMenu();
  return new HTMLRewriter()
    .on('.masthead-inner', { element: (e) => void e.append(menu, { html: true }) })
    .on('head', { element: (e) => void e.append(`<script defer src="${PAGE_SCRIPT_PATH}"></script>`, { html: true }) })
    .transform(response);
}

async function pod(request: Request, env: Env, url: URL, handle: string): Promise<Response> {
  const base = url.origin;
  // Outside dev only pod ids name pods; anything else is turned away before
  // it can bring a Durable Object into being.
  if (!isDev(env) && !isPodId(handle)) {
    return isNavigation(request) ? podLandingPage(404, `${base}/`, hostsFor(env, url).issuer, handle) : new Response('not found\n', { status: 404 });
  }
  const stub = env.POD.get(env.POD.idFromName(handle));
  // Named pods are a development convenience; pods with random ids belong to
  // accounts and exist once their storage is connected.
  if (isDev(env) && !isPodId(handle)) {
    await stub.ensureProvisioned(base, `${base}/profile/card#me`, profileDocument(`${base}/`, hostsFor(env, url).issuer));
  }

  const headers = new Headers(request.headers);
  for (const name of [...headers.keys()]) if (name.toLowerCase().startsWith(INTERNAL_PREFIX)) headers.delete(name);
  headers.set(BASE_HEADER, base);
  // A person opening the profile gets it rendered (below), so ask the pod for the data.
  const viewingProfile = isNavigation(request) && request.method === 'GET' && url.pathname === '/profile/card';
  if (viewingProfile) headers.set('Accept', 'text/turtle');

  if (request.method !== 'OPTIONS') {
    let agent: VerifiedAgent | null;
    try {
      agent = await tokenVerifier(withOwnHosts(env, url.port, (r) => worker.fetch(r, env), (input, init) => fetch(input, init))).verify({
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
  if (!isNavigation(request)) return response;
  if (response.status === 401 || response.status === 403 || response.status === 404) {
    return podLandingPage(response.status, `${base}/`, hostsFor(env, url).issuer, handle);
  }
  if (viewingProfile && response.status === 200) {
    const webid = `${base}/profile/card#me`;
    const quads = await parseRdf(await response.text(), response.headers.get('Content-Type') ?? 'text/turtle', `${base}/profile/card`);
    return publicProfilePage(webid, summarizeProfile(quads, webid), hostsFor(env, url).issuer);
  }
  return response;
}

function invalidToken(reason: string): Response {
  const description = reason.replace(/["\\]/gu, "'");
  return new Response(`${reason}\n`, {
    status: 401,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'WWW-Authenticate': `${DPOP_CHALLENGE}, error="invalid_token", error_description="${description}"`,
    },
  });
}
