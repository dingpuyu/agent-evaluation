const SESSION_KEY = "agent-evaluation-session";
const state = { session: null, catalog: null, baseline: null, candidate: null, experiments: [], current: null };
const $ = (selector) => document.querySelector(selector);
const h = (value) => String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
const fmt = (value) => Number.isInteger(Number(value)) ? String(value) : Number(value).toFixed(4);

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
  $("#pipeline").innerHTML = catalog.pipeline.map((name, index) => `<article class="${index < 4 ? "active" : "locked"}"><i>0${index + 1}</i><b>${h(name)}</b><small>${index < 4 ? "本次实验计算并纳入门禁" : "下一阶段：接入检索后评测"}</small></article>`).join("");
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
    if (bundle.schema !== "agent-evaluation.document-quality.artifacts.v1" || !Array.isArray(bundle.artifacts)) throw new Error("不是支持的 Artifact Bundle");
    state[side] = bundle;
    const prefix = side === "baseline" ? "baseline" : "candidate";
    $(`#${prefix}Name`).textContent = file.name;
    $(`#${prefix}Meta`).textContent = `${bundleProfile(bundle)} · ${bundle.artifacts.length} cases · ${(file.size / 1024).toFixed(1)}KB`;
    input.closest(".artifact-drop").classList.add("ready");
    const profile = bundleProfile(bundle);
    if (profile !== "配置未声明") $(`#${prefix}Label`).value = profile;
    $("#runExperiment").disabled = !(state.baseline && state.candidate);
  } catch (error) { state[side] = null; input.value = ""; toast(error.message); }
}

function metricDirection(metric) {
  if (metric.improved) return `<span class="up">改善</span>`;
  if (metric.regressed) return `<span class="down">退化</span>`;
  return `<span>不变</span>`;
}

function renderResult(experiment) {
  state.current = experiment;
  const comparison = experiment.comparison;
  const passed = experiment.promotion_status === "development_passed";
  $("#resultStatus").textContent = passed ? "DEV PASS" : "HOLD";
  $("#resultStatus").className = `dq-chip ${passed ? "safe" : ""}`;
  const metrics = comparison.metric_deltas.map((metric) => `<div class="metric-row"><b>${h(metric.name)}</b><span>${fmt(metric.baseline)}</span><span>${fmt(metric.candidate)}</span><span class="${metric.delta > 0 ? "up" : metric.delta < 0 ? "down" : ""}">${metric.delta >= 0 ? "+" : ""}${fmt(metric.delta)}</span>${metricDirection(metric)}</div>`).join("");
  $("#result").innerHTML = `<div class="decision-banner ${passed ? "" : "hold"}"><span>${passed ? "PASS" : "HOLD"}</span><div><b>${passed ? "Development 门禁通过，可申请盲测" : "候选策略未通过，保持 Baseline"}</b><p>${h(experiment.comparison.recommendation)}</p></div><code>${h(experiment.experiment_id)}</code></div>
    <div class="score-strip"><article><small>BASELINE CASES</small><b>${comparison.baseline.cases_passed}/${comparison.baseline.cases_total}</b><span>${h(experiment.intervention.baseline)}</span></article><article><small>CANDIDATE CASES</small><b>${comparison.candidate.cases_passed}/${comparison.candidate.cases_total}</b><span>${h(experiment.intervention.candidate)}</span></article><article><small>FIXED / REGRESSED</small><b>${comparison.fixed_cases.length} / ${comparison.regressed_cases.length}</b><span>${h(comparison.fixed_cases.join(", ") || "无修复用例")}</span></article><article><small>PRODUCTION MUTATION</small><b>FALSE</b><span>仅产生实验记录</span></article></div>
    <div class="metric-table"><div class="metric-row head"><span>METRIC</span><span>BASELINE</span><span>CANDIDATE</span><span>DELTA</span><span>DIRECTION</span></div>${metrics}</div>
    <div class="diagnosis-grid"><article><small>ROOT CAUSE DIAGNOSIS</small><h3>${h(experiment.diagnosis.root_cause_layer)} · ${Math.round(experiment.diagnosis.confidence * 100)}%</h3><ul>${experiment.diagnosis.evidence.map((item) => `<li>${h(item)}</li>`).join("")}</ul></article><article><small>NEXT ACTION</small><h3>${passed ? "进入受控 Holdout" : "继续 Development 调参"}</h3><p>${h(experiment.diagnosis.recommendation)}</p><p><b>人工审核：</b>${experiment.diagnosis.requires_human_review ? "必须" : "否"} · <b>原始产物落库：</b>${experiment.raw_artifacts_persisted ? "是" : "否"}</p></article></div>`;
  $("#resultSection").scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderHistory() {
  $("#history").innerHTML = state.experiments.length ? state.experiments.map((item) => `<button class="history-row-dq" data-id="${h(item.experiment_id)}"><code>${h(item.experiment_id)}</code><b>${h(item.intervention.baseline)} → ${h(item.intervention.candidate)}</b><span class="${item.promotion_status === "development_passed" ? "passed" : "hold"}">${h(item.promotion_status)}</span><time>${new Date(item.started_at).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}</time></button>`).join("") : `<div class="dq-empty">尚无实验记录</div>`;
}

async function runExperiment() {
  const button = $("#runExperiment"); button.disabled = true; button.textContent = "校验 + 评测中…";
  try {
    const experiment = await api("/api/v1/document-quality/experiments", { method: "POST", body: JSON.stringify({
      dataset_split: "development",
      evaluated_layers: ["ocr", "layout", "cleaning", "chunk"],
      intervention: { variable: "chunk_profile", baseline: $("#baselineLabel").value, candidate: $("#candidateLabel").value, rationale: $("#rationale").value },
      baseline_artifacts: state.baseline,
      candidate_artifacts: state.candidate,
    }) });
    state.experiments = [experiment, ...state.experiments.filter((item) => item.experiment_id !== experiment.experiment_id)];
    renderHistory(); renderResult(experiment); toast("真实 Pipeline Artifact 对照完成，原始正文未落库。" );
  } catch (error) { toast(error.message); }
  finally { button.disabled = !(state.baseline && state.candidate); button.textContent = "运行 Development 对照"; }
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
