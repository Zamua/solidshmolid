# Contributing

Changes land through pull requests with CI green (`make typecheck`, `make test`,
`make compat`, `make e2e`). `docs/SPEC.md` describes the system as built; a
change to behavior updates it in the same pull request. Commit messages are
single-line Conventional Commits.

## Local development

`make dev` keeps pod files in the Worker's own SQLite and offers a one-tap dev
sign-in. Pods are created on first request at `http://<handle>.localhost:8787/`,
and the local config trusts an `X-Dev-WebID` header as the signed-in agent:

```
curl -X PUT -H 'X-Dev-WebID: http://alice.localhost:8787/profile/card#me' \
     -H 'Content-Type: text/turtle' --data-raw '<#a> <#b> "c".' \
     http://alice.localhost:8787/notes/first.ttl
```

To try real Dropbox, Google Drive or Clerk sign-in locally, copy
`.dev.vars.example` to `.dev.vars.local`, fill in what you have, delete
`.dev.vars`, and run `make dev STORAGE=dev,dropbox,google-drive`.

## Principles

### The folder is the pod

The person's own storage holds every byte of every resource. A pod folder uses
the Community Solid Server file-backend layout, so a stock CSS pointed at a copy
of the folder serves the same pod; `make compat` keeps proving this. The service
keeps only a per-pod index and a bounded cache of small RDF documents, both
rebuildable from the folder. Reconcile never deletes or rewrites a file it
cannot map; it reports it and leaves it.

### Protocol fidelity

The server implements the Solid Protocol, Web Access Control, Solid-OIDC and
N3 Patch as specified, checked against a running Community Solid Server
(folder compatibility, real identity-provider tokens, end to end through the
Worker). Every intentional deviation is written in `docs/SPEC.md` with its
reason.

### Least privilege, fail closed

- Storage access uses the narrowest scope a provider offers (the Dropbox App
  folder, Drive `drive.file`).
- No client secret is held where PKCE suffices. Refresh tokens are encrypted
  at rest, bound to their link as associated data.
- An ACL that does not parse grants nothing. Bearer tokens are refused; DPoP
  proofs are checked and never accepted twice.
- Every fetch of a URL a client chose (issuers, JWKS, WebID documents) is
  time-boxed and size-capped. Remote JSON-LD contexts are not fetched.

### Identity is not storage

Accounts (the people who sign in), storage links (connected Dropbox or Drive
accounts), pods (an id plus a folder in some linked storage) and WebIDs are
distinct things. A WebID and every resource URL stay the same when a pod's
storage moves.

### Test first

New behavior starts with a failing test. A guard is covered only when a test
fails with the guard removed. Tests name the property they pin. Provider
behavior is tested against a faithful fake in CI, and against the real provider
before it ships.

### Layered domain

`worker/domain` is pure (no I/O, no runtime imports); `worker/app` orchestrates
through ports; `worker/runtime` holds the Worker, Durable Objects, HTTP
translation and adapters. `worker/tests/layering.test.ts` enforces the
dependency rule. Provider-specific detail stays inside its adapter;
cross-cutting concerns are wired at the composition root.

### Simplicity

Cloudflare-native: one Worker, one Durable Object per pod. A new primitive (D1,
R2, Queues, KV, containers) needs a concrete reason; R2 never holds user data.
