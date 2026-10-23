import type { AccountObject } from './objects/accountObject.js';
import type { DirectoryObject } from './objects/directoryObject.js';
import type { PodObject } from './objects/podObject.js';

export interface Env {
  POD: DurableObjectNamespace<PodObject>;
  ACCOUNT: DurableObjectNamespace<AccountObject>;
  DIRECTORY: DurableObjectNamespace<DirectoryObject>;
  /** Pod hostnames, with `{handle}` standing for the handle:
   * '{handle}.example.com' in prod, '{handle}-stg.example.com' in staging. */
  POD_HOST_TEMPLATE: string;
  /** The identity provider's host. */
  APEX_HOST: string;
  /** The storage provider people connect: 'dropbox', or 'dev' (local only:
   * files stay in each pod's own SQLite). */
  STORAGE: string;
  /** '1' in the local dev config only: trust an X-Dev-WebID header as the
   * authenticated agent and create pods on first request. */
  DEV_MODE?: string;
  /** The Dropbox app's key (public: it appears in every authorize URL). */
  DROPBOX_APP_KEY?: string;
  /** Secret: 32 bytes, base64, encrypting stored refresh tokens. */
  TOKEN_KEY?: string;
  /** Secret: the provider's private ES256 JWK, as JSON. */
  OIDC_SIGNING_JWK?: string;
  /** Clerk instance keys; without them nobody can sign in (outside dev). */
  CLERK_PUBLISHABLE_KEY?: string;
  /** Secret. */
  CLERK_SECRET_KEY?: string;
}
