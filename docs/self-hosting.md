# Self-hosting

## You need

- A Cloudflare account. The service is one Worker with SQLite-backed Durable
  Objects.
- Two domains on Cloudflare: one for the account site and identity provider
  (`account.example` below) and one for pods (`pods.example`). Pods serve
  whatever their folders hold, so they must not share a registrable domain
  with the account site (see "URLs" in [SPEC.md](SPEC.md)).
- A [Clerk](https://clerk.com) application for people's sign-in, with a
  production instance on your account domain. Sign-up uses an emailed code and
  optionally Google; turn passwords off (and not required).
- At least one storage provider:
  - **Dropbox**: an app with Scoped access and App folder access, the
    permissions `files.metadata.read`, `files.content.read` and
    `files.content.write`, and the redirect URI
    `https://account.example/link/dropbox/callback`. It uses PKCE, so only the
    app key is needed.
  - **Google Drive**: a Google Cloud project with the Drive API enabled, the
    `drive.file` scope on its consent screen, and a Web OAuth client with the
    redirect URI `https://account.example/link/google-drive/callback`.

## Configure

Copy `wrangler.jsonc` to `wrangler.deploy.jsonc` (ignored by git), give the
Worker a name, and add the routes and variables:

```jsonc
"routes": [
  { "pattern": "account.example", "custom_domain": true },
  { "pattern": "*.pods.example/*", "zone_name": "pods.example" }
],
"vars": {
  "APEX_HOST": "account.example",
  "POD_HOST_TEMPLATE": "{handle}.pods.example",
  "STORAGE": "dropbox,google-drive",       // the providers offered, in order
  "DROPBOX_APP_KEY": "...",                // with dropbox
  "GOOGLE_CLIENT_ID": "...",               // with google-drive
  "CLERK_PUBLISHABLE_KEY": "pk_live_...",
  "SUPPORT_EMAIL": "help@account.example"  // optional, shown on /privacy
}
```

In the pod domain's DNS, add a proxied wildcard record so every pod host
reaches the Worker, for example `*` AAAA `100::` (proxied). The account
domain's custom domain is created on deploy.

Then set the secrets:

```
head -c 32 /dev/urandom | base64 | npx wrangler secret put TOKEN_KEY --config wrangler.deploy.jsonc
node scripts/new-signing-jwk.mjs | npx wrangler secret put OIDC_SIGNING_JWK --config wrangler.deploy.jsonc
npx wrangler secret put CLERK_SECRET_KEY --config wrangler.deploy.jsonc
npx wrangler secret put GOOGLE_CLIENT_SECRET --config wrangler.deploy.jsonc   # with google-drive
```

`TOKEN_KEY` encrypts the stored storage refresh tokens; changing it means
everyone reconnects their storage. `OIDC_SIGNING_JWK` signs the tokens apps
receive; changing it signs everyone out of their apps.

## Deploy

```
npx wrangler deploy --config wrangler.deploy.jsonc
APEX_URL=https://account.example NO_POD_URL=https://zzzzzzzz.pods.example ./scripts/smoke.sh
```

Run the smoke test before and after each deploy and compare.
