import { describe, expect, it } from 'vitest';
import { Conflict, InsufficientStorage, NotFound, StorageUnavailable } from '../app/shared/errors.js';
import { revived } from '../runtime/adapters/accountRpc.js';

/** What Durable Object RPC delivers of a thrown error: name and message. */
function overRpc(thrown: Error): Promise<never> {
  const plain = new Error(thrown.message);
  plain.name = thrown.name;
  return Promise.reject(plain);
}

describe('errors that crossed Durable Object RPC', () => {
  it('come back as the class callers branch on', async () => {
    for (const Class of [StorageUnavailable, InsufficientStorage, Conflict, NotFound]) {
      const caught = await revived(overRpc(new Class('the Dropbox link was revoked'))).catch((e: unknown) => e);
      expect(caught, Class.name).toBeInstanceOf(Class);
      expect((caught as Error).message).toBe('the Dropbox link was revoked');
    }
  });

  it('leaves other errors and results alone', async () => {
    const bug = new TypeError('x is not a function');
    expect(await revived(Promise.reject(bug)).catch((e: unknown) => e)).toBe(bug);
    expect(await revived(Promise.resolve(7))).toBe(7);
  });
});
