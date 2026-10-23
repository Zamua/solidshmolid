// The households context's ports over Durable Object RPC: the directory, one
// HouseholdObject per household, the pods, and the people's accounts.

import type { Directory, HouseholdRepository, Identities, Placement, Pods } from '../../app/households/ports.js';
import { profileDocument } from '../../domain/pods/profile.js';
import type { Env } from '../env.js';
import type { Hosts } from '../hosts.js';

export function rpcDirectory(env: Env): Directory {
  const stub = env.DIRECTORY.get(env.DIRECTORY.idFromName('directory'));
  return {
    householdOf: (person) => stub.householdOf(person),
    join: (person, householdId) => stub.join(person, householdId),
    allocatePodId: (householdId) => stub.allocatePodId(householdId),
  };
}

export function rpcHousehold(env: Env, id: string): HouseholdRepository {
  const stub = env.HOUSEHOLD.get(env.HOUSEHOLD.idFromName(id));
  return {
    load: () => stub.load(),
    create: (state) => stub.create(state),
    addLink: (link, refreshToken) => stub.addLink(link, refreshToken),
    placePod: (podId, linkId) => stub.placePod(podId, linkId),
    rememberPending: (nonce, pending) => stub.rememberPending(nonce, pending),
    takePending: (nonce) => stub.takePending(nonce),
  };
}

export function rpcPods(env: Env, hosts: Hosts): Pods {
  return {
    place: (podId: string, placement: Placement, owner: string, managers: string[]) => {
      const base = hosts.podOrigin(podId);
      return env.POD.get(env.POD.idFromName(podId)).place(podId, base, placement, owner, profileDocument(`${base}/`, hosts.issuer), managers);
    },
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
