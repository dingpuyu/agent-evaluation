#!/usr/bin/env bash
set -euo pipefail

failures=0
fail() { printf 'FAIL: %s\n' "$*" >&2; failures=$((failures + 1)); }
ok() { printf 'OK: %s\n' "$*"; }

command -v docker >/dev/null 2>&1 || fail "Docker is not installed"
docker info >/dev/null 2>&1 || fail "Docker daemon is not reachable"
if docker compose version >/dev/null 2>&1 || command -v docker-compose >/dev/null 2>&1; then
  ok "Docker Compose is available"
else
  fail "Docker Compose V2 or docker-compose is required"
fi

[[ -f "${EVALUATION_ENV_FILE:-.env}" ]] && ok "private evaluation environment exists" || fail "run make deploy-init first"
[[ -n "${EVALUATION_MODEL_API_KEY:-${DEEPSEEK_API_KEY:-}}" ]] \
  && ok "evaluator model credential is available in the process environment" \
  || fail "export DEEPSEEK_API_KEY (or EVALUATION_MODEL_API_KEY)"

if [[ -f "${EVALUATION_ENV_FILE:-.env}" ]] && grep -Eq '^(DEEPSEEK_API_KEY|EVALUATION_MODEL_API_KEY)=.+' "${EVALUATION_ENV_FILE:-.env}"; then
  fail "model API keys must not be stored in the evaluation .env file"
else
  ok "evaluation file contains no model API key"
fi

for endpoint in "${RAGLAB_HOST_API_URL:-http://127.0.0.1:8080}/healthz" "${RAGLAB_HOST_AGENT_URL:-http://127.0.0.1:8090}/healthz"; do
  curl --fail --silent --show-error "$endpoint" >/dev/null \
    && ok "upstream is healthy: $endpoint" \
    || fail "upstream is unavailable: $endpoint"
done

if (( failures > 0 )); then
  printf 'evaluation_deploy_preflight=failed issues=%d\n' "$failures" >&2
  exit 1
fi
printf 'evaluation_deploy_preflight=passed\n'
