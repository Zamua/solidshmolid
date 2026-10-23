// The composition root: the one place that chooses adapters and builds the
// application services from the environment. Everything else receives what it
// needs from here.

import { Accounts } from '../app/accounts/accounts.js';
import type { Logins, Placement } from '../app/accounts/ports.js';
import { Provider } from '../app/identity/provider.js';
import { Pod } from '../app/pods/pod.js';
import { StorageUnavailable } from '../app/shared/errors.js';
import type { FileLister, FileStore, StorageAuthorization } from '../app/storage/ports.js';
import { FolderSync } from '../app/storage/sync.js';
import { RpcAccounts, rpcAccountPods, rpcDirectory, rpcIdentities, rpcPods } from './adapters/accountRpc.js';
import { HttpClientRegistry } from './adapters/clientRegistry.js';
import { DevFileStore } from './adapters/devFiles.js';
import { DEV_PROVIDER, devAuthorization, devGrants } from './adapters/devStorage.js';
import { DropboxFileStore } from './adapters/dropbox.js';
import { DropboxAuthorization, refreshAccess, revokeGrant } from './adapters/dropboxOAuth.js';
import { MemoryDriveNodes, SqlDriveNodes } from './adapters/driveNodes.js';
import { DriveFileStore } from './adapters/googleDrive.js';
import { type GoogleClient, GoogleDriveAuthorization, refreshGoogleAccess, revokeGoogleGrant } from './adapters/googleDriveOAuth.js';
import type { AccessToken, GrantKeeper } from './adapters/linkTokens.js';
import { ClerkLogins } from './adapters/clerkLogins.js';
import { type ClerkKeys, ClerkSessions, frontendApiOf } from './adapters/clerkSessions.js';
import { type Sessions, devSessions, firstOf, noSessions } from './adapters/sessions.js';
import type { SqlRunner } from './adapters/sql.js';
import { SqlPlacement } from './adapters/sqlPlacement.js';
import { SqlIndex } from './adapters/sqlPodIndex.js';
import { SolidOidcVerifier } from './adapters/solidOidcVerifier.js';
import { systemClock, webCryptoSecrets } from './adapters/system.js';
import { type Signer, signerFromJwk } from './adapters/tokenSigner.js';
import { UnlinkedStore } from './adapters/unlinked.js';
import type { Env } from './env.js';
import type { Hosts } from './hosts.js';
import type { Fetch } from './ownHosts.js';
import type { ClerkChrome } from './http/clerkChrome.js';

// Module scope, so keys, JWKS and WebID lookups are cached across requests in
// one isolate. An eviction costs a rebuild, never a failure.
let signer: Signer | null = null;
let verifier: SolidOidcVerifier | null = null;

const fetcher = (input: string, init?: RequestInit) => fetch(input, init);
const DROPBOX = 'dropbox';
const GOOGLE_DRIVE = 'google-drive';
const randomId = () => crypto.randomUUID().replaceAll('-', '');

export function isDev(env: Env): boolean {
  return env.DEV_MODE === '1';
}

export async function tokenSigner(env: Env): Promise<Signer> {
  if (!env.OIDC_SIGNING_JWK) throw new Error('OIDC_SIGNING_JWK is not configured');
  signer ??= await signerFromJwk(JSON.parse(env.OIDC_SIGNING_JWK));
  return signer;
}

/** `fetch` must serve the service's own hosts in-process (see ownHosts.ts). */
export function tokenVerifier(fetch: Fetch): SolidOidcVerifier {
  verifier ??= new SolidOidcVerifier({ fetch, now: () => Date.now() });
  return verifier;
}

export function directory(env: Env) {
  return env.DIRECTORY.get(env.DIRECTORY.idFromName('directory'));
}

export async function provider(env: Env, issuer: string): Promise<Provider> {
  return new Provider({
    issuer,
    accounts: new RpcAccounts(env),
    clients: new HttpClientRegistry(directory(env), fetcher),
    signer: await tokenSigner(env),
    clock: systemClock,
    secrets: webCryptoSecrets,
  });
}

let clerkSessions: { apex: string; sessions: ClerkSessions } | null = null;

/** Who is signed in on the apex: Clerk when configured; the dev config also
 * honors its dev sign-in cookie first. */
export function sessions(env: Env, apexOrigin: string): Sessions {
  const keys = clerkKeys(env);
  if (keys && clerkSessions?.apex !== apexOrigin) clerkSessions = { apex: apexOrigin, sessions: new ClerkSessions(keys, [apexOrigin]) };
  const clerk = keys ? clerkSessions!.sessions : null;
  if (isDev(env)) return clerk ? firstOf(devSessions, clerk) : devSessions;
  return clerk ?? noSessions;
}

/** What apex pages need to load Clerk, or null when it is not configured. */
export function clerkChrome(env: Env): ClerkChrome | null {
  const keys = clerkKeys(env);
  return keys ? { publishableKey: keys.publishableKey, frontendApi: frontendApiOf(keys.publishableKey) } : null;
}

function clerkKeys(env: Env): ClerkKeys | null {
  if (!env.CLERK_PUBLISHABLE_KEY || !env.CLERK_SECRET_KEY) return null;
  return { publishableKey: env.CLERK_PUBLISHABLE_KEY, secretKey: env.CLERK_SECRET_KEY };
}

/** The providers people may connect their storage to, as `STORAGE` lists them. */
export function storageProviders(env: Env): string[] {
  return env.STORAGE.split(',')
    .map((p) => p.trim())
    .filter(Boolean);
}

export function storageAuthorizations(env: Env): Record<string, StorageAuthorization> {
  const out: Record<string, StorageAuthorization> = {};
  for (const name of storageProviders(env)) {
    if (name === DEV_PROVIDER && isDev(env)) out[name] = devAuthorization;
    else if (name === DROPBOX) out[name] = new DropboxAuthorization(requireAppKey(env), fetcher);
    else if (name === GOOGLE_DRIVE) out[name] = new GoogleDriveAuthorization(requireGoogleClient(env), fetcher);
    else throw new Error(`STORAGE names ${name}, which this deployment cannot connect`);
  }
  return out;
}

/** How an account keeps the grants of each provider it may hold. */
export function storageGrants(env: Env): Record<string, GrantKeeper> {
  const keepers: Record<string, GrantKeeper> = {};
  if (env.DROPBOX_APP_KEY) {
    const appKey = env.DROPBOX_APP_KEY;
    keepers.dropbox = {
      refresh: async (refreshToken) => {
        const fresh = await refreshAccess(fetcher, appKey, refreshToken, Date.now());
        return { token: fresh.accessToken, expiresAt: fresh.expiresAt };
      },
      revoke: (refreshToken) => revokeGrant(fetcher, appKey, refreshToken, Date.now()),
    };
  }
  if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) {
    const client = requireGoogleClient(env);
    keepers[GOOGLE_DRIVE] = {
      refresh: async (refreshToken) => {
        const fresh = await refreshGoogleAccess(fetcher, client, refreshToken, Date.now());
        return { token: fresh.accessToken, expiresAt: fresh.expiresAt };
      },
      revoke: (refreshToken) => revokeGoogleGrant(fetcher, refreshToken),
    };
  }
  if (isDev(env)) keepers[DEV_PROVIDER] = devGrants;
  return keepers;
}

/** People's sign-ins: Clerk when configured, else (dev only) nobody to remove. */
function logins(env: Env): Logins {
  const keys = clerkKeys(env);
  if (keys) return new ClerkLogins(keys);
  if (isDev(env)) return { remove: async () => {} };
  throw new Error('CLERK_PUBLISHABLE_KEY and CLERK_SECRET_KEY are not configured');
}

export function accounts(env: Env, hosts: Hosts): Accounts {
  return new Accounts({
    directory: rpcDirectory(env),
    account: (key) => rpcAccountPods(env, key),
    pods: rpcPods(env, hosts),
    identities: rpcIdentities(env),
    logins: logins(env),
    authorizations: storageAuthorizations(env),
    ids: { random: randomId },
    webidOf: hosts.webidOf,
  });
}

/** A pod's services, wired to the storage it currently lives in. */
export interface PodServices {
  pod: Pod;
  /** Present once the pod is placed in storage with a change feed. */
  sync: FolderSync | null;
  placement: SqlPlacement;
  /** The pod as served from `placement`, and that storage. */
  podIn: (placement: Placement) => { pod: Pod; files: FileStore & FileLister };
}

const SYNC_INTERVAL_MS = 30_000;

export function podServices(env: Env, storage: DurableObjectStorage, base: string): PodServices {
  const sql = storage.sql as SqlRunner;
  const index = new SqlIndex(sql, (fn) => storage.transactionSync(fn));
  const placement = new SqlPlacement(sql);
  const podOn = (files: FileStore) => new Pod({ index, files, base, now: () => new Date(), newId: randomId });
  const podIn = (p: Placement) => {
    const files = placedStorage(env, sql, p);
    return { pod: podOn(files), files };
  };

  const placed = placement.current();
  if (!placed) {
    // Named development pods live in the dev store from their first request.
    const pod = podOn(isDev(env) ? new DevFileStore(sql) : new UnlinkedStore());
    return { pod, sync: null, placement, podIn };
  }
  const { pod, files } = podIn(placed);
  return { pod, sync: new FolderSync(pod, placement, files, SYNC_INTERVAL_MS, () => Date.now()), placement, podIn };
}

function placedStorage(env: Env, sql: SqlRunner, p: Placement): FileStore & FileLister {
  if (p.provider === DEV_PROVIDER && isDev(env)) return new DevFileStore(sql);
  if (p.provider === DROPBOX) return new DropboxFileStore({ fetch: fetcher, root: p.folder, accessToken: accountTokens(env, p) });
  if (p.provider === GOOGLE_DRIVE) return new DriveFileStore({ fetch: fetcher, root: p.folder, accessToken: accountTokens(env, p), nodes: new SqlDriveNodes(sql) });
  throw new StorageUnavailable(`this pod's storage (${p.provider}) is not reachable here`);
}

/** The storage around a placed pod's folder, for deleting that folder whole;
 * null where the pod's files live in the pod's own SQLite. */
export function storageAround(env: Env, p: Placement): FileStore | null {
  if (p.provider === DEV_PROVIDER) return null;
  if (p.provider === DROPBOX) return new DropboxFileStore({ fetch: fetcher, root: '', accessToken: accountTokens(env, p) });
  if (p.provider === GOOGLE_DRIVE) return new DriveFileStore({ fetch: fetcher, root: '', accessToken: accountTokens(env, p), nodes: new MemoryDriveNodes() });
  throw new StorageUnavailable(`this pod's storage (${p.provider}) is not reachable here`);
}

/** Access tokens from the pod's account, kept until shortly before expiry. */
function accountTokens(env: Env, p: Placement): (refresh: boolean) => Promise<string> {
  const account = env.ACCOUNT.get(env.ACCOUNT.idFromName(p.accountKey));
  let current: AccessToken | null = null;
  return async (refresh) => {
    if (refresh || !current || current.expiresAt - Date.now() < 60_000) current = await account.accessToken(p.linkId, refresh);
    return current.token;
  };
}

function requireGoogleClient(env: Env): GoogleClient {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) throw new Error('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are not configured');
  return { id: env.GOOGLE_CLIENT_ID, secret: env.GOOGLE_CLIENT_SECRET };
}

function requireAppKey(env: Env): string {
  if (!env.DROPBOX_APP_KEY) throw new Error('DROPBOX_APP_KEY is not configured');
  return env.DROPBOX_APP_KEY;
}
