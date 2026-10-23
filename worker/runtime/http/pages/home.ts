// The apex home page: welcome, then sign-up, then connecting storage, then
// the household. One page whose content follows where the person is.

import type { HouseholdState } from '../../../app/households/ports.js';
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
<li>${icon('usersThree')}<span>Make pods for your whole family and manage them in one place.</span></li>
<li>${icon('doorOpen')}<span>Leave anytime. Your folder is still a complete pod.</span></li>
</ul>
<div class="dock"><div><a class="btn primary" href="/sign-in?return=%2F">Create your pod</a><a class="btn quiet" href="/sign-in?return=%2F">I already have one</a></div></div>`,
  );
}

export function signupPage(): Response {
  return page(
    'Create your pod',
    `<h1 style="margin-top:56px">Create your pod</h1>
<p class="lede">You get your own address for apps to find you, and a household you manage. Next, you choose where its files live.</p>
<div class="dock"><form method="post" action="/api/signup"><button class="btn primary">Create my pod</button></form></div>`,
  );
}

/** Choosing storage for a household whose pods have none yet. */
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

export function householdPage(state: HouseholdState, person: string, hosts: Hosts): Response {
  const rows = state.pods
    .map((p, i) => {
      const member = state.members.find((m) => m.clerkUserId === p.owner);
      const you = p.owner === person;
      const host = new URL(hosts.podOrigin(p.podId)).host;
      return `<div class="row" style="padding:12px 0${i ? ';border-top:1px solid var(--line)' : ''}">
${podCloud(you ? 'Me' : '?', true)}
<div class="grow"><div class="row" style="gap:8px">${you ? '<span class="badge you">You</span>' : '<b>Member</b>'}${member?.role === 'manager' ? ' <span class="badge">Manager</span>' : ''}</div>
<div class="small"><a href="${escapeHtml(hosts.podOrigin(p.podId))}/">${escapeHtml(host)}</a></div></div></div>`;
    })
    .join('');
  const me = state.members.find((m) => m.clerkUserId === person);
  const storage = state.links
    .map(
      (l) => `<div class="card row">
<div class="icon-tile">${icon(l.provider === 'dropbox' ? 'dropboxLogo' : 'folderSimpleLock')}</div>
<div class="grow"><b>${l.provider === 'dropbox' ? 'Your Dropbox' : 'Development storage'}</b><div class="small">${podCount(state, l.linkId)}</div></div>
<span class="ok">${icon('checkCircle')}</span></div>`,
    )
    .join('');
  return page(
    'Your household',
    `<h1 style="margin-top:40px">Your household</h1>
<p class="lede">Everyone signs in as themselves.</p>
<div class="card" style="padding:6px 16px">${rows}</div>
${storage}
${me ? `<div class="card row"><div class="icon-tile">${icon('identificationCard')}</div><div class="grow"><b>Your WebID</b><div class="small">${escapeHtml(me.webid)}</div><div class="small">Apps ask for this when you sign in with Solid.</div></div></div>` : ''}`,
  );
}

function podCount(state: HouseholdState, linkId: string): string {
  const n = state.pods.filter((p) => p.linkId === linkId).length;
  return n === 1 ? '1 pod lives here' : `${n} pods live here`;
}
