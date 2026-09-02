# Phase D：一次性 Holdout、真实失败与 Bad Case 修复报告

## 结论先行

本阶段没有得到“全绿”结果。冻结候选 `700/80` 在 `v1.4.0` 一次性 Holdout 上为 **2/3，HOLD**。失败结果已经持久化，同一 `candidate_fingerprint + dataset_snapshot` 再次提交返回 `409`，不会因为反复试验而偶然变绿。

这次失败随后产生了一个新的 Development Bad Case。根因修复后的 `v1.5.0` Development 为 Baseline `4/5`、Candidate `5/5`，但没有重跑已见过的 Holdout，因此不能宣称新候选已通过盲测。

## 运行证据

### 冻结 Development

- Experiment：`docqexp_0ba061ddeb8e436b9b5f20c24a078572`
- Dataset：`v1.4.0`
- Snapshot：`sha256:66be26975348ef7b55558752a14a701fb01ff1d8256b0b43f07f66f996a09aec`
- Baseline：`3/4`
- Candidate：`4/4`
- Provider：`text-embedding-v4 / 1024d + Milvus HNSW/BM25/RRF + qwen3-rerank`
- Sandbox：临时 Collection，结束后清理；生产索引未修改。

### 一次性 Holdout

- Experiment：`docqexp_531e7a55ed114be99ab38644b66a9b6c`
- Parent：`docqexp_0ba061ddeb8e436b9b5f20c24a078572`
- Candidate fingerprint：`sha256:2ffda62b70eb020957979129035eeeaa706b879717919a06cbb8844000c753bc`
- Verdict：`fail`
- Candidate：`2/3`
- Hit@5 / MRR / Evidence Span / Locator Accuracy：均为 `1.0`
- Wrong Document：`0`
- Unsafe Publish：`0`
- 进入临时索引的 Chunk：`2`；非 `ready` 文档在 Embedding 前被阻断。

失败 Case：`holdout-low-dpi-review-002`。Golden 期望 `review_required`，实际为 `ocr_required`；Critical Field Exact Match 为 `0.8333`，整体硬门禁失败。

重复提交同一候选返回：

```text
409 this frozen candidate already consumed its one quality-result Holdout attempt
```

基础设施错误不会写入质量结果，可以重试；一旦形成 PASS/FAIL 质量判定，则结果不可重跑。

## 根因定位

最初表象是“低对比度 OCR 失败”。逐层检查后发现真实异常为：

```text
'<' not supported between instances of 'int' and 'NoneType'
```

Paddle 的 `parsing_res_list` 在低对比输入上会返回部分 `block_order=null`。Worker Adapter 把该字段当成必填整数直接排序，导致整页映射失败。修复不是调 Prompt，也不是把 Golden 改成 `ocr_required`，而是：

1. 如果整页 `block_order` 都是数字，按模型顺序排序。
2. 只要存在缺失值，就整页使用 bbox 的 `y/x` 视觉顺序，避免数字与 null 混排导致顺序静默错乱。
3. 增加 `null block_order` 确定性回归测试。
4. Worker 版本升级为 `0.2.0`，Parser Version 记录为 `3.7.0+raglab-worker-0.2.0`。
5. Parser 保留 Worker 的 `review_required`，不再把所有非 `ready` 状态压成 `ocr_required`。

此外，真实复跑还发现宿主机 OCR Worker 退出时 Parser `/healthz` 仍然返回绿色。现在 `/healthz` 只表示进程存活，新增 `/readyz` 检查 OCR 依赖；实测 Worker 停止后 `/readyz` 返回 `503`，恢复后返回 `200`。

## Bad Case 转写后的复测

为避免针对已经看过的 Holdout 原地调参，新增了不同型号、不同内容的 Development Case：

```text
dev-ocr-degraded-fallback-005
BeneVision N12 / N12-DEVELOPMENT-031
180 DPI 低对比扫描
```

真实结果：

- Experiment：`docqexp_fae7e2ead2c74fe7826f131d1ca22876`
- Dataset：`v1.5.0`
- Snapshot：`sha256:966d7fe72ff756deb87fe5e9ac3546d7dd57359cafec98499399f43d7b7f92d5`
- Baseline：`4/5`
- Candidate：`5/5`
- 新 Case 状态：`ready`
- Reading Order：型号标题在设备编号之前。
- OCR Parser Version：`3.7.0+raglab-worker-0.2.0`
- Development Retrieval：Hit@5、MRR、错误文档、引用位置、安全发布全部通过。

## 复现命令

```bash
# 目标系统生成无索引 Artifact
SPLIT=development MAX_RUNES=400 OVERLAP_RUNES=100 \
OUTPUT=../agent-evaluation/data/document-quality/dev-400-100-v15.json \
make document-quality-export

SPLIT=development MAX_RUNES=700 OVERLAP_RUNES=80 \
OUTPUT=../agent-evaluation/data/document-quality/dev-700-80-v15.json \
make document-quality-export

# 真实 Qwen / Milvus / Rerank Development 对照
BASELINE=data/document-quality/dev-400-100-v15.json \
CANDIDATE=data/document-quality/dev-700-80-v15.json \
make document-quality-import

# Holdout 只能由冻结 Development 实验触发一次
PARENT_EXPERIMENT=docqexp_... \
BASELINE=data/document-quality/holdout-400-100-v14.json \
CANDIDATE=data/document-quality/holdout-700-80-v14.json \
make document-quality-holdout
```

## 可用于面试的诚实表述

> 我没有把 Development 4/4 当成生产结论，而是实现了绑定数据快照和候选指纹的一次性 Holdout。第一次真实盲测 2/3 失败，检索指标全过，但低对比扫描触发了 OCR Adapter 的 null 排序异常。我们把失败归因到 OCR/安全层，修复可选字段归一化、状态透传和依赖 readiness，再把不同文档转成 Development 回归，得到 5/5。由于原 Holdout 已经见过，没有用修复版本重跑它；下一次晋级必须使用新的未见文档。

## 尚未完成

- `v1.5.0` 新候选尚无新的未见 Holdout，不能发布。
- Regression 的相似型号 Case 需要同一 Case 表达两份独立文档，当前 Artifact 契约还需升级。
- 宿主机 PaddleOCR 仅用于 Apple Silicon 本地验收；生产仍需 x86_64 OCR 节点或云 OCR，并验证同一 Contract。
