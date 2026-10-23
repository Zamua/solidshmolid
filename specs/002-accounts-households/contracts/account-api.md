# Contract: Account API

JSON over HTTPS on the apex host under `/api/`. Every call needs a Clerk session (cookie or
`Authorization: Bearer <Clerk session token>`); the caller is the signed-in Clerk user. A POST
must carry the apex `Origin`. Pages post plain HTML forms and get a 303 redirect; scripts get
JSON. Errors: `{ "error": "<code>", "message": "..." }` with 400/401/403/404/409.

| method and path | does |
| --- | --- |
| `GET /api/me` | the person and their account (WebID, pods, storage) or null |
| `POST /api/signup` | creates the account and its first pod id and WebID; repeating returns the same |
| `POST /api/storage/{provider}/start` | returns the provider's authorize URL (PKCE) |
| `GET /link/{provider}/callback` | finishes linking; places every pod waiting for storage |
| `POST /api/pods` | adds a pod beside the first, owned by the WebID and listed in its profile (409 before storage is connected) |
| `POST /api/storage/{linkId}/disconnect` | gives up the grant and removes the link; 409 with the pod list while any pod uses it (FR-015) |
| `GET /api/apps` | the apps the person approved |
| `POST /api/apps/revoke` `{clientId}` | removes the approval and ends the app's refresh tokens (FR-007) |
| `POST /api/pods/{id}/delete` `{deleteFiles: false}` | deletes a pod other than the first; keeps its folder; 409 for the WebID pod |
| `POST /api/pods/{id}/delete` `{deleteFiles: true}` | returns `{confirmToken, sentence}`; nothing deleted yet |
| `POST /api/account/delete` `{deleteFiles}` | the same for the whole account: every pod, the grants, the stored records, the Clerk user |
| `POST /api/deletions/confirm` `{token, typed}` | deletes the files only when `typed` equals `sentence` exactly (SC-005); any answer uses the token up |
| `POST /api/pods/{id}/move` `{linkId}` | copies to another link, then switches (FR-014); not built yet |
