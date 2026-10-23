// The provider's ports. Interfaces only.

import type { AuthorizeRequest, ClientInfo, Registration } from '../../domain/identity/oidc.js';

/** What the provider needs to know about one person. */
export interface AccountStore {
  key: string;
  /** The WebID this person signs in as, or null before they have a pod. */
  webid(): Promise<string | null>;
  hasApproval(clientId: string, webid: string): Promise<boolean>;
  approve(clientId: string, clientName: string | null, webid: string): Promise<void>;
  /** Apps the person approved, newest first. */
  approvals(): Promise<Approval[]>;
  /** Removes an app's approval and ends every refresh token it holds. */
  revokeApp(clientId: string): Promise<void>;
  /** A pending consent, so the decision can be checked against what was shown. */
  savePending(id: string, request: AuthorizeRequest, client: ClientInfo, expires: number): Promise<void>;
  takePending(id: string, now: number): Promise<{ request: AuthorizeRequest; client: ClientInfo } | null>;
  saveCode(hash: string, grant: CodeGrant): Promise<void>;
  /** Marks the code used and returns it; a second take returns it with `reused`. */
  takeCode(hash: string): Promise<(CodeGrant & { reused: boolean }) | null>;
  saveFamily(family: RefreshFamily): Promise<void>;
  family(id: string): Promise<RefreshFamily | null>;
  rotateFamily(id: string, newHash: string, expires: number): Promise<void>;
  revokeFamily(id: string): Promise<void>;
  /** Revokes every family that came from a given code. */
  revokeFromCode(codeHash: string): Promise<void>;
}

export interface Approval {
  clientId: string;
  clientName: string | null;
  webid: string;
  /** Unix seconds. */
  approved: number;
}

export interface CodeGrant {
  clientId: string;
  redirectUri: string;
  webid: string;
  codeChallenge: string;
  nonce: string | null;
  scopes: string[];
  expires: number;
}

export interface RefreshFamily {
  id: string;
  clientId: string;
  webid: string;
  jkt: string;
  scopes: string[];
  currentHash: string;
  fromCode: string;
  expires: number;
}

/** Finds a person's provider state. */
export interface Accounts {
  /** The account of a signed-in person (a Clerk user id), created on first use. */
  forPerson(personId: string): Promise<AccountStore>;
  /** The account a code or refresh token names, or null. */
  byKey(key: string): Promise<AccountStore | null>;
}

/** Apps that may ask for sign-in: Client ID Documents, registered clients and
 * the public client. */
export interface ClientRegistry {
  resolve(clientId: string): Promise<ClientInfo>;
  /** Stores a dynamically registered client and returns its id. */
  register(registration: Registration): Promise<string>;
}

export interface TokenSigner {
  sign(claims: Record<string, unknown>): Promise<string>;
}

export interface Clock {
  /** Unix seconds. */
  now(): number;
}

export interface Secrets {
  /** An unguessable token suitable for codes and ids. */
  random(): string;
  /** A one-way hash, so stored codes and refresh tokens are useless if read. */
  hash(secret: string): Promise<string>;
}
