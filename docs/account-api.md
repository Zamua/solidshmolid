# Account API

JSON over HTTPS on the apex host under `/api/`. Every call needs a Clerk session (cookie or
`Authorization: Bearer <Clerk session token>`); the caller is the signed-in Clerk user. A POST
must carry the apex `Origin`. Pages post plain HTML forms and get a 303 redirect; scripts get
JSON. Errors: `{ "error": "<code>", "message": "..." }` with 400/401/403/404/409, 405 for the
wrong method on a path below, and 503 or 507 when the person's storage fails or is full.

Under `/api/storage/`, the segment before `start` is a provider name (`dropbox`,
`google-drive`), and the segment before `disconnect` is the id of a connected storage, as
`GET /api/me` lists it.

| method and path | does |
| --- | --- |
| `GET /api/me` | the person and their account (WebID, pods, storage) or null |
| `POST /api/signup` | creates the account and its first pod id and WebID; repeating returns the same |
| `POST /api/storage/{provider}/start` `{newPod}` | returns the provider's authorize URL (PKCE); with `newPod: true`, finishing the flow also adds a pod in the new storage |
| `GET /link/{provider}/callback` | finishes linking; places every pod waiting for storage. Storage the account already has is not linked twice: its link gets the new grant |
| `POST /api/pods/place` | places the pods a failed placement left waiting, in the storage linked last; 409 before storage is connected, 503 or 507 when the storage fails again |
| `POST /api/pods` `{link}` | adds a pod beside the first, owned by the WebID and listed in its profile, in the connected storage `link` names (the first pod's by default; 404 for an unknown one, 409 before storage is connected) |
| `POST /api/storage/{linkId}/disconnect` | gives up the grant and removes the link; 409 with the pod list while any pod uses it. A link another link shares its storage account with is removed without giving the grant up |
| `GET /api/apps` | the apps the person approved |
| `POST /api/apps/revoke` `{clientId}` | removes the approval and ends the app's refresh tokens |
| `POST /api/pods/{id}/delete` `{deleteFiles: false}` | deletes a pod other than the first; keeps its folder; 409 for the WebID pod |
| `POST /api/pods/{id}/delete` `{deleteFiles: true}` | returns `{confirmToken, sentence}`; nothing deleted yet |
| `POST /api/account/delete` `{deleteFiles}` | the same for the whole account: every pod, the grants, the stored records, the Clerk user |
| `POST /api/deletions/confirm` `{token, typed}` | deletes the files only when `typed` equals `sentence` exactly; any answer uses the token up, and a wrong one answers 400 `{code: "not_confirmed", confirmToken, sentence}` with a fresh token |

There is no call to move a pod to another storage. A link gets a new grant when the person connects the same storage account again (`start`, then the callback): the link keeps its id and its pods carry on. Each entry of `storage` says `needsReconnect` when its grant stopped working.
