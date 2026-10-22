// Entry Worker: resolves the pod from the hostname and the agent from the
// request, then hands the request to that pod's Durable Object.

import { handleFromHost } from '../domain/handles.js';
import { profileDocument } from '../domain/profile.js';
import type { Env } from './env.js';
import { AGENT_HEADER, BASE_HEADER, INTERNAL_PREFIX } from './podObject.js';

export { PodObject } from './podObject.js';

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

    // Solid-OIDC verification arrives in M2; until then only the dev config
    // can name an agent, and everyone else is anonymous.
    const agent = dev ? (request.headers.get('X-Dev-WebID') ?? '') : '';

    const headers = new Headers(request.headers);
    for (const name of [...headers.keys()]) if (name.toLowerCase().startsWith(INTERNAL_PREFIX)) headers.delete(name);
    headers.set(BASE_HEADER, base);
    headers.set(AGENT_HEADER, agent);
    return stub.fetch(new Request(request, { headers }));
  },
} satisfies ExportedHandler<Env>;
