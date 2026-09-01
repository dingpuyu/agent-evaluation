#!/usr/bin/env python3
"""Import two real RAG pipeline artifact bundles into the evaluation platform."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import urllib.error
import urllib.request


def request(url: str, method: str = "GET", token: str = "", body: dict | None = None, timeout: int = 60) -> dict:
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
        raise RuntimeError(f"{method} {url} returned {exc.code}: {exc.read().decode(errors='replace')[:1200]}") from exc


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
    parser.add_argument("--baseline", required=True)
    parser.add_argument("--candidate", required=True)
    parser.add_argument("--rationale", default="增大窗口、降低 overlap，验证能否保持完整答案单元并减少重复向量成本")
    args = parser.parse_args()

    baseline = load_bundle(args.baseline)
    candidate = load_bundle(args.candidate)
    base = args.evaluation.rstrip("/")
    login = request(base + "/api/v1/session/login", "POST", body={"email": args.email, "password": args.password})
    experiment = request(base + "/api/v1/document-quality/experiments", "POST", login["access_token"], {
        "dataset_split": "development",
        "evaluated_layers": ["ocr", "layout", "cleaning", "chunk"],
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
        "status": "passed",
        "experiment_id": experiment["experiment_id"],
        "promotion_status": experiment["promotion_status"],
        "baseline_cases": f"{comparison['baseline']['cases_passed']}/{comparison['baseline']['cases_total']}",
        "candidate_cases": f"{comparison['candidate']['cases_passed']}/{comparison['candidate']['cases_total']}",
        "fixed_cases": comparison["fixed_cases"],
        "regressed_cases": comparison["regressed_cases"],
        "root_cause_layer": experiment["diagnosis"]["root_cause_layer"],
        "raw_artifacts_persisted": experiment["raw_artifacts_persisted"],
        "production_mutation": experiment["production_mutation"],
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
