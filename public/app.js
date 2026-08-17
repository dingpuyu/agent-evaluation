const SESSION_KEY = "agent-evaluation-session";
const state = { session: null, catalog: null, contract: null, dataset: null, badCases: [], runs: [], experiments: [] };
const $ = (selector) => document.querySelector(selector);
const h = (value) => String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
const pct = (value) => `${Math.round(Number(value || 0) * 100)}%`;

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
    $("#healthText").textContent = `${health.runtime} · ${health.model_configured ? health.model : "Key 未配置"}`;
  } catch { $("#healthText").textContent = "评测服务不可用"; }
}

function renderSummary() {
  const target = state.catalog?.targets?.[0];
  const suites = state.catalog?.suites || [];
  const dataset = state.dataset;
  $("#summaryGrid").innerHTML = `
    <article><small>评测目标</small><b>${h(target?.name || "—")}</b><span>${h(target?.type || "未连接")}</span></article>
    <article><small>评测套件</small><b>${suites.length}</b><span>RAG 诊断 + Prompt A/B</span></article>
    <article><small>生产型样本</small><b>${dataset?.cases?.length ?? "—"}</b><span>${h(dataset?.provenance || "等待加载")}</span></article>
    <article><small>Judge / Harness</small><b>Pi + Rules</b><span>模型辅助 + 确定性门禁</span></article>`;
}

function renderContract() {
  const contract = state.contract;
  if (!contract) return;
  $("#businessGoal").textContent = contract.business_goal;
  $("#flowMap").innerHTML = (contract.flow || []).map((node, index) => `<article class="${node.editable ? "editable" : ""}"><i>0${index + 1} / ${h(node.owner)}</i><h3>${h(node.name)}</h3><p>${h((node.quality || []).join(" · "))}</p><b>${h((node.interventions || []).join(" / "))}</b></article>`).join("");
  $("#hardControls").innerHTML = `<b>不可被 Prompt 覆盖：</b>${(contract.hard_controls || []).map((item) => `<span>${h(item)}</span>`).join("")}`;
  $("#baselinePrompt").textContent = contract.prompt_slot?.base_prompt || "未提供基线提示词";
}

function renderDataset() {
  const dataset = state.dataset;
  if (!dataset) return;
  $("#datasetDescription").textContent = dataset.description;
  $("#datasetMeta").textContent = `${dataset.dataset_id} · ${dataset.version}`;
  $("#datasetTable").innerHTML = `<div class="dataset-row head"><span>Case</span><span>业务分群</span><span>线上问题形态</span><span>期望决策</span></div>` + dataset.cases.map((item) => `<div class="dataset-row"><code>${h(item.id)}</code><span>${h(item.segment)}</span><span>${h(item.query)}</span><i class="${h(item.expected_decision)}">${h(item.expected_decision)}</i></div>`).join("");
}

function renderBadCases() {
  const list = $("#badcaseList");
  if (!state.badCases.length) { list.innerHTML = `<div class="empty">当前租户暂无 Bad Case，可先在 RAG 项目运行完整评测并标记失败案例。</div>`; return; }
  list.innerHTML = state.badCases.map((item) => `<article><div><code>${h(item.bad_case_id)}</code><b>${h(item.query)}</b><small>${h(item.status)} · 历史根因 ${h(item.root_cause || "unlabeled")} · ${h(item.actual_document_ids?.join("、") || "无召回")}</small></div><button data-diagnose="${h(item.bad_case_id)}">Pi 诊断</button></article>`).join("");
}

function renderDiagnosis(run) {
  const metric = Object.fromEntries((run.metrics || []).map((item) => [item.name, item]));
  const report = run.report;
  $("#diagnosisResult").innerHTML = `<section class="diagnosis"><header><div><span>${h(run.suite_id)} · ${h(run.model)}</span><b>${h(report.root_cause)} · ${pct(report.confidence)}</b></div><i>${Math.round(run.duration_ms / 100) / 10}s · ${run.tool_calls.length} tools</i></header><div class="diagnosis-metrics"><div><small>完成</small><b>${pct(metric.evaluation_completed?.value)}</b></div><div><small>工具覆盖</small><b>${pct(metric.required_tool_coverage?.value)}</b></div><div><small>Hit@5</small><b>${metric.hit_at_5?.value ?? 0}</b></div><div><small>MRR</small><b>${Number(metric.mrr?.value || 0).toFixed(3)}</b></div><div><small>安全写入</small><b>${metric.mutation_tools_called?.value === 0 ? "0" : h(metric.mutation_tools_called?.value)}</b></div></div><p>${h(report.summary)}</p><ul>${report.recommendations.map((item) => `<li><b>${h(item.layer)}</b> · ${h(item.action)}（风险：${h(item.risk)}）</li>`).join("")}</ul></section>`;
}

function renderExperiment(experiment) {
  const delta = experiment.delta;
  const grouped = new Map();
  for (const result of experiment.results || []) {
    const pair = grouped.get(result.case_id) || {};
    pair[result.variant] = result;
    grouped.set(result.case_id, pair);
  }
  const cases = [...grouped.entries()].map(([caseID, pair]) => {
    const baseline = pair.baseline || {};
    const candidate = pair.candidate || {};
    const outcome = !baseline.passed && candidate.passed ? "improved" : baseline.passed && !candidate.passed ? "regressed" : "unchanged";
    const checks = (values = {}) => Object.entries(values).map(([name, ok]) => `${name}:${ok ? "✓" : "×"}`).join(" · ");
    return `<article class="comparison-case ${outcome}"><header><code>${h(caseID)}</code><b>${outcome === "improved" ? "改善" : outcome === "regressed" ? "退化" : "未变化"}</b></header><p>${h(baseline.query || candidate.query || "")}</p><div><section><small>BASELINE · ${baseline.passed ? "PASS" : "FAIL"}</small><p>${h(baseline.answer || "—")}</p><i>${h(checks(baseline.checks))}</i></section><section><small>CANDIDATE · ${candidate.passed ? "PASS" : "FAIL"}</small><p>${h(candidate.answer || "—")}</p><i>${h(checks(candidate.checks))}</i></section></div></article>`;
  }).join("");
  $("#experimentResult").innerHTML = `<div class="comparison"><div class="comparison-top"><div class="score-card"><small>BASELINE PASS RATE</small><b>${pct(experiment.baseline.pass_rate)}</b><span>安全 ${pct(experiment.baseline.safety_pass_rate)} · ${Math.round(experiment.baseline.average_latency_ms)}ms</span></div><div class="score-card candidate"><small>CANDIDATE PASS RATE</small><b>${pct(experiment.candidate.pass_rate)}</b><span>安全 ${pct(experiment.candidate.safety_pass_rate)} · ${Math.round(experiment.candidate.average_latency_ms)}ms</span></div><div class="score-card delta"><small>QUALITY DELTA</small><b>${delta.pass_rate >= 0 ? "+" : ""}${pct(delta.pass_rate)}</b><span>引用 ${delta.citation_compliance >= 0 ? "+" : ""}${pct(delta.citation_compliance)} · 延迟 ${Math.round(delta.average_latency_ms)}ms</span></div></div><div class="recommendation">${h(experiment.recommendation)}</div><div class="case-delta"><div><b>改善 ${experiment.improved_cases.length}</b><span>${h(experiment.improved_cases.join("、") || "无")}</span></div><div><b>退化 ${experiment.regressed_cases.length}</b><span>${h(experiment.regressed_cases.join("、") || "无")}</span></div><div><b>未变化 ${experiment.unchanged_cases.length}</b><span>${h(experiment.unchanged_cases.join("、") || "无")}</span></div></div><div class="comparison-cases">${cases}</div></div>`;
}

function renderHistory() {
  const items = [
    ...state.runs.map((item) => ({ id: item.run_id, kind: "RAG Bad Case", status: item.status, time: item.started_at, result: item.report?.root_cause || "—" })),
    ...state.experiments.map((item) => ({ id: item.experiment_id, kind: "Prompt A/B", status: item.status, time: item.started_at, result: `${pct(item.baseline.pass_rate)} → ${pct(item.candidate.pass_rate)}` })),
  ].sort((a, b) => String(b.time).localeCompare(String(a.time)));
  $("#historyList").innerHTML = items.length ? items.map((item) => `<div class="history-row"><code>${h(item.id)}</code><b>${h(item.kind)}</b><span>${h(item.status)} · ${h(item.result)}</span><time>${new Date(item.time).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}</time></div>`).join("") : `<div class="empty">尚无运行记录</div>`;
}

async function loadWorkspace() {
  [state.catalog, state.contract, state.dataset] = await Promise.all([
    api("/api/v1/catalog", {}, false),
    api("/api/v1/targets/raglab/contract"),
    api("/api/v1/datasets/production-sample"),
  ]);
  const [badCases, runs, experiments] = await Promise.all([
    api("/api/v1/targets/raglab/bad-cases"),
    api("/api/v1/evaluations/runs"),
    api("/api/v1/experiments/prompt-comparisons"),
  ]);
  state.badCases = badCases.cases || []; state.runs = runs.runs || []; state.experiments = experiments.experiments || [];
  renderSummary(); renderContract(); renderDataset(); renderBadCases(); renderHistory();
}

async function login(event) {
  event.preventDefault(); $("#loginError").textContent = "";
  try {
    state.session = await api("/api/v1/session/login", { method: "POST", body: JSON.stringify({ email: $("#email").value, password: $("#password").value }) }, false);
    localStorage.setItem(SESSION_KEY, JSON.stringify(state.session));
    await loadWorkspace();
    $("#loginLayer").classList.add("hidden");
    $("#identityBox").innerHTML = `<b>${h(state.session.identity.subject)}</b><small>${h(state.session.identity.tenant_id)} · ${h(state.session.identity.roles.join(" / "))}</small><button id="logout">退出登录</button>`;
    $("#logout").addEventListener("click", logout);
  } catch (error) { $("#loginError").textContent = error.message; }
}

function logout() { localStorage.removeItem(SESSION_KEY); state.session = null; location.reload(); }

async function runExperiment() {
  const button = $("#runExperiment"); const previous = button.textContent; button.disabled = true; button.textContent = "Baseline / Candidate 运行中…";
  try {
    const experiment = await api("/api/v1/experiments/prompt-comparisons", { method: "POST", body: JSON.stringify({ prompt_overlay: $("#candidatePrompt").value, case_limit: Number($("#caseLimit").value) }) });
    state.experiments.unshift(experiment); renderExperiment(experiment); renderHistory(); toast("Prompt 对照评测完成，未修改生产配置。");
  } catch (error) { toast(error.message); }
  finally { button.disabled = false; button.textContent = previous; }
}

async function diagnose(badCaseID, button) {
  const previous = button.textContent; button.disabled = true; button.textContent = "读取 Trace…";
  try {
    const run = await api("/api/v1/evaluations/runs", { method: "POST", body: JSON.stringify({ suite_id: "raglab.medical.bad-case.v1", subject: { bad_case_id: badCaseID } }) });
    state.runs.unshift(run); renderDiagnosis(run); renderHistory(); toast("证据化诊断完成，报告等待人工审核。");
  } catch (error) { toast(error.message); }
  finally { button.disabled = false; button.textContent = previous; }
}

$("#loginForm").addEventListener("submit", login);
$("#runExperiment").addEventListener("click", runExperiment);
$("#badcaseList").addEventListener("click", (event) => { const button = event.target.closest("[data-diagnose]"); if (button) diagnose(button.dataset.diagnose, button); });
document.querySelectorAll(".sidebar nav a").forEach((link) => link.addEventListener("click", () => { document.querySelectorAll(".sidebar nav a").forEach((item) => item.classList.remove("active")); link.classList.add("active"); }));

await checkHealth();
try {
  const cached = JSON.parse(localStorage.getItem(SESSION_KEY) || "null");
  if (cached?.access_token) {
    state.session = cached; await loadWorkspace(); $("#loginLayer").classList.add("hidden");
    $("#identityBox").innerHTML = `<b>${h(cached.identity.subject)}</b><small>${h(cached.identity.tenant_id)} · ${h(cached.identity.roles.join(" / "))}</small><button id="logout">退出登录</button>`;
    $("#logout").addEventListener("click", logout);
  }
} catch { localStorage.removeItem(SESSION_KEY); }
