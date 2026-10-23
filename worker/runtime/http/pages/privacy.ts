// The privacy page. It states what the service holds today; change it in the
// same change as anything it describes.

import { page } from './shell.js';

const SUPPORT = 'solidshmolid-support@googlegroups.com';

export function privacyPage(): Response {
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
<p>solidshmolid is not meant for children under 13.</p>
<h2>Who else is involved</h2>
<p>Cloudflare runs our servers and keeps short-lived request logs for operating the service. Clerk handles sign-in. Your storage provider (Dropbox or Google Drive) holds your files under your own account and its own terms. Google is involved only if you continue with Google or keep your pods in Google Drive.</p>
<p>We do not sell your data, show ads, or use your files for anything except serving your pod to you and the apps you allow.</p>
<h2>Leaving</h2>
<p>You can remove apps, disconnect storage, delete a pod and delete your account. Deleting your account removes what we keep and your sign-in with Clerk. Your storage folders stay yours unless you choose to delete them too, and each is still a complete pod you can use with another Solid server. You can also revoke our access from your storage provider at any time.</p>
<h2>Contact</h2>
<p>Questions or requests: <a href="mailto:${SUPPORT}">${SUPPORT}</a>.</p>
</div>`,
  );
}
