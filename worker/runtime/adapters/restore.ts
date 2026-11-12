// Point-in-time recovery for a Durable Object's SQLite. The platform keeps
// about thirty days of history; an object returns to a moment in it by naming
// that moment's bookmark and restarting. Everything written after the
// bookmark is discarded, so this is an operator's tool and nothing else's.

/** The part of a Durable Object's storage that recovery uses. */
export interface RecoverableStorage {
  getBookmarkForTime(timestamp: number): Promise<string>;
  onNextSessionRestoreBookmark(bookmark: string): Promise<string>;
}

export class RecoveryRefused extends Error {}

/** How far back the platform keeps history. */
export const HISTORY_MS = 30 * 24 * 60 * 60 * 1000;

/** The bookmark for a moment (milliseconds since the epoch) the history holds. */
export async function bookmarkAt(storage: RecoverableStorage, at: number, now: number): Promise<string> {
  if (!Number.isFinite(at) || at > now) throw new RecoveryRefused('the time to return to is not in the past');
  if (at < now - HISTORY_MS) throw new RecoveryRefused('the time to return to is older than the history kept');
  return storage.getBookmarkForTime(at);
}

/** Has the object return to `bookmark` when it next starts, and restarts it
 * once the answer is on its way. Answers with the bookmark that undoes this. */
export async function restoreTo(storage: RecoverableStorage, bookmark: string, restart: () => void): Promise<string> {
  if (!/^[0-9a-f-]{8,128}$/u.test(bookmark)) throw new RecoveryRefused('that is not a bookmark');
  const undo = await storage.onNextSessionRestoreBookmark(bookmark);
  setTimeout(restart, 0);
  return undo;
}
