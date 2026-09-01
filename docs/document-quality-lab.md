# Document Quality Lab：真实文档流水线实验工作台

## 1. 解决的问题

PDF、DOCX、XLSX 和扫描件进入 RAG 后，失败不一定发生在检索或 Prompt。OCR 漏行、版面顺序错误、Cleaner 误删、Chunk 切断答案单元，都会让下游 Agent 在“没有正确证据”的前提下回答。

Document Quality Lab 把这段链路变成可重复的实验：

```text
RAG 无索引 Artifact
→ 冻结 Development Golden
→ Baseline / Candidate 单变量校验
→ OCR / Layout / Cleaning / Chunk 分层指标
→ 退化检测
→ 人工审核的晋级建议
```

工作台地址：`http://localhost:18200/document-quality`。

## 2. 为什么上传 Artifact，而不是把 RAG 代码复制过来

- RAG 平台保有文档、Parser、OCR、Cleaner 和 Chunker 的运行职责。
- 评测平台保有 Dataset、Oracle、指标、对照实验和质量门禁。
- 两边通过版本化 Artifact 契约连接，评测平台不需要访问 MinIO、PostgreSQL 或 Milvus。
- 原始 Blocks 和 Chunks 只在一次请求的内存中计算；落盘记录只有配置标签、数据快照、聚合指标、失败检查和诊断。

这能把“被测系统”和“裁判”分开，也减少业务文档在不同系统重复存储的泄漏面。

## 3. 强制实验约束

首版只开放 `Development + pre-index`：

1. Baseline 和 Candidate 必须包含 Development 的全部 4 条用例，不能只挑成功样本。
2. 两组 `status、blocks、cleaning` 必须逐 Case 完全一致，只允许 Chunk 结果和 Profile 不同。
3. Artifact 必须 `indexed=false` 且 Retrieval 为空，未执行层不能伪装成通过。
4. Body 上限 2 MiB，单个网页文件建议小于 900 KiB。
5. Holdout 与 Regression 不接受交互式上传；Development 通过只产生“可申请盲测”的建议。
6. Candidate 只有在硬门禁通过、没有新增失败 Case、没有指标退化时才可晋级。

## 4. 真实首轮实验

固定项：同一数据快照、同一 OCR、同一版面结果、同一 Cleaner。唯一变量是 Chunk Profile。

| 指标 | 400 / 100 | 700 / 80 | 结论 |
| --- | ---: | ---: | --- |
| Development Case | 3 / 4 | 4 / 4 | 修复 1 条长操作步骤 |
| Answer Span Containment | 0.75 | 1.00 | 完整答案单元不再跨 Chunk |
| Mean Embedding Amplification | 1.0734 | 1.0299 | 重叠导致的重复向量成本下降 |
| 新增失败 / 退化指标 | 0 / 0 | 0 / 0 | 满足 Development 晋级规则 |

根因不是“模型不够聪明”，而是 `chunk` 层把必须一起出现的步骤切开。增大窗口的同时把 Overlap 从 25% 降到约 11.4%，既恢复完整语义单元，也没有增加重复向量成本。

这个结果不能直接外推成通用参数：它只覆盖 4 条 Development Case。长表格、跨页说明书、真实召回、相似型号和版本隔离必须继续经过 Holdout、Regression 与 Retrieval 门禁。

## 5. 复现实验

先从 `rag-evolution-lab` 导出真实无索引 Artifact：

```bash
cd ../rag-evolution-lab

OUTPUT=../agent-evaluation/data/document-quality/artifacts-400-100.json \
MAX_RUNES=400 OVERLAP_RUNES=100 make document-quality-export

OUTPUT=../agent-evaluation/data/document-quality/artifacts-700-80.json \
MAX_RUNES=700 OVERLAP_RUNES=80 make document-quality-export
```

启动评测平台并导入：

```bash
cd ../agent-evaluation
make up

BASELINE=data/document-quality/artifacts-400-100.json \
CANDIDATE=data/document-quality/artifacts-700-80.json \
make document-quality-import
```

也可以在网页分别选择两个 JSON。服务端持久化目录为 `document-quality-experiments/`，文件权限 `0600`，并按目标系统身份中的 `tenant_id` 隔离。

## 6. 下一阶段

1. 在隔离的临时 Collection 对两组 Chunk 执行相同 Embedding、索引、查询和 Rerank，补齐 Retrieval 层。
2. 固定候选后只运行一次 Holdout，失败则回到 Development 形成新假设，不能查看盲测题后原地微调。
3. 将已确认的 Chunk、OCR、Cleaner Bad Case 写入 Regression，作为发布零退化门禁。
4. 接入人工审批，只有 Holdout 与 Regression 均通过才允许生成索引发布请求；评测平台自身仍不直接改生产。
