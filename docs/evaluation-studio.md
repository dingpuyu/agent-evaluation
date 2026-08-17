# Evaluation Studio：从项目梳理到阶段 Prompt 实验

## 目标

Evaluation Studio 解决的不是“再做一个聊天机器人”，而是把评测前最容易缺失的业务分析显式化：服务谁、完成什么任务、哪类失败代价最高、有什么可用数据、哪些边界必须硬控制、第一轮评测从哪里切入。

页面地址：`/studio`。

## 项目梳理 Agent

Evaluation Architect Agent 基于 Pi Agent Harness 和 DeepSeek。每轮对话只能访问四个注册工具：

1. 当前租户授权的 Target Contract；
2. 脱敏冻结数据集快照；
3. 当前租户可见的最近 Pilot 摘要；
4. 结构化发布 Project Brief。

Brief 持续保存项目名称、业务目标、用户、关键任务、失败成本、可用数据、约束、未知项、第一个评测建议和就绪度。模型不能枚举其他租户，也不能把猜测写成已知事实；未知信息必须继续留在 `unknowns`。

## 评测链路

```text
目标授权（锁定）
→ 冻结回放（锁定）
→ 范围与决策 Judge（Prompt 可编辑）
→ 检索证据 Judge（Prompt 可编辑）
→ 答案质量 Judge（Prompt 可编辑）
→ 发布建议 Judge（Prompt 可编辑）
```

授权、租户隔离、冻结数据集和确定性安全门禁不允许 Prompt 覆盖。可编辑的是评测模型的 Rubric，不是目标系统的 ACL 或安全规则。

## 阶段 Prompt 对照

阶段实验先对选定冻结样本各执行一次目标 Agent，保留同一批答案、引用与 Trace。随后 Baseline 与 Candidate Judge Prompt 分别评价这些观察结果。系统用数据集中的确定性断言计算 Oracle，再比较：

- Oracle Agreement；
- False Accepts；
- False Rejects；
- 平均 Judge Score；
- 逐题改善、退化和未变化。

这种设计避免把“Judge 更宽松”误当成“质量提升”。Candidate 若在 Golden Oracle 上新增误放或误拒，会被明确标记为退化。所有实验 `production_mutation=false`，仍需人工审核后才能替换正式评测 Prompt。

## 当前边界

- 首个注册 Target 仍是 `rag-evolution-lab`；新项目可以通过对话梳理，但执行回放前必须开发并注册对应 Target Adapter。
- 数据集是脱敏生产形态样本，不宣称为真实线上日志。
- Stage Judge 是模型辅助层，权限、安全和发布硬门禁仍以确定性检查为准。
- 当前工作区使用文件持久化；多副本生产部署应迁移 PostgreSQL，并补充版本号、乐观锁和审计事件表。
