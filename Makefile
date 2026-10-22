# Developer targets. Deploy targets live in the private infra repo.
SHELL := /bin/bash
NODE  := npx

.PHONY: help build test typecheck dev smoke

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
