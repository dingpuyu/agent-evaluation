# Phase E：多文档冲突与精确范围过滤实验报告

## 结论

本阶段没有把“正确文档能召回”误当成生产可用。全新的多文档 Holdout 首次真实运行得到 `0/3`，虽然 Candidate 的 Hit@5、证据完整率和来源定位均为 `1.0`，但错误版本或相似型号进入了最终 Top-5，`wrong_document_count=4`，发布被阻断。

修复采用服务端精确范围过滤，而不是继续调整 Prompt 或盲目提高 Rerank 权重。失败模式被转写成不同型号、版本和批次的 Development 回归，真实结果从 `7/8` 提升到 `8/8`，`wrong_document_count` 降为 `0`。原 Holdout 已曝光，系统将其标记为 `exposed` 并禁止复用；修复版本仍需要一套新的未见 Holdout 才能晋级。

## 真实实验链路

```text
11 份文档 Artifact
→ 阿里云 text-embedding-v4（1024 维）
→ 临时隔离 Milvus Collection
→ Exact + BM25 + Dense + RRF
→ qwen3-rerank
→ 文档 / 版本 / 型号 / 批次 / 证据跨度门禁
→ 清理临时 Collection
```

所有原始文档、Block 和 Chunk 只参与内存实验，实验记录仅保留指标、排名、范围过滤 Trace 和必要诊断。`production_mutation=false`，临时索引均已清理。

## Artifact Contract v2

旧契约默认一条 Case 只有一份文档，无法表达生产环境中真正困难的竞争关系。v2 允许同一 `case_id` 下存在多份拥有稳定 `document_id` 的文档，并保留：

- `source_file`
- `model_codes`
- `software_version_from/to`
- `document_revision`
- `supersedes`
- `affected_lots`
- `authority_level`

Baseline 与 Candidate 必须包含完全相同的 Case/Document 组合，OCR、Layout 和 Cleaning 产物也必须一致，因此仍然是受控的 Chunk 单变量实验。

## 未见 Holdout 结果

- Experiment：`docqexp_724571c602324ae486842c3eefa803af`
- Parent Development：`docqexp_95635539d6964b5192f3958574dadbd8`
- Candidate：`700/80`
- Provider：`text-embedding-v4 / 1024d / qwen3-rerank`
- Candidate：`0/3`
- Hit@5：`1.0`
- MRR：`0.8333`
- Evidence Span：`1.0`
- Wrong Document Count：`4`
- OCR / Layout / Cleaning / Chunk / Safety 失败：`0`
- Retrieval 失败：`3`

逐条现象：

1. `VSM-450 4.2 / 3.8`：当前版本排第 1，历史版本排第 2。
2. `VSM-410 Pro / VSM-410`：基础型号被 Rerank 排第 1，Pro 排第 2。
3. `LOT-K2608 / LOT-K2501`：当前通知排第 1，但废止通知仍进入 Top-5。

这证明仅靠 Embedding 和 Rerank 无法稳定解决适用范围问题。特别是基础型号是 Pro 型号的子串时，语义模型可能认为两者几乎等价。

## 根因与修复

查询侧从本次实验的文档元数据中构建可验证的精确实体集合：

1. 型号采用最长精确匹配，`VSM-420 Pro` 优先于 `VSM-420`。
2. 查询显式包含软件版本时，在 ANN/BM25 之前加入版本过滤。
3. 查询显式包含批次时，在 ANN/BM25 之前加入批次过滤。
4. Tenant、Role 过滤仍然和上述业务范围过滤同时在 Milvus 查询前执行。
5. 每次实际应用的条件写入 `applied_scope`，在网页中可审计，不依赖 LLM 声称自己遵守了范围。

同时修复了实验基础设施的一个问题：旧的 `pipeline_release` 由本批数据实际经过的 Parser 列表生成，导致 OCR Development 和原生格式 Holdout 被误判为不同部署。现在发布指纹只包含声明式 Release 和受控实验参数，`observed_parsers` 作为运行证据单独保存。

## 修复后 Development 回归

失败模式没有直接复用 Holdout 文档，而是转写为：

- `VSM-460 5.1 / 4.7` 版本冲突；
- `VSM-420 Pro / VSM-420` 后缀型号冲突；
- `BeneHeart C5 LOT-M2701 / LOT-M2602` 批次通知冲突。

真实实验：

- Experiment：`docqexp_709c6dcf4e8d48c894f6b47fa97008fa`
- Dataset：`raglab-document-quality-v1@1.7.0`
- Snapshot：`sha256:47c3c04ea08ff377a3267f09d78e9059c1e1a4559511f402bfcc46aae6db692c`
- Baseline：`7/8`
- Candidate：`8/8`
- Hit@5：`1.0`
- MRR：`1.0`
- Wrong Document Count：`0`
- Evidence Span：`1.0`
- Mean Embedding Amplification：`1.0149`

代表性 Trace：

```text
model_code=VSM-460 + software_version=5.1
→ synthetic-vsm460-network-r4

model_code=VSM-420 Pro
→ synthetic-vsm420-pro-power-r1

model_code=BeneHeart C5 + affected_lot=LOT-M2701
→ synthetic-c5-field-notice-r2
```

## 当前边界

- 旧 Holdout 已经曝光，不能用于证明修复后的泛化能力。
- 当前版本过滤验证的是显式精确版本；生产还需要 SemVer 范围、缺失版本澄清和不合法版本处理。
- 当用户没有提供型号、版本或批次时不能凭空过滤，应由 Agent 澄清或执行权威性/时效性冲突判断。
- Metadata 必须来自受信任的上传流程并经过校验，不能接受普通用户在查询请求中直接指定 ACL 或数据范围。
- `supersedes` 与 `authority_level` 已进入契约，但“查询未给批次时如何选择当前有效通知”仍需下一阶段验证。

## 面试表述

> 我用全新多文档 Holdout 验证 RAG 在同型号不同版本、基础型号与 Pro、当前与废止通知竞争时的表现。首次结果 0/3，Hit@5 和证据完整率其实全过，但错误文档仍进入 Top-5，说明传统召回指标掩盖了适用范围风险。排名中甚至出现基础型号超过 Pro。我没有继续调 Prompt，而是升级 Artifact v2 保存型号、版本、修订和批次，在 Milvus 检索前做服务端最长型号、版本和批次过滤，并把 applied_scope 写入 Trace。用不同设备转写 Development 回归后得到 7/8 到 8/8，MRR 从盲测观察到的 0.833 提升到 1，Wrong Document 从 4 降为 0。原 Holdout 已曝光，所以系统禁止复用，修复版本仍等待新的盲测。
