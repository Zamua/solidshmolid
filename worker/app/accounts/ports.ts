// The accounts context's ports. Interfaces only.

import type { PlacementOutcome } from '../storage/ports.js';

/** One of the person's pods: a folder inside one of their storage links. */
export interface PodRecord {
  podId: string;
  /** Null until storage is connected. */
  linkId: string | null;
  folder: string;
}

export interface LinkSummary {
  linkId: string;
  provider: string;
  account: string;
}

/** A person's account: their WebID, which lives in their first pod, every
 * pod they have, and the storage those pods live in. */
export interface AccountState {
  key: string;
  webid: string;
  pods: PodRecord[];
  links: LinkSummary[];
}

export interface PendingLink {
  verifier: string;
  /** The provider the flow started with; its callback alone may finish it. */
  provider: string;
  /** Finishing it also adds a pod in the new storage. */
  newPod: boolean;
}

/** A deletion waiting for its typed confirmation. */
export interface PendingDeletion {
  /** A pod id, or null for the whole account. */
  podId: string | null;
  sentence: string;
}

/** One account's records (its AccountObject). */
export interface AccountRepository {
  load(): Promise<AccountState | null>;
  /** Stores `state` unless the account has pods already; returns what is stored. */
  create(state: AccountState): Promise<AccountState>;
  addPod(pod: PodRecord): Promise<void>;
  /** Stores a new storage link; the grant stays inside the repository. */
  addLink(link: LinkSummary, refreshToken: string): Promise<void>;
  placePod(podId: string, linkId: string): Promise<void>;
  rememberPending(nonce: string, pending: PendingLink): Promise<void>;
  /** Consumed on read; null when absent or expired. */
  takePending(nonce: string): Promise<PendingLink | null>;
  rememberDeletion(token: string, pending: PendingDeletion): Promise<void>;
  /** Consumed on read; null when absent or expired. */
  takeDeletion(token: string): Promise<PendingDeletion | null>;
  removePod(podId: string): Promise<void>;
  /** Removes the link and gives up its grant with the provider. */
  removeLink(linkId: string): Promise<void>;
  /** Removes everything the account holds, provider state included; grants
   * are given up with their providers first. */
  erase(): Promise<void>;
}

/** Service-wide lookups (the directory). */
export interface Directory {
  /** The person's account key, assigned on first sight. */
  accountKeyFor(person: string): Promise<string>;
  /** A pod id no pod has ever had, now belonging to the account. */
  allocatePodId(accountKey: string): Promise<string>;
  /** Marks a pod id deleted; it is never handed out again. */
  retirePodId(podId: string): Promise<void>;
  /** Forgets the person's account key. */
  forget(person: string): Promise<void>;
}

export interface Placement {
  accountKey: string;
  linkId: string;
  provider: string;
  folder: string;
}

/** One entry of a folder, for people browsing a pod. */
export interface FileEntry {
  path: string;
  kind: 'container' | 'document';
  contentType: string | null;
  size: number;
  modified: string;
}

export interface FileContent {
  body: ReadableStream<Uint8Array>;
  contentType: string;
  size: number | null;
}

/** The pods themselves, wherever they run. */
export interface Pods {
  /** Serves the pod from `placement`: creates it in an empty folder (with a
   * WebID profile when `withProfile`), adopts the pod already in a non-empty one. */
  place(podId: string, placement: Placement, owner: string, withProfile: boolean): Promise<PlacementOutcome>;
  /** Lists `storagePodId` as a storage of the WebID that `webidPodId` holds. */
  declareStorage(webidPodId: string, owner: string, storagePodId: string): Promise<void>;
  /** Takes `storagePodId` out of that list. */
  dropStorage(webidPodId: string, owner: string, storagePodId: string): Promise<void>;
  /** A folder's entries, read as `owner`. */
  list(podId: string, owner: string, path: string): Promise<FileEntry[]>;
  /** A file's content, read as `owner`. */
  open(podId: string, owner: string, path: string): Promise<FileContent>;
  /** Stops serving the pod; with `deleteFiles`, also deletes its folder. */
  retire(podId: string, deleteFiles: boolean): Promise<void>;
}

/** People's sign-ins (the identity service). */
export interface Logins {
  remove(person: string): Promise<void>;
}

/** Which WebID a person signs in to Solid apps as. */
export interface Identities {
  bind(person: string, webid: string): Promise<void>;
}

export interface Ids {
  /** An unguessable id for links and nonces. */
  random(): string;
}
