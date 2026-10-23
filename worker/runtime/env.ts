import type { PodObject } from './objects/podObject.js';

export interface Env {
  POD: DurableObjectNamespace<PodObject>;
  /** Pod hostnames, with `{handle}` standing for the handle:
   * '{handle}.example.com' in prod, 'stg-{handle}.example.com' in staging. */
  POD_HOST_TEMPLATE: string;
  /** The identity provider's host. */
  APEX_HOST: string;
  /** Which FileStore pods use: 'dev' (local only) or a provider name. */
  STORAGE: string;
  /** '1' in the local dev config only: trust an X-Dev-WebID header as the
   * authenticated agent and create pods on first request. */
  DEV_MODE?: string;
  /** The Dropbox app's key (public: it appears in every authorize URL). */
  DROPBOX_APP_KEY?: string;
  /** Secret: 32 bytes, base64, encrypting stored refresh tokens. */
  TOKEN_KEY?: string;
}
