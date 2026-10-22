// Entry Worker: resolves the pod from the hostname and the agent from the
// request, then hands the request to that pod's Durable Object. The apex host
// carries the storage-link flow.

import { handleFromHost, isValidHandle } from '../domain/handles.js';
import { profileDocument } from '../domain/profile.js';
import { InvalidCredentials, SolidOidcVerifier, type VerifiedAgent } from './auth/solidOidc.js';
import type { Env } from './env.js';
import { withCors } from './http.js';
import { AGENT_HEADER, BASE_HEADER, HANDLE_HEADER, INTERNAL_PREFIX, JTI_EXPIRES_HEADER, JTI_HEADER } from './podObject.js';

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
      if (url.hostname === env.APEX_HOST) return apex(request, env, url);
      return new Response('not found\n', { status: 404 });
    }
    return pod(request, env, url, handle);
  },
} satisfies ExportedHandler<Env>;

async function pod(request: Request, env: Env, url: URL, handle: string): Promise<Response> {
  const dev = env.DEV_MODE === '1';
  const stub = env.POD.get(env.POD.idFromName(handle));
  const base = url.origin;
  if (dev) await stub.ensureProvisioned(handle, base, `${base}/profile/card#me`, profileDocument(`${base}/`, null));

  const headers = new Headers(request.headers);
  for (const name of [...headers.keys()]) if (name.toLowerCase().startsWith(INTERNAL_PREFIX)) headers.delete(name);
  headers.set(BASE_HEADER, base);
  headers.set(HANDLE_HEADER, handle);

  if (request.method !== 'OPTIONS') {
    let agent: VerifiedAgent | null;
    try {
      agent = await verify(request);
    } catch (e) {
      if (!(e instanceof InvalidCredentials)) throw e;
      return withCors(invalidToken(e.message), request, request.headers.get('Origin'));
    }
    if (agent) {
      headers.set(AGENT_HEADER, agent.webid);
      headers.set(JTI_HEADER, agent.jti);
      headers.set(JTI_EXPIRES_HEADER, String(agent.jtiExpires));
    } else if (dev) {
      headers.set(AGENT_HEADER, request.headers.get('X-Dev-WebID') ?? '');
    }
  }
  return stub.fetch(new Request(request, { headers }));
}

/** The apex: linking a pod to Dropbox. */
async function apex(request: Request, env: Env, url: URL): Promise<Response> {
  const dev = env.DEV_MODE === '1';
  const redirectUri = `${url.origin}/link/dropbox/callback`;
  const podBase = (handle: string) => `${url.protocol}//${env.POD_HOST_TEMPLATE.replace('{handle}', handle)}${url.port ? `:${url.port}` : ''}`;

  if (url.pathname === '/link/dropbox/start') {
    const handle = url.searchParams.get('pod') ?? '';
    if (!isValidHandle(handle)) return text('unknown pod\n', 404);
    let webid: string | null;
    try {
      webid = (await verify(request))?.webid ?? null;
    } catch (e) {
      if (!(e instanceof InvalidCredentials)) throw e;
      return invalidToken(e.message);
    }
    // A browser cannot sign a DPoP proof on a plain navigation, so the dev
    // config lets the pod's dev owner start the flow from the address bar.
    if (!webid && dev && request.method === 'GET') webid = `${podBase(handle)}/profile/card#me`;
    const stub = env.POD.get(env.POD.idFromName(handle));
    try {
      const location = await stub.beginDropboxLink(handle, podBase(handle), webid, redirectUri);
      if (request.method === 'GET') return Response.redirect(location, 302);
      return Response.json({ authorizeUrl: location });
    } catch (e) {
      return text(`${(e as Error).message}\n`, 403);
    }
  }

  if (url.pathname === '/link/dropbox/callback') {
    const [handle, nonce] = (url.searchParams.get('state') ?? '').split('.');
    const code = url.searchParams.get('code');
    if (!handle || !nonce || !isValidHandle(handle)) return page('Not connected', 'The link request was not recognised.', 400);
    if (!code) return page('Not connected', `Dropbox was not connected (${url.searchParams.get('error') ?? 'no code'}).`, 400);
    const stub = env.POD.get(env.POD.idFromName(handle));
    try {
      const outcome = await stub.completeDropboxLink(handle, podBase(handle), nonce, code, redirectUri);
      const detail =
        outcome === 'copied'
          ? 'Your pod now lives in the Apps/solidshmolid folder of your Dropbox.'
          : 'The pod already in your Dropbox folder is now being served.';
      return page('Dropbox connected', `${detail} <a href="${podBase(handle)}/">Open your pod</a>.`, 200);
    } catch (e) {
      return page('Not connected', escapeHtml((e as Error).message), 400);
    }
  }

  return text('solidshmolid: Solid pods on your own storage\n', 200);
}

async function verify(request: Request): Promise<VerifiedAgent | null> {
  verifier ??= new SolidOidcVerifier({ fetch: (input, init) => fetch(input, init), now: () => Date.now() });
  return verifier.verify({
    method: request.method,
    url: request.url,
    authorization: request.headers.get('Authorization'),
    dpop: request.headers.get('DPoP'),
  });
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

function text(body: string, status: number): Response {
  return new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}

function page(title: string, html: string, status: number): Response {
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><body style="font:16px/1.5 system-ui;max-width:32rem;margin:3rem auto;padding:0 1rem"><h1>${title}</h1><p>${html}</p>`,
    { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
  );
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/gu, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}
