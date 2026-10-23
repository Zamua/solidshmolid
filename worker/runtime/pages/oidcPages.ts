// Pages of the sign-in flow: consent and plain messages.

import type { ClientInfo } from '../../domain/oidc.js';
import { escapeHtml, page } from './shell.js';

export function consentPage(c: { pendingId: string; client: ClientInfo; webid: string }): Response {
  const name = c.client.name ?? 'An app';
  const origin = c.client.isPublic ? 'an app without a registered name' : hostOf(c.client.redirectUris[0] ?? c.client.clientId);
  const who = c.webid.replace(/^https?:\/\//u, '').replace(/\/profile\/card#me$/u, '');
  return page(
    `${name} wants to use your pod`,
    `<div class="card center" style="margin-top:40px">
  <h2>${escapeHtml(name)} wants to use your pod</h2>
  <p class="small">${escapeHtml(origin)}</p>
</div>
<ul class="plain card">
  <li>It will know this is <b>${escapeHtml(who)}</b>.</li>
  <li>It can read and save what your pod allows it to.</li>
  <li>You can remove it anytime from your account.</li>
</ul>
<div class="dock"><form method="post" action="/.oidc/auth/decision">
  <input type="hidden" name="pending" value="${escapeHtml(c.pendingId)}">
  <button class="btn primary" name="approve" value="yes">Allow</button>
  <button class="btn quiet" name="approve" value="no">Don't allow</button>
</form></div>`,
  );
}

export function messagePage(title: string, text: string, status: number): Response {
  return page(title, `<h1>${escapeHtml(title)}</h1><p class="lede">${escapeHtml(text)}</p>`, status);
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
