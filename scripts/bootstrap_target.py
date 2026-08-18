#!/usr/bin/env python3
"""Create the first real target Bad Case from a clean RAG evaluation run."""

from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request


def request(url: str, method: str = "GET", token: str = "", body: dict | None = None, timeout: int = 90) -> dict:
    payload = json.dumps(body).encode() if body is not None else None
    headers = {"Accept": "application/json"}
    if payload is not None:
        headers["Content-Type"] = "application/json"
    if token:
        headers["Authorization"] = f"Bearer {token}"
    try:
        with urllib.request.urlopen(urllib.request.Request(url, data=payload, headers=headers, method=method), timeout=timeout) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        raise RuntimeError(f"{method} {url} returned {error.code}: {error.read().decode(errors='replace')[:1200]}") from error


def main() -> None:
    api = os.getenv("RAGLAB_HOST_API_URL", "http://127.0.0.1:8080").rstrip("/")
    agent = os.getenv("RAGLAB_HOST_AGENT_URL", "http://127.0.0.1:8090").rstrip("/")
    app_id = "tenant_a-medical-device-agent"
    login = request(api + "/api/v1/auth/login", "POST", body={
        "email": os.getenv("AGENT_EVALUATION_EMAIL", "alice@tenant-a.local"),
        "password": os.getenv("AGENT_EVALUATION_PASSWORD", "RagLab-Alice-2026!"),
    })
    token = login["access_token"]
    query = urllib.parse.urlencode({"app_id": app_id})
    existing = request(f"{agent}/api/v1/evaluations/medical-device/bad-cases?{query}", token=token).get("cases", [])
    if existing:
        print(f"target_bootstrap=existing bad_cases={len(existing)}")
        return
    run = request(agent + "/api/v1/evaluations/medical-device/runs", "POST", token, {
        "app_id": app_id,
        "environment_id": app_id + "-dev",
    })
    run_id = run["run_id"]
    deadline = time.monotonic() + 600
    while time.monotonic() < deadline:
        run = request(f"{agent}/api/v1/evaluations/runs/{run_id}", token=token)
        if run.get("status") in {"completed", "failed"}:
            break
        time.sleep(2)
    if run.get("status") != "completed":
        raise RuntimeError(f"target evaluation did not complete: {run.get('status')} {run.get('error', '')}")
    cases = request(f"{agent}/api/v1/evaluations/runs/{run_id}/cases", token=token).get("cases", [])
    failed = [item for item in cases if not item.get("passed")]
    if not failed:
        print(f"target_bootstrap=passed run_id={run_id} cases={len(cases)} bad_case_created=false")
        return
    selected = next((item for item in failed if str(item.get("case_id", "")).startswith("rag:")), failed[0])
    bad_case = request(
        f"{agent}/api/v1/evaluations/runs/{run_id}/cases/{urllib.parse.quote(str(selected['case_id']), safe='')}/bad-case",
        "POST",
        token,
        {"root_cause": "insufficient_corpus", "resolution_note": "Captured from the first clean portable-deployment baseline; requires human review."},
    )
    print(f"target_bootstrap=passed run_id={run_id} failed_cases={len(failed)} bad_case_id={bad_case['bad_case_id']}")


if __name__ == "__main__":
    main()
