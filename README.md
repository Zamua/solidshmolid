# solidshmolid

[Solid](https://solidproject.org) pods whose files live in your own Dropbox or
Google Drive. solidshmolid runs the pod server (identity, access control, the
Solid protocol); every file sits in a folder in your storage, in the Community
Solid Server layout, so any CSS can serve it without us.

## Develop

Needs Node 22 or later.

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
