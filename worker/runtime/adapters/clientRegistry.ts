// Apps that ask for sign-in. A URL client id is a Client ID Document fetched
// over the network (time-boxed, size-capped: the URL is the client's choice);
// `reg_` ids were registered dynamically and live in the directory.

import type { ClientRegistry } from '../../app/identity/ports.js';
import { type ClientInfo, OidcError, PUBLIC_CLIENT, type Registration, clientFromDocument, publicClient } from '../../domain/identity/oidc.js';
import type { DirectoryObject } from '../objects/directoryObject.js';

const DOC_LIMIT = 64 * 1024;
const TIMEOUT_MS = 5000;
const REGISTERED = 'reg_';

export class HttpClientRegistry implements ClientRegistry {
  constructor(
    private readonly directory: DurableObjectStub<DirectoryObject>,
    private readonly fetcher: (input: string, init?: RequestInit) => Promise<Response>,
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
    return clientFromDocument(clientId, await this.fetchDocument(clientId));
  }

  register(registration: Registration): Promise<string> {
    return this.directory.registerClient(registration as unknown as Record<string, unknown>);
  }

  private async fetchDocument(url: string): Promise<unknown> {
    let res: Response;
    try {
      // No redirects: the document must live at the URL the client named.
      res = await this.fetcher(url, { headers: { Accept: 'application/ld+json, application/json' }, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (e) {
      throw new OidcError('invalid_client', `client document unreachable: ${(e as Error).message}`);
    }
    if (!res.ok) throw new OidcError('invalid_client', `client document answered ${res.status}`);
    const text = await limitedText(res);
    try {
      return JSON.parse(text);
    } catch {
      throw new OidcError('invalid_client', 'client document is not JSON');
    }
  }
}

/** The body, refused once it passes DOC_LIMIT bytes, without reading more. */
async function limitedText(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > DOC_LIMIT) {
      await reader.cancel();
      throw new OidcError('invalid_client', 'client document is too large');
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(await new Blob(chunks).arrayBuffer());
}
