// The service's URLs. A deployment has one set, from its configuration: https
// at the default port, whatever the request came in on. The dev server (http,
// :8787) has no fixed address, so there they follow the request.

import { isPodId } from '../domain/accounts/podIds.js';
import { handleFromHost } from '../domain/pods/handles.js';
import { webidAt } from '../domain/pods/profile.js';
import { type Env, isDev } from './env.js';

export interface Hosts {
  /** The identity provider, with a trailing slash. */
  issuer: string;
  /** A pod's origin, no trailing slash. */
  podOrigin(handle: string): string;
  webidOf(handle: string): string;
  /** The pod a WebID lives in when this service hosts it, else null. */
  podOfWebid(webid: string): string | null;
}

export function hostsFor(env: Env, request: URL): Hosts {
  const scheme = isDev(env) ? request.protocol : 'https:';
  const port = ownPort(env, request) && `:${ownPort(env, request)}`;
  const podOrigin = (handle: string) => `${scheme}//${env.POD_HOST_TEMPLATE.replace('{handle}', handle)}${port}`;
  const webidOf = (handle: string) => webidAt(podOrigin(handle));
  return {
    issuer: `${scheme}//${env.APEX_HOST}${port}/`,
    podOrigin,
    webidOf,
    podOfWebid: (webid) => {
      if (!URL.canParse(webid)) return null;
      const handle = handleFromHost(new URL(webid).hostname, env.POD_HOST_TEMPLATE);
      return handle !== null && isPodId(handle) && webidOf(handle) === webid ? handle : null;
    },
  };
}

/** The port the service answers on, '' for the default. */
export function ownPort(env: Env, request: URL): string {
  return isDev(env) ? request.port : '';
}
