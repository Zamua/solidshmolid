// The favicon, home-screen icons and web app manifest, served from the apex.

import { FAVICON_SVG, ICON_FILES, MANIFEST_ICONS } from './appIconData.js';

/** The masthead's sky, which browser chrome takes on around the pages. */
export const THEME_COLOR = '#cfe4ff';
export const FAVICON_PATH = '/favicon.svg';
export const TOUCH_ICON_PATH = '/apple-touch-icon.png';
export const MANIFEST_PATH = '/manifest.webmanifest';

const CACHE = 'public, max-age=86400';

// `browser`, not standalone: signing in and connecting storage leave the site
// and come back, which a standalone window does not reliably carry through.
// iOS ignores it and offers "Open as Web App" when adding to the Home Screen.
const MANIFEST = JSON.stringify({
  name: 'solidshmolid',
  short_name: 'solidshmolid',
  description: 'Solid pods whose files live in your own Dropbox or Google Drive',
  start_url: '/',
  scope: '/',
  display: 'browser',
  background_color: THEME_COLOR,
  theme_color: THEME_COLOR,
  icons: MANIFEST_ICONS,
});

const decoded = new Map<string, Uint8Array>();

function bytes(path: string, base64: string): Uint8Array {
  let out = decoded.get(path);
  if (!out) {
    out = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    decoded.set(path, out);
  }
  return out;
}

export function appIconRoute(request: Request, url: URL): Response | null {
  if (request.method !== 'GET' && request.method !== 'HEAD') return null;
  if (url.pathname === FAVICON_PATH) return new Response(FAVICON_SVG, { headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': CACHE } });
  if (url.pathname === MANIFEST_PATH) return new Response(MANIFEST, { headers: { 'Content-Type': 'application/manifest+json', 'Cache-Control': CACHE } });
  const file = ICON_FILES[url.pathname];
  if (!file) return null;
  return new Response(bytes(url.pathname, file.base64), { headers: { 'Content-Type': file.type, 'Cache-Control': CACHE } });
}
