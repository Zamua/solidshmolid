#!/usr/bin/env bash
# Smoke a running deployment through its public HTTP surface.
#
#   APEX_URL=https://example.com NO_POD_URL=https://zzzzzzzz.pods.example ./scripts/smoke.sh
#   APEX_URL=http://localhost:8787 POD_URL=http://smoke.localhost:8787 \
#     DEV_WEBID=http://smoke.localhost:8787/profile/card#me ./scripts/smoke.sh
#
# APEX_URL is the account site and identity provider. POD_URL, when set, is a
# provisioned pod; NO_POD_URL a pod host that must not exist. With DEV_WEBID
# (local dev config only) the write cycle runs too. Every request must also
# finish within SMOKE_LATENCY_BUDGET_MS: a deployment that answers correctly
# but slowly fails.
set -uo pipefail

APEX_URL="${APEX_URL:?set APEX_URL to the account site}"
APEX_URL="${APEX_URL%/}"
POD_URL="${POD_URL:-}"
POD_URL="${POD_URL%/}"
NO_POD_URL="${NO_POD_URL:-}"
BUDGET_MS="${SMOKE_LATENCY_BUDGET_MS:-6000}"
DEV_WEBID="${DEV_WEBID:-}"
pass=0
fail=0

# request NAME EXPECTED_STATUS CURL_ARGS... ; leaves the body in $BODY, headers in $HEADERS
request() {
  local name=$1 expected=$2
  shift 2
  local out
  out=$(curl -sS -o /tmp/smoke.body.$$ -D /tmp/smoke.headers.$$ -w '%{http_code} %{time_total}' "$@" 2>&1)
  local status=${out%% *} secs=${out##* }
  local ms
  ms=$(awk -v s="$secs" 'BEGIN { printf "%d", s * 1000 }')
  BODY=$(cat /tmp/smoke.body.$$ 2>/dev/null)
  HEADERS=$(tr -d '\r' < /tmp/smoke.headers.$$ 2>/dev/null)
  if [ "$status" != "$expected" ]; then
    printf 'FAIL %-34s status %s, want %s\n' "$name" "$status" "$expected"
    fail=$((fail + 1))
    return 1
  fi
  if [ "$ms" -gt "$BUDGET_MS" ]; then
    printf 'FAIL %-34s %sms over the %sms budget\n' "$name" "$ms" "$BUDGET_MS"
    fail=$((fail + 1))
    return 1
  fi
  printf 'PASS %-34s %s %5sms\n' "$name" "$status" "$ms"
  pass=$((pass + 1))
}

expect() {
  local name=$1 haystack=$2 needle=$3
  if grep -qiF -- "$needle" <<<"$haystack"; then
    pass=$((pass + 1))
  else
    printf 'FAIL %-34s missing %s\n' "$name" "$needle"
    fail=$((fail + 1))
  fi
}

request 'healthz' 200 "$APEX_URL/healthz"
request 'welcome page' 200 "$APEX_URL/" && expect 'welcome says what it is' "$BODY" 'A home for your data'
request 'sign-in page' 200 "$APEX_URL/sign-in"
request 'privacy page' 200 "$APEX_URL/privacy"
request 'provider discovery' 200 "$APEX_URL/.well-known/openid-configuration" && expect 'names its issuer' "$BODY" "\"issuer\":\"$APEX_URL/\""
request 'provider keys' 200 "$APEX_URL/.oidc/jwks" && expect 'publishes a key' "$BODY" '"kty"'
request 'account API needs a session' 401 -X POST -H "Origin: $APEX_URL" "$APEX_URL/api/signup"
request 'account API refuses other sites' 403 -X POST -H 'Origin: https://elsewhere.example' "$APEX_URL/api/signup"

if [ -n "$NO_POD_URL" ]; then
  request 'unknown pod is not found' 404 "${NO_POD_URL%/}/"
fi

if [ -n "$POD_URL" ]; then
  request 'profile is public' 200 "$POD_URL/profile/card" && expect 'profile is a profile' "$BODY" 'PersonalProfileDocument'
  request 'root needs credentials' 401 "$POD_URL/" && expect 'root asks for DPoP' "$HEADERS" 'WWW-Authenticate: DPoP'
  request 'CORS preflight' 204 -X OPTIONS -H 'Origin: https://app.example' -H 'Access-Control-Request-Method: PUT' "$POD_URL/x" &&
    expect 'preflight echoes origin' "$HEADERS" 'Access-Control-Allow-Origin: https://app.example'
fi

if [ -n "$DEV_WEBID" ] && [ -n "$POD_URL" ]; then
  as=(-H "X-Dev-WebID: $DEV_WEBID")
  doc="$POD_URL/smoke/$RANDOM$RANDOM.ttl"
  request 'PUT creates' 201 "${as[@]}" -X PUT -H 'Content-Type: text/turtle' --data '<#s> <#p> "one".' "$doc"
  request 'GET reads back' 200 "${as[@]}" "$doc" && expect 'body round-trips' "$BODY" '"one"'
  request 'PATCH inserts' 204 "${as[@]}" -X PATCH -H 'Content-Type: text/n3' \
    --data-raw '@prefix solid: <http://www.w3.org/ns/solid/terms#>. _:p a solid:InsertDeletePatch; solid:inserts { <#s> <#p> "two" }.' "$doc"
  request 'GET as N-Triples' 200 "${as[@]}" -H 'Accept: application/n-triples' "$doc" && expect 'patch applied' "$BODY" '"two"'
  request 'container lists it' 200 "${as[@]}" "$POD_URL/smoke/" && expect 'ldp:contains' "$BODY" "${doc##*/}"
  request 'DELETE document' 204 "${as[@]}" -X DELETE "$doc"
  request 'GET after delete' 404 "${as[@]}" "$doc"
  request 'DELETE emptied container' 204 "${as[@]}" -X DELETE "$POD_URL/smoke/"
fi

rm -f /tmp/smoke.body.$$ /tmp/smoke.headers.$$
printf '%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
