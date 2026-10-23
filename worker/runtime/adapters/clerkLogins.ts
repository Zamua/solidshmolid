// Clerk behind the Logins port: removing a person's sign-in when they delete
// their account.

import { type ClerkClient, createClerkClient } from '@clerk/backend';
import { isClerkAPIResponseError } from '@clerk/backend/errors';
import type { Logins } from '../../app/accounts/ports.js';
import type { ClerkKeys } from './clerkSessions.js';

export class ClerkLogins implements Logins {
  private readonly clerk: ClerkClient;

  constructor(keys: ClerkKeys) {
    this.clerk = createClerkClient(keys);
  }

  async remove(person: string): Promise<void> {
    try {
      await this.clerk.users.deleteUser(person);
    } catch (e) {
      if (!(isClerkAPIResponseError(e) && e.status === 404)) throw e;
    }
  }
}
