// HTTP pieces the adapters share: the fetch they are given, bodies read under
// a cap, the one-retry token policy, and OAuth token-endpoint calls.

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** The body as text, refused once it passes `limit` bytes, without reading more. */
export async function limitedText(res: Response, limit: number, tooLarge: () => Error): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw tooLarge();
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(await new Blob(chunks).arrayBuffer());
}

/** Sends with the current access token, and once more with a fresh one after a 401. */
export async function withAccessToken(accessToken: (refresh: boolean) => Promise<string>, send: (token: string) => Promise<Response>): Promise<Response> {
  const res = await send(await accessToken(false));
  return res.status === 401 ? send(await accessToken(true)) : res;
}

/** A form POST to an OAuth token endpoint; any answer without an access token
 * is `fail`ed with the provider's own description. */
export async function tokenCall(fetcher: Fetch, url: string, form: Record<string, string>, fail: (message: string) => Error): Promise<Record<string, unknown>> {
  const res = await fetcher(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
  });
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(await res.text()) as Record<string, unknown>;
  } catch {
    throw fail(`the token endpoint answered ${res.status}`);
  }
  if (!res.ok || typeof body.access_token !== 'string') throw fail(String(body.error_description ?? body.error ?? `HTTP ${res.status}`));
  return body;
}
