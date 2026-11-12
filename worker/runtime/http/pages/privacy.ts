// The privacy page. It states what the service holds today; change it in the
// same change as anything it describes.

import { escapeHtml, page } from './shell.js';

/** `support` is where people write with questions; the section goes when
 * a deployment names none. */
export function privacyPage(support: string | null): Response {
  return page(
    'Privacy',
    `<h1>Privacy</h1>
<p class="lede">solidshmolid gives you a Solid pod whose files live in your own cloud storage. This page says what we keep, where, and why.</p>
<div class="card prose">
<h2>Your files</h2>
<p>Your pods' files live in folders of your own storage: for Dropbox, inside <b>Apps/solidshmolid</b>; for Google Drive, in a <b>solidshmolid</b> folder in My Drive. We can open only that folder. In Google Drive we can see only the files solidshmolid itself made, nothing else in your Drive. When you or an app you approved reads or writes a file, it passes through our servers on its way; we do not keep a copy.</p>
<p>To answer quickly, we keep an index of your pod: each file's name, size, type and version. We also keep a copy of small linked-data documents (64 KB or less), such as your profile, access rules and app settings, alongside that index.</p>
<h2>Your account</h2>
<p>Signing in is handled by Clerk. It holds your sign-in details: your email address, or your name and email if you continue with Google.</p>
<p>We keep your account: your pods' addresses, your WebID, which apps you have approved, and the connection to your storage. That connection is a token from your storage provider; we store it encrypted and use it only to reach your pods' folders.</p>
<p>Your pods start private, except your WebID profile. Anyone can read the profile: it is how apps and other people recognize you. It holds your WebID and your pods' addresses, plus anything you or your apps add to it.</p>
<p>solidshmolid is not meant for children under 13.</p>
<h2>Who else is involved</h2>
<p>Cloudflare runs our servers and keeps short-lived request logs for operating the service. Clerk handles sign-in. Your storage provider (Dropbox or Google Drive) holds your files under your own account and its own terms. Google is involved only if you continue with Google or keep your pods in Google Drive.</p>
<p>We count how much the service is used, such as how many people were active in a day or how many pods were made. Those counts are kept under a scrambled identifier that cannot be traced back to you, and they hold nothing about your files, their names or the apps you use.</p>
<p>We do not sell your data, show ads, or use your files for anything except serving your pod to you and the apps you allow.</p>
<h2>Leaving</h2>
<p>You can remove apps and delete your account whenever you like. You can delete any pod except your first: it holds your WebID and goes only with your account. You can disconnect storage once no pod lives in it.</p>
<p>Deleting your account removes what we keep and your sign-in with Clerk. Your storage folders stay yours unless you choose to delete them too. Each folder still holds every file, in the layout other Solid servers use. Its access rules name the WebID you had here, so to use the folder with another server you would rewrite them for your new identity.</p>
<p>If you take our access away at your storage provider instead, the pods kept there stop until you connect that storage again from your account.</p>
${support ? `<h2>Contact</h2>
<p>Questions or requests: <a href="mailto:${escapeHtml(support)}">${escapeHtml(support)}</a>.</p>` : ''}
</div>`,
  );
}
