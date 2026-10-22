# Developer targets. Deploy targets live in the private infra repo.
SHELL := /bin/bash
NODE  := npx

.PHONY: help build test typecheck dev smoke compat

help:
	@grep -E '^[a-z-]+:.*?##' $(MAKEFILE_LIST) | sed 's/:.*##/\t/'

build: ## typecheck and bundle the worker (dry run)
	$(NODE) tsc -p worker/tsconfig.json --noEmit
	$(NODE) wrangler deploy --dry-run --outdir .wrangler/dist --config wrangler.jsonc

typecheck: ## typecheck the worker and its tests
	$(NODE) tsc -p worker/tsconfig.json --noEmit
	$(NODE) tsc -p worker/tests/tsconfig.json --noEmit

test: ## unit tests
	$(NODE) vitest run --root worker

dev: ## run the worker locally on :8787 (pods at http://<handle>.localhost:8787)
	$(NODE) wrangler dev --config wrangler.dev.jsonc --ip 127.0.0.1 --port 8787

smoke: ## smoke a running pod (POD_URL, optional DEV_WEBID; see scripts/smoke.sh)
	./scripts/smoke.sh

CSS_VERSION := 7.2.0
CSS_DIR     ?= $(HOME)/.cache/solidshmolid/css-$(CSS_VERSION)

compat: ## check a stock Community Solid Server serves the folders we write
	@test -f $(CSS_DIR)/node_modules/@solid/community-server/bin/server.js || \
	  (mkdir -p $(CSS_DIR) && cd $(CSS_DIR) && npm init -y >/dev/null && \
	   npm install --no-audit --no-fund --ignore-scripts @solid/community-server@$(CSS_VERSION))
	COMPAT_CSS_BIN=$(CSS_DIR)/node_modules/@solid/community-server/bin/server.js \
	  $(NODE) vitest run --root worker tests/compat.test.ts
