#!/usr/bin/env python3
"""Create a reviewed, redacted evaluation dataset from an authorized JSONL export."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from datetime import UTC, datetime
from pathlib import Path


PATTERNS = (
    (re.compile(r"(?<!\d)1[3-9]\d{9}(?!\d)"), "[PHONE]"),
    (re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}"), "[EMAIL]"),
    (re.compile(r"(?<!\d)\d{17}[0-9Xx](?!\d)"), "[ID_NUMBER]"),
    (re.compile(r"\b(?:MRN|患者号|住院号)[:：]?\s*[A-Za-z0-9_-]{4,}\b", re.I), "[PATIENT_ID]"),
)


def redact(value: str) -> str:
    result = value
    for pattern, replacement in PATTERNS:
        result = pattern.sub(replacement, result)
    return result.strip()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--authorized-export", action="store_true")
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--reviewed-by", required=True)
    args = parser.parse_args()
    if not args.authorized_export:
        raise SystemExit("refusing import without --authorized-export")

    cases = []
    for line_number, line in enumerate(Path(args.input).read_text(encoding="utf-8").splitlines(), start=1):
        if not line.strip():
            continue
        item = json.loads(line)
        query = redact(str(item.get("query", "")))
        if not query:
            continue
        stable = hashlib.sha256(f"{line_number}:{query}".encode()).hexdigest()[:12]
        cases.append({
            "id": f"prod-{stable}",
            "segment": str(item.get("segment", "unclassified"))[:80],
            "query": query[:4000],
            "device_context": item.get("device_context") or {},
            "expected_decision": str(item.get("expected_decision", "clarify")),
            "expected_reason": str(item.get("expected_reason", "")),
            "minimum_citations": int(item.get("minimum_citations", 0)),
            "required_answer_any": [redact(str(value)) for value in item.get("required_answer_any", [])][:20],
            "forbidden_answer_any": [redact(str(value)) for value in item.get("forbidden_answer_any", [])][:20],
            "safety_critical": bool(item.get("safety_critical", False)),
        })
    if not cases:
        raise SystemExit("no valid cases found")
    output = {
        "schema": "agent-evaluation.dataset.v1",
        "dataset_id": "authorized-redacted-production-v1",
        "name": "经授权脱敏生产回放集",
        "version": "1.0.0",
        "domain": "imported",
        "language": "zh-CN",
        "provenance": "authorized-redacted-production",
        "contains_patient_data": False,
        "description": f"由 {args.reviewed_by} 于 {datetime.now(UTC).isoformat()} 完成人工审核。原始身份字段不进入评测仓库。",
        "cases": cases,
    }
    Path(args.output).write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"output": args.output, "cases": len(cases), "reviewed_by": args.reviewed_by}, ensure_ascii=False))


if __name__ == "__main__":
    main()
