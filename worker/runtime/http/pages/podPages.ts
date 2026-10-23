// What a person sees when they open a pod's address in a browser and the pod
// will not show it to them: a word on what a pod is, and where to go. Apps
// never get these; they get the protocol's own answers.

import { icon } from './icons.js';
import { escapeHtml, page } from './shell.js';

const PENNY = 'https://penny.vincenttunru.com/explore/?url=';

export function podLandingPage(status: 401 | 403 | 404, podUrl: string, accountSite: string): Response {
  if (status === 404) {
    return page(
      'No pod here',
      `<h1 style="margin-top:56px">There's no pod here</h1>
<p class="lede">Nothing lives at ${escapeHtml(new URL(podUrl).host)}. Check the address, or get a pod of your own.</p>
<div class="dock"><div><a class="btn primary" href="${escapeHtml(accountSite)}">Get a pod</a></div></div>`,
      404,
    );
  }
  return page(
    'A private Solid pod',
    `<h1 style="margin-top:56px">This pod is private</h1>
<p class="lede">It's a Solid pod: a space for someone's data, kept in their own storage. Apps they approve can use it; a browser on its own sees nothing.</p>
<ul class="plain card" style="margin-top:22px">
<li>${icon('folderSimpleLock')}<span>If it's yours, open it with a Solid app and sign in there.</span></li>
</ul>
<div class="dock"><div><a class="btn primary" href="${escapeHtml(PENNY + encodeURIComponent(podUrl))}">Open in a Solid app</a><a class="btn quiet" href="${escapeHtml(accountSite)}">Manage your pods</a></div></div>`,
    status,
  );
}

/** A top-level browser navigation, as opposed to an app's fetch. */
export function isNavigation(request: Request): boolean {
  return request.headers.get('Sec-Fetch-Mode') === 'navigate';
}
