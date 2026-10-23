// The composition root: the one place that chooses adapters and builds the
// application services from the environment. Everything else receives what it
// needs from here.

import { Provider } from '../app/identity/provider.js';
import { Pod } from '../app/pods/pod.js';
import { FolderSync, StorageLinking } from '../app/storage/linking.js';
import type { FileStore } from '../app/storage/ports.js';
import { DevFileStore } from './adapters/devFiles.js';
import { DropboxAuthorization } from './adapters/dropboxOAuth.js';
import { DropboxOpener } from './adapters/dropboxStorage.js';
import type { SqlRunner } from './adapters/sql.js';
import { SqlIndex } from './adapters/sqlPodIndex.js';
import { StorageLinks } from './adapters/storageLinks.js';
import { UnlinkedStore } from './adapters/unlinked.js';
import { RpcAccounts } from './adapters/accountRpc.js';
import { HttpClientRegistry } from './adapters/clientRegistry.js';
import { type Sessions, devSessions, noSessions } from './adapters/sessions.js';
import { SolidOidcVerifier } from './adapters/solidOidcVerifier.js';
import { systemClock, webCryptoSecrets } from './adapters/system.js';
import { type Signer, signerFromJwk } from './adapters/tokenSigner.js';
import type { Env } from './env.js';

// Module scope, so keys, JWKS and WebID lookups are cached across requests in
// one isolate. An eviction costs a rebuild, never a failure.
let signer: Signer | null = null;
let verifier: SolidOidcVerifier | null = null;

export function isDev(env: Env): boolean {
  return env.DEV_MODE === '1';
}

export async function tokenSigner(env: Env): Promise<Signer> {
  if (!env.OIDC_SIGNING_JWK) throw new Error('OIDC_SIGNING_JWK is not configured');
  signer ??= await signerFromJwk(JSON.parse(env.OIDC_SIGNING_JWK));
  return signer;
}

export function tokenVerifier(): SolidOidcVerifier {
  verifier ??= new SolidOidcVerifier({ fetch: (input, init) => fetch(input, init), now: () => Date.now() });
  return verifier;
}

export function directory(env: Env) {
  return env.DIRECTORY.get(env.DIRECTORY.idFromName('directory'));
}

export async function provider(env: Env, issuer: string): Promise<Provider> {
  return new Provider({
    issuer,
    accounts: new RpcAccounts(env),
    clients: new HttpClientRegistry(directory(env), (input, init) => fetch(input, init)),
    signer: await tokenSigner(env),
    clock: systemClock,
    secrets: webCryptoSecrets,
  });
}

export function sessions(env: Env): Sessions {
  return isDev(env) ? devSessions : noSessions;
}

/** A pod's services, wired to the storage it currently lives in. */
export interface PodServices {
  pod: Pod;
  /** Present once the pod is linked to a provider with a change feed. */
  sync: FolderSync | null;
  /** Built on demand: only the link flow needs it. */
  linking: () => StorageLinking;
}

const SYNC_INTERVAL_MS = 30_000;

export async function podServices(env: Env, storage: DurableObjectStorage, handle: string, base: string): Promise<PodServices> {
  const sql = storage.sql as SqlRunner;
  const index = new SqlIndex(sql, (fn) => storage.transactionSync(fn));
  const links = new StorageLinks(sql, env.TOKEN_KEY, handle);
  const podOn = (files: FileStore) =>
    new Pod({ index, files, base, now: () => new Date(), newId: () => crypto.randomUUID().replaceAll('-', '') });

  const link = await links.current();
  const linked = link?.provider === 'dropbox' ? dropboxOpener(env).open(link) : null;
  const files: FileStore = linked ?? (isDev(env) && env.STORAGE === 'dev' ? new DevFileStore(sql) : new UnlinkedStore());
  const pod = podOn(files);

  return {
    pod,
    sync: linked ? new FolderSync(pod, links, linked, SYNC_INTERVAL_MS, () => Date.now()) : null,
    linking: () =>
      new StorageLinking({
        pod,
        podOn,
        index,
        current: files,
        links,
        authorization: new DropboxAuthorization(requireAppKey(env), (input, init) => fetch(input, init)),
        opener: dropboxOpener(env),
        newNonce: () => crypto.randomUUID().replaceAll('-', ''),
      }),
  };
}

function dropboxOpener(env: Env): DropboxOpener {
  return new DropboxOpener(requireAppKey(env), (input, init) => fetch(input, init));
}

function requireAppKey(env: Env): string {
  if (!env.DROPBOX_APP_KEY) throw new Error('DROPBOX_APP_KEY is not configured');
  return env.DROPBOX_APP_KEY;
}
