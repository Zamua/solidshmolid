# solidshmolid: working notes

Hosted Solid pods whose bytes live in the user's own Dropbox (then OneDrive,
Drive, WebDAV). `docs/SPEC.md` is the design and the source of truth; read it
before changing behavior, and update it in the same change.

## Shape

Layers and bounded contexts, enforced by `worker/tests/layering.test.ts`:

```
worker/domain/{shared,pods,identity,households}   pure rules, no I/O
worker/app/{shared,pods,storage,identity}         services + their ports (ports.ts per context)
worker/runtime/
  composition.ts    the one place that picks adapters and builds services
  worker.ts         entry: routes by host
  http/             translation only (solid.ts, oidc.ts, link.ts, dev.ts, pages/)
  adapters/         SQL stores, Dropbox, OAuth, token signer/verifier, sessions
  objects/          Durable Objects as thin shells (Pod, Account, Directory)
```

- One `PodObject` per handle; `AccountObject` per person (provider state);
  one `DirectoryObject` (account keys, handles, registered clients).
- The user's storage holds every resource; the pod index and a small RDF cache
  live in the pod's SQLite. Writes: storage first, index second, under the
  pod's `Serial` queue.
- The Solid-OIDC provider (`app/identity/provider.ts`) issues DPoP-bound
  tokens; `make e2e` proves a stock CSS accepts them.
- No D1, no R2 for user data.

## Commands

```
make test        # unit tests (vitest, node:sqlite stands in for DO SQLite)
make typecheck
make dev         # wrangler dev on 127.0.0.1:8787, pods at http://<handle>.localhost:8787
POD_URL=http://smoke.localhost:8787 DEV_WEBID='http://smoke.localhost:8787/profile/card#me' make smoke
make build       # wrangler dry-run bundle
make compat      # a stock CSS 7.2 serves a folder we wrote, and its tokens verify (CSS in ~/.cache/solidshmolid)
make e2e         # wrangler dev on ::1: CSS WebIDs use a dev pod; our provider signs a client in; CSS accepts our token
```

`wrangler.dev.jsonc` sets `DEV_MODE=1`: pods are created on first request,
`X-Dev-WebID` names the agent, and files go to the DO's own SQLite
(`DevFileStore`, 2 MB per file). Deployed configs never set it.
`wrangler.jsonc` is the deploy contract; per-environment files live in
`infra/solidshmolid/`.

## Gotchas

- The folder layout must stay byte-compatible with Community Solid Server's
  file backend (`domain/layout.ts`); CSS 7.2 uses `mime-types` 2.1.35, so that
  version is pinned on purpose. Bumping it can rename users' files.
- The pod base is per request (`x-solidshmolid-base`); the owner WebID baked
  into a pod's ACL at provisioning uses the base of that first request. In dev,
  always use `http://<handle>.localhost:8787` (with the port), or the owner
  WebID will not match.
- CSS reads every `CSS_*` environment variable as a CLI option, so the compat
  test's variable is `COMPAT_CSS_BIN`; and under the test runner's
  `NODE_ENV=test` its OIDC stack calls `jest`. `tests/support/css.ts` spawns it
  with a bare env.
- CSS lists a file whose name holds an escaped character (`a%3Ab.txt`)
  double-encoded (`a%253Ab.txt`) while serving the canonical URL; the compat
  test tolerates exactly that.
- macOS resolves `*.localhost` to `::1` and Linux to `127.0.0.1`, so
  scripts/e2e.sh binds wrangler to whichever the platform uses; anything that
  fetches a dev pod host (the verifier, CSS) depends on it.
- `worker/tests/tsconfig.json` sets `"exclude": []`: inheriting the base's
  `exclude: ["tests"]` silently skipped typechecking every test.
- Clerk: app `solidshmolid` (`app_3L4g4ToFucNUwJdtcubuwAogbRp`), dev keys in
  `~/keys/clerk-solidshmolid-dev.env`. `clerk api` reads a request body from
  stdin when stdin is not a terminal, so scripted calls hang unless given
  `< /dev/null`.
- `curl --data '@prefix ...'` reads a file named `prefix ...`; use
  `--data-raw` for Turtle/N3 bodies.
- Install scripts for esbuild/workerd are allow-listed in `package.json`
  (`allowScripts`), which npm now requires.

## State

M1 (core resource server on a dev store) is done and smoke-tested on wrangler
dev; JSON-LD, the CSS compatibility test and Solid-OIDC verification are in.
Next in M2: the Dropbox adapter and link flow (waiting on the Dropbox app
registration), then reconcile. Not deployed anywhere
yet; deploying waits for M2 since a pod without auth or storage is useless.
