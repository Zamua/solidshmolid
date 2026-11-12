import { describe, expect, it } from 'vitest';
import { fontRoute } from '../runtime/http/assets/fonts.js';
import { page } from '../runtime/http/pages/shell.js';

const APEX = 'https://account.example';

/** The font files a page's styles name. */
function fontUrls(html: string): string[] {
  return [...html.matchAll(/@font-face\{[^}]*src:url\(([^)]+)\)/gu)].map((m) => m[1]!);
}

describe("the pages' fonts", () => {
  it('are served by the account site itself, as woff2 that never changes under its name', async () => {
    const html = await page('T', '<p>x</p>').text();
    const urls = fontUrls(html);
    expect(urls).toHaveLength(4);
    for (const path of urls) {
      expect(path.startsWith('/fonts/')).toBe(true);
      const response = fontRoute(new Request(`${APEX}${path}`), new URL(`${APEX}${path}`));
      expect(response?.headers.get('Content-Type')).toBe('font/woff2');
      expect(response?.headers.get('Cache-Control')).toContain('immutable');
      const bytes = new Uint8Array(await response!.arrayBuffer());
      expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe('wOF2');
    }
  });

  it('reach a page on a pod host from the account site, which allows the cross-origin load', () => {
    const response = page('T', '<p>x</p>', 200, `${APEX}/`);
    expect(response.headers.get('Content-Security-Policy')).toContain(`font-src 'self' ${APEX}`);
    expect(fontRoute(new Request(`${APEX}/fonts/other.woff2`), new URL(`${APEX}/fonts/other.woff2`))).toBeNull();
  });

  it('name the account site in a pod page and allow any origin to load them', async () => {
    const urls = fontUrls(await page('T', '<p>x</p>', 200, `${APEX}/`).text());
    expect(urls.every((u) => u.startsWith(`${APEX}/fonts/`))).toBe(true);
    const path = new URL(urls[0]!).pathname;
    expect(fontRoute(new Request(`${APEX}${path}`), new URL(`${APEX}${path}`))?.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });

  it('leave a page with no address outside its own site', async () => {
    const response = page('T', '<p>x</p>');
    const html = await response.text();
    expect(html).not.toMatch(/https?:\/\/(?!www\.w3\.org)/u);
    const csp = response.headers.get('Content-Security-Policy')!;
    expect(csp).toContain("font-src 'self'");
    expect(csp).toContain("style-src 'unsafe-inline';");
    expect(csp).not.toContain('google');
  });

  it('answer only reads', async () => {
    const path = fontUrls(await page('T', '').text())[0]!;
    expect(fontRoute(new Request(`${APEX}${path}`, { method: 'POST' }), new URL(`${APEX}${path}`))).toBeNull();
  });
});
