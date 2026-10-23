# Contract: Account and Household API

JSON over HTTPS on the apex host under `/api/`. Every call needs a Clerk session (cookie or
`Authorization: Bearer <Clerk session token>`); the caller is the signed-in Clerk user. Errors:
`{ "error": "<code>", "message": "..." }` with 400/401/403/404/409.

| method and path | who | does |
| --- | --- | --- |
| `GET /api/me` | anyone signed in | account, household, own pod, role |
| `POST /api/signup` | new account | creates the household (caller as manager) and assigns the caller's pod id |
| `POST /api/storage/dropbox/start` | manager | returns the Dropbox authorize URL (PKCE) |
| `GET /link/dropbox/callback` | browser | finishes linking; creates the caller's pod in the new link if it has none |
| `GET /api/storage` | manager | storage links with pods using each |
| `DELETE /api/storage/{linkId}` | manager | 409 with the pod list while any pod uses it (FR-018) |
| `POST /api/members` `{name, kind}` | manager | `kind: "managed"` creates a Clerk user (username) and its pod; `kind: "adult"` creates an invitation |
| `POST /api/members/{handle}/setup-code` | manager | returns `{url, expires}` for a QR code (FR-014) |
| `POST /api/members/{handle}/reset-login` | manager | removes passkeys, approvals, refresh families (FR-015) |
| `POST /api/invitations/{id}/accept` | invited adult | joins the household and takes the pod |
| `POST /api/pods/{handle}/move` `{linkId}` | owner or manager | copies to another link, then switches (FR-017) |
| `POST /api/pods/{handle}/handover` | manager | removes manager grants; member continues with own sign-in and storage |
| `POST /api/folders/share` `{handle, path, family: bool}` | pod controller | writes the `acl:agentGroup` rule (FR-016) |
| `GET /api/apps` / `DELETE /api/apps/{clientId}` | anyone signed in | list and revoke own app approvals (FR-007) |
| `POST /api/pods/{handle}/delete` `{deleteFiles: false}` | owner or manager | deletes the pod; keeps the folder |
| `POST /api/pods/{handle}/delete` `{deleteFiles: true}` | owner or manager | returns `{confirmToken, sentence}`; nothing deleted yet |
| `POST /api/pods/{handle}/delete/confirm` `{confirmToken, typed}` | same caller | deletes the files only when `typed` equals `sentence` exactly (SC-006) |
