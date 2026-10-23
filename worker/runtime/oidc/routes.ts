// HTTP for the Solid-OIDC provider on the apex host (contracts/oidc.md).

import { type AccountStore, Provider } from '../../app/provider.js';
import { type ClientInfo, OidcError, PUBLIC_CLIENT, clientFromDocument, discovery, publicClient } from '../../domain/oidc.js';
import { verifyDpopProof } from '../auth/dpopProof.js';
import { type Signer, signerFromJwk } from '../auth/signer.js';
import type { Env } from '../env.js';
import { consentPage, messagePage } from '../pages/oidcPages.js';

const CLIENT_DOC_LIMIT = 64 * 1024;

let signer: Signer | null = null;

async function signerFor(env: Env): Promise<Signer> {
  if (!env.OIDC_SIGNING_JWK) throw new Error('OIDC_SIGNING_JWK is not configured');
  signer ??= await signerFromJwk(JSON.parse(env.OIDC_SIGNING_JWK));
  return signer;
}

/** Who is signed in at this browser. Clerk in deployments; the dev config
 * also takes a `dev_person` cookie set by /dev/sign-in. */
export type PersonOf = (request: Request) => Promise<string | null>;

export function issuerOf(url: URL): string {
  return `${url.origin}/`;
}

/** Handles provider paths; null when the path is not the provider's. */
export async function oidcRoute(request: Request, env: Env, url: URL, personOf: PersonOf): Promise<Response | null> {
  const p = url.pathname;
  if (p === '/.well-known/openid-configuration') return cors(Response.json(discovery(url.origin)));
  if (p === '/.oidc/jwks') return cors(Response.json((await signerFor(env)).jwks(), { headers: { 'Cache-Control': 'max-age=300' } }));
  if (!p.startsWith('/.oidc/')) return null;
  if (request.method === 'OPTIONS') return cors(new Response(null, { status: 204 }));

  const provider = await providerFor(env, url);
  try {
    if (p === '/.oidc/auth' && request.method === 'GET') {
      const out = await provider.authorize(url.searchParams, await personOf(request));
      if (out.kind === 'sign-in') return Response.redirect(`${url.origin}/sign-in?return=${encodeURIComponent(url.toString())}`, 302);
      if (out.kind === 'no-pod') return messagePage('No pod yet', 'Create your pod first, then sign in to the app again.', 403);
      if (out.kind === 'redirect') return Response.redirect(out.location, 302);
      return consentPage({ pendingId: out.pendingId, client: out.client, webid: out.webid });
    }
    if (p === '/.oidc/auth/decision' && request.method === 'POST') {
      const person = await personOf(request);
      if (!person) return messagePage('Signed out', 'Sign in again, then retry from the app.', 401);
      const form = await request.formData();
      const location = await provider.decide(person, String(form.get('pending') ?? ''), form.get('approve') === 'yes');
      return Response.redirect(location, 302);
    }
    if (p === '/.oidc/token' && request.method === 'POST') {
      const { jkt } = await verifyDpopProof(request.headers.get('DPoP'), 'POST', url.toString(), Math.floor(Date.now() / 1000));
      const form = new URLSearchParams(await request.text());
      return cors(Response.json(await provider.token(form, jkt), { headers: { 'Cache-Control': 'no-store' } }));
    }
    if (p === '/.oidc/reg' && request.method === 'POST') {
      const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
      const uris = body?.redirect_uris;
      if (!Array.isArray(uris) || uris.length === 0 || !uris.every((u) => typeof u === 'string' && /^https?:\/\//u.test(u))) {
        throw new OidcError('invalid_redirect_uri', 'redirect_uris must be http(s) URLs');
      }
      const doc = { redirect_uris: uris, client_name: typeof body?.client_name === 'string' ? body.client_name : null, token_endpoint_auth_method: 'none' };
      const id = await directory(env).registerClient(doc);
      return cors(Response.json({ ...doc, client_id: id, client_id_issued_at: Math.floor(Date.now() / 1000) }, { status: 201 }));
    }
    if (p === '/.oidc/session/end') return Response.redirect(`${url.origin}/sign-out`, 302);
    return new Response('not found\n', { status: 404 });
  } catch (e) {
    if (!(e instanceof OidcError)) throw e;
    if (p === '/.oidc/auth' || p === '/.oidc/auth/decision') return messagePage('That sign-in request did not work', e.message, 400);
    const status = e.code === 'invalid_client' ? 401 : 400;
    return cors(Response.json({ error: e.code, error_description: e.message }, { status, headers: { 'Cache-Control': 'no-store' } }));
  }
}

async function providerFor(env: Env, url: URL): Promise<Provider> {
  const s = await signerFor(env);
  const dir = directory(env);
  const accountStub = (key: string) => env.ACCOUNT.get(env.ACCOUNT.idFromName(key));
  const asStore = async (key: string): Promise<AccountStore> => {
    const stub = accountStub(key);
    await stub.ensure(key);
    return remote(stub, key);
  };
  return new Provider({
    issuer: issuerOf(url),
    accountFor: async (person) => asStore(await dir.accountKeyFor(person)),
    accountByKey: async (key) => (/^[0-9a-f]{32}$/u.test(key) ? remote(accountStub(key), key) : null),
    resolveClient: (id) => resolveClient(env, id),
    sign: (claims) => s.sign(claims),
    now: () => Math.floor(Date.now() / 1000),
    random: () => crypto.randomUUID().replaceAll('-', ''),
    hash: async (secret) => {
      const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret)));
      return [...d].map((b) => b.toString(16).padStart(2, '0')).join('');
    },
  });
}

/** An AccountStore backed by the person's AccountObject over RPC. */
function remote(stub: DurableObjectStub<import('../objects/accountObject.js').AccountObject>, key: string): AccountStore {
  return {
    key,
    webid: () => stub.webid(),
    hasApproval: (c, w) => stub.hasApproval(c, w),
    approve: (c, n, w) => stub.approve(c, n, w),
    savePending: (id, r, c, e) => stub.savePending(id, r, c, e),
    takePending: (id, n) => stub.takePending(id, n),
    saveCode: (h, g) => stub.saveCode(h, g),
    takeCode: (h) => stub.takeCode(h),
    saveFamily: (f) => stub.saveFamily(f),
    family: (id) => stub.family(id),
    rotateFamily: (id, h, e) => stub.rotateFamily(id, h, e),
    revokeFamily: (id) => stub.revokeFamily(id),
    revokeFromCode: (h) => stub.revokeFromCode(h),
  };
}

function directory(env: Env) {
  return env.DIRECTORY.get(env.DIRECTORY.idFromName('directory'));
}

/** A client by its id: the public client, a registered one, or a Client ID
 * Document fetched with a time box and a size cap. */
async function resolveClient(env: Env, clientId: string): Promise<ClientInfo> {
  if (clientId === PUBLIC_CLIENT) return publicClient();
  if (clientId.startsWith('reg_')) {
    const doc = await directory(env).registeredClient(clientId);
    if (!doc) throw new OidcError('invalid_client', 'unknown client');
    return clientFromDocument(clientId, doc);
  }
  if (!/^https:\/\//u.test(clientId) && !/^http:\/\/(localhost|127\.0\.0\.1)(:|\/)/u.test(clientId)) {
    throw new OidcError('invalid_client', 'client_id must be an https URL');
  }
  let res: Response;
  try {
    res = await fetch(clientId, { headers: { Accept: 'application/ld+json, application/json' }, signal: AbortSignal.timeout(5000) });
  } catch (e) {
    throw new OidcError('invalid_client', `client document unreachable: ${(e as Error).message}`);
  }
  if (!res.ok) throw new OidcError('invalid_client', `client document answered ${res.status}`);
  const text = await res.text();
  if (text.length > CLIENT_DOC_LIMIT) throw new OidcError('invalid_client', 'client document is too large');
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new OidcError('invalid_client', 'client document is not JSON');
  }
  return clientFromDocument(clientId, doc);
}

function cors(response: Response): Response {
  const out = new Response(response.body, response);
  out.headers.set('Access-Control-Allow-Origin', '*');
  out.headers.set('Access-Control-Allow-Headers', 'Content-Type, DPoP, Authorization');
  out.headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  return out;
}
