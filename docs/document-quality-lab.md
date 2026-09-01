# Document Quality Lab：真实文档流水线实验工作台

## 1. 解决的问题

PDF、DOCX、XLSX 和扫描件进入 RAG 后，失败不一定发生在检索或 Prompt。OCR 漏行、版面顺序错误、Cleaner 误删、Chunk 切断答案单元，都会让下游 Agent 在“没有正确证据”的前提下回答。

Document Quality Lab 把这段链路变成可重复的实验：

```text
RAG 无索引 Artifact
→ 冻结 Development Golden
→ Baseline / Candidate 单变量校验
→ OCR / Layout / Cleaning / Chunk 分层指标
→ Qwen Embedding → 临时 Milvus Hybrid → Qwen Rerank
→ 文档命中 + 单 Chunk 证据完整性 + 结构化引用定位指标
→ 退化检测
→ 人工审核的晋级建议
```

工作台地址：`http://localhost:18200/document-quality`。

## 2. 为什么上传 Artifact，而不是把 RAG 代码复制过来

- RAG 平台保有文档、Parser、OCR、Cleaner 和 Chunker 的运行职责。
- 评测平台保有 Dataset、Oracle、指标、对照实验和质量门禁。
- 两边通过版本化 Artifact 和 Retrieval Sandbox 契约连接；评测平台不访问目标数据库，也不持有 Milvus 凭据。
- 原始 Blocks 和 Chunks 只在一次请求的内存中计算；落盘记录只有配置标签、数据快照、聚合指标、失败检查和诊断。

这能把“被测系统”和“裁判”分开，也减少业务文档在不同系统重复存储的泄漏面。

## 3. 强制实验约束

当前开放 `Development + retrieval-sandbox`：

1. Baseline 和 Candidate 必须包含 Development 的全部 4 条用例，不能只挑成功样本。
2. 两组 `status、blocks、cleaning` 必须逐 Case 完全一致，只允许 Chunk 结果和 Profile 不同。
3. Artifact 必须 `indexed=false` 且 Retrieval 为空，未执行层不能伪装成通过。
4. Body 上限 2 MiB，单个网页文件建议小于 900 KiB。
5. Holdout 与 Regression 不接受交互式上传；Development 通过只产生“可申请盲测”的建议。
6. Candidate 只有在硬门禁通过、没有新增失败 Case、没有指标退化时才可晋级。
7. 物理 Collection 名由 RAG 服务生成，客户端不可指定；管理员鉴权、2 MiB/80 chunks/20 queries 上限和 pre-ANN 租户过滤不可绕过。
8. Qwen Rerank 在评测路径使用 strict 模式，供应商失败会让实验失败，不能静默回退后仍宣称跑了 Qwen。
9. 临时 Collection 在成功与异常路径都删除；返回值必须证明 `cleanup_completed=true` 和 `production_mutation=false`。

## 4. 真实首轮实验

固定项：同一数据快照、同一 OCR、同一版面结果、同一 Cleaner。唯一变量是 Chunk Profile。

| 指标 | 400 / 100 | 700 / 80 | 结论 |
| --- | ---: | ---: | --- |
| Development Case | 3 / 4 | 4 / 4 | 修复 1 条长操作步骤 |
| Answer Span Containment | 0.75 | 1.00 | 完整答案单元不再跨 Chunk |
| Mean Embedding Amplification | 1.0734 | 1.0299 | 重叠导致的重复向量成本下降 |
| Retrieval Hit@5 / MRR | 1.00 / 1.00 | 1.00 / 1.00 | 文档级指标看不出差异 |
| Retrieval Evidence Span | 0.00 | 1.00 | 只有 Candidate 的单个证据 Chunk 含完整操作步骤 |
| Retrieval Source Locator | 1.00 | 1.00 | PDF Page 与 XLSX Sheet/Cell Range/Heading Path 均匹配 Golden |
| 新增失败 / 退化指标 | 0 / 0 | 0 / 0 | 满足 Development Retrieval 晋级规则 |

根因不是“模型不够聪明”，而是 `chunk` 层把必须一起出现的步骤切开。增大窗口的同时把 Overlap 从 25% 降到约 11.4%，既恢复完整语义单元，也没有增加重复向量成本。

首轮把当前 34 个 chunks 全送入 Qwen Rerank，暴露了不必要的调用量。候选池收敛到 Top 20 后再次运行，全部质量指标不回退；单次网络时延存在抖动，所以延迟只作为软指标记录，不能凭一次样本宣称固定百分比收益。

继续沿来源链路检查时又发现一次真实契约截断：Document IR 中已经存在 XLSX Sheet/Cell Range，但 Artifact DTO 没有复制。修复后网页会单独展示结构化 Citation Trace；正确文档但错误行范围不再通过门禁。

这个结果不能直接外推成通用参数：它只覆盖 4 条 Development Case。长表格、跨页说明书、相似型号和版本隔离仍必须继续经过 Holdout 与 Regression。

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

## 6. 当前真实链路和持久化边界

```text
Browser Artifact (request memory only)
→ agent-evaluation validates single-variable experiment
→ authenticated RAG Retrieval Sandbox API
→ server-generated temporary Collection A/B
→ text-embedding-v4 1024d
→ Dense + BM25 + RRF(k=60)
→ exact identifier preservation
→ qwen3-rerank Top 20
→ rank/evidence checks
→ drop Collection A/B
→ persist metrics + provider/rank trace only
```

网页会显示 Embedding、维度、Reranker、Chunk 数、总耗时、cleanup 状态和命中证据的 Page/Sheet/Cell Range/Heading Path。持久化实验不包含 Baseline/Candidate Artifact、Chunk 正文或访问令牌。

## 7. 下一阶段

1. 冻结 `700/80 + candidate_top_n=20`，只运行一次 Holdout；失败则回到 Development 形成新假设，不能查看盲测题后原地微调。
2. 将已确认的 Chunk、OCR、Cleaner 和 Evidence Span Bad Case 写入 Regression，作为发布零退化门禁。
3. 已完成来源页/Sheet/Cell Range/Heading Path 的 Retrieval 引用门禁；下一轮增加跨页表格与多定位 Golden。
4. 接入人工审批，只有 Holdout 与 Regression 均通过才允许生成索引发布请求；评测平台自身仍不直接改生产。
