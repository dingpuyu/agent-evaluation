# Document Quality Suite Phase A 验证报告

日期：2026-09-02

## 结论

首版确定性质量基座已经跑通。它可以把文档流水线失败归因到 `OCR / Layout / Cleaning / Chunk / Retrieval / Safety`，并阻止 Agent 把所有问题都归结为 Prompt。

本报告中的 4/4 结果是 **Evaluator 契约 Fixture 验证**，用于证明 Golden、Artifact 和门禁计算一致；它不是 PaddleOCR 在完整冻结集上的生产基线。实际 Parser/OCR/Cleaner/Chunk 对比已经在 Phase B 跑通，仍不能被表述为生产准确率。

## 已完成

- `raglab.document-quality.v1` 冻结数据集：10 条 Case。
- Development 4 条、Holdout 3 条、Regression 3 条。
- 按 `source_group` 隔离，不允许同源不同渲染跨分层。
- 支持关键字段 Exact Match、Forbidden Normalization、Block、阅读顺序、Cleaner 删除、Protected Text、Chunk Span、来源文档和页码 Golden。
- 生成 Dataset SHA-256 Snapshot。
- 支持 JSON 和 Markdown 报告。

## 契约 Fixture 结果

```text
Split                     development
Cases                     4/4
Critical Field Exact      1.0000
Hard Case Failures        0
Protected Text            1.0000
Expected Noise Removal    1.0000
Answer Span Containment   1.0000
Hit@5                     1.0000
MRR                       1.0000
Wrong Document            0
Unsafe Publish            0
Gate                      PASS
```

Fixture 使用配置指纹 `contract-fixture:document-ir-v4:700-80`。名称显式标注 `contract-fixture`，避免被误认为真实 OCR 或生产指标。

## 故障注入验证

单测主动制造以下错误，并确认门禁落到正确层：

| 注入故障 | 预期归因 | 结果 |
| --- | --- | --- |
| `BAT-LOW-021 → BAT-LOW-O21` | OCR | 已检出 |
| 将“仅授权服务人员执行”作为模糊重复删除 | Cleaning | 已检出 |
| 将错误码和处理步骤拆到两个 Chunk | Chunk | 已检出 |
| 召回 Forbidden Document | Retrieval | 已检出 |
| `review_required` 文档标记为已索引 | Safety | 已检出 |

这组测试证明 Evaluator 不依赖 LLM Judge，也不会因为最终答案包含相似词就放过关键字段、误删除或错误来源。

## 运行方式

```bash
make test
make build
make document-eval \
  ARTIFACTS=tests/fixtures/document-quality-development-pass.json \
  SPLIT=development
```

生成文件默认写入 `data/document-quality/`，该目录不进入 Git，因为真实 Artifact 未来可能包含目标系统文档片段。仓库只提交脱敏 Fixture 和结构化 Golden。

## 后续状态

Phase B 已实现受鉴权的无索引 Artifact 导出、Cleaner 删除 Block、实际 PaddleOCR/Parser 调用和同 Snapshot 的 Chunk 对比。`400/100` Baseline 为 3/4，`700/80` Candidate 为 4/4；完整失败证据、复现命令和运行边界见 [Phase B 真实流水线对比报告](document-quality-phase-b-report.md)。

下一步是把已冻结 Candidate 依次跑 Holdout、Regression 和临时 Milvus Retrieval，再将这些受限工具开放给 Document Quality Engineer Agent。顺序仍然是先证明数据与指标可靠，再评测 Agent 是否能正确利用证据。
