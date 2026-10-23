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
}

/** Service-wide lookups (the directory). */
export interface Directory {
  /** The person's account key, assigned on first sight. */
  accountKeyFor(person: string): Promise<string>;
  /** A pod id no pod has ever had, now belonging to the account. */
  allocatePodId(accountKey: string): Promise<string>;
}

export interface Placement {
  accountKey: string;
  linkId: string;
  provider: string;
  folder: string;
}

/** The pods themselves, wherever they run. */
export interface Pods {
  /** Serves the pod from `placement`: creates it in an empty folder (with a
   * WebID profile when `withProfile`), adopts the pod already in a non-empty one. */
  place(podId: string, placement: Placement, owner: string, withProfile: boolean): Promise<PlacementOutcome>;
  /** Lists `storagePodId` as a storage of the WebID that `webidPodId` holds. */
  declareStorage(webidPodId: string, owner: string, storagePodId: string): Promise<void>;
}

/** Which WebID a person signs in to Solid apps as. */
export interface Identities {
  bind(person: string, webid: string): Promise<void>;
}

export interface Ids {
  /** An unguessable id for links and nonces. */
  random(): string;
}
