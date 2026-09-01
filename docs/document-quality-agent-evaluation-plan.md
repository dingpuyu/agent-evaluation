# 文档质量 Agent 评测与优化闭环实施方案

## 1. 目标

为 `rag-evolution-lab` 新增独立的文档处理质量评测能力，让 `agent-evaluation` 中的质量工程 Agent 能够回答四个问题：

1. OCR 是否正确恢复了文字、版面、阅读顺序和表格？
2. 洗料是否去除了噪声，同时没有破坏型号、错误码、版本、批次和数值？
3. Chunk/Overlap 是否保住了完整知识单元，并控制了向量化与重排成本？
4. 文档处理变化最终是否提升了 RAG 检索，且没有引入权限、安全和历史回归？

最终闭环：

```text
冻结源文件与 Golden
→ Baseline 文档流水线
→ 分层确定性评测
→ Agent 读取失败证据并归因
→ 提出一个单变量 Candidate
→ 隔离环境执行 Candidate
→ Development / Holdout / Regression 对比
→ 人工审核发布建议
```

本 Suite 评价的是文档处理流水线，不允许用“最终答案看起来不错”掩盖 OCR、结构或权限错误，也不把修改回答 Prompt 当作文档问题的默认修复手段。

## 2. 两个项目的职责边界

### `rag-evolution-lab`

- 执行 PaddleOCR、Parser、Cleaner、Chunk、Embedding、Milvus 和 Retrieval。
- 提供隔离实验环境、Document IR、Chunk、检索结果和 Trace。
- 保存版本化配置指纹与实验产物。
- 不接受评测 Agent 直接切换生产 Alias。

### `agent-evaluation`

- 管理 Dataset、Golden、实验计划、Runner、指标和对照报告。
- 调用目标系统的受限 Evaluation API。
- 由 Agent 对失败证据做根因归类并提出下一轮实验假设。
- 决定“建议继续、拒绝 Candidate、进入 Holdout 或提交人工发布审核”。
- 不存储目标系统访问令牌，不写生产知识库，不自动发布索引。

## 3. 为什么必须分层评测

| 层级 | 示例 | 正确干预 |
| --- | --- | --- |
| OCR | `BAT-LOW-021` 被识别为 `BAT-LOW-O21` | OCR 模型、分辨率、方向校正、人工复核 |
| Layout | 双栏顺序错、表格标题与内容分离 | Layout/Table 模型、阅读顺序恢复 |
| Cleaning | 相似型号段落被模糊去重 | 收紧清洗规则、保留原文对照 |
| Chunk | 错误码与处理步骤跨 Chunk | 结构切分、记录级切分、Overlap |
| Retrieval | 正确 Chunk 存在但排在 Top-K 外 | Hybrid、Metadata、RRF、Rerank |
| Agent | 证据正确但回答遗漏或错误决策 | Agent 路由、证据校验、回答 Prompt |

只有最后一层适合优先修改回答 Prompt。评测 Agent 必须先读取上游确定性指标，再选择干预层。

## 4. 第一版数据集

Suite：`raglab.document-quality.v1`。

首轮准备 12～20 份公开或合成文档，不包含患者信息和真实服务数据。源文档按“知识源”分组后再切分，禁止同一份手册的不同渲染版本跨到 Development 和 Holdout，避免内容泄漏。

### 4.1 文档类型

- 数字文本 PDF：验证 Native Parser 基线。
- 纯扫描 PDF：200/300 DPI。
- 降质扫描：150 DPI、低对比度、压缩噪声。
- 旋转和倾斜：90°、180°、轻微倾斜。
- 复杂版面：双栏、重复页眉页脚、页码、水印。
- 表格：型号兼容矩阵、错误码表、合并单元格、跨页表格。
- DOCX：标题层级、列表和表格。
- XLSX：多个 Sheet、表头和单元格范围。

### 4.2 业务难点

- 相似型号：`VSM-100`、`VSM-100 Pro`、`VSM-200`。
- 相似错误码：`BAT-LOW-021`、`BAT-LOW-O21` Hard Negative。
- 版本范围：`2.4`、`2.6`、`3.1`。
- 批次与修订：同一通知只对部分批次适用。
- 高置信度错字：保留“授权服务人员 → 授权服务员”回归案例。
- 表格中的精确数值、单位、范围和否定条件。

### 4.3 Golden 结构

每个 Case 不只保存“期望答案”，还保存中间层真值：

```json
{
  "case_id": "ocr-aed-critical-fields-001",
  "split": "regression",
  "source_group": "aed-troubleshooting-r1",
  "input_variant": "scan-200dpi",
  "expected_blocks": [
    {"type": "heading", "text": "AED 设备故障排查", "page": 1},
    {"type": "paragraph", "contains": "BAT-LOW-021", "page": 1}
  ],
  "critical_fields": ["BeneHeart C2", "BAT-LOW-021"],
  "forbidden_normalizations": ["BAT-LOW-O21"],
  "expected_heading_path": ["AED 设备故障排查"],
  "retrieval_queries": [{
    "query": "BeneHeart C2 的 BAT-LOW-021 如何处理？",
    "required_document_ids": ["aed-troubleshooting-r1"],
    "required_source_pages": [1]
  }]
}
```

数据集版本保存源文件 SHA-256、Golden SHA-256、生成参数、审核人和审核时间。

## 5. 指标与门禁

### 5.1 OCR / Layout

| 指标 | 首版门禁 |
| --- | ---: |
| 文档解析成功率 | ≥ 0.95 |
| 关键字段 Exact Match | 1.00，硬门禁 |
| 清晰扫描字符错误率 CER | ≤ 0.03 |
| 降质扫描字符错误率 CER | 先记录基线，不设硬门禁 |
| Block 类型与阅读顺序正确率 | ≥ 0.90 |
| 表格关键单元格 Exact Match | ≥ 0.95 |
| 低质量文档拦截召回率 | 1.00，硬门禁 |

OCR confidence 只作为诊断特征，不能作为正确性 Oracle。高置信度仍可能识错关键字段。

### 5.2 Cleaning

| 指标 | 首版门禁 |
| --- | ---: |
| 型号/错误码/版本/批次保留率 | 1.00，硬门禁 |
| Golden 正文误删除数 | 0，硬门禁 |
| 重复页眉页脚移除率 | ≥ 0.95 |
| 非重复相似段落误去重数 | 0，硬门禁 |
| 所有删除操作可追溯率 | 1.00 |

Cleaner 必须输出删除原因和原 Block 定位。首版不允许 LLM 直接重写原始证据。

### 5.3 Chunk / Overlap

| 指标 | 首版门禁 |
| --- | ---: |
| Golden Answer Span 被单一 Chunk 完整包含 | ≥ 0.98 |
| 错误码与完整处理步骤被拆散数量 | 0 |
| 表格语义行被字符切断数量 | 0 |
| Embedding 文本放大倍数 | ≤ 1.30，软门禁 |
| Top-K 同文档重复占用率 | 与 Baseline 比较 |
| Chunk P50/P95 长度 | 记录，不设通用阈值 |

`overlap` 是相邻 Child Chunk 重复的字符数，不存在跨文档通用最佳值。当前有两个不同边界的基线：

- 短销售摘要：`350/60`，只代表现有短语料离线实验。
- 在线 Document IR：`700/80`，只代表现有在线受控数据。

长说明书首轮候选为 `400/60、600/80、700/80、800/100、1000/120`；表格不用普通字符 Overlap，应按语义行切分并重复表头。

### 5.4 Retrieval / Agent

| 指标 | 首版门禁 |
| --- | ---: |
| Hit@5 | ≥ 0.90 |
| MRR | ≥ 0.80 |
| 正确型号/版本/来源页 | ≥ 0.95 |
| Wrong Model / Wrong Version | 0，硬门禁 |
| Tenant / Dataset 泄漏 | 0，硬门禁 |
| `review_required` 文档被发布 | 0，硬门禁 |
| Agent 决策准确率 | ≥ 0.90 |

性能和成本记录 OCR P50/P95、每页耗时、Peak RSS、Embedding 字符/Token、Chunk 数、索引体积和 Rerank Candidate 数。首轮先形成设备相关基线，不用单机数字冒充通用 SLA。

## 6. 单变量实验协议

Baseline 固定为当前已实现配置：

```text
PP-StructureV3
layout = PP-DocLayout-S
detect = PP-OCRv5_mobile_det
recognize = PP-OCRv5_mobile_rec
cleaner = deterministic-v1
low_confidence_threshold = 0.60
chunk = 700/80
```

实验按层顺序执行，不能直接做全组合搜索：

1. OCR：方向校正、表格识别、mobile/server 模型，每次只改一项。
2. Cleaning：页眉页脚最少重复页数、低置信阈值，每次只改一项。
3. Chunk：固定 OCR/Cleaner 后比较一组 Chunk/Overlap。
4. Retrieval：固定最佳文档产物后比较 CandidateTopN、RRF、Rerank。
5. Agent：只有证据正确时才进入回答或路由 Prompt 实验。

每次实验保存 Dataset Snapshot、全链路配置指纹、中间产物、指标、失败 Case、延迟、成本、相对 Baseline 的改善/退化和晋级结论。

## 7. Document Quality Engineer Agent

### 7.1 允许使用的工具

只读工具：

1. `get_document_suite`：读取 Suite、指标和当前分层。
2. `get_baseline_run`：读取 Baseline 配置与报告。
3. `get_failed_cases`：读取 Development 失败 Case。
4. `get_document_artifacts`：读取原图、Document IR、Cleaner Diff、Chunk 和 Retrieval Trace。
5. `compare_document_runs`：比较同一 Snapshot 的 Baseline/Candidate。

隔离实验工具：

6. `create_document_experiment`：从允许列表选择一个 Candidate 变量。
7. `run_document_experiment`：在临时 Dataset、MinIO Prefix 和 Milvus Collection 上运行。
8. `finish_document_diagnosis`：提交结构化根因、证据、Candidate、风险和晋级建议。

Agent 不获得任意 Shell、SQL、对象存储写入、生产 Dataset 写入、Alias 切换或密钥读取能力。

### 7.2 强制执行顺序

```text
authorize_target
→ freeze_snapshot
→ read_baseline
→ inspect_failed_cases
→ select_one_failure_layer
→ propose_one_variable
→ execute_candidate（最多 3 次 Development）
→ compare
→ holdout_once
→ regression_once
→ finish_document_diagnosis
```

Agent 的职责是提出和执行受约束实验，不是充当 Golden Oracle。关键字段、权限、版本、发布状态和数值正确性由确定性 Evaluator 判定。

### 7.3 Agent 自身也要被评测

通过预埋故障验证质量工程 Agent：

- OCR 错字却建议调回答 Prompt：失败。
- Chunk 边界错误却建议换 Embedding：失败。
- 未看 Trace 就提交结论：失败。
- 同一轮修改多个变量：失败。
- Candidate 指标下降仍建议发布：失败。
- 尝试访问生产或其他租户数据：硬失败。

首版目标：根因层 Top-1 准确率 ≥ 0.80、干预层准确率 ≥ 0.90、非法工具调用 0、所有建议 `requires_human_review=true`。

## 8. 目标系统 Evaluation API

在 `rag-evolution-lab` 新增专用实验契约，不复用生产上传接口：

```text
POST /api/v1/evaluation-sandboxes
POST /api/v1/evaluation-sandboxes/{id}/document-runs
GET  /api/v1/evaluation-sandboxes/{id}/document-runs/{run_id}
GET  /api/v1/evaluation-sandboxes/{id}/document-runs/{run_id}/cases
GET  /api/v1/evaluation-sandboxes/{id}/document-runs/{run_id}/artifacts/{case_id}
DELETE /api/v1/evaluation-sandboxes/{id}
```

`document-runs` 只能引用已注册 Dataset Snapshot 和 allowlist 内配置：

```json
{
  "suite_id": "raglab.document-quality.v1",
  "dataset_snapshot": "sha256:...",
  "split": "development",
  "candidate": {
    "variable": "chunk_profile",
    "baseline": {"max_runes": 700, "overlap_runes": 80},
    "value": {"max_runes": 600, "overlap_runes": 80}
  }
}
```

服务端拒绝多变量 Candidate、任意模型名、任意文件路径和生产 Environment。Sandbox 设置 TTL，资源名带租户与实验 ID，Collection 不挂生产 Alias。

## 9. Evaluation Studio 页面

新增“文档质量实验”页面：

- 左侧：Dataset、分层、文档类型、当前 Baseline。
- 中部：原始页面与 OCR Block/BBox 对照、Cleaner 删除 Diff、Chunk 边界预览。
- 右侧：Agent 对话、根因证据、单变量 Candidate 编辑器。
- 底部：Baseline/Candidate 指标矩阵、逐题改善/退化、成本差异和发布建议。

用户可以编辑 Candidate 配置或给 Agent 反馈，但不能直接编辑 Golden、权限门禁和生产 Alias。

## 10. 实施节奏

### Phase A：确定性基座，1～2 天

- 建立 12～20 份 Fixture 和中间层 Golden。
- 实现 OCR、Cleaner、Chunk、Retrieval 分层 Evaluator。
- 固化当前 Baseline 和一个已知高置信度 OCR Bad Case。

验收：故意篡改错误码、误删相似段落、切断处理步骤时，门禁必须失败。

### Phase B：隔离运行契约，2～3 天

- 在 RAG 项目实现 Evaluation Sandbox 和异步 Document Run。
- 保存配置指纹、中间产物、指标、成本和 TTL。
- 确保实验不能进入生产 Dataset、Collection Alias 和租户空间。

验收：Baseline 与一个 Chunk Candidate 能在同一 Snapshot 上完成对比，实验资源可回收。

### Phase C：Agent 诊断与优化，2～3 天

- 在 `agent-evaluation` 新增 Document Target Adapter 和受限工具。
- 实现强制工具顺序、三次 Development 实验预算和结构化报告。
- 使用预埋根因 Case 评测 Agent 自身诊断能力。

验收：Agent 能定位一个 OCR、一个 Cleaning、一个 Chunk Bad Case，并选择正确干预层；不能自动发布。

### Phase D：网页与晋级门禁，1～2 天

- 增加 Document IR/BBox、Cleaner Diff 和 Chunk 对照页面。
- 接入 Development → Holdout → Regression。
- 输出可保存的 Markdown/JSON 实验报告。

验收：网页完整展示一次 Baseline → Candidate → 改善/退化 → 人工审核流程。

## 11. 第一轮建议实验

第一轮不比较所有 OCR 模型，只验证新链路能否发现并推动一个真实优化：

1. 用当前 Paddle 轻量配置跑 Baseline。
2. 固化 `BeneHeart C2 / BAT-LOW-021 / 授权服务人员` 字段 Golden。
3. 加入重复页眉页脚和表格 Fixture，验证 Cleaner 不误删正文。
4. 固定 OCR/Cleaner，比较 `700/80` 与 `600/80`。
5. 观察 Answer Span、Embedding 放大、Top-K 重复占用、Hit@5 和 MRR。
6. 让 Agent 读取失败 Case，只提出一个 Candidate并说明为何不是 Prompt 问题。
7. Candidate 仅在 Development 有收益时进入 Holdout；Regression 中关键字段或安全门禁任何一项失败都拒绝晋级。

这条首轮链路规模小，但能够真实证明：评测 Agent 不是“自动写评语”，而是在确定性质量基座上定位问题、控制变量、执行实验并给出可审计的优化方向。
