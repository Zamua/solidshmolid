# Data Model: Accounts, Households and Solid Sign-In

All state lives in Durable Object SQLite. Each entity below names the object that owns it.

## Account (AccountObject, keyed by Clerk user id)

| field | notes |
| --- | --- |
| clerkUserId | key |
| householdId | one household per account in v1 |
| kind | `adult` (signs in with own identifiers) or `managed` (username only, created by a manager) |
| created | |

**IdentityBinding**: `webid`, `role` (`self` for the account's own pod, never more than one per
account). A manager's access to member pods comes from their ACLs, not from bindings, so a
manager can sign in to apps only as themselves (spec story 2, scenario 3).

**AppApproval**: `clientId` (URL or registered id), `clientName`, `webid`, `approved`,
`lastUsed`. Unique on (`clientId`, `webid`). Revoking deletes it and every refresh-token family
issued under it.

**AuthorizationCode**: `code` (random, hashed at rest), `clientId`, `redirectUri`, `webid`,
`codeChallenge`, `dpopJkt` (if the authorize request bound one), `nonce`, `expires` (60 s).
Consumed on first use; a second use revokes tokens issued from it.

**RefreshTokenFamily**: `familyId`, `clientId`, `webid`, `dpopJkt`, `currentHash`, `expires`.
Rotation on every use; presenting an old token revokes the family.

## Household (HouseholdObject, keyed by household id)

| field | notes |
| --- | --- |
| id | random |
| name | display only |
| created | |

**Member**: `clerkUserId`, `role` (`manager` or `member`), `webid`, `handle`. Invariant: at
least one manager (FR-010). A manager cannot leave or delete their account while they are the
only manager of other members.

**StorageLink**: `linkId`, `provider` (`dropbox`), `providerAccount`, `ownerClerkUserId`,
`refreshToken` (AES-GCM under `TOKEN_KEY`, associated data `household/<id>/link/<linkId>`),
`displayName` (for confirmation sentences), `created`. Cannot be removed while any pod uses it
(FR-018).

**PodPlacement**: `handle`, `linkId`, `folder` (= handle), `state` (`active`, `moving`,
`deleted`). A `moving` placement records `toLinkId`; reads keep serving from `linkId` until the
move commits (FR-017).

**SetupCode** (audit only; the secret lives at Clerk): `memberClerkUserId`, `issuedBy`,
`issued`, `expires` (15 min), `usedAt`.

## Directory (DirectoryObject, single instance)

| table | purpose |
| --- | --- |
| pod ids | `podId` -> `householdId`, `state` (`active` or `deleted`); ids are random, unique, never reused |
| accounts | `clerkUserId` -> `householdId` |
| providerAccounts | `provider`, `providerAccount` -> `householdId`, `linkId` |

## Pod (PodObject, keyed by handle; exists)

Gains `householdId` and `linkId` in its state, replacing its own storage link row. Access tokens
come from the household over RPC. Root ACL shape per FR-012.

## State transitions

```
PodPlacement:  (none) -> active -> moving -> active        (move or handover)
                                \-> deleted               (FR-019; files kept unless confirmed)
Member:        invited -> member -> (handover) -> adult with own household
Pod id:        assigned -> active -> deleted (never reassigned)
```

## Validation rules from the spec

- Pod ids: 8 characters from `23456789abcdefghjkmnpqrstuvwxyz`, assigned by the directory,
  unique and never reused (FR-009).
- Deleting files: `deleteFiles` requires the first-step token and the exact sentence
  `yes, delete my data in <displayName>` (FR-019, SC-006).
- Setup codes: single use, 15 minutes, one member (FR-014).
- Reset login: removes the member's passkeys at Clerk, revokes their app approvals and refresh
  families (FR-015).
