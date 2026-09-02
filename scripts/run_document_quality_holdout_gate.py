#!/usr/bin/env python3
"""Consume one frozen Document Quality Holdout attempt through the platform API."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import urllib.error
import urllib.request


def request(url: str, method: str = "GET", token: str = "", body: dict | None = None, timeout: int = 420) -> dict:
    payload = json.dumps(body, ensure_ascii=False).encode("utf-8") if body is not None else None
    headers = {"Accept": "application/json"}
    if payload is not None:
        headers["Content-Type"] = "application/json; charset=utf-8"
    if token:
        headers["Authorization"] = "Bearer " + token
    try:
        with urllib.request.urlopen(urllib.request.Request(url, data=payload, headers=headers, method=method), timeout=timeout) as response:
            return json.load(response)
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode(errors="replace")[:1600]
        raise RuntimeError(f"{method} {url} returned {exc.code}: {detail}") from exc


def load_bundle(path: str) -> dict:
    source = Path(path)
    if not source.is_file():
        raise RuntimeError(f"artifact bundle does not exist: {source}")
    payload = json.loads(source.read_text(encoding="utf-8"))
    if payload.get("schema") != "agent-evaluation.document-quality.artifacts.v1":
        raise RuntimeError(f"unsupported artifact bundle schema: {source}")
    return payload


def profile(bundle: dict) -> str:
    config = bundle.get("config") or {}
    return f"{config.get('max_runes', '?')}/{config.get('overlap_runes', '?')}"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evaluation", default=os.getenv("AGENT_EVALUATION_URL", "http://127.0.0.1:18200"))
    parser.add_argument("--email", default=os.getenv("AGENT_EVALUATION_EMAIL", "alice@tenant-a.local"))
    parser.add_argument("--password", default=os.getenv("AGENT_EVALUATION_PASSWORD", "RagLab-Alice-2026!"))
    parser.add_argument("--parent-experiment", required=True)
    parser.add_argument("--baseline", required=True)
    parser.add_argument("--candidate", required=True)
    parser.add_argument("--rationale", default="冻结开发集晋级参数，对未参与调参的文档执行一次性 Holdout")
    args = parser.parse_args()

    baseline = load_bundle(args.baseline)
    candidate = load_bundle(args.candidate)
    base = args.evaluation.rstrip("/")
    login = request(base + "/api/v1/session/login", "POST", body={"email": args.email, "password": args.password})
    experiment = request(base + "/api/v1/document-quality/holdout-gates", "POST", login["access_token"], {
        "parent_experiment_id": args.parent_experiment,
        "intervention": {
            "variable": "chunk_profile",
            "baseline": profile(baseline),
            "candidate": profile(candidate),
            "rationale": args.rationale,
        },
        "baseline_artifacts": baseline,
        "candidate_artifacts": candidate,
    })
    comparison = experiment["comparison"]
    print(json.dumps({
        "status": "completed",
        "experiment_id": experiment["experiment_id"],
        "parent_experiment_id": experiment["release_gate"]["parent_experiment_id"],
        "promotion_status": experiment["promotion_status"],
        "verdict": experiment["release_gate"]["verdict"],
        "candidate_fingerprint": experiment["release_gate"]["candidate_fingerprint"],
        "baseline_cases": f"{comparison['baseline']['cases_passed']}/{comparison['baseline']['cases_total']}",
        "candidate_cases": f"{comparison['candidate']['cases_passed']}/{comparison['candidate']['cases_total']}",
        "failed_cases": experiment["candidate_report"]["failed_cases"],
        "failure_layers": experiment["candidate_report"]["layer_failures"],
        "provider": experiment["retrieval_sandbox"]["candidate"]["provider"],
        "chunks_indexed": experiment["retrieval_sandbox"]["candidate"]["chunks_indexed"],
        "cleanup_completed": experiment["retrieval_sandbox"]["candidate"]["cleanup_completed"],
        "production_mutation": experiment["production_mutation"],
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
