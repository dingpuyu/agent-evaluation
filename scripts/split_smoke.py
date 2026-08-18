#!/usr/bin/env python3
"""Verify split blindness and execute one bounded stage comparison per split."""

from __future__ import annotations

import argparse
import json
import os
import urllib.error
import urllib.request


def request(url: str, method: str = "GET", token: str = "", body: dict | None = None, timeout: int = 300) -> dict:
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
    args = parser.parse_args()
    base = args.evaluation.rstrip("/")
    login = request(base + "/api/v1/session/login", "POST", body={"email": args.email, "password": args.password})
    token = login["access_token"]
    dataset = request(base + "/api/v1/datasets/production-sample", token=token)
    hidden = [item for item in dataset["cases"] if item.get("split") == "holdout"]
    if len(hidden) != 8 or not all(item.get("hidden") for item in hidden):
        raise RuntimeError("holdout is visible before execution")
    stages = request(base + "/api/v1/studio/stages", token=token)["stages"]
    stage = next(item for item in stages if item["stage_id"] == "release_judge")
    workspace = request(base + "/api/v1/project-workspaces", "POST", token, {"name": "Split Gate Smoke"})
    runs = []
    for split in ("development", "holdout", "regression"):
        run = request(base + f"/api/v1/project-workspaces/{workspace['workspace_id']}/stage-experiments", "POST", token, {
            "stage_id": stage["stage_id"],
            "candidate_prompt": stage["baseline_prompt"] + (
                "\n逐项列出硬门禁，任一失败时判定不通过。"
                " required_answer_any 是字面证据契约：实际 answer 必须原样包含其中至少一个完整字符串；"
                "只有语义近似、泛化的证据不足提示或 Judge 自行改写都必须判失败。"
            ),
            "dataset_split": split,
            "case_limit": 1,
        })
        if run.get("dataset_split") != split or run.get("dataset_snapshot") != dataset.get("snapshot_id"):
            raise RuntimeError(f"split or snapshot mismatch: {split}")
        if run.get("production_mutation") is not False or len(run.get("results", [])) != 1:
            raise RuntimeError(f"bounded split run failed: {split}")
        runs.append({
            "split": split,
            "experiment_id": run["stage_experiment_id"],
            "baseline_agreement": run["baseline"]["agreement"],
            "candidate_agreement": run["candidate"]["agreement"],
            "promotion_status": run["promotion_status"],
            "case_id": run["results"][0]["case_id"],
        })
    print(json.dumps({
        "status": "passed",
        "dataset_id": dataset["dataset_id"],
        "dataset_version": dataset["version"],
        "dataset_snapshot": dataset["snapshot_id"],
        "holdout_hidden_before_run": len(hidden),
        "runs": runs,
        "production_mutation": False,
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
