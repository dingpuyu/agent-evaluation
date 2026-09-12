# 文档质量评测可信度修复与验证记录

验证日期：2026-09-12。范围：评测器与实验输入可信度，不是新增模型能力，也不是全链路生产验收。

## 1. 本次为什么先修裁判

审查历史报告时发现：即使请求确实经过 Qwen、Milvus 和 Rerank，评测代码本身也可能把失败算成成功。继续增加数据或调用更强模型，不能消除这种误判。

本轮先写反例，在旧实现上运行：最初 4 组反例全部失败，证明旧门禁可被绕过；然后修代码、补充报告迁移和输入冻结测试。没有改 Golden 来制造通过，没有重开已消费 Holdout，也没有用 LLM Judge 代替精确校验。

## 2. 复现的问题与修复

| 问题 | 可复现反例 | 修复与当前行为 |
| --- | --- | --- |
| 精确字段变成子串匹配 | `4.2` 在 `14.2`、`4.2.1` 中被算命中；短批次命中长批次 | 标识符边界校验，保留原大小写与标点，不做模糊归一化；反例失败才是正确结果 |
| 正确文档与错误证据串用 | 正确文档只有半句，错误文档却包含完整答案跨度 | 只在 Top-5 中属于 required_document_ids 的证据内核对答案跨度 |
| 没有测却是 100% | 没有来源定位或噪声标注时，零分母被算作 1 | `value=null`、`passed=null`、`status=not_evaluated`、`sample_count=0`；所选评测层的硬指标无覆盖则 HOLD |
| 伪单变量实验 | 改 Chunk 的同时改型号、版本、批次或 Parser 配置 | 校验元数据、来源、Document IR、清洗产物与非 Chunk 配置；发现漂移，在模型调用前拒绝 |
| 输入文件没有冻结 | 本地旧 A/B 产物中有 6 份文档的原文件哈希不同 | 一次生成、一次上传、一次解析，再由同一 IR 切出 A/B；源文件 SHA-256 与输入指纹纳入记录 |
| 旧 PASS 自动沿用 | 新评测器仍显示旧报告绿色通过 | 报告标注 `document-quality/2`；旧结果保留为历史待复核，不作为晋级许可 |
| 更换候选重刷盲测 | 用新 Candidate Fingerprint 请求同一已消费 Snapshot | 按租户与 Snapshot 检查消费记录；换候选或评测器不能重开 |

子串修复不是通用实体解析器。例如 `VSM-100` 和带空格后缀的产品名称仍需要独立型号标注与适用范围校验；不能凭一个字符串匹配器宣称解决所有型号歧义。

## 3. 严格规则对已有成绩的影响

Phase F 的历史真实调用记录为 Baseline `3/4`、Candidate `4/4`。这些调用记录不被删除，但当时的完整门禁通过结论不成立：4 条 Holdout 缺少 `expected_noise_removal` 与 `retrieval_source_locator_accuracy` 的标注覆盖。

新测试用现有冻结用例及确定性 Retrieval Fixture 验证：用例层面的 4/4 并不意味着所有硬指标通过，整体应 HOLD。这不是本轮重新运行真实 Qwen 后得到的准确率，也不表示业务效果突然退化，而是评测语义被纠正。

已曝光、已消费的数据不能重新称作盲测。后续应在 Development/Regression 补充人工标注；新的盲测需要独立准备并冻结。明确不适用的层可在预索引开发实验中显式缩小范围，不能在看过结果后临时删掉失败指标。

## 4. 成对导出：控制变量与节省 OCR 成本

RAG 接口 `POST /api/v1/datasets/{dataset_id}/documents/evaluation-artifacts` 新增可选表单参数：

```text
max_runes=400                 overlap_runes=100
candidate_max_runes=700       candidate_overlap_runes=80
```

提交候选参数时返回 `artifact-pair.v1`，包含 `baseline`、`candidate`、`parser_executions=1`。二者源文件哈希、Document IR、Blocks 与 Cleaning 相同，Chunk 不同，均为 `indexed=false`。单份导出接口仍兼容。

参数含义是 Unicode 字符数，不是 Token：`max_runes` 允许 100–2000，Overlap 必须非负且小于窗口一半。`400/100 → 700/80` 是当前对照实验候选，不是行业通用最优值。

在 RAG 仓库运行：

```bash
BASELINE=../agent-evaluation/data/document-quality/artifacts-400-100.json \
CANDIDATE=../agent-evaluation/data/document-quality/artifacts-700-80.json \
MAX_RUNES=400 OVERLAP_RUNES=100 \
CANDIDATE_MAX_RUNES=700 CANDIDATE_OVERLAP_RUNES=80 \
make document-quality-export-pair
```

完整导出遇到扫描件仍需要可用的 OCR Worker。本轮本机 OCR 就绪检查受 Worker 不可达影响，未把这次原生 Markdown 验证宣称为扫描 PDF/OCR 验收。

## 5. 实际验证与复现

| 验证 | 本次结果 | 外部模型调用 |
| --- | --- | --- |
| `npm test` | 41/41 通过，含 7 组新增完整性测试 | 0 |
| `npm run build` | TypeScript 构建通过 | 0 |
| RAG `go test ./internal/httpapi -run DocumentQuality -count=1` | 通过，含成对接口 Mock Parser 计数与指纹断言 | 0 |
| `python3 scripts/document_quality_integrity_smoke.py` | 本地真实 API + 原生 Parser：解析次数 1、来源/IR/清洗相同、Chunk 不同、不建索引；元数据篡改返回 HTTP 400 | 0 |
| 网页渲染回归 | 无覆盖显示未评测和 n=0；历史详情和历史列表均不显示绿色 PASS | 0 |
| 浏览器实际登录查看 | 本地工作台展示“历史记录 · 待复核”，阶段为 evaluator-revalidation-required，旧 Holdout 显示已消费；不触发重跑 | 0 |

HTTP 探针仅上传合成 Markdown 到无索引预览端点，不写知识索引、不保存测试实验、不输出令牌。默认使用仓库已有的本地演示账号，也支持 `AGENT_EVALUATION_EMAIL/PASSWORD`、`INTEGRITY_DATASET_ID` 覆盖；不得把演示密码用于公网。

## 6. 低成本模型如何使用

本轮模型 API 调用数为 0，模型 API 费用为 0。精确标识、权限、来源、样本覆盖、配置漂移和门禁判定由确定性代码执行。

后续可复用现有 DeepSeek 配置，辅助生成 Bad Case 归因候选、实验假设与说明文本；仍须人工确认，模型不能更改 Golden、重开 Holdout 或自行发布。建议先通过完整性检查，再跑少量 Development 样本；按唯一配置/输入哈希复用解析产物，避免重复 OCR、Embedding 与无效重排。语义 Judge 只给辅助分，不取代安全和适用范围硬门禁。本轮未新增付费模型，也没有修改现有密钥。

## 7. 可以讲述的技术经历与边界

可以据实讲：我不只实现检索，还发现并修复评测器的假阳性；用故障注入证明漏洞，区分“文档命中”和“来自正确文档的完整证据”，把未覆盖指标从满分改为不可评估；再从原文件与 IR 层控制 A/B 变量，让性能优化结论可追溯。原先漂亮的 PASS 被我主动撤回了晋级效力。

不能讲：已获得真实医院生产验证、百万级准确率、OCR 全面通过、700/80 是生产最优值、或本轮 RAG 准确率得到提升。

仍存在的工程边界：

- Artifact 由已授权管理员上传；哈希用于一致性和可追溯，不是防伪签名。恶意同时伪造两份输入需要后续服务端签发 Artifact 或可信产物存储来防范。
- 本轮校验冻结声明的流水线配置，尚不等于锁定远端供应商实际模型修订；后续应补服务端 Provider 配置/版本回执。
- Holdout 并发锁目前为单进程内存锁，消费结果为文件存储；多副本部署需数据库唯一约束与持久化 attempt 状态机。本轮不宣称分布式 exactly-once。
- 无覆盖指标统一 HOLD 是保守策略；未来若支持“不适用”，必须在冻结协议中预声明，不能事后为通过而豁免。
- 数据集仍小且含合成材料；真实性与统计置信度是下一步工作，不通过追加几条容易题来证明泛化。
