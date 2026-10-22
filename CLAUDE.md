# solidshmolid: working notes

Hosted Solid pods whose bytes live in the user's own Dropbox (then OneDrive,
Drive, WebDAV). `docs/SPEC.md` is the design and the source of truth; read it
before changing behavior, and update it in the same change.

## Shape

- Cloudflare Worker (`worker/runtime/worker.ts`) resolves the pod from the
  host (`POD_HOST_TEMPLATE`) and forwards to one Durable Object per pod
  (`PodObject`, `worker/runtime/podObject.ts`).
- Layers, enforced by `tests/layering.test.ts`: `worker/domain` (pure: paths,
  CSS folder layout, WAC, N3 Patch, conneg), `worker/app` (the `Pod` service
  and its ports), `worker/runtime` (Worker, DO, HTTP, adapters).
- The index lives in the DO's SQLite (`runtime/sqlIndex.ts`); the user's
  storage holds every resource. Writes: storage first, index second, all under
  the pod's `Serial` queue.
- No D1, no R2 for user data.

## Commands

```
make test        # unit tests (vitest, node:sqlite stands in for DO SQLite)
make typecheck
make dev         # wrangler dev on 127.0.0.1:8787, pods at http://<handle>.localhost:8787
POD_URL=http://smoke.localhost:8787 DEV_WEBID='http://smoke.localhost:8787/profile/card#me' make smoke
make build       # wrangler dry-run bundle
make compat      # a stock CSS 7.2 serves a folder we wrote (installs CSS in ~/.cache/solidshmolid)
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
  test's variable is `COMPAT_CSS_BIN`.
- CSS lists a file whose name holds an escaped character (`a%3Ab.txt`)
  double-encoded (`a%253Ab.txt`) while serving the canonical URL; the compat
  test tolerates exactly that.
- `curl --data '@prefix ...'` reads a file named `prefix ...`; use
  `--data-raw` for Turtle/N3 bodies.
- Install scripts for esbuild/workerd are allow-listed in `package.json`
  (`allowScripts`), which npm now requires.

## State

M1 (core resource server on a dev store) is done and smoke-tested on wrangler
dev; the CSS compatibility test passes. Next: JSON-LD conversion, then M2
(Solid-OIDC verification, Dropbox adapter, link flow). Not deployed anywhere
yet; deploying waits for M2 since a pod without auth or storage is useless.
