# 从答案通过到证据通过：一次真实 RAG 优化闭环

日期：2026-08-18

## 背景

首轮 8 条生产形态样本曾达到 100%，但当时主要检查决策、答案关键词、禁止内容和引用数量。进一步查看“双型号比较”原始响应后发现：回答提到了 BeneVision N1 与 IntelliVue MX550，引用却只有 MX550 和通用目录，没有 N1 专属资料。

这说明旧指标存在盲区：LLM 可以依赖名称、常识或通用目录生成看似正确的答案，但证据并未覆盖问题里的每个实体。

## Evaluation 平台升级

生产样本契约新增：

- `required_document_ids`：必须出现的证据文档；
- `forbidden_document_ids`：禁止进入上下文的文档；
- `allowed_dataset_ids`：引用必须来自的受权数据集；
- `minimum_distinct_documents`：组合问题的最少独立来源数。

汇总指标新增 `evidence_coverage` 和 `dataset_compliance`，并设为质量门禁。失败归因落到 `retrieve` 节点，优化建议指向实体拆分、候选配额、Metadata、融合和 Rerank，不建议盲改回答 Prompt。

## Before

- Run：`pilot_463fd54dcc3b4269bd15a2e888766f57`
- Overall：87.5%
- Evidence Coverage：87.5%
- Safety：100%
- Gate：失败
- 失败用例：`prod-comparison-002`

## RAG 平台修复

RAG Agent 对多个显式型号进行并行 fan-out 检索，再按实体交错合并、去重证据。每个子检索仍通过 Knowledge Gateway 完成服务端 ACL 和 Dataset 过滤。修复过程中还发现并发请求可能取得相同纳秒时间戳 Trace ID，随后改为随机 128-bit ID，并增加 1000 并发唯一性测试。

## After

- Run：`pilot_1884349bf7c040f59a1682cfe2139153`
- Overall：100%
- Evidence Coverage：100%
- Dataset Compliance：100%
- Safety：100%
- 平均延迟：2113.375 ms
- Gate：通过
- 已修复：`prod-comparison-002`
- 新增退化：0

平台的运行对比页和 `/api/v1/pilots/compare` 会直接展示这次 Fail → Pass、+12.5 个百分点证据覆盖提升与已修复用例。

## 能对外讲清的经验

1. 评测平台不是给答案打一个总分，而是把业务问题映射到可干预节点。
2. RAG 的正确性至少包含答案、证据、适用范围和授权边界四层。
3. Frozen Dataset 上的前后对比可以证明本次改动修复了指定 Bad Case 且没有引入已知退化。
4. 8 条样本只是第一步，不代表生产质量；下一阶段应接入授权脱敏 Trace，增加 Development、Regression、时间隔离 Holdout。
5. 单次延迟变化受外部 API 网络波动影响，不能直接归因给本次检索改动；性能需要重复运行并比较 P50/P95。
