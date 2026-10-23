# Quickstart: validating accounts, pods and Solid sign-in

## Prerequisites

- The Clerk development instance's keys in `~/keys/clerk-solidshmolid-dev.env`; `make
  .dev.vars` copies them, and generates `OIDC_SIGNING_JWK` and `TOKEN_KEY`.
- `~/keys/dropbox-solidshmolid-app-key`, as for spec 001.

## Automated

```
make test        # domain + app: OP flows, accounts, deletion confirmation
make compat      # includes: a stock CSS pod accepts a token our provider issued
make e2e         # wrangler dev, no Clerk: sign up, connect the dev provider, add a pod;
                 # a scripted client signs in through /.oidc and uses its pod
make dev &       # then, with the real Clerk dev instance:
make clerk-live  # a throwaway Clerk user signs in by ticket; the Worker accepts the session
```

Expected: all green; the CSS check proves an independent resource server accepts our tokens.

## By hand (dev server, real Clerk dev instance, real Dropbox)

1. `make dev STORAGE=dropbox`; open `http://localhost:8787/`; sign up; connect Dropbox.
   Expect `Apps/solidshmolid/<id>/` in Dropbox and `http://<id>.localhost:8787/profile/card`
   public.
2. Add a pod. Expect a second folder beside the first, and the profile listing both pods as
   `pim:storage`.
3. Sign in to a Solid app (for example the SolidOS data browser served locally) choosing
   `http://localhost:8787/` as provider. Expect the app to act as your WebID in both pods.
4. Delete the second pod keeping files: the folder remains. Repeat with file deletion: a
   mistyped sentence deletes nothing; the exact sentence deletes the folder.
5. Try to disconnect Dropbox while pods live there: refused, naming them.
