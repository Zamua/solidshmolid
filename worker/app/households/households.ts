// Signing up and connecting storage, for a person and their household.
//
// Signing up gives the person a household they manage and a pod id; the pod
// itself exists once storage is connected, in its own folder of that storage.

import { memberName } from '../../domain/households/household.js';
import type { StorageAuthorization } from '../storage/ports.js';
import type { Directory, HouseholdRepository, HouseholdState, Identities, Ids, Logins, Pods } from './ports.js';

export class NotAManager extends Error {}
export class LinkExpired extends Error {}
export class NoStorageYet extends Error {}

export interface HouseholdsDeps {
  directory: Directory;
  household: (id: string) => HouseholdRepository;
  pods: Pods;
  identities: Identities;
  logins: Logins;
  authorization: StorageAuthorization;
  ids: Ids;
  /** The WebID of a pod id ('https://<id>.solidshmolid.com/profile/card#me'). */
  webidOf: (podId: string) => string;
}

export class Households {
  constructor(private readonly deps: HouseholdsDeps) {}

  /** The person's household, created with them as its manager on first call.
   * Safe to repeat and to race: the directory and the household each keep
   * the first writer's record. */
  async signup(person: string): Promise<HouseholdState> {
    const id = await this.deps.directory.join(person, this.deps.ids.random());
    const household = this.deps.household(id);
    let state = await household.load();
    if (!state) {
      const podId = await this.deps.directory.allocatePodId(id);
      const webid = this.deps.webidOf(podId);
      const name = (await this.deps.logins.nameOf(person)) ?? '';
      state = await household.create({
        id,
        members: [{ clerkUserId: person, role: 'manager', kind: 'adult', name, webid, handle: podId }],
        pods: [{ podId, owner: person, linkId: null, folder: podId }],
        links: [],
      });
    }
    await this.deps.identities.bind(person, memberOf(state, person).webid);
    return state;
  }

  async mine(person: string): Promise<HouseholdState | null> {
    const id = await this.deps.directory.householdOf(person);
    return id ? this.deps.household(id).load() : null;
  }

  /** Starts connecting storage; returns the provider's consent URL. */
  async beginLink(person: string, redirectUri: string): Promise<string> {
    const state = await this.managed(person);
    const { verifier, challenge } = await this.deps.authorization.pkce();
    const nonce = this.deps.ids.random();
    await this.deps.household(state.id).rememberPending(nonce, { verifier, person });
    return this.deps.authorization.authorizeUrl(redirectUri, `${state.id}.${nonce}`, challenge);
  }

  /** Finishes connecting storage, then places every pod still waiting for
   * storage into its own folder there. Only the person who started the flow
   * may finish it, so a consent link cannot be handed to someone else. */
  async completeLink(person: string, householdId: string, nonce: string, code: string, redirectUri: string): Promise<HouseholdState> {
    const household = this.deps.household(householdId);
    const pending = await household.takePending(nonce);
    if (!pending || pending.person !== person) throw new LinkExpired('this connection attempt expired; start again');
    const grant = await this.deps.authorization.exchange(code, pending.verifier, redirectUri);
    const linkId = this.deps.ids.random();
    const provider = this.deps.authorization.provider;
    await household.addLink({ linkId, provider, account: grant.accountId }, grant.refreshToken);

    await this.placeWaiting(householdId, linkId, provider);
    return (await household.load())!;
  }

  /** Adds a member whose login the manager creates (a child): their own
   * WebID and pod, placed beside the manager's own pod. */
  async addManagedMember(manager: string, rawName: string): Promise<HouseholdState> {
    const name = memberName(rawName);
    const state = await this.managed(manager);
    const own = state.pods.find((p) => p.owner === manager);
    const link = state.links.find((l) => l.linkId === own?.linkId);
    if (!link) throw new NoStorageYet('connect storage before adding someone');

    const podId = await this.deps.directory.allocatePodId(state.id);
    const webid = this.deps.webidOf(podId);
    const person = await this.deps.logins.createManaged(`pod-${podId}`, name);
    const household = this.deps.household(state.id);
    try {
      await household.addMember({ clerkUserId: person, role: 'member', kind: 'managed', name, webid, handle: podId }, { podId, owner: person, linkId: null, folder: podId });
    } catch (e) {
      await this.deps.logins.remove(person);
      throw e;
    }
    await this.deps.directory.join(person, state.id);
    await this.deps.identities.bind(person, webid);
    await this.placeWaiting(state.id, link.linkId, link.provider);
    return (await household.load())!;
  }

  /** Places every pod still waiting for storage, each in its own folder of
   * `linkId`, owned by its member and fully open to the managers. */
  private async placeWaiting(householdId: string, linkId: string, provider: string): Promise<void> {
    const household = this.deps.household(householdId);
    const state = (await household.load())!;
    const managers = state.members.filter((m) => m.role === 'manager').map((m) => m.webid);
    for (const pod of state.pods.filter((p) => p.linkId === null)) {
      const owner = memberOf(state, pod.owner).webid;
      await this.deps.pods.place(pod.podId, { householdId, linkId, provider, folder: pod.folder }, owner, managers);
      await household.placePod(pod.podId, linkId);
    }
  }

  private async managed(person: string): Promise<HouseholdState> {
    const state = await this.mine(person);
    if (!state || memberOf(state, person).role !== 'manager') throw new NotAManager('only a household manager can connect storage');
    return state;
  }
}

function memberOf(state: HouseholdState, person: string) {
  const member = state.members.find((m) => m.clerkUserId === person);
  if (!member) throw new NotAManager('not a member of this household');
  return member;
}
