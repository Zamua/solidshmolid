# solidshmolid

Solid pods that live in storage you already own.

A [Solid](https://solidproject.org) pod is a personal data store that apps
read and write with your permission. solidshmolid runs the pod server (your
identity, access control, containers, patches), while every file of your pod
lives in a folder in your own Dropbox. Disconnect the service and the folder
is still complete: it uses the same layout as the Community Solid Server
file backend, so any CSS can serve it.

Status: early development. Not deployed yet.

## Run it locally

```
npm install
make dev
```

Pods are created on first request at `http://<handle>.localhost:8787/`. The
local config trusts an `X-Dev-WebID` header as the signed-in user:

```
curl http://alice.localhost:8787/profile/card
curl -H 'X-Dev-WebID: http://alice.localhost:8787/profile/card#me' http://alice.localhost:8787/
curl -X PUT -H 'X-Dev-WebID: http://alice.localhost:8787/profile/card#me' \
     -H 'Content-Type: text/turtle' --data-raw '<#a> <#b> "c".' \
     http://alice.localhost:8787/notes/first.ttl
```

## Tests

```
make test
POD_URL=http://smoke.localhost:8787 DEV_WEBID='http://smoke.localhost:8787/profile/card#me' make smoke
```

## Design

See [docs/SPEC.md](docs/SPEC.md).
