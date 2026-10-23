// What a person sees when they open a pod's address in a browser and the pod
// will not show it to them: a word on what a pod is, and where to go. Apps
// never get these; they get the protocol's own answers.

import type { ProfileSummary } from '../../../domain/pods/profile.js';
import { icon } from './icons.js';
import { escapeHtml, page } from './shell.js';

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
<li>${icon('folderSimpleLock')}<span>If it's yours, sign in at solidshmolid.com to see what's in it.</span></li>
</ul>
<div class="dock"><div><a class="btn primary" href="${escapeHtml(accountSite)}">Go to your pods</a></div></div>`,
    status,
  );
}

/** A WebID profile, readable: who it is, where their data lives, who
 * vouches for them. Apps get the profile document itself. */
export function publicProfilePage(webid: string, profile: ProfileSummary): Response {
  const name = profile.name ?? 'A Solid profile';
  const storages = profile.storages.map((s) => `<li>${icon('folderSimpleLock')}<span>${escapeHtml(s)}</span></li>`).join('');
  return page(
    name,
    `<div class="row" style="margin-top:44px;gap:16px">${podInitial(profile.name)}<h1 style="margin:0">${escapeHtml(name)}</h1></div>
<div class="card row"><div class="icon-tile">${icon('identificationCard')}</div><div class="grow"><b>WebID</b><div class="small">${escapeHtml(webid)}</div></div></div>
${storages ? `<div class="card"><h2>Pods</h2><ul class="plain">${storages}</ul></div>` : ''}
${profile.issuers.length ? `<p class="small" style="margin-top:16px">Signs in with ${profile.issuers.map((i) => escapeHtml(new URL(i).host)).join(', ')}.</p>` : ''}`,
  );
}

function podInitial(name: string | null): string {
  return `<span class="user-chip" style="width:56px;height:56px;font-size:24px">${name ? escapeHtml([...name][0]!.toUpperCase()) : icon('user', 26)}</span>`;
}

/** A top-level browser navigation, as opposed to an app's fetch. */
export function isNavigation(request: Request): boolean {
  return request.headers.get('Sec-Fetch-Mode') === 'navigate';
}
