// The sign-in flow's consent page.

import type { ClientInfo } from '../../../domain/identity/oidc.js';
import { icon } from './icons.js';
import { escapeHtml, page } from './shell.js';

export function consentPage(c: { pendingId: string; client: ClientInfo; webid: string }): Response {
  const name = c.client.name ?? 'An app';
  const origin = c.client.isPublic ? 'An app without a registered name' : hostOf(c.client.redirectUris[0] ?? c.client.clientId);
  return page(
    `${name} wants to use your pod`,
    `<div class="consent-head"><div class="icon-tile">${icon('squaresFour')}</div>
<h1>${escapeHtml(name)} wants to use your pod</h1>
<p class="lede">${escapeHtml(origin)}</p></div>
<ul class="plain card">
<li>${icon('identificationCard')}<span>It will know you by your WebID.</span></li>
<li>${icon('folderSimpleLock')}<span>It can read and save what your pod allows it to.</span></li>
<li>${icon('plugs')}<span>You can remove it anytime from your pods page.</span></li>
</ul>
<div class="dock"><form method="post" action="/.oidc/auth/decision">
<input type="hidden" name="pending" value="${escapeHtml(c.pendingId)}">
<button class="btn primary" name="approve" value="yes">Allow</button>
<button class="btn quiet" name="approve" value="no">Don't allow</button>
</form></div>`,
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
