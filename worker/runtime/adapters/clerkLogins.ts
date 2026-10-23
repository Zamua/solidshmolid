// Clerk behind the Logins port: managed members are username-only Clerk
// users, created and removed through the Backend API.

import { type ClerkClient, createClerkClient } from '@clerk/backend';
import { isClerkAPIResponseError } from '@clerk/backend/errors';
import type { Logins } from '../../app/households/ports.js';
import type { ClerkKeys } from './clerkSessions.js';

export class ClerkLogins implements Logins {
  private readonly clerk: ClerkClient;

  constructor(keys: ClerkKeys) {
    this.clerk = createClerkClient(keys);
  }

  async createManaged(username: string, name: string): Promise<string> {
    const user = await this.clerk.users.createUser({ username, firstName: name, skipPasswordRequirement: true, publicMetadata: { managed: true } });
    return user.id;
  }

  async remove(person: string): Promise<void> {
    try {
      await this.clerk.users.deleteUser(person);
    } catch (e) {
      if (!(isClerkAPIResponseError(e) && e.status === 404)) throw e;
    }
  }

  async nameOf(person: string): Promise<string | null> {
    try {
      const user = await this.clerk.users.getUser(person);
      return user.firstName ?? user.username ?? user.primaryEmailAddress?.emailAddress.split('@')[0] ?? null;
    } catch (e) {
      if (isClerkAPIResponseError(e) && e.status === 404) return null;
      throw e;
    }
  }
}

/** Development stand-in: people are whatever /dev/sign-in says they are. */
export const devLogins: Logins = {
  createManaged: async (username) => `dev-${username}`,
  remove: async () => {},
  nameOf: async (person) => person,
};
