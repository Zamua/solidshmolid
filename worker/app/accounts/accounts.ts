// A person's pods: signing up, connecting storage, and adding more pods.
//
// Signing up gives the person a pod id and their WebID; the pod itself exists
// once storage is connected, in its own folder of that storage. Further pods
// belong to the same WebID and are listed in its profile.

import { confirmationSentence, confirmsDeletion, providerDisplayName } from '../../domain/accounts/deletion.js';
import type { StorageAuthorization } from '../storage/ports.js';
import type { AccountRepository, AccountState, Directory, FileContent, FileEntry, Identities, Ids, Logins, PodRecord, Pods } from './ports.js';

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

/** What typing the sentence did: deleted, or asks again under a new token. */
export type Confirmation = { deleted: 'pod' | 'account' } | { retry: { token: string; sentence: string } };

export interface AccountsDeps {
  directory: Directory;
  account: (key: string) => AccountRepository;
  pods: Pods;
  identities: Identities;
  logins: Logins;
  /** The providers people may connect, by name. */
  authorizations: Record<string, StorageAuthorization>;
  ids: Ids;
  /** The WebID of a pod id ('https://<id>.pods.example/profile/card#me'). */
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

  /** Starts connecting storage at `provider`; returns its consent URL.
   * With `newPod`, finishing it also adds a pod there. */
  async beginLink(person: string, provider: string, redirectUri: string, newPod = false): Promise<string> {
    const authorization = this.authorization(provider);
    const state = await this.signedUp(person);
    const { verifier, challenge } = await authorization.pkce();
    const nonce = this.deps.ids.random();
    await this.deps.account(state.key).rememberLinkPending(nonce, { verifier, provider, newPod });
    return authorization.authorizeUrl(redirectUri, `${state.key}.${nonce}`, challenge);
  }

  /** Finishes connecting storage, then places every pod still waiting for
   * storage into its own folder there. Only the account that started the
   * flow may finish it, so a consent link cannot be handed to someone else. */
  async completeLink(person: string, provider: string, accountKey: string, nonce: string, code: string, redirectUri: string): Promise<AccountState> {
    const authorization = this.authorization(provider);
    if ((await this.deps.directory.accountKeyFor(person)) !== accountKey) throw new LinkExpired('this connection attempt expired; start again');
    const account = this.deps.account(accountKey);
    const pending = await account.takeLinkPending(nonce);
    if (!pending || pending.provider !== provider) throw new LinkExpired('this connection attempt expired; start again');
    const grant = await authorization.exchange(code, pending.verifier, redirectUri);
    const linkId = this.deps.ids.random();
    await account.addLink({ linkId, provider, account: grant.accountId }, grant.refreshToken);
    await this.placeWaiting(accountKey, linkId, provider);
    const state = (await account.load())!;
    return pending.newPod ? this.newPodIn(state, { linkId, provider }) : state;
  }

  /** Adds a pod beside the first one, owned by the same WebID, in the
   * storage `linkId` names; the first pod's storage by default. */
  async addPod(person: string, linkId: string | null = null): Promise<AccountState> {
    const state = await this.signedUp(person);
    const link = state.links.find((l) => l.linkId === (linkId ?? state.pods[0]!.linkId));
    if (!link) throw linkId ? new NotFound('no such storage') : new NoStorageYet('connect storage before adding a pod');
    return this.newPodIn(state, link);
  }

  /** A folder of one of the person's pods. */
  async files(person: string, podId: string, path: string): Promise<FileEntry[]> {
    const state = await this.ownPlaced(person, podId);
    return this.deps.pods.list(podId, state.webid, path);
  }

  /** A file of one of the person's pods. */
  async file(person: string, podId: string, path: string): Promise<FileContent> {
    const state = await this.ownPlaced(person, podId);
    return this.deps.pods.open(podId, state.webid, path);
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
  async confirmDeletion(person: string, token: string, typed: string): Promise<Confirmation> {
    const state = await this.signedUp(person);
    const account = this.deps.account(state.key);
    const pending = await account.takeDeletion(token);
    if (!pending) throw new NotConfirmed('this confirmation expired; start again');
    if (!confirmsDeletion(typed, pending.sentence)) {
      // Every answer uses its token up; a wrong one gets a fresh try.
      const retry = this.deps.ids.random();
      await account.rememberDeletion(retry, pending);
      return { retry: { token: retry, sentence: pending.sentence } };
    }
    if (pending.podId === null) {
      await this.erase(person, state, true);
      return { deleted: 'account' };
    }
    const pod = state.pods.find((p) => p.podId === pending.podId);
    if (!pod) throw new NotFound('no such pod');
    await this.removePod(state, pod, true);
    return { deleted: 'pod' };
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

  private authorization(provider: string): StorageAuthorization {
    const authorization = this.deps.authorizations[provider];
    if (!authorization) throw new NotFound(`${provider} is not storage this service connects`);
    return authorization;
  }

  /** A new pod in `link`, listed in the WebID's profile beside the first. */
  private async newPodIn(state: AccountState, link: { linkId: string; provider: string }): Promise<AccountState> {
    const podId = await this.deps.directory.allocatePodId(state.key);
    const account = this.deps.account(state.key);
    await account.addPod({ podId, linkId: null, folder: podId });
    await this.placeWaiting(state.key, link.linkId, link.provider);
    await this.deps.pods.declareStorage(state.pods[0]!.podId, state.webid, podId);
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

  /** The account, when `podId` is one of its pods and has storage. */
  private async ownPlaced(person: string, podId: string): Promise<AccountState> {
    const state = await this.signedUp(person);
    const pod = state.pods.find((p) => p.podId === podId);
    if (!pod) throw new NotFound('no such pod');
    if (!pod.linkId) throw new NoStorageYet('this pod is waiting for storage');
    return state;
  }

  private async signedUp(person: string): Promise<AccountState> {
    const state = await this.mine(person);
    if (!state) throw new NotSignedUp('create your pod first');
    return state;
  }
}
