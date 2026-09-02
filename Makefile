.PHONY: install build test deploy-test deploy-init deploy-check deploy-up deploy-verify deploy-status deploy-down up down status smoke studio-smoke split-smoke document-quality-smoke document-quality-import document-quality-holdout pilot document-eval document-compare import-production

DOCKER_COMPOSE ?= $(shell if docker compose version >/dev/null 2>&1; then echo 'docker compose'; elif command -v docker-compose >/dev/null 2>&1; then echo 'docker-compose'; else echo 'docker compose'; fi)
EVALUATION_ENV_FILE ?= .env
RAGLAB_DEPLOY_ENV ?= ../rag-evolution-lab/.env
COMPOSE_ENV_FILE = $(if $(wildcard $(EVALUATION_ENV_FILE)),--env-file $(EVALUATION_ENV_FILE),)
COMPOSE = $(DOCKER_COMPOSE) $(COMPOSE_ENV_FILE)
WITH_ENV = EVALUATION_ENV_FILE=$(EVALUATION_ENV_FILE) ./scripts/run_with_env.sh

install:
	npm ci

build:
	npm run build

test:
	npm test

deploy-test:
	python3 -m unittest discover -s scripts/tests -p 'test_deploy_init.py'

deploy-init:
	python3 scripts/deploy_init.py --raglab-env $(RAGLAB_DEPLOY_ENV) --output $(EVALUATION_ENV_FILE) --host $${DEPLOY_HOST:-localhost}

deploy-check:
	$(WITH_ENV) ./scripts/deploy_preflight.sh

deploy-up: deploy-check
	$(WITH_ENV) $(COMPOSE) up -d --build

deploy-verify:
	$(WITH_ENV) python3 scripts/bootstrap_target.py
	$(WITH_ENV) python3 scripts/smoke.py
	$(WITH_ENV) python3 scripts/studio_smoke.py
	$(WITH_ENV) python3 scripts/split_smoke.py
	$(WITH_ENV) python3 scripts/document_quality_smoke.py

deploy-status:
	$(WITH_ENV) $(COMPOSE) ps

deploy-down:
	$(WITH_ENV) $(COMPOSE) down

up:
	@$(WITH_ENV) $(COMPOSE) up -d --build

down:
	$(WITH_ENV) $(COMPOSE) down

status:
	$(WITH_ENV) $(COMPOSE) ps
	@curl --fail --silent http://127.0.0.1:$${AGENT_EVALUATION_PORT:-18200}/healthz && echo

smoke:
	$(WITH_ENV) python3 scripts/smoke.py

studio-smoke:
	$(WITH_ENV) python3 scripts/studio_smoke.py

split-smoke:
	$(WITH_ENV) python3 scripts/split_smoke.py

document-quality-smoke:
	$(WITH_ENV) python3 scripts/document_quality_smoke.py

document-quality-import:
	@test -n "$${BASELINE}" || (echo "BASELINE=/path/to/baseline-artifacts.json is required" && exit 1)
	@test -n "$${CANDIDATE}" || (echo "CANDIDATE=/path/to/candidate-artifacts.json is required" && exit 1)
	$(WITH_ENV) python3 scripts/import_document_quality_experiment.py --baseline "$${BASELINE}" --candidate "$${CANDIDATE}"

document-quality-holdout:
	@test -n "$${PARENT_EXPERIMENT}" || (echo "PARENT_EXPERIMENT=docqexp_... is required" && exit 1)
	@test -n "$${BASELINE}" || (echo "BASELINE=/path/to/holdout-baseline.json is required" && exit 1)
	@test -n "$${CANDIDATE}" || (echo "CANDIDATE=/path/to/holdout-candidate.json is required" && exit 1)
	$(WITH_ENV) python3 scripts/run_document_quality_holdout_gate.py --parent-experiment "$${PARENT_EXPERIMENT}" --baseline "$${BASELINE}" --candidate "$${CANDIDATE}"

pilot:
	$(WITH_ENV) python3 scripts/pilot.py

document-eval:
	@test -n "$${ARTIFACTS}" || (echo "ARTIFACTS=/path/to/document-artifacts.json is required" && exit 1)
	npm run document-eval -- --artifacts "$${ARTIFACTS}" --split "$${SPLIT:-all}" --layers "$${LAYERS:-ocr,layout,cleaning,chunk,retrieval,safety}"

document-compare:
	@test -n "$${BASELINE}" || (echo "BASELINE=/path/to/baseline-report.json is required" && exit 1)
	@test -n "$${CANDIDATE}" || (echo "CANDIDATE=/path/to/candidate-report.json is required" && exit 1)
	npm run document-compare -- --baseline "$${BASELINE}" --candidate "$${CANDIDATE}"

import-production:
	@test -n "$${INPUT}" || (echo "INPUT=/authorized/export.jsonl is required" && exit 1)
	@test -n "$${REVIEWED_BY}" || (echo "REVIEWED_BY is required" && exit 1)
	python3 scripts/import_production_samples.py --authorized-export --input "$${INPUT}" --output datasets/imported-production-v1.json --reviewed-by "$${REVIEWED_BY}"
