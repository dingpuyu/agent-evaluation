.PHONY: install build test up down status smoke import-production

DOCKER_COMPOSE ?= docker-compose

install:
	npm ci

build:
	npm run build

test:
	npm test

up:
	@DEEPSEEK_API_KEY="$${DEEPSEEK_API_KEY:-$$(launchctl getenv DEEPSEEK_API_KEY 2>/dev/null)}" $(DOCKER_COMPOSE) up -d --build

down:
	$(DOCKER_COMPOSE) down

status:
	$(DOCKER_COMPOSE) ps
	@curl --fail --silent http://127.0.0.1:$${AGENT_EVALUATION_PORT:-18200}/healthz && echo

smoke:
	python3 scripts/smoke.py --evaluation http://127.0.0.1:$${AGENT_EVALUATION_PORT:-18200}

import-production:
	@test -n "$${INPUT}" || (echo "INPUT=/authorized/export.jsonl is required" && exit 1)
	@test -n "$${REVIEWED_BY}" || (echo "REVIEWED_BY is required" && exit 1)
	python3 scripts/import_production_samples.py --authorized-export --input "$${INPUT}" --output datasets/imported-production-v1.json --reviewed-by "$${REVIEWED_BY}"
