// Entry Worker: resolves the pod from the hostname and the agent from the
// request, then hands the request to that pod's Durable Object.

import { handleFromHost } from '../domain/handles.js';
import { profileDocument } from '../domain/profile.js';
import { InvalidCredentials, SolidOidcVerifier } from './auth/solidOidc.js';
import type { Env } from './env.js';
import { withCors } from './http.js';
import { AGENT_HEADER, BASE_HEADER, INTERNAL_PREFIX, JTI_EXPIRES_HEADER, JTI_HEADER } from './podObject.js';

export { PodObject } from './podObject.js';

// Module scope, so issuer keys and WebID lookups are cached across requests
// in one isolate. An eviction costs a refetch, never a failure.
let verifier: SolidOidcVerifier | null = null;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/healthz') {
      return new Response('ok\n', { headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' } });
    }

    const handle = handleFromHost(url.hostname, env.POD_HOST_TEMPLATE);
    if (handle === null) {
      if (url.hostname === env.APEX_HOST) {
        return new Response('solidshmolid: Solid pods on your own storage\n', { headers: { 'Content-Type': 'text/plain' } });
      }
      return new Response('not found\n', { status: 404 });
    }

    const dev = env.DEV_MODE === '1';
    const stub = env.POD.get(env.POD.idFromName(handle));
    const base = url.origin;
    if (dev) await stub.ensureProvisioned(base, `${base}/profile/card#me`, profileDocument(`${base}/`, null));

    const headers = new Headers(request.headers);
    for (const name of [...headers.keys()]) if (name.toLowerCase().startsWith(INTERNAL_PREFIX)) headers.delete(name);
    headers.set(BASE_HEADER, base);

    if (request.method !== 'OPTIONS') {
      verifier ??= new SolidOidcVerifier({ fetch: (input, init) => fetch(input, init), now: () => Date.now() });
      try {
        const agent = await verifier.verify({
          method: request.method,
          url: request.url,
          authorization: request.headers.get('Authorization'),
          dpop: request.headers.get('DPoP'),
        });
        if (agent) {
          headers.set(AGENT_HEADER, agent.webid);
          headers.set(JTI_HEADER, agent.jti);
          headers.set(JTI_EXPIRES_HEADER, String(agent.jtiExpires));
        } else if (dev) {
          headers.set(AGENT_HEADER, request.headers.get('X-Dev-WebID') ?? '');
        }
      } catch (e) {
        if (!(e instanceof InvalidCredentials)) throw e;
        return withCors(invalidToken(e.message), request, request.headers.get('Origin'));
      }
    }
    return stub.fetch(new Request(request, { headers }));
  },
} satisfies ExportedHandler<Env>;

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
