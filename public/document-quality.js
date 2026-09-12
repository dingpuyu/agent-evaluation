const SESSION_KEY = "agent-evaluation-session";
const state = { session: null, catalog: null, baseline: null, candidate: null, experiments: [], current: null };
const $ = (selector) => document.querySelector(selector);
const h = (value) => String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
const fmt = (value) => value === null || value === undefined ? "未评测" : Number.isInteger(Number(value)) ? String(value) : Number(value).toFixed(4);

function toast(message) {
  const node = $("#toast"); node.textContent = message; node.classList.add("show");
  window.setTimeout(() => node.classList.remove("show"), 3500);
}

async function api(path, init = {}, authenticated = true) {
  const headers = new Headers(init.headers || {});
  if (init.body) headers.set("Content-Type", "application/json");
  if (authenticated && state.session?.access_token) headers.set("Authorization", `Bearer ${state.session.access_token}`);
  const response = await fetch(path, { ...init, headers });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload?.error?.message || `请求失败 (${response.status})`);
  }
  return response.json();
}

async function checkHealth() {
  try {
    const health = await api("/healthz", {}, false);
    $("#healthDot").classList.add("ok");
    $("#healthText").textContent = `${health.runtime} · ${health.version}`;
  } catch { $("#healthText").textContent = "评测服务不可用"; }
}

function renderIdentity() {
  const identity = state.session.identity;
  $("#identityBox").innerHTML = `<b>${h(identity.subject)}</b><small>${h(identity.tenant_id)} · ${h(identity.roles.join(" / "))}</small><button id="logout">退出</button>`;
  $("#logout").addEventListener("click", () => { localStorage.removeItem(SESSION_KEY); location.reload(); });
}

function renderCatalog() {
  const catalog = state.catalog;
  $("#datasetName").textContent = `${catalog.dataset.id}@${catalog.dataset.version}`;
  $("#datasetSnapshot").textContent = catalog.dataset.snapshot;
  $("#datasetCases").textContent = `${catalog.dataset.cases} cases · 无患者数据 · ${catalog.dataset.provenance}`;
  const splits = catalog.dataset.splits;
  $("#developmentSplitSummary").textContent = `${splits.development.case_count} 条公开用例 · 可反复运行`;
  $("#holdoutSplitSummary").textContent = `${splits.holdout.case_count} 条隐藏用例 · ${splits.holdout.attempt_status || splits.holdout.status}`;
  $("#regressionSplitSummary").textContent = `${splits.regression.case_count} 条冻结回归 · 仅发布门禁使用`;
  const regressionReady = catalog.current_stage === "regression-ready";
  $("#holdoutStage").classList.toggle("done", regressionReady);
  $("#holdoutSplitCard").classList.toggle("enabled", regressionReady);
  $("#holdoutSplitStatus").textContent = regressionReady ? "一次性通过" : "已锁定";
  $("#regressionSplitCard").classList.toggle("enabled", regressionReady);
  $("#regressionSplitStatus").textContent = regressionReady ? "待执行" : "已锁定";
  $("#currentStageText").innerHTML = regressionReady
    ? "当前 Snapshot 已通过一次性 <b>Holdout</b>，候选参数已冻结；下一步只能运行 Regression，不能再次查看盲测调参。"
    : catalog.current_stage === "evaluator-revalidation-required"
      ? "评测规则已升级：旧版通过结论仅供历史审计。请重新验证 Development；已曝光的 Holdout 不能用于证明新的泛化能力。"
    : catalog.current_stage === "new-holdout-required"
      ? "上一轮 Holdout 已曝光，必须创建新的未见数据后才能继续晋级。"
      : "Development 通过后才允许服务端消费一次 <b>Holdout</b>；网页不能直接读取隐藏问题。";
  $("#pipeline").innerHTML = catalog.pipeline.map((name, index) => `<article class="active"><i>0${index + 1}</i><b>${h(name)}</b><small>${index === 4 ? "Qwen → Milvus Hybrid → Rerank" : "本次实验计算并纳入门禁"}</small></article>`).join("");
  $("#guardrails").innerHTML = catalog.guardrails.map((item) => `<li>${h(item)}</li>`).join("");
  state.experiments = catalog.experiments || [];
  renderHistory();
  if (state.experiments[0]) renderResult(state.experiments[0]);
}

async function loadCatalog() {
  state.catalog = await api("/api/v1/document-quality/catalog");
  renderCatalog();
}

function bundleProfile(bundle) {
  const maxRunes = Number(bundle?.config?.max_runes);
  const overlapRunes = Number(bundle?.config?.overlap_runes);
  return Number.isFinite(maxRunes) && Number.isFinite(overlapRunes) ? `${maxRunes}/${overlapRunes}` : "配置未声明";
}

async function readBundle(input, side) {
  const file = input.files?.[0];
  if (!file) return;
  if (file.size > 900 * 1024) { toast("单个 Artifact Bundle 不能超过 900KB"); input.value = ""; return; }
  try {
    const bundle = JSON.parse(await file.text());
    if (!["agent-evaluation.document-quality.artifacts.v1", "agent-evaluation.document-quality.artifacts.v2"].includes(bundle.schema) || !Array.isArray(bundle.artifacts)) throw new Error("不是支持的 Artifact Bundle");
    state[side] = bundle;
    const prefix = side === "baseline" ? "baseline" : "candidate";
    $(`#${prefix}Name`).textContent = file.name;
    $(`#${prefix}Meta`).textContent = `${bundleProfile(bundle)} · ${new Set(bundle.artifacts.map((item) => item.case_id)).size} cases / ${bundle.artifacts.length} docs · ${(file.size / 1024).toFixed(1)}KB`;
    input.closest(".artifact-drop").classList.add("ready");
    const profile = bundleProfile(bundle);
    if (profile !== "配置未声明") $(`#${prefix}Label`).value = profile;
    $("#runExperiment").disabled = !(state.baseline && state.candidate);
  } catch (error) { state[side] = null; input.value = ""; toast(error.message); }
}

function metricDirection(metric) {
  if (metric.comparable === false || metric.delta === null) return `<span>未评测 / 不可比较</span>`;
  if (metric.improved) return `<span class="up">改善</span>`;
  if (metric.regressed) return `<span class="down">退化</span>`;
  return `<span>不变</span>`;
}

function locatorLabel(hit) {
  if (hit.source_page) return `PDF · P${h(hit.source_page)}`;
  if (hit.source_sheet || hit.source_cell_range) return `工作表 · ${h(hit.source_sheet || "—")} · ${h(hit.source_cell_range || "—")}`;
  return "章节定位 · 无页码 / 工作表标注";
}

function renderResult(experiment) {
  state.current = experiment;
  const comparison = experiment.comparison;
  const split = experiment.dataset?.split || "development";
  const legacy = experiment.candidate_report?.evaluator_version !== "document-quality/2" || experiment.baseline_report?.evaluator_version !== "document-quality/2";
  const passed = !legacy && ["development_passed", "retrieval_passed", "holdout_passed"].includes(experiment.promotion_status);
  const statusLabel = legacy ? "历史记录 · 待复核" : experiment.promotion_status === "holdout_passed" ? "HOLDOUT PASS"
    : split === "holdout" && !passed ? "HOLDOUT FAIL"
      : experiment.promotion_status === "retrieval_passed" ? "RETRIEVAL PASS" : passed ? "DEV PASS" : "HOLD";
  $("#resultStatus").textContent = statusLabel;
  $("#resultStatus").className = `dq-chip ${passed ? "safe" : ""}`;
  const metrics = comparison.metric_deltas.map((metric) => `<div class="metric-row"><b>${h(metric.name)}</b><span>${legacy ? "历史未复核" : `${fmt(metric.baseline)} (n=${metric.baseline_samples ?? "?"})`}</span><span>${legacy ? "历史未复核" : `${fmt(metric.candidate)} (n=${metric.candidate_samples ?? "?"})`}</span><span>${legacy || metric.delta === null ? "—" : `${metric.delta >= 0 ? "+" : ""}${fmt(metric.delta)}`}</span>${legacy ? "<span>旧规则</span>" : metricDirection(metric)}</div>`).join("");
  const coverageNotice = legacy
    ? `<p class="decision-banner hold">旧版报告未修复精确字段、覆盖率和变量冻结问题。原始记录不改写，历史 PASS 不再作为晋级依据；表中旧指标不作可信分数展示。</p>`
    : experiment.candidate_report.coverage_gaps?.length
      ? `<p class="decision-banner hold">缺少评测覆盖：${h(experiment.candidate_report.coverage_gaps.join("、"))}。未评测不等于通过；需补充独立标注或明确缩小评测范围。</p>` : "";
  const sandbox = experiment.retrieval_sandbox;
  const releaseGate = experiment.release_gate ? `<section class="locator-trace"><header><small>SEALED RELEASE GATE</small><b>${h(experiment.release_gate.kind)} · ${legacy ? "历史判定（不可用于晋级）" : h(experiment.release_gate.verdict.toUpperCase())}</b><span>同一租户与 Snapshot 的质量结果只允许一次；更换候选或评测器版本不能重开已消费盲测。</span></header><div><code>${h(experiment.release_gate.candidate_fingerprint)}</code><b>Parent ${h(experiment.release_gate.parent_experiment_id)}</b><span>${h(experiment.release_gate.retry_policy)}</span><small>production_mutation=${h(experiment.production_mutation)}</small></div></section>` : "";
  const sandboxTrace = sandbox ? `<div class="sandbox-trace"><article><small>BASELINE RETRIEVAL</small><b>${h(sandbox.baseline.provider.embedder)} · ${sandbox.baseline.provider.dimensions}d</b><span>${h(sandbox.baseline.provider.reranker)} · ${sandbox.baseline.chunks_indexed} chunks · ${fmt(sandbox.baseline.total_latency_ms)}ms</span><code>${h(sandbox.baseline.collection_scope)} · cleanup=${sandbox.baseline.cleanup_completed}</code></article><article><small>CANDIDATE RETRIEVAL</small><b>${h(sandbox.candidate.provider.embedder)} · ${sandbox.candidate.provider.dimensions}d</b><span>${h(sandbox.candidate.provider.reranker)} · ${sandbox.candidate.chunks_indexed} chunks · ${fmt(sandbox.candidate.total_latency_ms)}ms</span><code>${h(sandbox.candidate.collection_scope)} · cleanup=${sandbox.candidate.cleanup_completed}</code></article></div>` : "";
  const locatorRows = sandbox ? sandbox.candidate.queries.flatMap((query) => query.hits.filter((hit) => hit.source_page || hit.source_sheet || hit.source_cell_range || hit.heading_path?.length).slice(0, 1).map((hit) => `<div><code>${h(query.query_id)}</code><b>${h(hit.document_id)}</b><span>${locatorLabel(hit)}</span><small>${h((hit.heading_path || []).join(" › ") || "无标题路径")}</small></div>`)) : [];
  const locatorTrace = locatorRows.length ? `<section class="locator-trace"><header><small>STRUCTURED CITATION TRACE</small><b>来源定位记录</b><span>展示定位不代表已验证；必须有对应 Golden 标注，指标与样本数才可作为门禁依据。</span></header>${locatorRows.join("")}</section>` : "";
  const scopeRows = sandbox ? sandbox.candidate.queries.filter((query) => query.applied_scope?.length).map((query) => `<div><code>${h(query.query_id)}</code><b>${h(query.applied_scope.join(" · "))}</b><span>Top‑1 ${h(query.hits[0]?.document_id || "无结果")}</span><small>在 ANN/BM25 之前由服务端应用，不依赖 LLM 自觉遵守。</small></div>`) : [];
  const scopeTrace = scopeRows.length ? `<section class="locator-trace"><header><small>EXACT SCOPE TRACE</small><b>型号 / 版本 / 批次过滤</b><span>先缩小适用范围，再执行混合召回与重排，避免相似文档污染证据集。</span></header>${scopeRows.join("")}</section>` : "";
  const decisionTitle = split === "holdout"
    ? passed ? "一次性 Holdout 通过，可进入 Regression" : "一次性 Holdout 失败，冻结结果并阻断发布"
    : passed ? "Development Retrieval 门禁通过，可申请盲测" : "候选策略未通过，保持 Baseline";
  const nextAction = legacy ? "旧规则结论待复核；已消费盲测不得复用" : split === "holdout"
    ? passed ? "进入 Regression" : "转写 Bad Case，形成新候选"
    : passed ? "进入受控 Holdout" : "继续 Development 调参";
  $("#result").innerHTML = `${coverageNotice}<div class="decision-banner ${passed ? "" : "hold"}"><span>${legacy ? "历史" : passed ? "PASS" : "HOLD"}</span><div><b>${legacy ? "旧规则记录，待重新评测" : decisionTitle}</b><p>${legacy ? "原结论不自动迁移到新评测规则。" : h(experiment.comparison.recommendation)}</p></div><code>${h(experiment.experiment_id)}</code></div>
    <div class="score-strip"><article><small>BASELINE CASES</small><b>${comparison.baseline.cases_passed}/${comparison.baseline.cases_total}</b><span>${h(experiment.intervention.baseline)}</span></article><article><small>CANDIDATE CASES</small><b>${comparison.candidate.cases_passed}/${comparison.candidate.cases_total}</b><span>${h(experiment.intervention.candidate)}</span></article><article><small>FIXED / REGRESSED</small><b>${comparison.fixed_cases.length} / ${comparison.regressed_cases.length}</b><span>${h(comparison.fixed_cases.join(", ") || "无修复用例")}</span></article><article><small>PRODUCTION MUTATION</small><b>FALSE</b><span>仅产生实验记录</span></article></div>
    ${sandboxTrace}${releaseGate}${scopeTrace}${locatorTrace}<div class="metric-table"><div class="metric-row head"><span>METRIC</span><span>BASELINE</span><span>CANDIDATE</span><span>DELTA</span><span>DIRECTION</span></div>${metrics}</div>
    <div class="diagnosis-grid"><article><small>RULE-BASED DIAGNOSIS</small><h3>${h(experiment.diagnosis.root_cause_layer)} · 规则归因，待人工确认</h3><ul>${experiment.diagnosis.evidence.map((item) => `<li>${h(item)}</li>`).join("")}</ul></article><article><small>NEXT ACTION</small><h3>${nextAction}</h3><p>${legacy ? "以下归因来自历史实验，不构成新规则下的晋级许可。" : ""}${h(experiment.diagnosis.recommendation)}</p><p><b>人工审核：</b>${experiment.diagnosis.requires_human_review ? "必须" : "否"} · <b>原始产物落库：</b>${experiment.raw_artifacts_persisted ? "是" : "否"}</p></article></div>`;
  $("#resultSection").scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderHistory() {
  $("#history").innerHTML = state.experiments.length ? state.experiments.map((item) => {
    const legacy = item.candidate_report?.evaluator_version !== "document-quality/2" || item.baseline_report?.evaluator_version !== "document-quality/2";
    return `<button class="history-row-dq" data-id="${h(item.experiment_id)}"><code>${h(item.experiment_id)}</code><b>${h((item.dataset?.split || "development").toUpperCase())} · ${h(item.intervention.baseline)} → ${h(item.intervention.candidate)}</b><span class="${!legacy && item.promotion_status !== "hold" ? "passed" : "hold"}">${legacy ? "历史待复核" : h(item.promotion_status)}</span><time>${new Date(item.started_at).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}</time></button>`;
  }).join("") : `<div class="dq-empty">尚无实验记录</div>`;
}

async function runExperiment() {
  const button = $("#runExperiment"); button.disabled = true; button.textContent = "Embedding + Milvus + Rerank 中…";
  try {
    const experiment = await api("/api/v1/document-quality/experiments", { method: "POST", body: JSON.stringify({
      dataset_split: "development",
      execution_stage: "retrieval-sandbox",
      intervention: { variable: "chunk_profile", baseline: $("#baselineLabel").value, candidate: $("#candidateLabel").value, rationale: $("#rationale").value },
      baseline_artifacts: state.baseline,
      candidate_artifacts: state.candidate,
    }) });
    state.experiments = [experiment, ...state.experiments.filter((item) => item.experiment_id !== experiment.experiment_id)];
    renderHistory(); renderResult(experiment); toast("真实 Retrieval 对照完成，临时索引已清理，原始正文未落库。" );
  } catch (error) { toast(error.message); }
  finally { button.disabled = !(state.baseline && state.candidate); button.textContent = "运行真实 Retrieval 对照"; }
}

async function login(event) {
  event.preventDefault(); $("#loginError").textContent = "";
  try {
    state.session = await api("/api/v1/session/login", { method: "POST", body: JSON.stringify({ email: $("#email").value, password: $("#password").value }) }, false);
    localStorage.setItem(SESSION_KEY, JSON.stringify(state.session));
    await loadCatalog(); $("#loginLayer").classList.add("hidden"); renderIdentity();
  } catch (error) { $("#loginError").textContent = error.message; }
}

$("#baselineFile").addEventListener("change", (event) => readBundle(event.target, "baseline"));
$("#candidateFile").addEventListener("change", (event) => readBundle(event.target, "candidate"));
$("#runExperiment").addEventListener("click", runExperiment);
$("#loginForm").addEventListener("submit", login);
$("#history").addEventListener("click", (event) => { const button = event.target.closest("[data-id]"); const item = state.experiments.find((experiment) => experiment.experiment_id === button?.dataset.id); if (item) renderResult(item); });

await checkHealth();
try {
  const cached = JSON.parse(localStorage.getItem(SESSION_KEY) || "null");
  if (cached?.access_token) { state.session = cached; await loadCatalog(); $("#loginLayer").classList.add("hidden"); renderIdentity(); }
} catch { localStorage.removeItem(SESSION_KEY); }
