# solidshmolid

[Solid](https://solidproject.org) pods whose files live in your own Dropbox or
Google Drive. solidshmolid runs the pod server (identity, access control, the
Solid protocol); every file sits in a folder in your storage, in the Community
Solid Server layout, so a stock CSS can serve the same files.

The public instance runs at `solidshmolid.com`.

## What works, and what does not

Works: reading and writing documents and containers (`GET`, `HEAD`, `PUT`,
`POST`, `DELETE`), N3 Patch, SPARQL Update with ground triples, Turtle, JSON-LD and N-Triples, Web Access
Control, Solid-OIDC with DPoP (as a resource server, and as an identity
provider for its own WebIDs), several pods per person, Dropbox and Google
Drive.

Not there:

- SPARQL Update beyond `INSERT DATA` and `DELETE DATA` (what client
  libraries send to save a document): no variables, `WHERE` or graphs.
- Solid Notifications, description resources and an LDN inbox.
- `acl:agentGroup` and `acl:origin` in access rules, and ACP.
- Fixing a storage connection whose access was removed at the provider, and
  moving a pod to other storage.

[docs/SPEC.md](docs/SPEC.md) has the full list under "Conformance".

## Develop

Use Node 26, the version CI runs.

```
npm install
make dev     # http://localhost:8787, no accounts needed
make test
```

`make compat` and `make e2e` check against a real Community Solid Server.

## Docs

- [Design](docs/SPEC.md)
- [Self-hosting](docs/self-hosting.md)
- [Contributing](CONTRIBUTING.md)
- [Account API](docs/account-api.md) and [identity provider](docs/oidc.md)

MIT licensed.
