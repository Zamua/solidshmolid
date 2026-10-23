// The user's storage, as the pod and storage services see it. Interfaces only.


/** A stored file. `file` is relative to the pod folder, `/`-separated. */
export interface FileInfo {
  file: string;
  /** The storage provider's revision; changes on every write. */
  rev: string;
  size: number;
  modified: string;
}

export interface StoredFile {
  body: ReadableStream<Uint8Array>;
  /** Size of the whole file, not of the range. */
  size: number;
  rev: string;
}

/** Inclusive byte offsets, already resolved against the file size. */
export interface ByteRange {
  start: number;
  end: number;
}

export interface WriteOptions {
  /** Absent: write unconditionally. Null: the file must not exist. A string:
   * the file must be at that revision. */
  ifRev?: string | null;
}

/** The user's storage, rooted at the pod folder. */
export interface FileStore {
  read(file: string, range?: ByteRange): Promise<StoredFile | null>;
  write(file: string, body: ReadableStream<Uint8Array> | Uint8Array, options?: WriteOptions): Promise<FileInfo>;
  /** Removing a missing file succeeds. */
  remove(file: string): Promise<void>;
  /** Creating an existing folder succeeds. */
  makeFolder(folder: string): Promise<void>;
  removeFolder(folder: string): Promise<void>;
}

/** A write's revision precondition failed. */
export class RevisionConflict extends Error {}

/** One entry of a storage listing. Folder paths end in '/'. */
export interface ListedEntry {
  kind: 'file' | 'folder' | 'deleted';
  path: string;
  rev: string | null;
  size: number;
  modified: string | null;
}

export interface Listing {
  entries: ListedEntry[];
  /** Pass to `changes` to get what changed after this listing. */
  cursor: string;
}

/** Storage that can enumerate the pod folder and report later changes. */
export interface FileLister {
  listAll(): Promise<Listing>;
  /** Changes since `cursor`, deletions included. */
  changes(cursor: string): Promise<Listing>;
}

/** A pod's connection to a storage provider. */
export interface StorageLink {
  provider: string;
  account: string;
  /** The long-lived grant; adapters keep it encrypted at rest. */
  refreshToken: string;
  /** Where the provider's change feed was last read. */
  cursor: string | null;
}

/** A link flow in progress, kept until the provider calls back. */
export interface PendingLink {
  verifier: string;
  webid: string;
}

export interface LinkStore {
  current(): Promise<StorageLink | null>;
  save(link: StorageLink): Promise<void>;
  setCursor(cursor: string): Promise<void>;
  remember(nonce: string, pending: PendingLink): Promise<void>;
  /** The pending link for `nonce`, consumed, or null when absent or expired. */
  take(nonce: string): Promise<PendingLink | null>;
}

export interface Grant {
  refreshToken: string;
  accountId: string;
  accessToken: string;
  /** Epoch milliseconds. */
  expiresAt: number;
}

/** A storage provider's OAuth (PKCE, offline access). */
export interface StorageAuthorization {
  readonly provider: string;
  pkce(): Promise<{ verifier: string; challenge: string }>;
  authorizeUrl(redirectUri: string, state: string, challenge: string): string;
  exchange(code: string, verifier: string, redirectUri: string): Promise<Grant>;
}

/** Opens the user's storage for a link. */
export interface StorageOpener {
  open(link: StorageLink, grant?: Grant): FileStore & FileLister;
}
