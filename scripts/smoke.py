#!/usr/bin/env python3
"""End-to-end smoke test against the independent Agent Evaluation service."""

from __future__ import annotations

import argparse
import json
import os
import urllib.error
import urllib.request


def request(url: str, method: str = "GET", token: str = "", body: dict | None = None, timeout: int = 180) -> dict:
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
        raise RuntimeError(f"{method} {url} returned {exc.code}: {exc.read().decode(errors='replace')[:1000]}") from exc


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--evaluation", default=os.getenv("AGENT_EVALUATION_URL", "http://127.0.0.1:18200"))
    parser.add_argument("--email", default=os.getenv("AGENT_EVALUATION_EMAIL", "alice@tenant-a.local"))
    parser.add_argument("--password", default=os.getenv("AGENT_EVALUATION_PASSWORD", "RagLab-Alice-2026!"))
    args = parser.parse_args()
    base = args.evaluation.rstrip("/")
    health = request(base + "/healthz")
    if not health.get("model_configured"):
        raise RuntimeError("evaluation model key is not configured")
    login = request(base + "/api/v1/session/login", "POST", body={"email": args.email, "password": args.password})
    token = login["access_token"]
    contract = request(base + "/api/v1/targets/raglab/contract", token=token)
    dataset = request(base + "/api/v1/datasets/production-sample", token=token)
    cases = request(base + "/api/v1/targets/raglab/bad-cases", token=token).get("cases") or []
    if not contract.get("flow") or len(dataset.get("cases") or []) < 4:
        raise RuntimeError("target contract or production-shaped dataset is not ready")
    hidden_holdout = [item for item in dataset["cases"] if item.get("split") == "holdout" and item.get("hidden")]
    if len(hidden_holdout) != 8 or any("BeneFusion" in item.get("query", "") for item in hidden_holdout):
        raise RuntimeError("holdout cases were not blinded in the public dataset view")
    run = request(base + "/api/v1/evaluations/runs", "POST", token, {
        "suite_id": "raglab.medical.bad-case.v1", "subject": {"bad_case_id": cases[0]["bad_case_id"]},
    }) if cases else None
    experiment = request(base + "/api/v1/experiments/prompt-comparisons", "POST", token, {
        "prompt_overlay": "回答先给结论，再说明适用范围与需要核验的事实；所有结论必须对应证据。",
        "dataset_split": "development",
        "case_limit": 2,
    }, timeout=300)
    if (run and run.get("status") != "completed") or experiment.get("status") != "completed":
        raise RuntimeError("evaluation smoke did not complete")
    print(json.dumps({
        "status": "passed",
        "business_nodes": len(contract["flow"]),
        "dataset_cases": len(dataset["cases"]),
        "dataset_snapshot": dataset["snapshot_id"],
        "split_summary": dataset["split_summary"],
        "diagnosis": {"run_id": run["run_id"], "root_cause": run["report"]["root_cause"], "metrics": len(run["metrics"])} if run else {"status": "skipped", "reason": "target_has_no_bad_case"},
        "prompt_experiment": {"experiment_id": experiment["experiment_id"], "dataset_split": experiment["dataset_split"], "promotion_status": experiment["promotion_status"], "baseline": experiment["baseline"], "candidate": experiment["candidate"], "regressions": experiment["regressed_cases"]},
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
