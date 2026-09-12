#!/usr/bin/env python3
"""Live native-parser/HTTP integrity probes. No Embedding, LLM or index calls."""
import copy
import hashlib
import json
import os
from pathlib import Path
import urllib.error
import urllib.request
import uuid


def request(url, payload=None, token="", content_type="application/json"):
    headers = {"Accept": "application/json"}
    if token:
        headers["Authorization"] = "Bearer " + token
    if isinstance(payload, dict):
        payload = json.dumps(payload).encode()
    if payload is not None:
        headers["Content-Type"] = content_type
    try:
        with urllib.request.urlopen(urllib.request.Request(url, data=payload, headers=headers), timeout=30) as response:
            return response.status, json.load(response)
    except urllib.error.HTTPError as error:
        return error.code, json.load(error)


def main():
    evaluation = os.getenv("AGENT_EVALUATION_URL", "http://127.0.0.1:18200").rstrip("/")
    api = os.getenv("INTEGRITY_RAGLAB_API_URL", "http://127.0.0.1:18080").rstrip("/")
    status, session = request(evaluation + "/api/v1/session/login", {
        "email": os.getenv("AGENT_EVALUATION_EMAIL", "alice@tenant-a.local"),
        "password": os.getenv("AGENT_EVALUATION_PASSWORD", "RagLab-Alice-2026!"),
    })
    if status != 200:
        raise RuntimeError("test account login failed (credentials are not printed)")
    token = session["access_token"]
    boundary = "integrity-" + uuid.uuid4().hex
    source = ("# Synthetic integrity probe\n\nVSM-100 software 4.2. " + "Only a test sentence. " * 50).encode()
    fields = {"case_id": "integrity-probe", "document_id": "integrity-manual", "metadata": json.dumps({"model_codes": ["VSM-100"], "software_version_from": "4.2"}), "max_runes": "400", "overlap_runes": "100", "candidate_max_runes": "700", "candidate_overlap_runes": "80"}
    body = bytearray()
    for name, value in fields.items():
        body.extend(f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode())
    body.extend(f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="integrity.md"\r\nContent-Type: text/markdown\r\n\r\n'.encode())
    body.extend(source)
    body.extend(f'\r\n--{boundary}--\r\n'.encode())
    dataset_id = os.getenv("INTEGRITY_DATASET_ID", "tenant-a-operations")
    status, pair = request(f"{api}/api/v1/datasets/{dataset_id}/documents/evaluation-artifacts", bytes(body), token, "multipart/form-data; boundary=" + boundary)
    if status != 200 or pair.get("parser_executions") != 1:
        raise RuntimeError(f"paired native preview failed: HTTP {status}")
    baseline, candidate = pair["baseline"], pair["candidate"]
    expected_hash = "sha256:" + hashlib.sha256(source).hexdigest()
    assert baseline["source_sha256"] == candidate["source_sha256"] == expected_hash
    assert baseline["document_ir"] == candidate["document_ir"]
    assert baseline["blocks"] == candidate["blocks"] and baseline["cleaning"] == candidate["cleaning"]
    assert not baseline["indexed"] and not candidate["indexed"]
    assert baseline["chunks"] != candidate["chunks"]

    dataset = json.loads((Path(__file__).resolve().parents[1] / "datasets/raglab-document-quality-v1.json").read_text())
    def bundle(variant, max_runes, overlap):
        artifacts = []
        for case in dataset["cases"]:
            if case["split"] != "development":
                continue
            item = copy.deepcopy(variant)
            item["case_id"] = case["case_id"]
            item["document_id"] = case["source_group"]
            artifacts.append(item)
        return {"schema": "agent-evaluation.document-quality.artifacts.v2", "config": {"max_runes": max_runes, "overlap_runes": overlap, "pipeline_release": "integrity-http-probe"}, "artifacts": artifacts}
    left, right = bundle(baseline, 400, 100), bundle(candidate, 700, 80)
    right["artifacts"][0]["metadata"]["software_version_from"] = "14.2"
    status, rejection = request(evaluation + "/api/v1/document-quality/experiments", {"execution_stage": "pre-index", "baseline_artifacts": left, "candidate_artifacts": right}, token)
    assert status == 400 and "single-variable" in json.dumps(rejection), "metadata drift must be rejected before grading or model calls"
    print(json.dumps({"status": "passed", "paired_parser_executions": 1, "identical_source_ir_cleaning": True, "different_chunks": True, "metadata_drift_http_status": status, "model_api_calls": 0, "indexed": False}, indent=2))


if __name__ == "__main__":
    main()
