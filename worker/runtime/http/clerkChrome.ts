// Puts Clerk on every apex page: its script (served by the instance's
// Frontend API) and our boot script, with a CSP that allows exactly those.
// Pages themselves never mention Clerk.

import { CLERK_BOOT_PATH } from './assets/clerkBoot.js';
import { escapeHtml, pageCsp } from './pages/shell.js';

/** Clerk's bot protection, which clerk-js loads on sign-in and sign-up and
 * probes on several hosts and ports. */
const PROTECT = 'https://*.protect.clerk.com:*';

export interface ClerkChrome {
  frontendApi: string;
  publishableKey: string;
}

export function withClerk(response: Response, clerk: ClerkChrome): Response {
  if (!(response.headers.get('Content-Type') ?? '').startsWith('text/html')) return response;
  const fapi = `https://${clerk.frontendApi}`;
  const out = new Response(response.body, response);
  out.headers.set(
    'Content-Security-Policy',
    pageCsp({
      script: [fapi, PROTECT, 'https://challenges.cloudflare.com'],
      connect: [fapi, PROTECT],
      img: ['https://img.clerk.com'],
      frame: ['https://challenges.cloudflare.com'],
      worker: ['blob:'],
    }),
  );
  return new HTMLRewriter()
    .on('head', {
      element(head) {
        head.append(
          `<script defer crossorigin="anonymous" src="${fapi}/npm/@clerk/ui@1/dist/ui.browser.js"></script>
<script defer crossorigin="anonymous" data-clerk-publishable-key="${escapeHtml(clerk.publishableKey)}" src="${fapi}/npm/@clerk/clerk-js@6/dist/clerk.browser.js"></script>
<script defer src="${CLERK_BOOT_PATH}"></script>`,
          { html: true },
        );
      },
    })
    .transform(out);
}
