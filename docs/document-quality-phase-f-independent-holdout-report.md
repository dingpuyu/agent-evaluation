# Phase F：独立标识符边界 Holdout 报告

## 结论

`raglab-document-quality-v1@1.8.0` 的一次性 Holdout 已真实通过。候选 Chunk Profile `700/80` 在 4 个此前未参与调参的 Case 上得到 `4/4`，Baseline `400/100` 为 `3/4`；候选的 Hit@5、MRR、证据跨度完整率均为 `1.0`，`wrong_document_count=0`，没有新增回退。

这次结果验证了两个独立假设：

1. 服务端 pre-ANN 范围过滤能泛化到新的型号、版本和批次标识符，而不是只记住 Phase E 的设备名称。
2. `700/80` 能保存 452 字的完整操作单元，`400/100` 虽然召回正确文档，但不能提供单个完整证据 Chunk。

该 Holdout 的质量判定已经被永久消费。重复提交相同 Snapshot 与 Candidate Fingerprint 返回 HTTP `409`；当前阶段为 `regression-ready`，不能再次查看盲测结果后原地调参。

## 数据隔离设计

Phase E 已曝光的 3 个 Holdout Case 被转入 Regression。新的 Holdout 使用完全不同的标识符和文本，共 4 个 Case、8 份文档：

| Case | 正确范围 | Hard Negative | 验证点 |
| --- | --- | --- | --- |
| `holdout-model-boundary-007` | `VSM-520` | `VSM-52` | 短型号不能命中长型号的前缀 |
| `holdout-longest-model-008` | `BeneVision N17 Elite` | `BeneVision N17` | 同时匹配时选择最长型号 |
| `holdout-version-boundary-009` | 软件 `14.2` | 软件 `4.2` | 短版本不能命中长版本的后缀 |
| `holdout-lot-boundary-010` | `LOT-P28010` | `LOT-P2801` | 短批次不能命中长批次的前缀 |

文档使用 DOCX、HTML 和 Markdown，全部为合成医疗设备运维资料，不含患者信息，也不能用于真实设备操作。

## 冻结链路

```text
Development 11 documents
→ 400/100 与 700/80 单变量 Artifact
→ Qwen text-embedding-v4 1024d
→ 临时 Milvus Hybrid Collection
→ qwen3-rerank
→ Parent Retrieval PASS
→ Holdout 8 documents
→ 相同 Provider / Index / Candidate Fingerprint
→ 一次性质量判定
→ 清理临时 Collection
```

- Dataset Snapshot：`sha256:2bc65521e5a29a59ebaf0b2b851508d9d1d3a27216fe6781141f6fdc98452e0b`
- Parent Development：`docqexp_d6778ba4914546ad9dc834f39721fd41`
- Holdout：`docqexp_1d7e5bf677dc4aaeb02e46171beb166f`
- Candidate Fingerprint：`sha256:339730f00be64a716f863e4ddf11381234ec6c4a1b7ce7b0deb167c84819a3db`
- Provider：`text-embedding-v4 / 1024d / qwen3-rerank`
- `production_mutation=false`
- `cleanup_completed=true`

## 真实结果

| 指标 | Baseline 400/100 | Candidate 700/80 |
| --- | ---: | ---: |
| Case Pass | 3/4 | 4/4 |
| Answer Span | 0.75 | 1.00 |
| Retrieval Evidence Span | 0.75 | 1.00 |
| Hit@5 | 1.00 | 1.00 |
| MRR | 1.00 | 1.00 |
| Wrong Document | 0 | 0 |
| Mean Embedding Amplification | 1.0518 | 1.00 |
| Indexed Chunks | 13 | 12 |
| Sandbox Total | 4192 ms | 4432 ms |

候选总耗时略高约 240 ms，主要来自远端模型网络波动，当前 4 条查询的样本量不足以证明性能退化，因此不把单次延迟作为否决项。Chunk 数从 13 降到 12，同时完整证据率提升，才是本次受控变量可以支持的结论。

## 可审计范围 Trace

```text
VSM-520 query
→ model_code=VSM-520
→ synthetic-vsm520-temperature-r1

BeneVision N17 Elite query
→ model_code=BeneVision N17 Elite
→ synthetic-n17-elite-network-r1

VSM-480 software 14.2 query
→ model_code=VSM-480 + software_version=14.2
→ synthetic-vsm480-calibration-r5

BeneHeart C7 LOT-P28010 query
→ model_code=BeneHeart C7 + affected_lot=LOT-P28010
→ synthetic-c7-field-notice-r4
```

过滤条件来自受信任的索引元数据和查询中的显式标识符，在 ANN/BM25 之前执行。普通用户不能直接提交 Milvus Filter，也不能覆盖 Tenant/Role ACL。

## 一次性门禁验证

首次运行返回：

```text
promotion_status=holdout_passed
verdict=pass
baseline_cases=3/4
candidate_cases=4/4
```

使用相同父实验、Snapshot 和 Candidate Fingerprint 再次提交时，服务端返回 HTTP `409`：质量结果已经消费，不允许重试。基础设施在产生质量结果前失败才允许重试。

## 当前边界

- 4 条 Holdout 足以验证本次标识符边界假设，但不能代表所有厂商命名体系。
- 当前版本过滤验证显式精确版本；SemVer 范围、缺失版本澄清仍未完成。
- 当前实验覆盖检索证据，不等价于 Agent 最终答案和引用已经通过。
- 单次远端延迟不能用于容量规划，需要独立并发压测和多次统计。
- 本仓库公开后，这批已消费 Holdout 只能作为审计和讲解样本；下一轮真正未见数据必须存放在受控对象存储或私有 Dataset 服务中，不能预先提交到公开 Git。
- 下一门禁是 Regression。只有把历史 OCR、相似型号、版本冲突和废止通知一起跑绿，并验证 Agent 回答引用，才可以形成发布候选。

## 面试表述

> 第一轮多文档 Holdout 暴露了错误版本和相似型号进入 Top-K 的问题，我用服务端 pre-ANN 型号、版本、批次过滤修复，并拒绝复用已曝光盲测。随后重新构造了 4 个完全不同标识符的独立 Holdout，专门验证 VSM-52/VSM-520、N17/N17 Elite、4.2/14.2 和相似批次号。真实 Qwen Embedding、Milvus Hybrid、Qwen Rerank 结果是 Baseline 3/4、Candidate 4/4，Wrong Document 为 0；700/80 还修复了 452 字操作单元被切断的问题。相同候选重复提交返回 409，平台自动进入 regression-ready。这个结果支持“候选具备回归资格”，但我没有把 4 条盲测夸大成生产发布结论。
