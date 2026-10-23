// HTTP for linking a pod to Dropbox, on the apex host.

import { InvalidCredentials } from '../adapters/solidOidcVerifier.js';
import { isDev, tokenVerifier } from '../composition.js';
import type { Env } from '../env.js';
import { isValidHandle } from '../../domain/pods/handles.js';
import { escapeHtml, page } from './pages/shell.js';

export async function linkRoute(request: Request, env: Env, url: URL): Promise<Response | null> {
  if (url.pathname === '/link/dropbox/start') return start(request, env, url);
  if (url.pathname === '/link/dropbox/callback') return callback(env, url);
  return null;
}

/** The pod origin for a handle, on the same scheme and port as the apex. */
export function podBase(env: Env, url: URL, handle: string): string {
  return `${url.protocol}//${env.POD_HOST_TEMPLATE.replace('{handle}', handle)}${url.port ? `:${url.port}` : ''}`;
}

async function start(request: Request, env: Env, url: URL): Promise<Response> {
  const handle = url.searchParams.get('pod') ?? '';
  if (!isValidHandle(handle)) return text('unknown pod\n', 404);
  let webid: string | null;
  try {
    webid =
      (
        await tokenVerifier().verify({
          method: request.method,
          url: request.url,
          authorization: request.headers.get('Authorization'),
          dpop: request.headers.get('DPoP'),
        })
      )?.webid ?? null;
  } catch (e) {
    if (!(e instanceof InvalidCredentials)) throw e;
    return text(`${e.message}\n`, 401);
  }
  // A browser cannot sign a DPoP proof on a plain navigation, so the dev
  // config lets the pod's dev owner start the flow from the address bar.
  if (!webid && isDev(env) && request.method === 'GET') webid = `${podBase(env, url, handle)}/profile/card#me`;
  const stub = env.POD.get(env.POD.idFromName(handle));
  try {
    const location = await stub.beginDropboxLink(handle, podBase(env, url, handle), webid, `${url.origin}/link/dropbox/callback`);
    return request.method === 'GET' ? Response.redirect(location, 302) : Response.json({ authorizeUrl: location });
  } catch (e) {
    return text(`${(e as Error).message}\n`, 403);
  }
}

async function callback(env: Env, url: URL): Promise<Response> {
  const [handle, nonce] = (url.searchParams.get('state') ?? '').split('.');
  const code = url.searchParams.get('code');
  if (!handle || !nonce || !isValidHandle(handle)) return page('Not connected', '<h1>Not connected</h1><p class="lede">The link request was not recognised.</p>', 400);
  if (!code) {
    const reason = escapeHtml(url.searchParams.get('error') ?? 'no code');
    return page('Not connected', `<h1>Not connected</h1><p class="lede">Dropbox was not connected (${reason}).</p>`, 400);
  }
  const stub = env.POD.get(env.POD.idFromName(handle));
  const base = podBase(env, url, handle);
  try {
    const outcome = await stub.completeDropboxLink(handle, base, nonce, code, `${url.origin}/link/dropbox/callback`);
    const detail =
      outcome === 'copied'
        ? 'Your pod now lives in the Apps/solidshmolid folder of your Dropbox.'
        : 'The pod already in your Dropbox folder is now being served.';
    return page('Dropbox connected', `<h1>Dropbox connected</h1><p class="lede">${detail}</p><p><a href="${escapeHtml(base)}/">Open your pod</a></p>`);
  } catch (e) {
    return page('Not connected', `<h1>Not connected</h1><p class="lede">${escapeHtml((e as Error).message)}</p>`, 400);
  }
}

function text(body: string, status: number): Response {
  return new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}
