#!/usr/bin/env bash
# Runs the end-to-end suite: starts the dev Worker, then tests/e2e.test.ts
# against it with tokens from a stock CSS identity provider.
set -euo pipefail
: "${COMPAT_CSS_BIN:?set COMPAT_CSS_BIN (make e2e does)}"
PORT="${E2E_PORT:-8799}"
# Pod hosts are *.localhost: macOS resolves those to ::1, Linux to 127.0.0.1.
IP=$([ "$(uname)" = Darwin ] && echo ::1 || echo 127.0.0.1)
log=$(mktemp)
npx wrangler dev --config wrangler.dev.jsonc --ip "$IP" --port "$PORT" --persist-to "$(mktemp -d)" >"$log" 2>&1 &
dev=$!
trap 'kill $dev 2>/dev/null || true; rm -f "$log"' EXIT
for _ in $(seq 1 120); do
  curl -sf "http://localhost:$PORT/healthz" >/dev/null && break
  sleep 0.5
done
curl -sf "http://localhost:$PORT/healthz" >/dev/null || { cat "$log"; exit 1; }
E2E_POD_URL="http://e2e.localhost:$PORT" E2E_APEX_URL="http://localhost:$PORT" npx vitest run --root worker tests/e2e.test.ts tests/e2e-signin.test.ts tests/e2e-signup.test.ts
