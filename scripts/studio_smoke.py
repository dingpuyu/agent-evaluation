#!/usr/bin/env python3
"""End-to-end smoke for project discovery chat and stage Prompt comparison."""

from __future__ import annotations

import argparse
import json
import os
import urllib.error
import urllib.request


def request(url: str, method: str = "GET", token: str = "", body: dict | None = None, timeout: int = 240) -> dict:
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
    parser.add_argument("--evaluation", default=os.getenv("AGENT_EVALUATION_URL", "http://127.0.0.1:18200"))
    parser.add_argument("--email", default=os.getenv("AGENT_EVALUATION_EMAIL", "alice@tenant-a.local"))
    parser.add_argument("--password", default=os.getenv("AGENT_EVALUATION_PASSWORD", "RagLab-Alice-2026!"))
    args = parser.parse_args()
    base = args.evaluation.rstrip("/")
    login = request(base + "/api/v1/session/login", "POST", body={"email": args.email, "password": args.password})
    token = login["access_token"]
    stages = request(base + "/api/v1/studio/stages", token=token)["stages"]
    dataset = request(base + "/api/v1/datasets/production-sample", token=token)
    workspace = request(base + "/api/v1/project-workspaces", "POST", token, {"name": "Studio Smoke · 医疗设备 Agent"})
    workspace = request(base + f"/api/v1/project-workspaces/{workspace['workspace_id']}/messages", "POST", token, {
        "message": "请读取当前 RAG Agent、冻结数据集和最近质量结果，梳理目标用户、关键任务、最高风险与第一个评测切入点。",
    })
    retrieval = next(item for item in stages if item["stage_id"] == "retrieval_judge")
    experiment = request(base + f"/api/v1/project-workspaces/{workspace['workspace_id']}/stage-experiments", "POST", token, {
        "stage_id": retrieval["stage_id"],
        "candidate_prompt": retrieval["baseline_prompt"] + "\n对多实体问题逐一核对必需文档，缺少任何实体专属证据时判失败。",
        "dataset_split": "development",
        "case_limit": 2,
    })
    if len(workspace.get("messages", [])) < 3 or not workspace.get("brief", {}).get("business_goal"):
        raise RuntimeError("project discovery did not produce a persisted brief")
    recommended_stage = workspace["brief"].get("recommended_stage_id")
    if recommended_stage not in {"scope_judge", "retrieval_judge", "answer_judge", "release_judge"}:
        raise RuntimeError("project discovery did not select an editable judge stage")
    if not workspace["brief"].get("recommended_prompt_hypothesis"):
        raise RuntimeError("project discovery did not publish a prompt hypothesis")
    if experiment.get("status") != "completed" or len(experiment.get("results", [])) != 2:
        raise RuntimeError("stage prompt comparison did not complete")
    if experiment.get("dataset_split") != "development" or experiment.get("dataset_snapshot") != dataset.get("snapshot_id"):
        raise RuntimeError("stage prompt comparison did not preserve the selected frozen snapshot")
    print(json.dumps({
        "status": "passed",
        "workspace_id": workspace["workspace_id"],
        "readiness_score": workspace["brief"]["readiness_score"],
        "recommended_stage_id": recommended_stage,
        "recommended_prompt_hypothesis": workspace["brief"]["recommended_prompt_hypothesis"],
        "agent_steps": workspace["last_agent_steps"],
        "editable_stages": [item["stage_id"] for item in stages if item["prompt_editable"]],
        "locked_stages": [item["stage_id"] for item in stages if not item["prompt_editable"]],
        "stage_experiment_id": experiment["stage_experiment_id"],
        "dataset_split": experiment["dataset_split"],
        "dataset_snapshot": experiment["dataset_snapshot"],
        "promotion_status": experiment["promotion_status"],
        "baseline_agreement": experiment["baseline"]["agreement"],
        "candidate_agreement": experiment["candidate"]["agreement"],
        "regressions": experiment["regressed_cases"],
        "production_mutation": experiment["production_mutation"],
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
