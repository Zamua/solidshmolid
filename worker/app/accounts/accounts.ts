// A person's pods: signing up, connecting storage, and adding more pods.
//
// Signing up gives the person a pod id and their WebID; the pod itself exists
// once storage is connected, in its own folder of that storage. Further pods
// belong to the same WebID and are listed in its profile.

import type { StorageAuthorization } from '../storage/ports.js';
import type { AccountRepository, AccountState, Directory, Identities, Ids, Pods } from './ports.js';

export class NotSignedUp extends Error {}
export class LinkExpired extends Error {}
export class NoStorageYet extends Error {}

export interface AccountsDeps {
  directory: Directory;
  account: (key: string) => AccountRepository;
  pods: Pods;
  identities: Identities;
  authorization: StorageAuthorization;
  ids: Ids;
  /** The WebID of a pod id ('https://<id>.solidshmolid.com/profile/card#me'). */
  webidOf: (podId: string) => string;
}

export class Accounts {
  constructor(private readonly deps: AccountsDeps) {}

  /** The person's account, created with its first pod on first call. Safe to
   * repeat and to race: the account keeps the first record written. */
  async signup(person: string): Promise<AccountState> {
    const key = await this.deps.directory.accountKeyFor(person);
    const account = this.deps.account(key);
    let state = await account.load();
    if (!state) {
      const podId = await this.deps.directory.allocatePodId(key);
      state = await account.create({ key, webid: this.deps.webidOf(podId), pods: [{ podId, linkId: null, folder: podId }], links: [] });
    }
    await this.deps.identities.bind(person, state.webid);
    return state;
  }

  async mine(person: string): Promise<AccountState | null> {
    return this.deps.account(await this.deps.directory.accountKeyFor(person)).load();
  }

  /** Starts connecting storage; returns the provider's consent URL. */
  async beginLink(person: string, redirectUri: string): Promise<string> {
    const state = await this.signedUp(person);
    const { verifier, challenge } = await this.deps.authorization.pkce();
    const nonce = this.deps.ids.random();
    await this.deps.account(state.key).rememberPending(nonce, { verifier });
    return this.deps.authorization.authorizeUrl(redirectUri, `${state.key}.${nonce}`, challenge);
  }

  /** Finishes connecting storage, then places every pod still waiting for
   * storage into its own folder there. Only the account that started the
   * flow may finish it, so a consent link cannot be handed to someone else. */
  async completeLink(person: string, accountKey: string, nonce: string, code: string, redirectUri: string): Promise<AccountState> {
    if ((await this.deps.directory.accountKeyFor(person)) !== accountKey) throw new LinkExpired('this connection attempt expired; start again');
    const account = this.deps.account(accountKey);
    const pending = await account.takePending(nonce);
    if (!pending) throw new LinkExpired('this connection attempt expired; start again');
    const grant = await this.deps.authorization.exchange(code, pending.verifier, redirectUri);
    const linkId = this.deps.ids.random();
    const provider = this.deps.authorization.provider;
    await account.addLink({ linkId, provider, account: grant.accountId }, grant.refreshToken);
    await this.placeWaiting(accountKey, linkId, provider);
    return (await account.load())!;
  }

  /** Adds a pod beside the first one, owned by the same WebID. */
  async addPod(person: string): Promise<AccountState> {
    const state = await this.signedUp(person);
    const first = state.pods[0]!;
    const link = state.links.find((l) => l.linkId === first.linkId);
    if (!link) throw new NoStorageYet('connect storage before adding a pod');
    const podId = await this.deps.directory.allocatePodId(state.key);
    const account = this.deps.account(state.key);
    await account.addPod({ podId, linkId: null, folder: podId });
    await this.placeWaiting(state.key, link.linkId, link.provider);
    await this.deps.pods.declareStorage(first.podId, state.webid, podId);
    return (await account.load())!;
  }

  /** Places every pod still waiting for storage, each in its own folder of
   * `linkId`. The first pod carries the WebID profile. */
  private async placeWaiting(accountKey: string, linkId: string, provider: string): Promise<void> {
    const account = this.deps.account(accountKey);
    const state = (await account.load())!;
    for (const pod of state.pods.filter((p) => p.linkId === null)) {
      const withProfile = pod.podId === state.pods[0]!.podId;
      await this.deps.pods.place(pod.podId, { accountKey, linkId, provider, folder: pod.folder }, state.webid, withProfile);
      await account.placePod(pod.podId, linkId);
    }
  }

  private async signedUp(person: string): Promise<AccountState> {
    const state = await this.mine(person);
    if (!state) throw new NotSignedUp('create your pod first');
    return state;
  }
}
