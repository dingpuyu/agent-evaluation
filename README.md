# Agent Evaluation

面向生产 Agent 的独立评测与优化实验平台。它不承载业务问答，也不直连目标系统数据库；通过受鉴权的评测契约、回放 API 和 Trace 观察完整 Agent 行为。

当前第一个真实目标是 `rag-evolution-lab` 医疗设备销售 Agent，覆盖两条闭环：

1. **业务链路 → Prompt A/B**：识别可干预节点，使用脱敏生产型样本对 Baseline/Candidate 做隔离回放，比较任务成功、安全、引用和延迟。
2. **Bad Case → 证据诊断**：Pi Agent Harness 读取人工期望、历史复测、当前只读 Replay 和 Query Trace，生成必须人工审核的根因与优化假设。

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
