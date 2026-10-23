// The composition root: the one place that chooses adapters and builds the
// application services from the environment. Everything else receives what it
// needs from here.

import { Households } from '../app/households/households.js';
import type { Placement } from '../app/households/ports.js';
import { Provider } from '../app/identity/provider.js';
import { Pod } from '../app/pods/pod.js';
import { StorageUnavailable } from '../app/shared/errors.js';
import type { FileLister, FileStore, StorageAuthorization } from '../app/storage/ports.js';
import { FolderSync } from '../app/storage/sync.js';
import { RpcAccounts } from './adapters/accountRpc.js';
import { HttpClientRegistry } from './adapters/clientRegistry.js';
import { DevFileStore } from './adapters/devFiles.js';
import { DEV_PROVIDER, devAuthorization, devRefresher } from './adapters/devStorage.js';
import { DropboxFileStore } from './adapters/dropbox.js';
import { DropboxAuthorization, refreshAccess } from './adapters/dropboxOAuth.js';
import { rpcDirectory, rpcHousehold, rpcIdentities, rpcPods } from './adapters/householdRpc.js';
import type { AccessToken, Refresher } from './adapters/linkTokens.js';
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
import type { ClerkChrome } from './http/clerkChrome.js';

// Module scope, so keys, JWKS and WebID lookups are cached across requests in
// one isolate. An eviction costs a rebuild, never a failure.
let signer: Signer | null = null;
let verifier: SolidOidcVerifier | null = null;

const fetcher = (input: string, init?: RequestInit) => fetch(input, init);
const randomId = () => crypto.randomUUID().replaceAll('-', '');

export function isDev(env: Env): boolean {
  return env.DEV_MODE === '1';
}

export async function tokenSigner(env: Env): Promise<Signer> {
  if (!env.OIDC_SIGNING_JWK) throw new Error('OIDC_SIGNING_JWK is not configured');
  signer ??= await signerFromJwk(JSON.parse(env.OIDC_SIGNING_JWK));
  return signer;
}

export function tokenVerifier(): SolidOidcVerifier {
  verifier ??= new SolidOidcVerifier({ fetch: fetcher, now: () => Date.now() });
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

/** The provider households connect their storage to. */
export function storageAuthorization(env: Env): StorageAuthorization {
  if (env.STORAGE === DEV_PROVIDER && isDev(env)) return devAuthorization;
  if (env.STORAGE === 'dropbox') return new DropboxAuthorization(requireAppKey(env), fetcher);
  throw new Error(`STORAGE=${env.STORAGE} is not a provider this deployment can connect`);
}

/** How a household mints access tokens for each provider it may hold. */
export function storageRefreshers(env: Env): Record<string, Refresher> {
  const refreshers: Record<string, Refresher> = {};
  if (env.DROPBOX_APP_KEY) {
    const appKey = env.DROPBOX_APP_KEY;
    refreshers.dropbox = async (refreshToken) => {
      const fresh = await refreshAccess(fetcher, appKey, refreshToken, Date.now());
      return { token: fresh.accessToken, expiresAt: fresh.expiresAt };
    };
  }
  if (isDev(env)) refreshers[DEV_PROVIDER] = devRefresher;
  return refreshers;
}

export function households(env: Env, hosts: Hosts): Households {
  return new Households({
    directory: rpcDirectory(env),
    household: (id) => rpcHousehold(env, id),
    pods: rpcPods(env, hosts),
    identities: rpcIdentities(env),
    authorization: storageAuthorization(env),
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
  if (p.provider === 'dropbox') return new DropboxFileStore({ fetch: fetcher, root: p.folder, accessToken: householdTokens(env, p) });
  throw new StorageUnavailable(`this pod's storage (${p.provider}) is not reachable here`);
}

/** Access tokens from the pod's household, kept until shortly before expiry. */
function householdTokens(env: Env, p: Placement): (refresh: boolean) => Promise<string> {
  const household = env.HOUSEHOLD.get(env.HOUSEHOLD.idFromName(p.householdId));
  let current: AccessToken | null = null;
  return async (refresh) => {
    if (refresh || !current || current.expiresAt - Date.now() < 60_000) current = await household.accessToken(p.linkId, refresh);
    return current.token;
  };
}

function requireAppKey(env: Env): string {
  if (!env.DROPBOX_APP_KEY) throw new Error('DROPBOX_APP_KEY is not configured');
  return env.DROPBOX_APP_KEY;
}
