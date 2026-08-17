# 架构与业务闭环

## 1. 平台定位

Agent Evaluation 的核心不是给最终答案打一个分，而是解释：业务在哪个节点失败、哪类干预可能有效、修改后是否真的改善、是否引入新的安全或业务退化。

```text
业务目标与流程契约
  → 生产样本治理（授权、脱敏、标注、分层）
  → Baseline 运行与 Trace
  → 失败节点归因
  → Candidate 干预（Prompt / 检索 / 规则 / 工具）
  → 同集对照 + 独立回归
  → 人工审核与发布建议
```

平台对象之间的关系：

```text
Target Manifest
  └─ Workflow Contract
      └─ Evaluation Plan（目标 + 数据快照 + 指标 + 门禁）
          ├─ Pilot Run（完整基线）
          ├─ Prompt Experiment（单变量 A/B）
          └─ Bad Case Diagnosis（证据化根因分析）
```

Evaluation Studio 在这组对象前增加一个可持续更新的 `Project Workspace`：项目梳理 Agent 读取注册 Target、冻结 Dataset 与最近 Pilot，和用户一起形成 Project Brief；Brief 再关联一组 `Stage Prompt Experiment`。Stage 实验评价的是 Judge Prompt 对确定性 Oracle 的一致性，不允许修改 Target 权限、冻结观察或硬门禁。详细设计见 [Evaluation Studio](evaluation-studio.md)。

第一阶段只有一个 Target Adapter，但 Plan、Run、Dataset 和 Gate 已经脱离具体 UI。新增 Agent 时应实现 Adapter 和 Workflow Contract，而不是复制一套评测服务。

## 2. Target Adapter

首个 `RaglabAdapter` 只依赖被测系统的 HTTP API：

- 登录与身份确认。
- 获取业务流程、质量指标和可干预点。
- 获取租户可见 Bad Case 与历史 Attempt。
- 执行一次只读 Retrieval Replay 并读取对应 Trace。
- 在隔离上下文中执行单条 Prompt Candidate，不持久化候选配置。

Bearer Token 只存在于请求链路中，不进入运行记录。评测前先访问目标资源完成租户授权，再产生 LLM 成本。

## 3. 为什么只有回答节点能编辑 Prompt

当前医疗 Agent 的关键控制分别属于不同层：

| 业务节点 | 主要问题 | 正确干预 |
|---|---|---|
| 范围/风险识别 | 临床问题被回答 | 确定性安全规则 |
| 上下文解析 | 型号版本缺失 | 实体解析与澄清策略 |
| 知识检索 | 找错型号或版本 | 数据、Metadata、Rewrite、Rerank |
| 证据校验 | 过期或不适用证据进入回答 | 适用性规则 |
| 回答生成 | 表达不清、事实覆盖不足 | Prompt Candidate |
| 引用与 Trace | 无法审计 | 运行时可观测性 |

因此网页只允许对回答生成添加 Overlay；租户过滤、临床拒答、证据校验不接受 Prompt 覆盖。若检索 Hit@5 失败，平台应建议修数据或检索，而不是继续堆提示词。

## 4. 两类判定

- 确定性指标决定权限泄漏、决策、引用数量、工具预算、Trace 和安全门禁。
- 模型辅助诊断负责从复杂轨迹中组织证据、归纳根因和提出实验假设。

模型 Judge 不能推翻确定性安全失败，所有优化建议都要求人工审核。

## 5. 数据真实性

仓库自带的是“脱敏生产型”样本：覆盖真实流量形态，但不冒充真实客户日志。接入线上数据必须满足业务授权、最小字段、PII/PHI 脱敏、人工复核、数据版本和留存期限。`scripts/import_production_samples.py` 提供可审计的导入入口，并明确拒绝未授权导出。

## 6. 首轮 Pilot 的判定边界

首轮 Pilot 使用确定性断言检查决策、原因码、引用、必含事实和禁止内容，再把失败映射到业务节点。答案里出现正确关键词并不代表 RAG 正确，因此样本还能声明 `required_document_ids`、`forbidden_document_ids`、`allowed_dataset_ids` 和 `minimum_distinct_documents`。这些字段形成证据覆盖与数据集边界门禁，并把缺文档问题归因到 Retrieval，而不是错误地建议修改 Prompt。

它不使用 Prompt Candidate，也不自动修改目标系统。只有 Baseline 形成后，才能选择回答 Prompt、检索、Rerank、语料或规则中的一个变量做后续实验。两次运行只有在 Target 与 Dataset Snapshot 相同时才允许直接比较；平台同时展示 Gate 迁移、指标差值、已修复用例和新增退化。
