// The user's storage, as the pod and storage services see it. Interfaces only.

/** A stored file. `file` is relative to the pod folder, `/`-separated. */
export interface FileInfo {
  file: string;
  /** The storage provider's revision: new on every write, and never one this
   * path had before, a file deleted and written again included. */
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
  /** Names that differ only in case are one name here: the storage keeps one
   * spelling and answers to any. */
  readonly mergesCase: boolean;
  read(file: string, range?: ByteRange): Promise<StoredFile | null>;
  write(file: string, body: ReadableStream<Uint8Array> | Uint8Array, options?: WriteOptions): Promise<FileInfo>;
  /** Removing a missing file succeeds. */
  remove(file: string): Promise<void>;
  /** Creating an existing folder succeeds. */
  makeFolder(folder: string): Promise<void>;
  removeFolder(folder: string): Promise<void>;
  /** The names of what a folder holds directly, files and folders alike;
   * none for a folder that is not there. */
  namesIn(folder: string): Promise<string[]>;
}

/** A write's revision precondition failed. */
export class RevisionConflict extends Error {}

/** One entry of a storage listing. Folder paths end in '/'. */
export interface FileEntry {
  kind: 'file';
  path: string;
  rev: string;
  size: number;
  modified: string | null;
}

/** A folder's path ends in '/'; a deleted entry's never does. */
export type ListedEntry = FileEntry | { kind: 'folder'; path: string } | { kind: 'deleted'; path: string };

export interface Listing {
  entries: ListedEntry[];
  /** Pass to `changes` to get what changed after this listing. */
  cursor: string;
}

/** Storage that can enumerate the pod folder and report later changes. */
export interface FileLister {
  listAll(): Promise<Listing>;
  /** Changes since `cursor`, deletions included. Throws `CursorLost` when
   * the storage can no longer say what changed since then. */
  changes(cursor: string): Promise<Listing>;
}

/** The change feed cannot be continued from a cursor: only a fresh listing
 * says what the folder holds now. */
export class CursorLost extends Error {}

/** Placing a pod in a folder either starts a new pod or adopts the one there. */
export type PlacementOutcome = 'created' | 'adopted';

/** A pod's folder in one of its account's storage links. */
export interface Placement {
  accountKey: string;
  linkId: string;
  provider: string;
  folder: string;
}

/** A pod's place in storage: not yet given one, being written into `target`,
 * or in it with the change feed read up to `cursor`. */
export type PodPlacement =
  | { state: 'unplaced' }
  | { state: 'placing'; target: Placement }
  | { state: 'placed'; target: Placement; cursor: string };

/** The pod's own record of its placement. */
export interface PlacementStore {
  current(): PodPlacement;
  save(placement: PodPlacement): void;
}

export interface Grant {
  refreshToken: string;
  accountId: string;
  accessToken: string;
  /** Epoch milliseconds. */
  expiresAt: number;
}

/** The provider would not give or renew a grant: consent was cut short,
 * the code was bad, or the person took the app's access away. `gone` says
 * the provider named the grant itself as no longer good, so asking again
 * with it will not help; only the person connecting again will. */
export class GrantRefused extends Error {
  constructor(
    message: string,
    readonly gone = false,
  ) {
    super(message);
  }
}

/** A storage provider's OAuth (PKCE, offline access). */
export interface StorageAuthorization {
  readonly provider: string;
  pkce(): Promise<{ verifier: string; challenge: string }>;
  authorizeUrl(redirectUri: string, state: string, challenge: string): string;
  exchange(code: string, verifier: string, redirectUri: string): Promise<Grant>;
}
