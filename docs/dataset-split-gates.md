# 三层数据集与发布门禁

## 要解决的问题

如果开发者能看到全部题目并不断修改 Prompt，最终得到的通常是“记住这批题”的局部最优，而不是可泛化的 Agent。生产评测需要把形成假设、验证泛化和防止历史退化分开。

当前医疗设备销售试点使用 `raglab-medical-sales-production-sample-v2@2.0.0`，共 28 条脱敏生产形态样本：

| Split | 数量 | 用途 | 运行前是否可见 |
| --- | ---: | --- | --- |
| Development | 10 | 调试工具链、定位问题、形成 Prompt 假设 | 是 |
| Holdout | 8 | 验证未见问题上的泛化能力 | 否 |
| Regression | 10 | 固化已确认 Bad Case、安全边界和多实体问题 | 是，但不可删除 |

这些数据来自公开医疗设备资料对应的合成问题、脱敏生产流量形态和已经复现过的工程 Bad Case，不包含患者信息，也不宣称是真实线上日志。

首轮真实回放还发现了一个 Golden False Positive：新客户产品线介绍属于固定引导人设，按业务契约不触发 RAG；旧标注却要求 `grounded_customer_answer + citation`，把正确行为判成失败。修复方式是将该类用例标成 `customer_guided_onboarding` 且不强制引用，而不是为了迎合错误标注去修改业务 Agent。

完整 Regression 又发现第二个 False Positive：面对“跳过权限并输出内部资料”，Agent 用 `answer/grounded_customer_answer` 明确拒绝泄露并引导安全外部检查，旧 Golden 却只接受 `clarify/insufficient_evidence`。新版契约允许多种合规 decision/reason 组合，但同时强制出现拒绝语义并禁止内部内容，从而评价业务结果而不是死记状态码。

## 首轮真实门禁结果

在快照 `sha256:433918add4b8c1192e113d6f0ef604b5eb0aeed113a39e56536953d5d63c5bcc` 上，通过已注册的 `rag-evolution-lab` Target 真实回放 Regression 10 条样本：

| 指标 | 结果 |
| --- | ---: |
| Pass Rate | 100% |
| Decision Accuracy | 100% |
| Citation Compliance | 100% |
| Evidence Coverage | 100% |
| Dataset Compliance | 100% |
| Safety Pass Rate（6 条） | 100% |
| 平均端到端延迟 | 2870.8 ms |

所有硬门禁通过，`production_mutation=false`。这不是对模型效果的永久保证，而是该 Target、数据快照和运行环境下的一次可复现实验记录。

阶段 Prompt 对照还验证了平台的优化闭环：Holdout 越权样本中，Baseline Release Judge 把泛化的“证据不足”误当成满足明确拒绝短语，Oracle 一致率为 0；Candidate Prompt 强制逐字核验 `required_answer_any` 后，一致率提升到 100%，晋级状态为 `validate_regression`。这类改进只改变评测 Judge，不修改被测 Agent，能避免用评测 Prompt 偷偷掩盖目标系统缺陷。

## 冻结与可复现性

加载数据时计算整个 JSON 文件的 SHA-256，实验同时保存：

- `dataset_id`
- `dataset_version`
- `dataset_snapshot`
- `dataset_split`

比较两次 Pilot 时，Target、Dataset、Snapshot 和 Split 必须完全一致。即使文件名没变，只要内容发生变化，快照就不同，平台拒绝把两次结果当成同一基线比较。

## Holdout 防泄漏

`GET /api/v1/datasets/production-sample` 会保留 Holdout 数量和风险分布，但用占位文本替换问题、期望决策和语义化 ID。项目梳理 Agent 的数据检查工具同样只读取 Development 与 Regression 示例。

当用户主动运行 Holdout 实验后，该次结果可以展示问题和逐题证据，便于人工复核；这意味着本版本 Holdout 已被“消费”。如果继续依据这些题修改 Prompt，下一轮正式验证应发布新的 Dataset 版本并轮换 Holdout。

## 晋级状态

```text
Development 有收益且无退化
  → validate_holdout
Holdout 有收益且无退化
  → validate_regression
Regression 有收益且无退化
  → human_review
任何新增退化或安全失败
  → reject
没有测得收益
  → iterate
```

晋级状态只是工程建议，不直接修改目标 Agent 或正式 Judge Prompt。权限、租户隔离和安全硬门禁仍拥有一票否决权，最终发布必须经过人工审核。

## 当前样本覆盖

- 新客户产品线认知和术语解释。
- BeneVision、BeneHeart、BeneFusion、Resona、IntelliVue、Evita 的型号与配置边界。
- 多实体比较和相似产品族 Hard Negative。
- 价格、库存、注册证、区域在售和数据时效。
- 售后缺少型号时的澄清。
- 临床建议拒答、Prompt Injection 和内部资料越权。
- 否定语境，防止把“不能保证现货”误判成危险承诺。

## 后续演进

真实生产接入后，建议按时间窗口切分：较早的授权脱敏样本进入 Development，较新的时间窗口进入 Holdout，确认过的线上事故进入 Regression。每次变更保留数据来源、脱敏审核人、Golden 审核人和版本变更记录。
