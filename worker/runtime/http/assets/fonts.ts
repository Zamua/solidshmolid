// The pages' typefaces, served from the apex so a page contacts no font host.

import { FONT_FILES } from './fontData.js';

// A path names its content's hash, so the file never changes under it.
const CACHE = 'public, max-age=31536000, immutable';

const decoded = new Map<string, Uint8Array>();

/** The `@font-face` rules. `apex` is the account site's origin for a page on
 * a pod's host, and empty on the account site itself. */
export function fontFaces(apex: string): string {
  return FONT_FILES.map(
    (file) => `@font-face{font-family:'${file.family}';font-weight:${file.weight};font-style:normal;font-display:swap;src:url(${apex}${file.path}) format('woff2')}`,
  ).join('');
}

export function fontRoute(request: Request, url: URL): Response | null {
  if (request.method !== 'GET' && request.method !== 'HEAD') return null;
  const file = FONT_FILES.find((f) => f.path === url.pathname);
  if (!file) return null;
  let bytes = decoded.get(file.path);
  if (!bytes) {
    bytes = Uint8Array.from(atob(file.base64), (c) => c.charCodeAt(0));
    decoded.set(file.path, bytes);
  }
  // Pages on pod hosts load the fonts from here, and fonts are fetched with CORS.
  return new Response(bytes, { headers: { 'Content-Type': 'font/woff2', 'Cache-Control': CACHE, 'Access-Control-Allow-Origin': '*' } });
}
