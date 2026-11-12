// Apps that ask for sign-in. A URL client id is a Client ID Document fetched
// over the network (time-boxed, size-capped: the URL is the client's choice);
// `reg_` ids were registered dynamically and live in the directory.

import type { ClientRegistry } from '../../app/identity/ports.js';
import { type ClientInfo, OidcError, PUBLIC_CLIENT, type Registration, clientFromDocument, publicClient } from '../../domain/identity/oidc.js';
import type { DirectoryObject } from '../objects/directoryObject.js';
import { type Fetch, limitedText } from './http.js';

const DOC_LIMIT = 64 * 1024;
const TIMEOUT_MS = 5000;
const REGISTERED = 'reg_';
/** A document that could not be used is not fetched again this soon, however often it is named. */
const RETRY_MS = 60_000;
const FAILURES = 256;
/** Shared across requests: a registry is built for each one. */
const failures = new Map<string, { at: number; error: OidcError }>();

export class HttpClientRegistry implements ClientRegistry {
  constructor(
    private readonly directory: DurableObjectStub<DirectoryObject>,
    private readonly fetcher: Fetch,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async resolve(clientId: string): Promise<ClientInfo> {
    if (clientId === PUBLIC_CLIENT) return publicClient();
    if (clientId.startsWith(REGISTERED)) {
      const doc = await this.directory.registeredClient(clientId);
      if (!doc) throw new OidcError('invalid_client', 'unknown client');
      return clientFromDocument(clientId, doc);
    }
    if (!/^https:\/\//u.test(clientId) && !/^http:\/\/(localhost|127\.0\.0\.1)[:/]/u.test(clientId)) {
      throw new OidcError('invalid_client', 'client_id must be an https URL');
    }
    const failed = failures.get(clientId);
    if (failed && this.now() - failed.at < RETRY_MS) throw failed.error;
    try {
      const client = clientFromDocument(clientId, await this.fetchDocument(clientId));
      failures.delete(clientId);
      return client;
    } catch (e) {
      if (e instanceof OidcError) {
        failures.delete(clientId);
        if (failures.size >= FAILURES) failures.delete(failures.keys().next().value!);
        failures.set(clientId, { at: this.now(), error: e });
      }
      throw e;
    }
  }

  register(registration: Registration): Promise<string> {
    return this.directory.registerClient(registration as unknown as Record<string, unknown>);
  }

  async signedIn(clientId: string): Promise<void> {
    if (clientId.startsWith(REGISTERED)) await this.directory.clientSignedIn(clientId);
  }

  private async fetchDocument(url: string): Promise<unknown> {
    let res: Response;
    try {
      // No redirects: the document must live at the URL the client named.
      res = await this.fetcher(url, { headers: { Accept: 'application/ld+json, application/json' }, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch {
      throw new OidcError('invalid_client', 'client document could not be reached');
    }
    // What the URL answered is not the caller's to learn; that it is no client document is.
    if (!res.ok) throw new OidcError('invalid_client', 'client document could not be read');
    const text = await limitedText(res, DOC_LIMIT, () => new OidcError('invalid_client', 'client document is too large'));
    try {
      return JSON.parse(text);
    } catch {
      throw new OidcError('invalid_client', 'client document is not JSON');
    }
  }
}
