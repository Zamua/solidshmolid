// The households context's ports. Interfaces only.

import type { Member } from '../../domain/households/household.js';
import type { PlacementOutcome } from '../storage/ports.js';

/** Where a pod's files live: a folder inside one of the household's links. */
export interface PodPlacement {
  podId: string;
  /** The person whose pod it is. */
  owner: string;
  /** Null until the household has connected storage. */
  linkId: string | null;
  folder: string;
}

export interface LinkSummary {
  linkId: string;
  provider: string;
  account: string;
}

export interface HouseholdState {
  id: string;
  members: Member[];
  pods: PodPlacement[];
  links: LinkSummary[];
}

export interface PendingLink {
  verifier: string;
  person: string;
}

/** One household's records (its HouseholdObject). */
export interface HouseholdRepository {
  load(): Promise<HouseholdState | null>;
  /** Stores `state` unless the household exists; returns what is stored. */
  create(state: HouseholdState): Promise<HouseholdState>;
  /** Adds a member and their pod (waiting for storage) together. */
  addMember(member: Member, pod: PodPlacement): Promise<void>;
  /** Stores a new storage link; the grant stays inside the repository. */
  addLink(link: LinkSummary, refreshToken: string): Promise<void>;
  placePod(podId: string, linkId: string): Promise<void>;
  rememberPending(nonce: string, pending: PendingLink): Promise<void>;
  /** Consumed on read; null when absent or expired. */
  takePending(nonce: string): Promise<PendingLink | null>;
}

/** Service-wide lookups (the directory). */
export interface Directory {
  householdOf(person: string): Promise<string | null>;
  /** Puts `person` in `householdId` unless they are in one already; returns
   * the household they are in. */
  join(person: string, householdId: string): Promise<string>;
  /** A pod id no pod has ever had, now belonging to `householdId`. */
  allocatePodId(householdId: string): Promise<string>;
}

export interface Placement {
  householdId: string;
  linkId: string;
  provider: string;
  folder: string;
}

/** The pods themselves, wherever they run. */
export interface Pods {
  /** Serves the pod from `placement`: creates it in an empty folder, adopts
   * the pod already in a non-empty one. */
  place(podId: string, placement: Placement, owner: string, managers: string[]): Promise<PlacementOutcome>;
}

/** People's sign-ins (the identity service). */
export interface Logins {
  /** A sign-in for a member without email, under a unique username; returns
   * the new person's id. */
  createManaged(username: string, name: string): Promise<string>;
  remove(person: string): Promise<void>;
  /** How the person is called there, when known. */
  nameOf(person: string): Promise<string | null>;
}

/** Which WebID a person signs in to Solid apps as. */
export interface Identities {
  bind(person: string, webid: string): Promise<void>;
}

export interface Ids {
  /** An unguessable id for households, links and nonces. */
  random(): string;
}
