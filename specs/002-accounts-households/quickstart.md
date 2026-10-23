# Quickstart: validating accounts, households and Solid sign-in

## Prerequisites

- A Clerk application with a development instance: usernames enabled, email optional,
  passkeys on. Its publishable key in `wrangler.dev.jsonc` vars, its secret key in `.dev.vars`
  as `CLERK_SECRET_KEY`.
- `OIDC_SIGNING_JWK` and `TOKEN_KEY` in `.dev.vars` (`make .dev.vars` generates both).
- `~/keys/dropbox-solidshmolid-app-key`, as for spec 001.

## Automated

```
make test      # domain + app: OP flows, households, deletion confirmation
make compat    # includes: a stock CSS pod accepts a token our provider issued
make e2e       # wrangler dev: scripted client signs in through /.oidc (Clerk testing token),
               # gets a DPoP-bound token, and reads/writes its pod; a managed member's token
               # is refused at the manager-only paths
```

Expected: all green; the CSS check proves an independent resource server accepts our tokens.

## By hand (dev server, real Clerk dev instance, real Dropbox)

1. `make dev`; open `http://localhost:8787/`; sign up as `dana`; connect Dropbox.
   Expect `Apps/solidshmolid/dana/` in Dropbox and `http://dana.localhost:8787/profile/card`
   public.
2. Add member `sam` (managed). Expect `Apps/solidshmolid/sam/`; Dana can read and write it.
3. Setup code for Sam: open its URL in a private window, register a passkey. Reusing the URL
   must fail; after 15 minutes an unused code must fail.
4. Sign in to a Solid app (for example the SolidOS data browser served locally) choosing
   `http://localhost:8787/` as provider, as Sam. Expect the app to act as `sam`.
5. Share `dana/photos/` with the family; Sam's app can read it, a stranger's cannot.
6. Delete pod `sam` keeping files: the folder remains. Repeat with file deletion: a mistyped
   sentence deletes nothing; the exact sentence deletes the folder.
7. Try to disconnect Dropbox while `dana` lives there: refused, naming `dana`.
