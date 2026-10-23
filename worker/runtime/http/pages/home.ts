// The apex home page: welcome, then sign-up, then connecting storage, then
// the person's pods. One page whose content follows where the person is.

import type { AccountState } from '../../../app/accounts/ports.js';
import type { Approval } from '../../../app/identity/ports.js';
import type { Hosts } from '../../hosts.js';
import { icon } from './icons.js';
import { escapeHtml, page, podCloud } from './shell.js';

export function welcomePage(): Response {
  return page(
    'solidshmolid',
    `<div style="margin-top:72px"><div class="row" style="gap:6px">${podCloud({ html: icon('image', 28) })}${podCloud({ html: icon('notepad', 28) })}${podCloud({ html: icon('calendarBlank', 28) })}</div>
<h1>A home for your data, kept in your own cloud</h1>
<p class="lede">Get a pod: a private space your apps can use with your permission. Its files live in your Dropbox, where you can always see them.</p></div>
<ul class="plain card" style="margin-top:26px">
<li>${icon('folderSimpleLock')}<span>Your files stay in your Dropbox, not on our servers.</span></li>
<li>${icon('stack')}<span>Keep separate pods for work, photos or anything else.</span></li>
<li>${icon('doorOpen')}<span>Leave anytime. Your folder is still a complete pod.</span></li>
</ul>
<div class="dock"><div><a class="btn primary" href="/sign-up?return=%2F">Create your pod</a><a class="btn quiet" href="/sign-in?return=%2F">I already have one</a></div></div>`,
  );
}

export function signupPage(): Response {
  return page(
    'Create your pod',
    `<h1 style="margin-top:56px">Create your pod</h1>
<p class="lede">You get your own address that apps know you by. Next, you choose where your pod's files live.</p>
<div class="dock"><form method="post" action="/api/signup"><button class="btn primary">Create my pod</button></form></div>`,
  );
}

/** Choosing storage for an account whose pods have none yet. */
export function connectPage(provider: string): Response {
  const dropbox = provider === 'dropbox';
  return page(
    'Connect storage',
    `<h1 style="margin-top:44px">Where should your pod live?</h1>
<p class="lede">Pick the storage you already use. You can add more later.</p>
<div class="card" style="margin-top:22px;padding:8px">
<div class="choice on"><div class="dot"></div><div class="grow"><b>${dropbox ? 'Dropbox' : 'Development storage'}</b><div class="small">${dropbox ? 'A folder called Apps/solidshmolid' : 'Kept on this dev server only'}</div></div>${dropbox ? `<span style="color:#0061fe">${icon('dropboxLogo', 28)}</span>` : ''}</div>
<div class="choice off"><div class="dot"></div><div class="grow"><b>Google Drive</b><div class="small">Coming soon</div></div></div>
<div class="choice off"><div class="dot"></div><div class="grow"><b>OneDrive</b><div class="small">Coming soon</div></div></div>
</div>
<ul class="plain" style="margin-top:18px">
<li>${icon('eye')}<span>We can only open that one folder, nothing else in your storage.</span></li>
<li>${icon('plugs')}<span>Disconnect anytime from your account or from ${dropbox ? 'Dropbox' : 'the provider'}.</span></li>
</ul>
<div class="dock"><form method="post" action="/api/storage/${escapeHtml(provider)}/start"><button class="btn primary">${dropbox ? `${icon('dropboxLogo')}Connect Dropbox` : 'Connect'}</button></form></div>`,
  );
}

export function podsPage(state: AccountState, apps: Approval[], hosts: Hosts): Response {
  const rows = state.pods
    .map((p, i) => {
      const origin = hosts.podOrigin(p.podId);
      const where = p.linkId ? `<a href="${escapeHtml(origin)}/">${escapeHtml(new URL(origin).host)}</a>` : 'Waiting for storage';
      const remove = i === 0 ? '' : `<a class="icon-btn" href="/pods/${escapeHtml(p.podId)}/delete" aria-label="Delete pod ${i + 1}">${icon('trash', 20)}</a>`;
      return `<div class="row" style="padding:12px 0${i ? ';border-top:1px solid var(--line)' : ''}">
${podCloud(String(i + 1), true)}
<div class="grow"><div class="row" style="gap:8px;flex-wrap:wrap"><b>${i === 0 ? 'Your pod' : `Pod ${i + 1}`}</b>${i === 0 ? ' <span class="badge">WebID</span>' : ''}</div>
<div class="small">${where}</div></div>${remove}</div>`;
    })
    .join('');
  const appRows = apps
    .map(
      (a, i) => `<div class="row" style="padding:10px 0${i ? ';border-top:1px solid var(--line)' : ''}">
<div class="grow"><b>${escapeHtml(a.clientName ?? hostOf(a.clientId))}</b><div class="small">${escapeHtml(hostOf(a.clientId))}</div></div>
<form method="post" action="/api/apps/revoke"><input type="hidden" name="clientId" value="${escapeHtml(a.clientId)}"><button class="chip-btn">Remove</button></form></div>`,
    )
    .join('');
  const storage = state.links
    .map(
      (l) => `<div class="card row">
<div class="icon-tile">${icon(l.provider === 'dropbox' ? 'dropboxLogo' : 'folderSimpleLock')}</div>
<div class="grow"><b>${l.provider === 'dropbox' ? 'Your Dropbox' : 'Development storage'}</b><div class="small">${podCount(state, l.linkId)}</div></div>
<span class="ok">${icon('checkCircle')}</span></div>`,
    )
    .join('');
  return page(
    'Your pods',
    `<h1 style="margin-top:40px">Your pods</h1>
<p class="lede">Each pod is its own folder in your storage. Apps you allow can use them.</p>
<div class="card" style="padding:6px 16px">${rows}</div>
${storage}
<div class="card row"><div class="icon-tile">${icon('identificationCard')}</div><div class="grow"><b>Your WebID</b><div class="small">${escapeHtml(state.webid)}</div><div class="small">Apps ask for this when you sign in with Solid.</div></div></div>
<div class="card"><h2>Apps</h2>${appRows ? `<div style="margin-top:4px">${appRows}</div>` : '<p class="small">No apps yet. When you sign in to a Solid app with solidshmolid, it shows up here, and you can remove it.</p>'}</div>
<p class="small center" style="margin-top:22px"><a href="/account/delete">Delete account</a></p>
<div class="dock"><div><form method="post" action="/api/pods"><button class="btn primary">${icon('plus')}Add a pod</button></form><a class="btn quiet" href="/sign-out">${icon('signOut')}Sign out</a></div></div>`,
  );
}

function podCount(state: AccountState, linkId: string): string {
  const n = state.pods.filter((p) => p.linkId === linkId).length;
  return n === 1 ? '1 pod lives here' : `${n} pods live here`;
}

/** What deleting removes, and the choice of keeping the files. */
export function deletePage(what: 'pod' | 'account', action: string, providerName: string | null): Response {
  const title = what === 'pod' ? 'Delete this pod?' : 'Delete your account?';
  const lede =
    what === 'pod'
      ? 'Its address stops working and apps lose it. Its folder stays in your storage unless you choose otherwise.'
      : 'Your pods stop working, your WebID goes away, and apps lose access. Your folders stay in your storage unless you choose otherwise.';
  const files = providerName
    ? `<button class="btn danger-quiet" name="deleteFiles" value="true">Delete and remove the files from ${escapeHtml(providerName)}</button>`
    : '';
  return page(
    title,
    `<h1 style="margin-top:40px">${title}</h1>
<p class="lede">${lede}</p>
<form method="post" action="${escapeHtml(action)}" class="card stack">
<button class="btn danger" name="deleteFiles" value="false">Delete, keep the files</button>
${files}
<a class="btn quiet" href="/">Cancel</a>
</form>`,
  );
}

/** The last step before files are deleted: typing the sentence. */
export function confirmDeletionPage(token: string, sentence: string): Response {
  return page(
    'Delete files',
    `<h1 style="margin-top:40px">This deletes files for good</h1>
<p class="lede">Type the sentence below exactly to delete the files from your storage. Anything else deletes nothing.</p>
<form method="post" action="/api/deletions/confirm" class="card">
<p class="sentence">${escapeHtml(sentence)}</p>
<input type="hidden" name="token" value="${escapeHtml(token)}">
<label class="label" for="typed">Type it here</label>
<input class="field" id="typed" name="typed" autocomplete="off" autocapitalize="off" spellcheck="false" required>
<button class="btn danger" style="margin-top:16px">Delete the files</button>
<a class="btn quiet" href="/">Cancel</a>
</form>`,
  );
}

function hostOf(clientId: string): string {
  try {
    return new URL(clientId).host;
  } catch {
    return clientId;
  }
}

/** A request the service refused, with the way back. */
export function refusalPage(title: string, message: string, status: number): Response {
  const sentence = message.charAt(0).toUpperCase() + message.slice(1);
  return page(title, `<h1 style="margin-top:40px">${escapeHtml(title)}</h1><p class="lede">${escapeHtml(sentence)}.</p><p style="margin-top:18px"><a href="/">Back to your pods</a></p>`, status);
}

/** Our own sign-up: an email code, or Google. The boot script drives it. */
export function signUpPage(back: string): Response {
  const signIn = `/sign-in?return=${encodeURIComponent(back)}`;
  return page(
    'Create your account',
    `<h1 style="margin-top:40px">Create your account</h1>
<p class="lede">Use your email or Google. There is no password to remember.</p>
<div class="card" data-clerk-mount="sign-up" data-return="${escapeHtml(back)}">
<button type="button" class="btn outline" data-google>${icon('googleLogo', 22)}Continue with Google</button>
<div class="or"><span>or</span></div>
<form data-email-form>
<label class="label" for="email">Email</label>
<input class="field" id="email" name="email" type="email" autocomplete="email" inputmode="email" required>
<div id="clerk-captcha"></div>
<button class="btn primary" style="margin-top:16px">Send me a code</button>
</form>
<form data-code-form hidden>
<p class="small" style="margin-bottom:12px">We sent a 6-digit code to <b data-email-shown></b>.</p>
<label class="label" for="code">Code</label>
<input class="field" id="code" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]*" maxlength="6" required>
<button class="btn primary" style="margin-top:16px">Create my account</button>
<button type="button" class="btn quiet" data-back>Use a different email</button>
</form>
<p class="small problem" role="alert" data-problem hidden></p>
</div>
<p class="small center" style="margin-top:18px">Already have an account? <a href="${escapeHtml(signIn)}">Sign in</a></p>`,
  );
}
