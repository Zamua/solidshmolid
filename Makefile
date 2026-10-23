# Developer targets. Deploying is up to whoever runs it; see docs/self-hosting.md.
SHELL := /bin/bash
NODE  := npx

.PHONY: help build test typecheck dev smoke compat e2e live icons

help:
	@grep -E '^[a-z-]+:.*?##' $(MAKEFILE_LIST) | sed 's/:.*##/\t/'

build: ## typecheck and bundle the worker (dry run)
	$(NODE) tsc -p worker/tsconfig.json --noEmit
	$(NODE) wrangler deploy --dry-run --outdir .wrangler/dist --config wrangler.jsonc

typecheck: ## typecheck the worker and its tests
	$(NODE) tsc -p worker/tsconfig.json --noEmit
	$(NODE) tsc -p worker/tests/tsconfig.json --noEmit

icons: ## regenerate the page icons from @phosphor-icons/core (names in scripts/icons.mjs)
	node scripts/icons.mjs

test: ## unit tests
	$(NODE) vitest run --root worker

# The dev Worker's secrets: a fresh token key and signing key, then whatever
# provider and Clerk keys .dev.vars.local holds (see .dev.vars.example).
.dev.vars:
	@printf 'TOKEN_KEY=%s\n' "$$(head -c 32 /dev/urandom | base64)" > .dev.vars
	@printf "OIDC_SIGNING_JWK='%s'\n" "$$(node scripts/new-signing-jwk.mjs)" >> .dev.vars
	@if [ -f .dev.vars.local ]; then cat .dev.vars.local >> .dev.vars; fi
	@chmod 600 .dev.vars

dev: .dev.vars ## run the worker locally on :8787 (pods at http://<handle>.localhost:8787; STORAGE=dev,dropbox,google-drive offers real ones too)
	$(NODE) wrangler dev --config wrangler.dev.jsonc --ip 127.0.0.1 --port 8787 $(if $(STORAGE),--var STORAGE:$(STORAGE))

live: ## the Dropbox adapter against real Dropbox (DROPBOX_LIVE_TOKEN: an app-folder access token)
	@test -n "$$DROPBOX_LIVE_TOKEN" || { echo 'set DROPBOX_LIVE_TOKEN'; exit 1; }
	$(NODE) vitest run --root worker tests/dropbox.live.test.ts

clerk-live: .dev.vars ## a real Clerk dev session through a running `make dev` (Clerk keys in .dev.vars.local)
	set -a && . ./.dev.vars.local && set +a && CLERK_LIVE_APEX=$${CLERK_LIVE_APEX:-http://localhost:8787} \
	  $(NODE) vitest run --root worker tests/clerk.live.test.ts

smoke: ## smoke a running deployment (APEX_URL; optional POD_URL, NO_POD_URL, DEV_WEBID; see scripts/smoke.sh)
	./scripts/smoke.sh

CSS_VERSION := 7.2.0
CSS_DIR     ?= $(HOME)/.cache/solidshmolid/css-$(CSS_VERSION)

CSS_BIN     := $(CSS_DIR)/node_modules/@solid/community-server/bin/server.js

$(CSS_BIN):
	mkdir -p $(CSS_DIR) && cd $(CSS_DIR) && npm init -y >/dev/null && \
	  npm install --no-audit --no-fund --ignore-scripts @solid/community-server@$(CSS_VERSION)

compat: $(CSS_BIN) ## a stock CSS serves the folders we write, and its tokens verify here
	COMPAT_CSS_BIN=$(CSS_BIN) $(NODE) vitest run --root worker tests/compat.test.ts tests/idp.test.ts

e2e: $(CSS_BIN) .dev.vars ## a CSS WebID uses a dev pod through the Worker (starts wrangler dev)
	COMPAT_CSS_BIN=$(CSS_BIN) ./scripts/e2e.sh
