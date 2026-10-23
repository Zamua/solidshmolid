# Developer targets. Deploy targets live in the private infra repo.
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

# The dev Worker's secrets: a fresh token key and signing key, the Dropbox app
# key when DROPBOX_APP_KEY_FILE exists (public, but operator config), the
# Google Drive client when GOOGLE_ENV_FILE exists, and the Clerk dev
# instance's keys when CLERK_ENV_FILE exists.
DROPBOX_APP_KEY_FILE ?= $(HOME)/keys/dropbox-solidshmolid-app-key
GOOGLE_ENV_FILE ?= $(HOME)/keys/google-drive-solidshmolid.env
CLERK_ENV_FILE ?= $(HOME)/keys/clerk-solidshmolid-dev.env
.dev.vars:
	@printf 'TOKEN_KEY=%s\n' "$$(head -c 32 /dev/urandom | base64)" > .dev.vars
	@printf "OIDC_SIGNING_JWK='%s'\n" "$$(node scripts/new-signing-jwk.mjs)" >> .dev.vars
	@if [ -f "$(DROPBOX_APP_KEY_FILE)" ]; then printf 'DROPBOX_APP_KEY=%s\n' "$$(tr -d '\n' < $(DROPBOX_APP_KEY_FILE))" >> .dev.vars; fi
	@if [ -f "$(GOOGLE_ENV_FILE)" ]; then grep -E '^GOOGLE_CLIENT_(ID|SECRET)=' "$(GOOGLE_ENV_FILE)" >> .dev.vars; fi
	@if [ -f "$(CLERK_ENV_FILE)" ]; then grep -E '^CLERK_(PUBLISHABLE|SECRET)_KEY=' "$(CLERK_ENV_FILE)" >> .dev.vars; fi
	@chmod 600 .dev.vars

dev: .dev.vars ## run the worker locally on :8787 (pods at http://<handle>.localhost:8787; STORAGE=dev,dropbox,google-drive offers real ones too)
	$(NODE) wrangler dev --config wrangler.dev.jsonc --ip 127.0.0.1 --port 8787 $(if $(STORAGE),--var STORAGE:$(STORAGE))

live: ## the Dropbox adapter against real Dropbox (DROPBOX_LIVE_TOKEN_FILE holds an app-folder token)
	DROPBOX_LIVE_TOKEN="$$(tr -d '\n' < $${DROPBOX_LIVE_TOKEN_FILE:-$$HOME/keys/dropbox-dev-token})" \
	  $(NODE) vitest run --root worker tests/dropbox.live.test.ts

clerk-live: .dev.vars ## a real Clerk dev session through a running `make dev` (CLERK_ENV_FILE holds the keys)
	set -a && . "$(CLERK_ENV_FILE)" && set +a && CLERK_LIVE_APEX=$${CLERK_LIVE_APEX:-http://localhost:8787} \
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
