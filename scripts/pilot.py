#!/usr/bin/env python3
"""Run and verify the first complete platform pilot."""

from __future__ import annotations

import argparse
import json
import os
import time
import urllib.error
import urllib.request


def request(url: str, method: str = "GET", token: str = "", body: dict | None = None, timeout: int = 60) -> dict:
    payload = json.dumps(body).encode() if body is not None else None
    headers = {"Accept": "application/json"}
    if payload is not None:
        headers["Content-Type"] = "application/json"
    if token:
        headers["Authorization"] = "Bearer " + token
    try:
        with urllib.request.urlopen(urllib.request.Request(url, data=payload, headers=headers, method=method), timeout=timeout) as response:
            return json.load(response)
    except urllib.error.HTTPError as exc:
        raise RuntimeError(f"{method} {url} returned {exc.code}: {exc.read().decode(errors='replace')[:1200]}") from exc


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--evaluation", default="http://127.0.0.1:18200")
    parser.add_argument("--email", default=os.getenv("AGENT_EVALUATION_EMAIL", "alice@tenant-a.local"))
    parser.add_argument("--password", default=os.getenv("AGENT_EVALUATION_PASSWORD", "RagLab-Alice-2026!"))
    parser.add_argument("--max-wait", type=int, default=240)
    args = parser.parse_args()
    base = args.evaluation.rstrip("/")
    login = request(base + "/api/v1/session/login", "POST", body={"email": args.email, "password": args.password})
    token = login["access_token"]
    overview = request(base + "/api/v1/platform/overview", token=token)
    plan = request(base + "/api/v1/plans/raglab-medical-sales-baseline-v1", token=token)
    run = request(base + "/api/v1/pilots/raglab-medical-sales-baseline-v1/runs", "POST", token, {})
    deadline = time.monotonic() + args.max_wait
    while run.get("status") in {"queued", "running"} and time.monotonic() < deadline:
        time.sleep(1)
        run = request(base + "/api/v1/pilots/" + run["pilot_run_id"], token=token)
    if run.get("status") not in {"completed", "failed"}:
        raise RuntimeError("pilot did not finish before timeout")
    if run.get("status") == "failed":
        raise RuntimeError("pilot failed: " + str(run.get("error") or "unknown error"))
    if run.get("cases_completed") != plan["dataset"]["case_count"]:
        raise RuntimeError("pilot did not execute the frozen dataset")
    print(json.dumps({
        "status": "completed",
        "platform": overview["platform"],
        "pilot_run_id": run["pilot_run_id"],
        "plan_id": run["plan_id"],
        "target_id": run["target_id"],
        "workflow_nodes": len(plan["workflow"]),
        "dataset": plan["dataset"],
        "baseline": run["baseline"],
        "gate_passed": run["gate_passed"],
        "gates": run["gates"],
        "failed_cases": run["failed_cases"],
        "intervention_guidance": run["intervention_guidance"],
        "production_mutation": run["production_mutation"],
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
