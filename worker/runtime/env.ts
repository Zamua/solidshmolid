import type { AccountObject } from './objects/accountObject.js';
import type { DirectoryObject } from './objects/directoryObject.js';
import type { PodObject } from './objects/podObject.js';

export interface Env {
  POD: DurableObjectNamespace<PodObject>;
  ACCOUNT: DurableObjectNamespace<AccountObject>;
  DIRECTORY: DurableObjectNamespace<DirectoryObject>;
  /** Pod hostnames, with `{handle}` standing for the handle:
   * '{handle}.pods.example', or '{handle}-test.pods.example' for a second
   * deployment. Never on the apex's registrable domain. */
  POD_HOST_TEMPLATE: string;
  /** The account site and identity provider's host ('account.example'). */
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
  /** Secret: the keys TOKEN_KEY replaced, newest first, separated by commas.
   * Tokens sealed under them still open, and are sealed again under
   * TOKEN_KEY when next used. Set only while replacing the key. */
  TOKEN_KEY_OLD?: string;
  /** Secret: the provider's private ES256 JWK, as JSON. */
  OIDC_SIGNING_JWK?: string;
  /** Where people write with questions, shown on the privacy page. */
  SUPPORT_EMAIL?: string;
  /** Clerk instance keys; without them nobody can sign in (outside dev). */
  CLERK_PUBLISHABLE_KEY?: string;
  /** Secret. */
  CLERK_SECRET_KEY?: string;
  /** The release tag this deployment was built from, set by the deploy;
   * `/healthz` and `/readyz` report it. */
  RELEASE?: string;
  /** Secret: the key the operator's routes ask for (recovery, the directory
   * export). Without it those routes do not exist. */
  OPERATOR_KEY?: string;
  /** Where usage events go; without it, or without the salt, none are written. */
  ACTIVITY?: AnalyticsEngineDataset;
  /** Secret: at least 32 random bytes keying the hash of who an event is about. */
  ACTIVITY_SALT?: string;
}

/** Whether this is the local dev config, which trusts what a deployment never does.
 * The flag alone is not enough: it counts only on a loopback host, so one set
 * by mistake on a deployment changes nothing. */
export function isDev(env: Env): boolean {
  return env.DEV_MODE === '1' && isLoopback(env.APEX_HOST);
}

function isLoopback(host: string | undefined): boolean {
  const name = (host ?? '').replace(/:\d+$/u, '');
  return name === 'localhost' || name.endsWith('.localhost') || name === '127.0.0.1' || name === '[::1]';
}
