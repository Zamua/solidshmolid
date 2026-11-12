import { describe, expect, it } from 'vitest';
import { HISTORY_MS, RecoveryRefused, bookmarkAt, restoreTo } from '../runtime/adapters/restore.js';
import { SqlDirectory } from '../runtime/adapters/sqlDirectory.js';
import { sqlRunner } from './support/fakes.js';

const NOW = Date.parse('2026-11-12T12:00:00Z');
const storage = () => {
  const calls: string[] = [];
  return {
    calls,
    getBookmarkForTime: async (at: number) => (calls.push(`at ${at}`), '0000007b-0000b26e-00001538-0c3e87bb37b3db5cc52eedb93cd3b96b'),
    onNextSessionRestoreBookmark: async (bookmark: string) => (calls.push(`restore ${bookmark}`), '0000007c-00000000-00001538-aaaa'),
  };
};

describe('point-in-time recovery', () => {
  it('names a bookmark only for a moment the history holds', async () => {
    const s = storage();
    expect(await bookmarkAt(s, NOW - 1000, NOW)).toMatch(/^0000007b/u);
    await expect(bookmarkAt(s, NOW + 1, NOW)).rejects.toThrow(RecoveryRefused);
    await expect(bookmarkAt(s, NOW - HISTORY_MS - 1, NOW)).rejects.toThrow(RecoveryRefused);
    await expect(bookmarkAt(s, Number.NaN, NOW)).rejects.toThrow(RecoveryRefused);
    expect(s.calls).toEqual([`at ${NOW - 1000}`]);
  });

  it('answers with the way back before the object restarts', async () => {
    const s = storage();
    let restarted = false;
    const undo = await restoreTo(s, '0000007b-0000b26e-00001538-0c3e87bb37b3db5cc52eedb93cd3b96b', () => void (restarted = true));
    expect([undo, restarted]).toEqual(['0000007c-00000000-00001538-aaaa', false]);
    await new Promise((r) => setTimeout(r, 5));
    expect(restarted).toBe(true);
  });

  it('refuses what is not a bookmark, and restarts nothing', async () => {
    const s = storage();
    let restarted = false;
    await expect(restoreTo(s, 'yesterday; DROP', () => void (restarted = true))).rejects.toThrow(RecoveryRefused);
    await new Promise((r) => setTimeout(r, 5));
    expect([s.calls, restarted]).toEqual([[], false]);
  });
});

describe('the directory export', () => {
  it('holds who has which account and every pod id, and no registered client', async () => {
    const directory = new SqlDirectory(sqlRunner());
    const key = directory.accountKeyFor('person-hash-1');
    const pod = directory.allocatePodId(key);
    const retired = directory.allocatePodId(key);
    directory.retirePodId(retired);
    directory.registerClient({ redirect_uris: ['https://app.example/cb'] });
    const out = directory.export();
    expect(out.people).toEqual([{ person: 'person-hash-1', accountKey: key }]);
    expect(out.podIds.map((p) => [p.podId, p.accountKey, p.state]).sort()).toEqual([[pod, key, out.podIds.find((p) => p.podId === pod)!.state], [retired, key, out.podIds.find((p) => p.podId === retired)!.state]].sort());
    expect(new Set(out.podIds.map((p) => p.state)).size).toBe(2);
    expect(JSON.stringify(out)).not.toContain('app.example');
  });
});
