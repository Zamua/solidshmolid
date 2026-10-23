// HTTP for the Solid-OIDC provider on the apex host (contracts/oidc.md).
// Translation only: parse the request, call the provider, shape the response.

import { OidcError, discovery } from '../../domain/identity/oidc.js';
import { verifyDpopProof } from '../adapters/dpopProof.js';
import { provider, tokenSigner } from '../composition.js';
import type { Env } from '../env.js';
import { consentPage, messagePage } from './pages/oidcPages.js';

/** Handles provider paths; null when the path is not the provider's. */
export async function oidcRoute(request: Request, env: Env, url: URL, person: string | null): Promise<Response | null> {
  const path = url.pathname;
  if (path === '/.well-known/openid-configuration') return cors(Response.json(discovery(url.origin)));
  if (!path.startsWith('/.oidc/')) return null;
  if (request.method === 'OPTIONS') return cors(new Response(null, { status: 204 }));
  if (path === '/.oidc/jwks') return cors(Response.json((await tokenSigner(env)).jwks(), { headers: { 'Cache-Control': 'max-age=300' } }));

  const op = await provider(env, `${url.origin}/`);
  try {
    if (path === '/.oidc/auth' && request.method === 'GET') {
      const out = await op.authorize(url.searchParams, person);
      switch (out.kind) {
        case 'sign-in':
          return Response.redirect(`${url.origin}/sign-in?return=${encodeURIComponent(url.toString())}`, 302);
        case 'no-pod':
          return messagePage('No pod yet', 'Create your pod first, then sign in to the app again.', 403);
        case 'redirect':
          return Response.redirect(out.location, 302);
        case 'consent':
          return consentPage(out);
      }
    }
    if (path === '/.oidc/auth/decision' && request.method === 'POST') {
      // SameSite cookies do not stop a page on a sibling subdomain from
      // posting here; only our own consent page may.
      if (request.headers.get('Origin') !== url.origin) return messagePage('Not allowed', 'Approve apps from this site only.', 403);
      if (!person) return messagePage('Signed out', 'Sign in again, then retry from the app.', 401);
      const form = await request.formData();
      return Response.redirect(await op.decide(person, String(form.get('pending') ?? ''), form.get('approve') === 'yes'), 302);
    }
    if (path === '/.oidc/token' && request.method === 'POST') {
      const { jkt } = await verifyDpopProof(request.headers.get('DPoP'), 'POST', url.toString(), Math.floor(Date.now() / 1000));
      const tokens = await op.token(new URLSearchParams(await request.text()), jkt);
      return cors(Response.json(tokens, { headers: { 'Cache-Control': 'no-store' } }));
    }
    if (path === '/.oidc/reg' && request.method === 'POST') {
      return cors(Response.json(await op.register(await request.json().catch(() => null)), { status: 201 }));
    }
    if (path === '/.oidc/session/end') return Response.redirect(`${url.origin}/sign-out`, 302);
    return new Response('not found\n', { status: 404 });
  } catch (e) {
    if (!(e instanceof OidcError)) throw e;
    // Before the client is trusted, an error is shown to the person, never
    // sent to a redirect the client named.
    if (path.startsWith('/.oidc/auth')) return messagePage('That sign-in request did not work', e.message, 400);
    const status = e.code === 'invalid_client' ? 401 : 400;
    return cors(Response.json({ error: e.code, error_description: e.message }, { status, headers: { 'Cache-Control': 'no-store' } }));
  }
}

function cors(response: Response): Response {
  const out = new Response(response.body, response);
  out.headers.set('Access-Control-Allow-Origin', '*');
  out.headers.set('Access-Control-Allow-Headers', 'Content-Type, DPoP, Authorization');
  out.headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  return out;
}
