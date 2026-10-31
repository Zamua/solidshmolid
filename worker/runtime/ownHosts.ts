// Fetching the service's own hosts. A Worker's subrequest to its own custom
// domain or route never reaches it (Cloudflare answers 522), so lookups the
// service makes of itself (its provider's keys, a WebID it hosts) are served
// in-process instead; every other URL goes out over the network.

import { handleFromHost } from '../domain/pods/handles.js';
import type { Fetch } from './adapters/http.js';
import type { Env } from './env.js';

/** `port` is the one the service answers on ('' for the default), so a
 * neighbour on the same host and another port stays outside. */
export function withOwnHosts(env: Env, port: string, serve: (request: Request) => Promise<Response>, network: Fetch): Fetch {
  return (input, init) => {
    const url = new URL(input);
    const own = url.port === port && (url.hostname === env.APEX_HOST || handleFromHost(url.hostname, env.POD_HOST_TEMPLATE) !== null);
    return own ? serve(new Request(input, init)) : network(input, init);
  };
}
