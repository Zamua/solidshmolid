// A person's pods: signing up, connecting storage, and adding more pods.
//
// Signing up gives the person a pod id and their WebID; the pod itself exists
// once storage is connected, in its own folder of that storage. Further pods
// belong to the same WebID and are listed in its profile.

import { confirmationSentence, confirmsDeletion, providerDisplayName } from '../../domain/accounts/deletion.js';
import { personName } from '../../domain/accounts/names.js';
import type { StorageAuthorization } from '../storage/ports.js';
import type { AccountRepository, AccountState, Directory, Identities, Ids, Logins, PodRecord, Pods } from './ports.js';

export class NotSignedUp extends Error {}
export class LinkExpired extends Error {}
export class NoStorageYet extends Error {}
export class NotFound extends Error {}
export class HoldsWebid extends Error {}
export class NotConfirmed extends Error {}
export class StorageInUse extends Error {
  constructor(readonly podIds: string[]) {
    super(`this storage still holds ${podIds.length === 1 ? 'a pod' : `${podIds.length} pods`}; delete ${podIds.length === 1 ? 'it' : 'them'} first`);
  }
}

/** A deletion either happened, or waits for the person to type `sentence`. */
export type DeletionStep = { done: true } | { confirm: { token: string; sentence: string } };

export interface AccountsDeps {
  directory: Directory;
  account: (key: string) => AccountRepository;
  pods: Pods;
  identities: Identities;
  logins: Logins;
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
      state = await account.create({ key, webid: this.deps.webidOf(podId), name: null, pods: [{ podId, linkId: null, folder: podId }], links: [] });
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

  /** The person's WebID and the name its profile gives, read from the
   * profile itself (apps may have changed it). */
  async profile(person: string): Promise<{ webid: string; name: string | null }> {
    const state = await this.signedUp(person);
    const first = state.pods[0]!;
    const name = first.linkId ? await this.deps.pods.profileName(first.podId) : state.name;
    if (name !== state.name) await this.deps.account(state.key).setName(name);
    return { webid: state.webid, name };
  }

  /** Sets the name apps read from the person's profile. */
  async rename(person: string, raw: string): Promise<void> {
    const name = personName(raw);
    const state = await this.signedUp(person);
    const first = state.pods[0]!;
    if (!first.linkId) throw new NoStorageYet('connect storage before naming your profile');
    await this.deps.pods.setProfileName(first.podId, state.webid, name);
    await this.deps.account(state.key).setName(name);
  }

  /** Deletes a pod other than the first (which holds the WebID; deleting the
   * account removes it). Its files stay unless `deleteFiles`, which first
   * asks for the typed sentence. */
  async deletePod(person: string, podId: string, deleteFiles: boolean): Promise<DeletionStep> {
    const state = await this.signedUp(person);
    const pod = state.pods.find((p) => p.podId === podId);
    if (!pod) throw new NotFound('no such pod');
    if (pod === state.pods[0]) throw new HoldsWebid('this pod holds your WebID; delete your account to remove it');
    if (deleteFiles && pod.linkId) return this.askToConfirm(state, podId, [pod]);
    await this.removePod(state, pod, false);
    return { done: true };
  }

  /** Deletes the account and every pod. Files stay unless `deleteFiles`,
   * which first asks for the typed sentence. */
  async deleteAccount(person: string, deleteFiles: boolean): Promise<DeletionStep> {
    const state = await this.signedUp(person);
    if (deleteFiles && state.pods.some((p) => p.linkId)) return this.askToConfirm(state, null, state.pods);
    await this.erase(person, state, false);
    return { done: true };
  }

  /** Step two of deleting files: only the exact sentence deletes anything,
   * and any answer uses up the request. */
  async confirmDeletion(person: string, token: string, typed: string): Promise<'pod' | 'account'> {
    const state = await this.signedUp(person);
    const pending = await this.deps.account(state.key).takeDeletion(token);
    if (!pending || !confirmsDeletion(typed, pending.sentence)) throw new NotConfirmed('the sentence did not match; start again and type it exactly');
    if (pending.podId === null) {
      await this.erase(person, state, true);
      return 'account';
    }
    const pod = state.pods.find((p) => p.podId === pending.podId);
    if (!pod) throw new NotFound('no such pod');
    await this.removePod(state, pod, true);
    return 'pod';
  }

  /** Disconnects storage that no pod uses any more. */
  async disconnect(person: string, linkId: string): Promise<AccountState> {
    const state = await this.signedUp(person);
    if (!state.links.some((l) => l.linkId === linkId)) throw new NotFound('no such storage');
    const using = state.pods.filter((p) => p.linkId === linkId).map((p) => p.podId);
    if (using.length > 0) throw new StorageInUse(using);
    const account = this.deps.account(state.key);
    await account.removeLink(linkId);
    return (await account.load())!;
  }

  private async askToConfirm(state: AccountState, podId: string | null, pods: PodRecord[]): Promise<DeletionStep> {
    const providers = [...new Set(pods.map((p) => state.links.find((l) => l.linkId === p.linkId)?.provider).filter((p) => p !== undefined))];
    const sentence = confirmationSentence(providers.map(providerDisplayName).join(' and '));
    const token = this.deps.ids.random();
    await this.deps.account(state.key).rememberDeletion(token, { podId, sentence });
    return { confirm: { token, sentence } };
  }

  private async removePod(state: AccountState, pod: PodRecord, deleteFiles: boolean): Promise<void> {
    if (pod.linkId) await this.deps.pods.dropStorage(state.pods[0]!.podId, state.webid, pod.podId);
    await this.deps.pods.retire(pod.podId, deleteFiles);
    await this.deps.account(state.key).removePod(pod.podId);
    await this.deps.directory.retirePodId(pod.podId);
  }

  private async erase(person: string, state: AccountState, deleteFiles: boolean): Promise<void> {
    for (const pod of [...state.pods].reverse()) {
      await this.deps.pods.retire(pod.podId, deleteFiles);
      await this.deps.directory.retirePodId(pod.podId);
    }
    await this.deps.account(state.key).erase();
    await this.deps.directory.forget(person);
    await this.deps.logins.remove(person);
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
