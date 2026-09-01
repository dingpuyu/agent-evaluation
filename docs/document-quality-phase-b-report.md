# Document Quality Suite Phase B：真实流水线对比报告

日期：2026-09-02

## 结论

第一条真实纵向链路已跑通：`rag-evolution-lab` 通过受鉴权、无索引的 Artifact 接口运行实际 PDF/XLSX/Markdown Parser、PaddleOCR、Cleaner 与 Chunker；`agent-evaluation` 在同一 Dataset Snapshot 上比较 Baseline 与 Candidate，并给出可审计的晋级建议。

本轮固定 OCR、Layout、Cleaner 和 4 条 Development Case，只改变 Chunk 参数：

| 指标 | Baseline `400/100` | Candidate `700/80` | 变化 |
| --- | ---: | ---: | ---: |
| 通过 Case | 3/4 | 4/4 | +1 |
| 硬失败 | 1 | 0 | -1 |
| Answer Span Containment | 0.75 | 1.00 | +0.25 |
| 关键字段 Exact Match | 1.00 | 1.00 | 0 |
| Protected Text | 1.00 | 1.00 | 0 |
| Expected Noise Removal | 1.00 | 1.00 | 0 |
| 平均 CER | 0 | 0 | 0 |
| Embedding 文本放大倍数 | 1.0734 | 1.0299 | -0.0435 |

对比器给出 `PROMOTE`：Candidate 修复 `dev-chunk-long-procedure-004`，没有新增回退。这里的 Promote 只表示“可以从 Development 进入下一阶段”，不表示可以直接发布生产。

## 实际输入与证据

导出脚本每次动态生成四份完全合成、无患者数据的真实格式文件：

1. 图片型中文 AED 扫描 PDF：验证 OCR、版面顺序和关键标识符。
2. 三页重复页眉/页脚 PDF：验证删除原因与正文保护。
3. XLSX 型号/版本/硬件修订矩阵：验证表头语义和相似型号。
4. 长 Markdown 服务步骤：验证完整操作单元是否被单一 Chunk 包含。

所有 Artifact 都来自目标系统的真实 Parser 调用，不是手工拼接的成功样本。响应包含 Document IR v4、Block、Cleaner 删除审计、Chunk、运行耗时和参数指纹，并固定 `indexed=false`、`retrieval=[]`。

## 发现并修复的 Bad Case

### 1. 小 Chunk 切断长操作单元

`400/100` 看似粒度更细，但长步骤从约第 270 个字符开始，完整答案单元跨过窗口边界，没有任何单一 Chunk 完整包含 Golden Span。它因此在 Chunk 层失败，而不是被归因到 Embedding、Rerank 或 Prompt。

保持输入文档、OCR 和 Cleaner 不变后，`700/80` 完整保留答案单元，并减少本组样本的重复文本放大。这个结果证明 Chunk Size 需要围绕业务答案单元评测，不能只凭经验设一个数字。

### 2. 版面模型漏掉整行

最初的扫描页混用 20/18pt 字号且首段行距不同。字符识别保留了型号和错误码，但 PP-DocLayout-S 没有输出完整处理行，整页 CER 为 `0.3649`。固定模型，仅把合成页正文统一为 18pt、60pt 行距后恢复 5/5 Block，CER 降为 `0`，该 Artifact 的平均 OCR confidence 为 `0.977630`。

经验是：OCR confidence 不是正确性 Oracle；必须同时对整页文本、关键字段、Block 数和阅读顺序做 Golden 校验。

### 3. Golden 与 Parser 稳定契约不一致

XLSX 首轮 Golden 写成无列名的 `VSM-100 | 2.6`，而 Parser 的稳定输出是 `型号: VSM-100 | 软件版本: 2.6 | 硬件修订: HR-1`。检查源文件和 Document IR 后确认这是评测契约漂移，不是解析回归，因此修正 Golden，而没有为了通过测试去破坏带表头语义的 Parser 输出。

### 4. ARM64 容器运行时故障

Linux ARM64 容器中的 PaddlePaddle 3.2.2 在 PPStructureV3 初始化时发生 SIGSEGV；同一机器的 macOS PaddlePaddle 3.3.1 + PaddleOCR 3.7.0 可以通过真实探针。本轮用宿主机 Worker 完成本地算法验收，但没有把它写成“容器部署已通过”。目标部署仍需验证 x86_64 镜像、新版 ARM wheel，或选择云 OCR/独立 OCR 节点。

## 评测边界

本轮报告显式设置：

```text
evaluated_layers = ocr,layout,cleaning,chunk
split = development
```

Retrieval 与 Safety 没有运行，也不会因为字段为空而被算成通过。无索引接口不会写 MinIO、PostgreSQL、Embedding 或 Milvus；这既避免污染在线数据，也意味着 Hit@5、MRR、错型号、错版本和租户隔离尚无本轮结论。

Artifact 原文可能来自目标系统，因此 `data/document-quality/` 默认被 Git 忽略。仓库只提交合成 Golden、脱敏契约 Fixture、执行器和报告方法，不提交 Token 或实际访问凭据。

## 可复现命令

先启动 RAG 平台与可用的 OCR Worker，然后分别导出：

```bash
cd ../rag-evolution-lab
OUTPUT=../agent-evaluation/data/document-quality/artifacts-400-100.json \
MAX_RUNES=400 OVERLAP_RUNES=100 make document-quality-export

OUTPUT=../agent-evaluation/data/document-quality/artifacts-700-80.json \
MAX_RUNES=700 OVERLAP_RUNES=80 make document-quality-export
```

在评测仓库运行分层评测和对比：

```bash
npm run document-eval -- \
  --artifacts data/document-quality/artifacts-400-100.json \
  --split development --layers ocr,layout,cleaning,chunk \
  --output-json data/document-quality/report-400-100.json \
  --output-md data/document-quality/report-400-100.md

npm run document-eval -- \
  --artifacts data/document-quality/artifacts-700-80.json \
  --split development --layers ocr,layout,cleaning,chunk \
  --output-json data/document-quality/report-700-80.json \
  --output-md data/document-quality/report-700-80.md

npm run document-compare -- \
  --baseline data/document-quality/report-400-100.json \
  --candidate data/document-quality/report-700-80.json
```

## 下一步门禁

1. 保持 Candidate 冻结，补充旋转、低 DPI、双栏、跨页表格的 Holdout Artifact，只运行一次。
2. 把 Candidate 跑过 Regression，关键标识符、Cleaner 正文保护或 `review_required` 发布安全任一失败即 Hold。
3. 在临时 Dataset/Collection 接入真实 Embedding、Milvus 和 Rerank，增加 Hit@5、MRR、WrongModel/Version 和引用定位。
4. 把上述工具包装成 Document Quality Engineer Agent 的严格状态机：最多三次 Development 实验、单变量修改、禁止自动发布、最终必须人工审核。

这才形成完整的工程闭环：失败样本不是拿来“调到通过为止”，而是先归因到正确层，控制变量修复，再用不可见集和安全回归阻止过拟合。
