# 开发节奏

## Phase 1：单目标闭环（当前）

- 通用 Target / Suite / Dataset / Run 契约。
- 业务链路和可干预点展示。
- 脱敏生产型回放集。
- Prompt Baseline/Candidate 隔离对比。
- Pi Bad Case 证据诊断。
- 运行持久化、租户隔离和本地工作台。
- Target / Workflow / Evaluation Plan 注册模型。
- 异步完整 Baseline Pilot、质量门禁与失败节点映射。

## Phase 2：真实生产样本治理

- 从授权 Query Trace/用户反馈抽样，不直接复制全部日志。
- PII/PHI 自动脱敏加人工复核。
- 按业务分群、风险和频次做代表性采样。
- 时间切分 Development / Regression / Holdout，避免 Prompt 对测试集过拟合。
- 保存 Dataset、Prompt、Target、Tool Schema 和 Judge 版本。

## Phase 3：多干预实验

- Prompt、Query Rewrite、Rerank、工具描述和路由规则分别形成 Candidate。
- 同一 Dataset 下比较单变量变化。
- 输出改善、退化、无变化和无法判定案例。
- 安全硬门禁失败时直接拒绝发布建议。
- 新增 Document Quality Suite：分层评测 OCR、Layout、Cleaning、Chunk 和 Retrieval，通过隔离 Sandbox 让质量工程 Agent 执行受约束实验，详细方案见 [文档质量 Agent 评测与优化闭环](document-quality-agent-evaluation-plan.md)。

## Phase 4：多 Agent 平台

- 客服 Agent、工单 Agent、Text2SQL Agent、浏览器 Agent Adapter。
- 工具参数准确率、轨迹效率、长任务成功率、恢复能力和成本指标。
- CI 回归、定时生产采样、实验审批和趋势告警。
