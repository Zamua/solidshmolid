// The forms and small JSON the account site and the provider read into
// memory: a few fields each, so anything bigger is refused unread.

import { readAll } from '../../app/shared/streams.js';

export const SMALL_BODY_LIMIT = 16 * 1024;

/** The request with its body already read, or PayloadTooLarge past `limit`. */
export async function withSmallBody(request: Request, limit = SMALL_BODY_LIMIT): Promise<Request> {
  if (!request.body) return request;
  const body = await readAll(request.body, limit);
  return new Request(request.url, { method: request.method, headers: request.headers, body });
}
