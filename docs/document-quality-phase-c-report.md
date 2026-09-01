# Document Quality Suite Phase C：真实 Retrieval Sandbox 报告

## 结论

2026-09-02 已完成 `400/100 → 700/80` 的真实 Provider 对照。两组 Artifact 来自同一 Parser/OCR/Cleaner 产物，仅 Chunk Profile 不同；每组都独立经过：

```text
text-embedding-v4 (1024d)
→ Milvus 2.6 HNSW/COSINE + BM25
→ RRF(k=60) + exact identifier preservation
→ qwen3-rerank (strict, candidate_top_n=20)
```

候选通过 Development Retrieval 门禁，修复 `dev-chunk-long-procedure-004`，没有新增失败或指标退化。该结论只允许进入 Holdout，不授权自动发布。

## 为什么增加 Evidence Span 指标

首轮真实结果里，Baseline 和 Candidate 的 `Hit@5=1.0、MRR=1.0`。只看文档级召回，会得出“两个参数一样好”的错误结论。

但 `400/100` 把完整服务步骤拆到多个 Chunk。虽然正确文档排第 1，任何单一证据都无法覆盖完整答案。为此增加硬指标：`retrieval_evidence_span_containment`，要求 Golden 答案单元必须完整出现在某个已召回 Chunk 中。

| 指标 | 400/100 | 700/80 | Delta |
| --- | ---: | ---: | ---: |
| Development Cases | 3/4 | 4/4 | +1 case |
| Answer Span Containment | 0.75 | 1.00 | +0.25 |
| Retrieval Hit@5 | 1.00 | 1.00 | 0 |
| Retrieval MRR | 1.00 | 1.00 | 0 |
| Retrieval Evidence Span | 0.00 | 1.00 | +1.00 |
| Mean Embedding Amplification | 1.0734 | 1.0299 | -0.0435 |

## 第二个 Bad Case：无界 Rerank 候选

第一轮把语料中 33/34 个 Chunk 全部送入 Rerank。Trace 中出现 `pre_rerank_rank=33/34` 的弱候选，说明候选数意外随 Chunk 总量增长，会放大供应商调用成本和尾延迟。

修复为独立参数 `candidate_top_n=20` 后复跑：

- 最大 pre-rerank rank 被限制为 20；
- Hit@5、MRR、Evidence Span 和 Case Pass 全部不回退；
- 真实 Rerank 调用仍有网络抖动，因此延迟只记录为软指标，不把一次观测包装成稳定收益。

这次经验说明：`Top-K`、ANN/RRF Candidate 和 Rerank Candidate 是三个不同参数，不能共用一个“越多越好”的数字。

## 隔离与安全验证

- 只有目标系统 `admin/platform_admin` 可运行；viewer 实测返回 403。
- Collection 名由服务端使用加密随机数生成，API 不接受物理 Collection。
- 每条临时记录都带服务端身份生成的 Tenant/Role ACL，Hybrid Search 在 ANN 前过滤。
- Qwen Rerank 使用 strict 模式；真实供应商失败会终止实验，不允许伪装成 Qwen 成功。
- 两轮运行结束后 Milvus `raglab_eval_*` Collection 数均为 0。
- 实验记录不含原始 Artifact/Chunk 内容、模型 Key 或访问令牌。

## 下一步

冻结当前 Candidate，进入一次性 Holdout。之后将本次长步骤证据残缺和无界 Candidate 两个问题固化进 Regression，再补 PDF Page 与 XLSX Sheet/Cell Range 的引用正确性门禁。
