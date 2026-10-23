// Accounts over Durable Object RPC: the directory maps a person to an account
// key, and each account key names one AccountObject.

import type { AccountRepository, Directory, Identities, Placement, Pods } from '../../app/accounts/ports.js';
import type { AccountStore, Accounts } from '../../app/identity/ports.js';
import { BadRequest, Forbidden, InsufficientStorage, NotFound, PodError, StorageUnavailable } from '../../app/shared/errors.js';
import { profileDocument } from '../../domain/pods/profile.js';
import type { Env } from '../env.js';
import type { Hosts } from '../hosts.js';
import type { AccountObject } from '../objects/accountObject.js';

const ACCOUNT_KEY = /^[0-9a-f]{32}$/u;

export class RpcAccounts implements Accounts {
  constructor(private readonly env: Env) {}

  async forPerson(personId: string): Promise<AccountStore> {
    const key = await this.env.DIRECTORY.get(this.env.DIRECTORY.idFromName('directory')).accountKeyFor(personId);
    const stub = this.stub(key);
    await stub.ensure(key);
    return accountStore(stub, key);
  }

  async byKey(key: string): Promise<AccountStore | null> {
    if (!ACCOUNT_KEY.test(key)) return null;
    const stub = this.stub(key);
    return (await stub.exists()) ? accountStore(stub, key) : null;
  }

  private stub(key: string): DurableObjectStub<AccountObject> {
    return this.env.ACCOUNT.get(this.env.ACCOUNT.idFromName(key));
  }
}

function accountStore(stub: DurableObjectStub<AccountObject>, key: string): AccountStore {
  return {
    key,
    webid: () => stub.webid(),
    hasApproval: (clientId, webid) => stub.hasApproval(clientId, webid),
    approve: (client, webid) => stub.approve(client, webid),
    approvals: () => stub.approvals(),
    revokeApp: (clientId) => stub.revokeApp(clientId),
    savePending: (id, request, client, expires) => stub.savePending(id, request, client, expires),
    takePending: (id, now) => stub.takePending(id, now),
    saveCode: (hash, grant) => stub.saveCode(hash, grant),
    takeCode: (hash) => stub.takeCode(hash),
    saveFamily: (family) => stub.saveFamily(family),
    family: (id) => stub.family(id),
    rotateFamily: (id, fromHash, newHash, expires) => stub.rotateFamily(id, fromHash, newHash, expires),
    revokeFamily: (id) => stub.revokeFamily(id),
    revokeFromCode: (hash) => stub.revokeFromCode(hash),
  };
}

/** The accounts context's ports over Durable Object RPC. */
export function rpcDirectory(env: Env): Directory {
  const stub = env.DIRECTORY.get(env.DIRECTORY.idFromName('directory'));
  return {
    accountKeyFor: (person) => stub.accountKeyFor(person),
    allocatePodId: (accountKey) => stub.allocatePodId(accountKey),
    retirePodId: (podId) => stub.retirePodId(podId),
    forget: (person) => stub.forget(person),
  };
}

export function rpcAccountPods(env: Env, key: string): AccountRepository {
  const stub = env.ACCOUNT.get(env.ACCOUNT.idFromName(key));
  return {
    load: () => stub.loadPods(),
    create: async (state) => {
      await stub.ensure(key);
      return stub.createPods(state);
    },
    addPod: (pod) => stub.addPod(pod),
    addLink: (link, refreshToken) => stub.addLink(link, refreshToken),
    placePod: (podId, linkId) => stub.placePod(podId, linkId),
    rememberPending: (nonce, pending) => stub.rememberLinkPending(nonce, pending),
    takePending: (nonce) => stub.takeLinkPending(nonce),
    rememberDeletion: (token, pending) => stub.rememberDeletion(token, pending),
    takeDeletion: (token) => stub.takeDeletion(token),
    removePod: (podId) => stub.removePod(podId),
    removeLink: (linkId) => stub.removeLink(linkId),
    erase: () => stub.erase(),
  };
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
      const key = await env.DIRECTORY.get(env.DIRECTORY.idFromName('directory')).accountKeyFor(person);
      const account = env.ACCOUNT.get(env.ACCOUNT.idFromName(key));
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
