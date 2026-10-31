// Accounts over Durable Object RPC: the directory maps a person to an account
// key, and each account key names one AccountObject. The objects' methods
// carry their ports' names, so a stub serves as the port itself.

import type { AccountRepository, Directory, Identities, Placement, Pods } from '../../app/accounts/ports.js';
import type { AccountStore, Accounts, KeyedAccount } from '../../app/identity/ports.js';
import { BadRequest, Forbidden, InsufficientStorage, NotFound, PodError, StorageUnavailable } from '../../app/shared/errors.js';
import { profileDocument } from '../../domain/pods/profile.js';
import type { Env } from '../env.js';
import type { Hosts } from '../hosts.js';
import type { AccountObject } from '../objects/accountObject.js';
import type { DirectoryObject } from '../objects/directoryObject.js';

const ACCOUNT_KEY = /^[0-9a-f]{32}$/u;

export class RpcAccounts implements Accounts {
  constructor(private readonly env: Env) {}

  async forPerson(personId: string): Promise<KeyedAccount> {
    const key = await rpcDirectory(this.env).accountKeyFor(personId);
    const stub = accountStub(this.env, key);
    await stub.ensure(key);
    return { key, store: stub };
  }

  async byKey(key: string): Promise<AccountStore | null> {
    if (!ACCOUNT_KEY.test(key)) return null;
    const stub = accountStub(this.env, key);
    return (await stub.exists()) ? stub : null;
  }
}

function accountStub(env: Env, key: string): DurableObjectStub<AccountObject> {
  return env.ACCOUNT.get(env.ACCOUNT.idFromName(key));
}

/** The one global directory. */
export function rpcDirectory(env: Env): DurableObjectStub<DirectoryObject> & Directory {
  return env.DIRECTORY.get(env.DIRECTORY.idFromName('directory'));
}

export function rpcAccountPods(env: Env, key: string): AccountRepository {
  return accountStub(env, key);
}

export function rpcPods(env: Env, hosts: Hosts): Pods {
  const stub = (podId: string) => env.POD.get(env.POD.idFromName(podId));
  return {
    place: (podId: string, placement: Placement, owner: string, withProfile: boolean) => {
      const base = hosts.podOrigin(podId);
      return stub(podId).place(podId, base, placement, owner, withProfile ? profileDocument(`${base}/`, hosts.issuer) : null);
    },
    declareStorage: (webidPodId: string, owner: string, storagePodId: string) =>
      stub(webidPodId).declareStorage(hosts.podOrigin(webidPodId), owner, `${hosts.podOrigin(storagePodId)}/`),
    dropStorage: (webidPodId: string, owner: string, storagePodId: string) =>
      stub(webidPodId).dropStorage(hosts.podOrigin(webidPodId), owner, `${hosts.podOrigin(storagePodId)}/`),
    retire: (podId: string, deleteFiles: boolean) => stub(podId).retire(hosts.podOrigin(podId), deleteFiles),
    list: (podId: string, owner: string, path: string) => revived(stub(podId).list(hosts.podOrigin(podId), owner, path)),
    open: (podId: string, owner: string, path: string) => revived(stub(podId).readFile(hosts.podOrigin(podId), owner, path)),
  };
}

export function rpcIdentities(env: Env): Identities {
  return {
    bind: async (person, webid) => {
      const key = await rpcDirectory(env).accountKeyFor(person);
      const account = accountStub(env, key);
      await account.ensure(key);
      await account.bindWebid(webid);
    },
  };
}

const POD_ERRORS: Record<string, new (message: string) => PodError> = { NotFound, BadRequest, Forbidden, InsufficientStorage, StorageUnavailable };

/** Durable Object RPC keeps a thrown error's name and message but not its
 * class; callers branch on the class. */
async function revived<T>(call: Promise<T>): Promise<T> {
  try {
    return await call;
  } catch (e) {
    const Class = e instanceof Error ? POD_ERRORS[e.name] : undefined;
    throw Class && !(e instanceof Class) ? new Class((e as Error).message) : e;
  }
}
