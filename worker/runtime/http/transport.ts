// The one address a deployment answers on: https at the default port. A
// request that reaches an own host any other way (plain http, another port
// the edge also listens on) would otherwise be served with that origin as its
// base, so issuers, WebIDs and pod URLs would come out under a second name.

const HSTS = 'max-age=31536000';

/** A redirect to the https address of the same resource, or null when the
 * request is already there. GET and HEAD move with 301; anything else with
 * 308, which keeps the method and body. */
export function httpsRedirect(request: Request, url: URL): Response | null {
  if (url.protocol === 'https:' && url.port === '') return null;
  const status = request.method === 'GET' || request.method === 'HEAD' ? 301 : 308;
  return new Response(null, { status, headers: { Location: `https://${url.hostname}${url.pathname}${url.search}` } });
}

/** Tells browsers to keep using https for this host. */
export function withHsts(response: Response): Response {
  if (response.status === 101) return response;
  const out = new Response(response.body, response);
  out.headers.set('Strict-Transport-Security', HSTS);
  return out;
}
