#!/usr/bin/env python3
"""Authenticated smoke for Document Quality Lab catalog and static surface."""

from __future__ import annotations

import argparse
import json
import os
import urllib.request


def request_json(url: str, method: str = "GET", token: str = "", body: dict | None = None) -> dict:
    payload = json.dumps(body).encode() if body is not None else None
    headers = {"Accept": "application/json"}
    if body is not None:
        headers["Content-Type"] = "application/json"
    if token:
        headers["Authorization"] = "Bearer " + token
    with urllib.request.urlopen(urllib.request.Request(url, data=payload, headers=headers, method=method), timeout=30) as response:
        return json.load(response)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--evaluation", default=os.getenv("AGENT_EVALUATION_URL", "http://127.0.0.1:18200"))
    parser.add_argument("--email", default=os.getenv("AGENT_EVALUATION_EMAIL", "alice@tenant-a.local"))
    parser.add_argument("--password", default=os.getenv("AGENT_EVALUATION_PASSWORD", "RagLab-Alice-2026!"))
    args = parser.parse_args()
    base = args.evaluation.rstrip("/")
    login = request_json(base + "/api/v1/session/login", "POST", body={"email": args.email, "password": args.password})
    catalog = request_json(base + "/api/v1/document-quality/catalog", token=login["access_token"])
    with urllib.request.urlopen(base + "/document-quality", timeout=30) as response:
        page = response.read().decode("utf-8")
    if catalog.get("current_stage") != "retrieval-sandbox" or catalog.get("dataset", {}).get("cases") != 10:
        raise RuntimeError("document quality catalog is incomplete")
    if "retrieval" not in catalog.get("evaluated_layers", []):
        raise RuntimeError("document quality retrieval layer is unavailable")
    if "Document Quality Lab" not in page:
        raise RuntimeError("document quality web surface is unavailable")
    print(json.dumps({
        "status": "passed",
        "dataset": catalog["dataset"]["id"],
        "snapshot": catalog["dataset"]["snapshot"],
        "layers": catalog["evaluated_layers"],
        "experiments": len(catalog.get("experiments", [])),
        "current_stage": catalog["current_stage"],
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
