# Agent Evaluation

面向生产 Agent 的独立评测与优化实验平台。它不承载业务问答，也不直连目标系统数据库；通过受鉴权的评测契约、回放 API 和 Trace 观察完整 Agent 行为。

当前第一个真实目标是 `rag-evolution-lab` 医疗设备销售 Agent，覆盖两条闭环：

1. **业务链路 → Prompt A/B**：识别可干预节点，使用脱敏生产型样本对 Baseline/Candidate 做隔离回放，比较任务成功、安全、引用和延迟。
2. **Bad Case → 证据诊断**：Pi Agent Harness 读取人工期望、历史复测、当前只读 Replay 和 Query Trace，生成必须人工审核的根因与优化假设。

v0.6 新增第三条已跑通闭环：**真实 Document → Retrieval 单变量实验**。同一 Parser 产物只改变 Chunk Profile，再让两组 chunks 分别经过 `text-embedding-v4 (1024d) → 临时 Milvus HNSW+BM25/RRF → qwen3-rerank`；实验结束强制删除临时 Collection，平台只保存指标和 Rank Trace，不保存上传正文，也不改生产索引。检索门禁同时验证 PDF Page、XLSX Sheet/Cell Range 与 Heading Path，避免“文档命中但引用位置错误”被当成成功。

平台还提供独立的 **Evaluation Studio**：通过项目梳理 Agent 对话补齐目标用户、关键任务、失败成本、可用数据和未知项；再选择范围、检索、答案或发布 Judge 阶段，编辑 Candidate Prompt，并在同一冻结观察集上比较其与确定性 Golden Oracle 的一致率、误放和误拒。

从 v0.4 起，生产形态评测集按 **Development / Holdout / Regression** 三层冻结：Development 用于形成 Prompt 假设，Holdout 在运行前隐藏问题文本，Regression 固化已确认 Bad Case 与安全门禁。实验记录数据版本、SHA-256 快照和所用分层，避免用同一批可见题反复调参造成虚假提升。

平台第一阶段还提供一条完整试点链路：`Target Manifest → 业务 Workflow → Evaluation Plan → 冻结 Dataset → 异步 Baseline Run → Quality Gate → 干预节点建议`。它用于回答“这个 Agent 当前是否达标、失败发生在哪一层、下一步应该改什么”，然后才进入 Prompt 或检索策略实验。

## 为什么是独立项目

- 被测系统负责业务图、授权检索、工具执行和 Trace。
- 本项目负责数据集、Runner、Evaluator、Judge、对照实验、报告和质量门禁。
- 评测故障不会阻塞线上 Agent；候选 Prompt 不写入生产配置。
- 同一平台后续可以新增客服、工单、Text2SQL 或多 Agent Target Adapter。

## 本地启动

先启动 `rag-evolution-lab`，再启动本项目：

```bash
make test
make up
make status
```

访问：<http://localhost:18200>

项目梳理与阶段 Prompt 实验：<http://localhost:18200/studio>

文档质量单变量实验：<http://localhost:18200/document-quality>

默认复用 `DEEPSEEK_API_KEY`。Key 只注入容器，不写入运行记录、数据集或仓库。

### 在新电脑与 RAG 平台一起部署

先在同级目录的 `rag-evolution-lab` 执行 `make deploy-init、deploy-up、deploy-bootstrap、deploy-verify`，再在本仓库执行：

```bash
make deploy-init
make deploy-up
make deploy-verify
```

初始化器会读取 `../rag-evolution-lab/.env`，自动对齐实际端口和随机 Tenant A 密码；自己的 `.env` 与 `.deploy/credentials.txt` 权限均为 `0600`。评测模型 Key 仍只从当前进程环境注入。完整说明见 RAG 仓库的 `docs/portable-deployment.md`。

真实端到端验证：

```bash
make smoke
make studio-smoke
make split-smoke
```

运行医疗 RAG Agent 的完整首轮基线（全部冻结样本）：

```bash
make pilot
```

Pilot 是异步运行：创建请求立即返回 `202`，网页和脚本轮询持久化进度。即使浏览器刷新，也能从运行历史继续查看。

## 平台 API

- `GET /api/v1/platform/overview`：平台注册目标、计划和最近试点。
- `GET /api/v1/plans/raglab-medical-sales-baseline-v1`：冻结业务链路、指标、数据集与门禁。
- `POST /api/v1/pilots/raglab-medical-sales-baseline-v1/runs`：创建完整基线运行。
- `GET /api/v1/pilots/{pilot_run_id}`：查询逐题进度、门禁和干预建议。
- `GET /api/v1/pilots/compare?baseline_id=...&candidate_id=...`：比较同一目标、同一数据快照的两次运行，返回指标增量、已修复用例和新增退化。
- `POST /api/v1/experiments/prompt-comparisons`：在回答节点执行 Baseline/Candidate 对照。
- `POST /api/v1/project-workspaces`：创建租户隔离的项目梳理工作区。
- `POST /api/v1/project-workspaces/{id}/messages`：和 Evaluation Architect Agent 对话并更新项目 Brief。
- `GET /api/v1/studio/stages`：读取锁定阶段与可编辑 Judge 阶段。
- `POST /api/v1/project-workspaces/{id}/stage-experiments`：运行阶段 Prompt Baseline/Candidate 对照。
- `GET /api/v1/document-quality/catalog`：读取 Document Quality 冻结集、分层状态和实验规则。
- `POST /api/v1/document-quality/experiments`：以内存中的两组无索引 Artifact 运行单变量对照；`execution_stage=retrieval-sandbox` 会调用 RAG 平台的隔离真实检索工具，只允许 Development。
- `GET /api/v1/document-quality/experiments/{id}`：读取租户隔离的指标、失败层、诊断和晋级建议。

Prompt 与阶段实验均可传 `dataset_split=development|holdout|regression`。推荐晋级顺序是：

```text
Development 形成假设 → Holdout 盲测 → Regression 发布回归 → 人工审核
```

详细策略见 [三层数据集与发布门禁](docs/dataset-split-gates.md)。

所有平台资产都经过目标系统身份校验，并按租户隔离。

## 评测维度

- Task：决策、任务完成、澄清与拒答。
- Tool Use：工具选择、参数、顺序、预算和副作用。
- Retrieval：Hit@5、MRR、型号/版本与权限隔离。
- Grounding：证据覆盖、根因可信度和引用。
- Safety：临床边界、越权、Prompt Injection、生产写入。
- Observability：Trace 完整度、模型/套件/Prompt 版本。
- Performance / Cost：延迟、Token 与调用成本。

详细设计见 [架构与业务闭环](docs/architecture.md) 和 [开发节奏](docs/roadmap.md)。

首次真实试点及一次 Evaluation False Positive 的发现、修复和复测过程见 [首轮试点报告](docs/first-pilot-report.md)。答案级指标进一步升级为证据级门禁并推动 RAG 修复的过程见 [证据覆盖优化报告](docs/evidence-retrieval-optimization.md)。

针对扫描 PDF、OCR、洗料和 Chunk/Overlap 的下一条跨项目闭环，见 [文档质量 Agent 评测与优化闭环实施方案](docs/document-quality-agent-evaluation-plan.md)。该 Suite 会把 OCR、Layout、Cleaning、Chunk、Retrieval 和 Agent 分层评测，允许质量工程 Agent 在隔离环境中执行受约束的单变量实验，但不允许自动修改或发布生产索引。

Document Quality Suite 已包含 11 条 Golden，分为 Development/Holdout/Regression，故障注入覆盖 OCR 错字、可选排序字段、洗料误删、Chunk 边界、错误证据和低质量文档误发布。评测可以显式选择实际执行层，未运行的 Retrieval/Safety 不会被伪装成通过；Baseline/Candidate 对比器只有在 Candidate 硬门禁通过且没有新增回退时才建议晋级。契约验证见 [Phase A 报告](docs/document-quality-phase-a-report.md)；真实 OCR/清洗/切块 Artifact 的 `400/100 → 700/80` 实验见 [Phase B 报告](docs/document-quality-phase-b-report.md)；Qwen、Milvus 与 Rerank 的隔离 Retrieval 对照见 [Phase C 报告](docs/document-quality-phase-c-report.md)。

Phase D 已加入绑定父实验、数据 Snapshot 与 Candidate Fingerprint 的一次性 Holdout。首轮真实结果不是全绿：`v1.4.0` Holdout 为 `2/3`，低对比扫描因 Paddle 输出 `block_order=null` 触发 Adapter 排序异常，发布被 HOLD；重复提交同一候选返回 `409`。修复后把不同型号样本转为 Development Bad Case，`v1.5.0` 实际得到 `4/5 → 5/5`，但没有重跑已经看过的 Holdout，因此仍未宣称可发布。完整证据、实验 ID、指标和复现命令见 [Phase D Holdout 报告](docs/document-quality-phase-d-holdout-report.md)。

现在这条闭环已经进入网页工作台：在 RAG 项目分别导出 `400/100` 与 `700/80` 的无索引 Artifact 后，可直接上传到 `/document-quality`。平台强制检查两组 Artifact 的 OCR、Layout、Cleaner 产物完全一致，只允许 Chunk Profile 变化。真实 Retrieval 结果中，两组 Document Hit@5 和 MRR 都是 `1.0`，但新加的单 Chunk 证据完整率从 `0 → 1.0`，证明“检索到正确文档”仍可能无法回答完整步骤；候选同时保持 Development `3/4 → 4/4`、Answer Span `0.75 → 1.00`、Embedding Amplification `1.0734 → 1.0299`。后续真实复跑又验证了 XLSX `兼容矩阵 / A1:C1,A3:C3` 的结构化引用，`retrieval_source_locator_accuracy=1.0`；错误单元格范围会直接 HOLD。结论仍只是“有资格进入 Holdout”，不是“已得到生产最优参数”。操作和安全边界见 [Document Quality Lab](docs/document-quality-lab.md)。

命令行导入同一组真实结果：

```bash
BASELINE=data/document-quality/artifacts-400-100.json \
CANDIDATE=data/document-quality/artifacts-700-80.json \
make document-quality-import
```
