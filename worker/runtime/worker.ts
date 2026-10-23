// Entry Worker: routes by host. Pod hosts go to that pod's Durable Object
// after the agent is verified; the apex carries the identity provider, the
// account and household API, the home page and (in development) stand-ins
// for sign-in.

import { isPodId } from '../domain/households/podIds.js';
import { handleFromHost } from '../domain/pods/handles.js';
import { profileDocument } from '../domain/pods/profile.js';
import { InvalidCredentials, type VerifiedAgent } from './adapters/solidOidcVerifier.js';
import { isDev, tokenVerifier } from './composition.js';
import { hostsFor } from './hosts.js';
import type { Env } from './env.js';
import { devRoute } from './http/dev.js';
import { apiRoute } from './http/api.js';
import { homeRoute } from './http/home.js';
import { oidcRoute } from './http/oidc.js';
import { withCors } from './http/solid.js';
import { AGENT_HEADER, BASE_HEADER, INTERNAL_PREFIX, JTI_EXPIRES_HEADER, JTI_HEADER } from './objects/podObject.js';

export { AccountObject } from './objects/accountObject.js';
export { DirectoryObject } from './objects/directoryObject.js';
export { HouseholdObject } from './objects/householdObject.js';
export { PodObject } from './objects/podObject.js';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/healthz') {
      return new Response('ok\n', { headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' } });
    }
    const handle = handleFromHost(url.hostname, env.POD_HOST_TEMPLATE);
    if (handle !== null) return pod(request, env, url, handle);
    if (url.hostname === env.APEX_HOST) {
      return (
        (await oidcRoute(request, env, url)) ??
        (await apiRoute(request, env, url)) ??
        (await homeRoute(request, env, url)) ??
        (await devRoute(request, env, url)) ??
        new Response('not found\n', { status: 404 })
      );
    }
    return new Response('not found\n', { status: 404 });
  },
} satisfies ExportedHandler<Env>;

async function pod(request: Request, env: Env, url: URL, handle: string): Promise<Response> {
  const stub = env.POD.get(env.POD.idFromName(handle));
  const base = url.origin;
  // Named pods are a development convenience; pods with random ids belong to
  // households and exist once their storage is connected.
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
  return stub.fetch(new Request(request, { headers }));
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
