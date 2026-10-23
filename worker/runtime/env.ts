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
  /** The storage providers people may connect, comma-separated, in the order
   * offered: 'dropbox', 'google-drive', and 'dev' (local only: files stay in
   * each pod's own SQLite). */
  STORAGE: string;
  /** '1' in the local dev config only: trust an X-Dev-WebID header as the
   * authenticated agent and create pods on first request. */
  DEV_MODE?: string;
  /** The Dropbox app's key (public: it appears in every authorize URL). */
  DROPBOX_APP_KEY?: string;
  /** The Google OAuth client for Drive (public: in every authorize URL). */
  GOOGLE_CLIENT_ID?: string;
  /** Secret: that client's secret, which Google requires to refresh. */
  GOOGLE_CLIENT_SECRET?: string;
  /** Secret: 32 bytes, base64, encrypting stored refresh tokens. */
  TOKEN_KEY?: string;
  /** Secret: the provider's private ES256 JWK, as JSON. */
  OIDC_SIGNING_JWK?: string;
  /** Where people write with questions, shown on the privacy page. */
  SUPPORT_EMAIL?: string;
  /** Clerk instance keys; without them nobody can sign in (outside dev). */
  CLERK_PUBLISHABLE_KEY?: string;
  /** Secret. */
  CLERK_SECRET_KEY?: string;
}
