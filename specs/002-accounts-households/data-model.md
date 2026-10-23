# Data Model: Accounts, Pods and Solid Sign-In

All state lives in Durable Object SQLite. Each entity below names the object that owns it.

## Account (AccountObject, keyed by account key)

The directory assigns each Clerk user an account key; codes and refresh tokens carry it.

| field | notes |
| --- | --- |
| key | random; names the object |
| webid | the account's one WebID, in its first pod |
| created | |

**Pod**: `podId`, `linkId` (null until storage is connected), `folder` (= podId), in creation
order. The first pod holds the WebID profile; the rest are listed in it as `pim:storage`.

**StorageLink**: `linkId`, `provider` (`dropbox`), `providerAccount`, `refreshToken` (AES-GCM
under `TOKEN_KEY`, associated data `account/<key>/link/<linkId>`), `created`. Cannot be removed
while any pod uses it (FR-015). Access tokens are minted from it on request and kept in memory.

**PendingLink**: `nonce`, PKCE `verifier`, `expires` (15 min). Consumed on the provider's callback,
which must come from the same account.

**AppApproval**: `clientId` (URL or registered id), `clientName`, `webid`, `approved`,
`lastUsed`. Unique on (`clientId`, `webid`). Revoking deletes it and every refresh-token family
issued under it.

**AuthorizationCode**: `code` (random, hashed at rest), `clientId`, `redirectUri`, `webid`,
`codeChallenge`, `dpopJkt` (if the authorize request bound one), `nonce`, `expires` (60 s).
Consumed on first use; a second use revokes tokens issued from it.

**RefreshTokenFamily**: `familyId`, `clientId`, `webid`, `dpopJkt`, `currentHash`, `expires`.
Rotation on every use; presenting an old token revokes the family.

## Directory (DirectoryObject, single instance)

| table | purpose |
| --- | --- |
| person | `clerkUserId` -> account key |
| pod ids | `podId` -> account key, `state` (`active` or `deleted`); ids are random, unique, never reused |
| clients | dynamically registered clients |

## Pod (PodObject, keyed by pod id)

The resource index and RDF cache, plus its **Placement**: `accountKey`, `linkId`, `provider`,
`folder`, and the storage change-feed `cursor`. Access tokens come from the account over RPC.
Root ACL per FR-012.

## State transitions

```
Pod:      (waiting for storage) -> placed -> moving -> placed   (FR-014)
                                          \-> deleted           (FR-016; files kept unless confirmed)
Pod id:   assigned -> active -> deleted (never reassigned)
```

## Validation rules from the spec

- Pod ids: 8 characters from `23456789abcdefghjkmnpqrstuvwxyz`, assigned by the directory,
  unique and never reused (FR-009).
- Deleting files: `deleteFiles` requires the first-step token and the exact sentence
  `yes, delete my data in <displayName>` (FR-016, SC-005).
