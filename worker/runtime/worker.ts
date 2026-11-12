// Entry Worker: routes by host. Pod hosts go to that pod's Durable Object
// after the agent is verified; the apex carries the identity provider, the
// account API, the home page and (in development) stand-ins
// for sign-in.

import { isPodId } from '../domain/accounts/podIds.js';
import { DPOP_CHALLENGE } from '../domain/identity/oidc.js';
import { handleFromHost } from '../domain/pods/handles.js';
import { PROFILE_PATH, profileDocument, webidAt } from '../domain/pods/profile.js';
import { InvalidCredentials, type VerifiedAgent } from './adapters/solidOidcVerifier.js';
import { webidPod } from '../app/accounts/accounts.js';
import { accounts, activity, clerkChrome, isDev, sessions, tokenVerifier, uncountedIfAsked } from './composition.js';
import { hostsFor, ownPort } from './hosts.js';
import { withOwnHosts } from './ownHosts.js';
import { unready } from './readiness.js';
import type { Env } from './env.js';
import { devRoute } from './http/dev.js';
import { apiRoute } from './http/api.js';
import { withClerk } from './http/clerkChrome.js';
import { homeRoute } from './http/home.js';
import { signInRoute } from './http/signIn.js';
import { httpsRedirect, untransformed, withHsts } from './http/transport.js';
import { oidcRoute } from './http/oidc.js';
import { operatorRoute } from './http/operator.js';
import { appIconRoute } from './http/assets/appIcons.js';
import { fontRoute } from './http/assets/fonts.js';
import { PAGE_SCRIPT_PATH } from './http/assets/pageScript.js';
import { accountMenu } from './http/pages/home.js';
import { problemPage } from './http/pages/problem.js';
import { isNavigation, podLandingPage, publicProfilePage } from './http/pages/podPages.js';
import { summarizeProfile } from '../domain/pods/profile.js';
import { InvalidRdf, parseRdf } from '../domain/shared/rdf.js';
import { withCors } from './http/solid.js';
import { AGENT_HEADER, BASE_HEADER, INTERNAL_PREFIX, JTI_EXPIRES_HEADER, JTI_HEADER } from './objects/podObject.js';

export { AccountObject } from './objects/accountObject.js';
export { DirectoryObject } from './objects/directoryObject.js';
export { PodObject } from './objects/podObject.js';

const worker = {
  async fetch(request: Request, bound: Env, ctx?: ExecutionContext): Promise<Response> {
    const env = uncountedIfAsked(bound, request);
    const url = new URL(request.url);
    // Liveness, then readiness: both name the release, neither says more.
    // Reads of the account site only, so on a pod these are ordinary names.
    if (url.hostname === env.APEX_HOST && (request.method === 'GET' || request.method === 'HEAD')) {
      if (url.pathname === '/healthz') return probe('ok', 200, env);
      if (url.pathname === '/readyz') {
        const problems = await unready(env);
        if (problems.length > 0) console.error(`not ready: ${problems.join(', ')}`);
        return problems.length > 0 ? probe('not ready', 503, env) : probe('ready', 200, env);
      }
    }
    const handle = handleFromHost(url.hostname, env.POD_HOST_TEMPLATE);
    if (handle === null && url.hostname !== env.APEX_HOST) return new Response('not found\n', { status: 404 });
    // Development runs on plain http and a port of its own.
    if (isDev(env)) return untransformed(await route(request, env, url, handle, ctx));
    return httpsRedirect(request, url) ?? withHsts(untransformed(await route(request, env, url, handle, ctx)));
  },
} satisfies ExportedHandler<Env>;

function route(request: Request, env: Env, url: URL, handle: string | null, ctx?: ExecutionContext): Promise<Response> {
  return handle !== null ? pod(request, env, url, handle, ctx) : apex(request, env, url, ctx);
}

export default worker;

function probe(word: string, status: number, env: Env): Response {
  return new Response(`${word}\n`, { status, headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store', 'X-Release': env.RELEASE ?? 'unknown' } });
}

/** The apex: who is signed in is settled once, before any route runs. */
async function apex(request: Request, env: Env, url: URL, ctx?: ExecutionContext): Promise<Response> {
  const asset = appIconRoute(request, url) ?? fontRoute(request, url);
  if (asset) return asset;
  // Before any session is looked at: the operator's routes take a key, never a cookie.
  const operator = await operatorRoute(request, env, url);
  if (operator) return operator;
  const session = await sessions(env, url.origin).check(request);
  if (session.redirect) return session.redirect;
  if (session.person && url.pathname !== PAGE_SCRIPT_PATH) ctx?.waitUntil(activeOnSite(env, url, session.person));
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

/** Counts a signed-in person with an account as active. */
async function activeOnSite(env: Env, url: URL, person: string): Promise<void> {
  try {
    const state = await accounts(env, hostsFor(env, url)).mine(person);
    if (state) await activity(env).record({ actor: webidPod(state).podId, action: 'active' });
  } catch {
    // Counting never surfaces a failure.
  }
}

async function pod(request: Request, env: Env, url: URL, handle: string, ctx?: ExecutionContext): Promise<Response> {
  const base = hostsFor(env, url).podOrigin(handle);
  // Outside dev only pod ids name pods; anything else is turned away before
  // it can bring a Durable Object into being.
  if (!isDev(env) && !isPodId(handle)) {
    return isNavigation(request) ? podLandingPage(404, `${base}/`, hostsFor(env, url).issuer, handle) : new Response('not found\n', { status: 404 });
  }
  const stub = env.POD.get(env.POD.idFromName(handle));
  // Named pods are a development convenience; pods with random ids belong to
  // accounts and exist once their storage is connected.
  if (isDev(env) && !isPodId(handle)) {
    await stub.ensureProvisioned(base, webidAt(base), profileDocument(`${base}/`, hostsFor(env, url).issuer));
  }

  const headers = new Headers(request.headers);
  for (const name of [...headers.keys()]) if (name.toLowerCase().startsWith(INTERNAL_PREFIX)) headers.delete(name);
  headers.set(BASE_HEADER, base);
  // A person opening the profile gets it rendered (below), so ask the pod for the data.
  const viewingProfile = isNavigation(request) && request.method === 'GET' && url.pathname === PROFILE_PATH;
  if (viewingProfile) headers.set('Accept', 'text/turtle');

  let asked: 'owner' | 'agent' | 'public' = 'public';
  if (request.method !== 'OPTIONS') {
    let agent: VerifiedAgent | null;
    try {
      agent = await tokenVerifier(env).verify(
        { method: request.method, url: request.url, authorization: request.headers.get('Authorization'), dpop: request.headers.get('DPoP') },
        // Its lookups of the service's own hosts are served here, in-process.
        withOwnHosts(env, ownPort(env, url), (r) => worker.fetch(r, env), (input, init) => fetch(input, init)),
      );
    } catch (e) {
      if (!(e instanceof InvalidCredentials)) throw e;
      // What a lookup found goes to the log; the caller gets the fixed reason.
      if (e.detail) console.warn(JSON.stringify({ level: 'warn', msg: 'credentials refused', reason: e.message, detail: e.detail }));
      return withCors(invalidToken(e.message), request, request.headers.get('Origin'));
    }
    if (agent) {
      const actor = hostsFor(env, url).podOfWebid(agent.webid);
      if (actor) ctx?.waitUntil(activity(env).record({ actor, action: 'active' }));
      asked = actor === handle ? 'owner' : 'agent';
      headers.set(AGENT_HEADER, agent.webid);
      headers.set(JTI_HEADER, agent.jti);
      headers.set(JTI_EXPIRES_HEADER, String(agent.jtiExpires));
    } else if (isDev(env)) {
      headers.set(AGENT_HEADER, request.headers.get('X-Dev-WebID') ?? '');
    }
  }
  const response = await stub.fetch(new Request(request, { headers }));
  if (request.method !== 'OPTIONS') ctx?.waitUntil(activity(env).record({ actor: null, action: 'pod_request', detail: asked }));
  if (!isNavigation(request)) return response;
  if (response.status === 401 || response.status === 403 || response.status === 404) {
    return podLandingPage(response.status, `${base}/`, hostsFor(env, url).issuer, handle);
  }
  if (viewingProfile && response.status === 200) {
    const webid = webidAt(base);
    const text = await response.text();
    try {
      const quads = await parseRdf(text, response.headers.get('Content-Type') ?? 'text/turtle', `${base}${PROFILE_PATH}`);
      return publicProfilePage(webid, summarizeProfile(quads, webid), hostsFor(env, url).issuer);
    } catch (e) {
      // A profile edited into something that does not parse is shown as stored.
      if (!(e instanceof InvalidRdf)) throw e;
      return new Response(text, response);
    }
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
