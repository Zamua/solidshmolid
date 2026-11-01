# Solid-OIDC provider

Served on the apex host (`pods.example` below; `localhost:8787` in development).
Conforms to Solid-OIDC; deviations are listed at the end.

## Discovery: `GET /.well-known/openid-configuration`

```json
{
  "issuer": "https://pods.example/",
  "authorization_endpoint": "https://pods.example/.oidc/auth",
  "token_endpoint": "https://pods.example/.oidc/token",
  "jwks_uri": "https://pods.example/.oidc/jwks",
  "registration_endpoint": "https://pods.example/.oidc/reg",
  "end_session_endpoint": "https://pods.example/.oidc/session/end",
  "scopes_supported": ["openid", "webid", "offline_access"],
  "response_types_supported": ["code"],
  "grant_types_supported": ["authorization_code", "refresh_token"],
  "code_challenge_methods_supported": ["S256"],
  "token_endpoint_auth_methods_supported": ["none", "client_secret_basic"],
  "dpop_signing_alg_values_supported": ["ES256", "ES384", "ES512", "PS256", "PS384", "PS512", "RS256", "RS384", "RS512", "EdDSA"],
  "id_token_signing_alg_values_supported": ["ES256"],
  "solid_oidc_supported": "https://solidproject.org/TR/solid-oidc"
}
```

## `GET /.oidc/jwks`

The provider's public keys; `Cache-Control: max-age=300`.

## `GET /.oidc/auth`

Query: `client_id`, `redirect_uri`, `response_type=code`, `scope` (must include `openid webid`),
`code_challenge`, `code_challenge_method=S256`, `state`, optional `nonce`, `prompt`.

1. Resolve the client: a URL `client_id` is fetched as a Client ID Document (time-boxed,
   size-capped); its `redirect_uris` must contain `redirect_uri` exactly. The value
   `http://www.w3.org/ns/solid/terms#PublicOidcClient` is a public client with no redirect check
   beyond https or localhost. Registered ids are looked up.
2. No Clerk session: redirect to `/sign-in?return=<this URL>`.
3. Show the consent page: client name and origin, the identity it will receive (the account's
   own WebID), Approve / Deny. Skipped when an approval exists and `prompt` is not `consent`.
4. Approve: redirect to `redirect_uri?code=…&state=…&iss=…`. Deny: `error=access_denied`.

## `POST /.oidc/token`

Requires a `DPoP` header on every call.

- `grant_type=authorization_code`: `code`, `redirect_uri`, `client_id`, `code_verifier`.
- `grant_type=refresh_token`: `refresh_token`, `client_id`; the DPoP key must equal the family's.

A code redeems once (`nextCode` in `domain/identity/oidc.ts`). Presented again, it is refused
and every refresh family it produced is revoked, including one still being issued when the
replay lands. Revoking an app revokes its outstanding codes with its families.

Response:

```json
{
  "access_token": "<JWT>",
  "token_type": "DPoP",
  "expires_in": 3600,
  "id_token": "<JWT>",
  "refresh_token": "<opaque, only with offline_access>",
  "scope": "openid webid offline_access"
}
```

Access token claims: `iss`, `aud: ["solid", <client_id>]`, `sub` (the WebID), `webid`,
`client_id`, `azp`, `cnf: {"jkt": <DPoP thumbprint>}`, `iat`, `exp`, `jti`.
ID token claims: `iss`, `aud: <client_id>`, `sub` (the WebID), `webid`, `azp`, `nonce`,
`iat`, `exp`.

Errors follow RFC 6749 (`invalid_grant`, `invalid_client`, `invalid_dpop_proof`, ...).

## `POST /.oidc/reg`

Dynamic client registration for clients without a Client ID Document: accepts up to 10
`redirect_uris` (each at most 2048 characters) and a `client_name` (cut to 100 characters) in a
body of at most 16 KiB; returns `client_id` (and no secret for `token_endpoint_auth_method: none`).
A registration no one has signed in through (redeemed a code for) within 7 days is dropped.

## `GET|POST /.oidc/session/end`

Asks the person whether to sign out of this site, and signs them out when
they confirm, landing on the front page. A `post_logout_redirect_uri` is
ignored, so the endpoint cannot send anyone elsewhere.

## Deviations

- Only the authorization code flow with PKCE; no implicit flow.
- A person can only receive their own WebID.
- The public client (`http://www.w3.org/ns/solid/terms#PublicOidcClient`) is asked for consent
  every time: it may name any redirect, so an earlier approval says nothing about who receives
  the code. The consent page names the host the code goes to.
