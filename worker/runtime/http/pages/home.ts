// The apex home page: welcome, then sign-up, then connecting storage, then
// the person's pods. One page whose content follows where the person is.

import type { AccountState, FileEntry } from '../../../app/accounts/ports.js';
import type { Approval } from '../../../app/identity/ports.js';
import type { Hosts } from '../../hosts.js';
import { icon } from './icons.js';
import { problemPage, sentenceOf } from './problem.js';
import { lookOf, storagePhrase } from './providers.js';
import { escapeHtml, page, podCloud } from './shell.js';

export function welcomePage(providers: string[]): Response {
  const storage = storagePhrase(providers);
  return page(
    'solidshmolid',
    `<div class="welcome"><div style="margin-top:72px"><div class="row" style="gap:6px">${podCloud({ html: icon('image', 28) })}${podCloud({ html: icon('notepad', 28) })}${podCloud({ html: icon('calendarBlank', 28) })}</div>
<h1>A home for your data, kept in your own cloud</h1>
<p class="lede">Get a pod: a private space your apps can use with your permission. Its files live in ${escapeHtml(storage)}, where you can always see them.</p>
<div class="dock"><div><a class="btn primary" href="/sign-up?return=%2F">Create your pod</a><a class="btn quiet" href="/sign-in?return=%2F">I already have one</a></div></div></div>
<ul class="plain card features" style="margin-top:26px">
<li>${icon('folderSimpleLock')}<span>Your files stay in ${escapeHtml(storage)}, not on our servers.</span></li>
<li>${icon('stack')}<span>Keep separate pods for work, photos or anything else.</span></li>
<li>${icon('doorOpen')}<span>Leave anytime. Your folder is still a complete pod.</span></li>
</ul></div>`,
  );
}

/** Choosing storage for an account whose pods have none yet: one tap per
 * provider starts connecting it. */
export function connectPage(providers: string[]): Response {
  const choices = providers
    .map((p) => {
      const look = lookOf(p);
      return `<form method="post" action="/api/storage/${escapeHtml(p)}/start"><button class="choice pick">
<span class="provider-logo"${look.color ? ` style="color:${look.color}"` : ''}>${icon(look.icon, 28)}</span>
<span class="grow"><b>${escapeHtml(look.name)}</b><span class="small" style="display:block">${escapeHtml(look.where)}</span></span>
${icon('caretRight', 20)}</button></form>`;
    })
    .join('');
  return page(
    'Connect storage',
    `<h1>Where should your pod live?</h1>
<p class="lede">Pick the storage you already use.</p>
<div class="choices">${choices}
<div class="choice off"><span class="provider-logo">${icon('cloud', 28)}</span><span class="grow"><b>OneDrive</b><span class="small" style="display:block">Coming soon</span></span></div>
</div>
<ul class="plain" style="margin-top:18px">
<li>${icon('eye')}<span>We can only open that one folder, nothing else in your storage.</span></li>
<li>${icon('plugs')}<span>Take our access away anytime, here or in your storage provider's settings.</span></li>
</ul>`,
  );
}

/** The person's WebID, then their pods grouped under the storage each lives
 * in. `offered` lists the providers people may connect; with more than the
 * one storage already connected, adding a pod asks where it goes. */
export function podsPage(state: AccountState, apps: Approval[], hosts: Hosts, offered: string[]): Response {
  const choose = state.links.length > 1 || unconnected(state, offered).length > 0;
  const add = choose
    ? `<a class="add-pod" href="/pods/new">${icon('plus', 20)}Add a pod</a>`
    : `<form method="post" action="/api/pods"><button class="add-pod">${icon('plus', 20)}Add a pod</button></form>`;
  const podRow = (i: number) => {
    const p = state.pods[i]!;
    const host = escapeHtml(new URL(hosts.podOrigin(p.podId)).host);
    return `<a class="row list-row row-link" href="/pods/${escapeHtml(p.podId)}/files">${podCloud(String(i + 1), true)}<span class="grow"><b>${podLabel(i)}</b><span class="small" style="display:block">${host}</span>${i === 0 ? '<span class="small" style="display:block">Holds your WebID</span>' : ''}</span><span class="chevron">${icon('caretRight', 20)}</span></a>`;
  };
  const groups = state.links
    .map((l) => {
      const look = lookOf(l.provider);
      const pods = state.pods.flatMap((p, i) => (p.linkId === l.linkId ? [i] : []));
      // Storage holding no pods can be let go; one holding pods cannot.
      const disconnect = pods.length
        ? ''
        : `<form method="post" action="/api/storage/${escapeHtml(l.linkId)}/disconnect"><button class="chip-btn">Disconnect</button></form>`;
      return `<div class="card" style="padding:6px 16px">
<div class="row list-row"><span class="provider-logo"${look.color ? ` style="color:${look.color}"` : ''}>${icon(look.icon, 24)}</span><div class="grow"><b>${escapeHtml(look.yours)}</b><div class="small">${pods.length === 1 ? '1 pod' : `${pods.length} pods`}</div></div>${disconnect}</div>
${pods.map(podRow).join('')}</div>`;
    })
    .join('');
  const appRows = apps
    .map(
      (a) => `<div class="row list-row">
<div class="grow"><b>${escapeHtml(appName(a))}</b><div class="small">${escapeHtml(a.site ?? 'Signed in with your WebID')}</div></div>
<a class="chip-btn" href="/apps/remove?client=${encodeURIComponent(a.clientId)}">Remove</a></div>`,
    )
    .join('');
  return page(
    'Your pods',
    `<h1>Your pods</h1>
<p class="lede">Each pod is its own folder in your storage. Apps you allow can use them.</p>
<div class="card">
<div class="row"><div class="icon-tile">${icon('identificationCard')}</div><div class="grow"><b>Your WebID</b><div class="small">Apps ask for it when you sign in with Solid.</div></div></div>
<div class="card-actions"><a class="pill-btn" href="${escapeHtml(state.webid)}" title="${escapeHtml(state.webid)}">${icon('user', 18)}View</a>
<button type="button" class="pill-btn copy-btn" data-copy="${escapeHtml(state.webid)}" hidden>${icon('copy', 18)}${icon('check', 18)}<span data-label>Copy</span></button></div></div>
${groups}
<div class="card" style="padding:6px 16px">${add}</div>
<div class="card">
<div class="row"><div class="icon-tile">${icon('squaresFour')}</div><div class="grow"><b>Apps</b><div class="small">${appRows ? 'Solid apps you signed in to' : 'None yet. When you sign in to a Solid app with solidshmolid, it shows up here.'}</div></div></div>
${appRows ? `<div style="margin-top:8px">${appRows}</div>` : ''}</div>
<p class="small center" style="margin-top:22px"><a href="/account/delete">Delete account</a></p>`,
  );
}

/** Offered providers the person has no storage with yet. */
function unconnected(state: AccountState, offered: string[]): string[] {
  return offered.filter((p) => !state.links.some((l) => l.provider === p));
}

/** Where a new pod goes: storage already connected, or more to connect. */
export function newPodPage(state: AccountState, offered: string[]): Response {
  const choice = (action: string, hidden: string, provider: string, title: string, detail: string) => {
    const look = lookOf(provider);
    return `<form method="post" action="${escapeHtml(action)}">${hidden}<button class="choice pick">
<span class="provider-logo"${look.color ? ` style="color:${look.color}"` : ''}>${icon(look.icon, 28)}</span>
<span class="grow"><b>${escapeHtml(title)}</b><span class="small" style="display:block">${escapeHtml(detail)}</span></span>
${icon('caretRight', 20)}</button></form>`;
  };
  const connected = state.links.map((l) =>
    choice('/api/pods', `<input type="hidden" name="link" value="${escapeHtml(l.linkId)}">`, l.provider, lookOf(l.provider).yours, podCount(state, l.linkId)),
  );
  const more = unconnected(state, offered).map((p) =>
    choice(`/api/storage/${p}/start`, '<input type="hidden" name="newPod" value="true">', p, `Connect ${lookOf(p).name}`, lookOf(p).where),
  );
  return page(
    'Add a pod',
    `<h1>Where should the new pod live?</h1>
<p class="lede">It gets its own folder and address. Apps you allow can use it.</p>
<div class="choices">${connected.join('')}${more.join('')}</div>
<p class="small center" style="margin-top:22px"><a href="/">Cancel</a></p>`,
  );
}

function podCount(state: AccountState, linkId: string): string {
  const n = state.pods.filter((p) => p.linkId === linkId).length;
  return n === 1 ? '1 pod lives here' : `${n} pods live here`;
}

/** What deleting removes, and the choice of keeping the files. */
export function deletePage(what: 'pod' | 'account', action: string, providerName: string | null, pod: { index: number; host: string } | null = null): Response {
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
    `<h1>${title}</h1>
<p class="lede">${lede}</p>
${pod ? `<div class="card row">${podCloud(String(pod.index + 1), true)}<div class="grow"><b>${podLabel(pod.index)}</b><div class="small">${escapeHtml(pod.host)}</div></div></div>` : ''}
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
    `<h1>This deletes files for good</h1>
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

function appName(a: Approval): string {
  return a.clientName ?? a.site ?? 'An app';
}

/** Removing an app, asked once more: it loses access until approved again. */
export function removeAppPage(a: Approval): Response {
  return page(
    'Remove app',
    `<h1>Remove ${escapeHtml(appName(a))}?</h1>
<p class="lede">${escapeHtml(a.site ?? 'This app')} will no longer be able to use your pods. If you sign in to it again, it will ask for your permission again.</p>
<form method="post" action="/api/apps/revoke" class="card stack">
<input type="hidden" name="clientId" value="${escapeHtml(a.clientId)}">
<button class="btn danger">Remove</button>
<a class="btn quiet" href="/">Cancel</a>
</form>`,
  );
}

/** A request the service refused, with the way back. */
export function refusalPage(title: string, message: string, status: number): Response {
  return problemPage(title, sentenceOf(message), status);
}

/** Our own sign-up: an email code, or Google. The boot script drives it. */
export function signUpPage(back: string): Response {
  const signIn = `/sign-in?return=${encodeURIComponent(back)}`;
  return page(
    'Create your account',
    `<h1>Create your account</h1>
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

/** The avatar chip and its menu, for every page someone signed in sees. */
export function accountMenu(): string {
  return `<details class="account-menu">
<summary aria-label="Your account"><span class="user-chip">${icon('user', 20)}</span></summary>
<div class="menu">
<a href="/">${icon('house', 20)}Your pods</a>
<a href="/sign-out">${icon('signOut', 20)}Sign out</a>
</div>
</details>`;
}

function podLabel(index: number): string {
  return index === 0 ? 'Your pod' : `Pod ${index + 1}`;
}

/** One folder of a pod, for its owner: folders to open, files to download. */
export function filesPage(state: AccountState, podId: string, path: string, entries: FileEntry[], hosts: Hosts): Response {
  const index = state.pods.findIndex((p) => p.podId === podId);
  const base = `/pods/${encodeURIComponent(podId)}`;
  const segments = path.split('/').filter(Boolean);
  // Ancestors only: the folder itself is the heading.
  const crumbs = [`<a href="/">Your pods</a>`]
    .concat(segments.length ? [`<a href="${base}/files">${escapeHtml(podLabel(index))}</a>`] : [])
    .concat(segments.slice(0, -1).map((seg, i) => `<a href="${base}/files?path=${encodeURIComponent(`/${segments.slice(0, i + 1).join('/')}/`)}">${escapeHtml(decodeSegment(seg))}</a>`))
    .join('<span class="crumb-sep">/</span>');
  const rows = [...entries]
    .sort((a, b) => (a.kind === b.kind ? a.path.localeCompare(b.path) : a.kind === 'container' ? -1 : 1))
    .map((e) => {
      const name = decodeSegment(e.path.replace(/\/$/u, '').split('/').pop()!);
      const folder = e.kind === 'container';
      const href = folder ? `${base}/files?path=${encodeURIComponent(e.path)}` : `${base}/download?path=${encodeURIComponent(e.path)}`;
      const detail = folder ? 'Folder' : `${formatSize(e.size)}, ${formatDate(e.modified)}`;
      return `<a class="row row-link list-row" href="${escapeHtml(href)}"${folder ? '' : ' download'}>
<span class="icon-tile">${icon(folder ? 'folder' : 'file')}</span>
<span class="grow"><b class="file-name">${escapeHtml(name)}</b><span class="small" style="display:block">${escapeHtml(detail)}</span></span>
<span class="chevron">${icon(folder ? 'caretRight' : 'downloadSimple', 20)}</span></a>`;
    })
    .join('');
  return page(
    'Files',
    `<p class="crumbs">${crumbs}</p>
<h1>${escapeHtml(segments.length ? decodeSegment(segments.at(-1)!) : podLabel(index))}</h1>
<p class="small">${escapeHtml(new URL(hosts.podOrigin(podId)).host)}${escapeHtml(path)}</p>
<div class="card" style="padding:6px 16px">${rows || '<p class="small" style="padding:14px 0">Nothing here yet. Apps you approve can save files here.</p>'}</div>
${segments.length === 0 && index > 0 ? `<p class="small center" style="margin-top:22px"><a href="${base}/delete">Delete this pod</a></p>` : ''}`,
  );
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}
