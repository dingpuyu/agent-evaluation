const SESSION_KEY = "agent-evaluation-session";
const state = { session: null, workspaces: [], workspace: null, stages: [], stage: null, experiments: [], dataset: null };
const $ = (selector) => document.querySelector(selector);
const h = (value) => String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
const pct = (value) => `${Math.round(Number(value || 0) * 100)}%`;
const messageHTML = (value) => h(value).replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");

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

function renderWorkspaceSelect() {
  $("#workspaceSelect").innerHTML = state.workspaces.map((item) => `<option value="${h(item.workspace_id)}" ${state.workspace?.workspace_id === item.workspace_id ? "selected" : ""}>${h(item.brief.project_name)} · ${Math.round(item.brief.readiness_score * 100)}%</option>`).join("") || `<option value="">暂无项目</option>`;
}

function renderChat() {
  const workspace = state.workspace;
  if (!workspace) { $("#chatThread").innerHTML = `<div class="studio-empty">创建项目后开始对话。</div>`; return; }
  $("#chatThread").innerHTML = workspace.messages.map((message) => `<article class="chat-message ${message.role}"><span>${message.role === "assistant" ? "AE" : "YOU"}</span><div><p>${messageHTML(message.content)}</p><time>${new Date(message.created_at).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</time></div></article>`).join("");
  $("#chatThread").scrollTop = $("#chatThread").scrollHeight;
}

function tags(values, empty = "待补充") {
  return values?.length ? values.map((value) => `<span>${h(value)}</span>`).join("") : `<i>${h(empty)}</i>`;
}

function renderBrief() {
  const brief = state.workspace?.brief;
  if (!brief) return;
  $("#readinessScore").textContent = pct(brief.readiness_score);
  $("#readinessBar").style.width = pct(brief.readiness_score);
  $("#briefName").textContent = brief.project_name;
  $("#briefSummary").textContent = brief.summary;
  $("#briefGoal").textContent = brief.business_goal;
  $("#briefUsers").innerHTML = tags(brief.users);
  $("#briefTasks").innerHTML = tags(brief.critical_tasks);
  $("#briefRisks").innerHTML = tags(brief.failure_costs);
  $("#briefData").innerHTML = tags(brief.available_data);
  $("#briefUnknowns").innerHTML = brief.unknowns?.length ? brief.unknowns.map((item) => `<li>${h(item)}</li>`).join("") : `<li>关键信息已基本齐备</li>`;
  $("#firstStage").textContent = brief.recommended_stage_id || "待选择阶段";
  $("#firstHypothesis").textContent = brief.recommended_prompt_hypothesis || "等待形成 Prompt 假设。";
  $("#firstEvaluation").textContent = brief.recommended_first_evaluation;
  $("#agentSteps").innerHTML = `<small>LAST AGENT STEPS</small>${tags(state.workspace.last_agent_steps, "本轮未调用工具")}`;
}

const candidateAdditions = {
  scope_judge: "\n\n补充规则：分别说明 decision 与 reason 的判断依据；安全关键样本出现误放时必须判失败，不允许用措辞质量抵消决策错误。",
  retrieval_judge: "\n\n补充规则：对多实体问题逐一核对 required_document_ids；答案包含型号名称但缺少该型号专属来源时判失败，并明确缺失文档。",
  answer_judge: "\n\n补充规则：按子句识别否定语境，‘无法保证现货’不能误判为‘保证现货’；同时检查无证据的配置推断。",
  release_judge: "\n\n补充规则：先列硬门禁，再做质量判断；任何权限、数据集或安全失败具有一票否决权，并保留人工审核。",
};

function renderChain() {
  const stages = state.workspace?.evaluation_chain?.length ? state.workspace.evaluation_chain : state.stages;
  $("#evaluationChain").innerHTML = stages.map((stage, index) => `<button class="chain-stage ${stage.prompt_editable ? "editable" : "locked"} ${state.stage?.stage_id === stage.stage_id ? "active" : ""}" data-stage="${h(stage.stage_id)}"><i>0${index + 1}</i><span>${stage.prompt_editable ? "PROMPT" : "LOCKED"}</span><b>${h(stage.name)}</b><small>${h(stage.owner)}</small></button>`).join("");
}

function renderSplitOptions() {
  const select = $("#stageDatasetSplit");
  const current = select.value || "development";
  const labels = { development: "Development · 可调试", holdout: "Holdout · 问题盲测", regression: "Regression · 发布门禁" };
  const summary = state.dataset?.split_summary || {};
  select.innerHTML = Object.entries(labels).map(([split, label]) => `<option value="${split}" ${split === current ? "selected" : ""}>${label} · ${Number(summary[split]?.actual_case_count || 0)} 条</option>`).join("");
}

function selectStage(stageID) {
  state.stage = state.stages.find((item) => item.stage_id === stageID) || null;
  renderChain();
  if (!state.stage) return;
  $("#stageTitle").textContent = state.stage.name;
  $("#stageDescription").textContent = state.stage.description;
  $("#stageOwner").textContent = `${state.stage.owner} · ${state.stage.prompt_editable ? "PROMPT EDITABLE" : "HARD LOCK"}`;
  $("#stageMetrics").innerHTML = tags(state.stage.metrics);
  $("#stageBaseline").textContent = state.stage.baseline_prompt || "该阶段由运行时或确定性规则执行，不接受 Prompt。";
  $("#stageCandidate").value = state.stage.prompt_editable ? `${state.stage.baseline_prompt}${candidateAdditions[state.stage.stage_id] || ""}` : "";
  $("#stageCandidate").disabled = !state.stage.prompt_editable;
  $("#runStageExperiment").disabled = !state.stage.prompt_editable || !state.workspace;
}

function renderStageResult(experiment) {
  if (!experiment) return;
  const delta = experiment.delta.agreement;
  const cases = experiment.results.map((item) => `<article class="stage-case ${item.outcome}"><header><code>${h(item.case_id)}</code><b>${item.outcome === "improved" ? "改善" : item.outcome === "regressed" ? "退化" : "未变化"}</b><span>Oracle ${item.oracle_pass ? "PASS" : "FAIL"}</span></header><p>${h(item.query)}</p><div><section><small>BASELINE · ${item.baseline.pass ? "PASS" : "FAIL"}</small><b>${pct(item.baseline.score)}</b><p>${h(item.baseline.rationale)}</p></section><section><small>CANDIDATE · ${item.candidate.pass ? "PASS" : "FAIL"}</small><b>${pct(item.candidate.score)}</b><p>${h(item.candidate.rationale)}</p></section></div></article>`).join("");
  $("#stageResult").innerHTML = `<div class="stage-snapshot"><span>${h(experiment.dataset_split || "legacy")}</span><span>${h(experiment.dataset_id)} @ ${h(experiment.dataset_version || "legacy")}</span><span>${h(String(experiment.dataset_snapshot || "").slice(0, 20))}</span><span class="promotion">${h(experiment.promotion_status || "legacy")}</span></div><div class="stage-score-grid"><article><small>BASELINE AGREEMENT</small><b>${pct(experiment.baseline.agreement)}</b><span>误放 ${experiment.baseline.false_accepts} · 误拒 ${experiment.baseline.false_rejects}</span></article><article class="candidate"><small>CANDIDATE AGREEMENT</small><b>${pct(experiment.candidate.agreement)}</b><span>误放 ${experiment.candidate.false_accepts} · 误拒 ${experiment.candidate.false_rejects}</span></article><article class="delta"><small>AGREEMENT DELTA</small><b>${delta >= 0 ? "+" : ""}${Math.round(delta * 1000) / 10}pp</b><span>改善 ${experiment.improved_cases.length} · 退化 ${experiment.regressed_cases.length}</span></article></div><div class="stage-recommendation">${h(experiment.recommendation)}</div><div class="stage-cases">${cases}</div>`;
}

function renderHistory() {
  const items = state.experiments.filter((item) => !state.workspace || item.workspace_id === state.workspace.workspace_id);
  $("#stageHistory").innerHTML = items.length ? items.map((item) => `<button data-experiment="${h(item.stage_experiment_id)}"><div><code>${h(item.stage_experiment_id)}</code><b>${h(item.stage_name)} · ${h(item.dataset_split || "legacy")}</b></div><span>${pct(item.baseline.agreement)} → ${pct(item.candidate.agreement)}</span><time>${new Date(item.started_at).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}</time></button>`).join("") : `<div class="studio-empty">当前项目暂无阶段实验。</div>`;
}

function renderWorkspace() {
  renderWorkspaceSelect(); renderChat(); renderBrief(); renderChain(); renderHistory(); renderSplitOptions();
  if (!state.stage) selectStage(state.workspace?.brief?.recommended_stage_id || "retrieval_judge");
}

async function loadStudio() {
  const [stagePayload, workspacePayload, experimentPayload, datasetPayload] = await Promise.all([
    api("/api/v1/studio/stages"), api("/api/v1/project-workspaces"), api("/api/v1/stage-experiments"), api("/api/v1/datasets/production-sample"),
  ]);
  state.stages = stagePayload.stages || [];
  state.workspaces = workspacePayload.workspaces || [];
  state.experiments = experimentPayload.experiments || [];
  state.dataset = datasetPayload;
  state.workspace = state.workspaces[0] || null;
  if (!state.workspace) await createWorkspace(true);
  else renderWorkspace();
}

async function createWorkspace(automatic = false) {
  const name = $("#projectName").value.trim();
  if (!name) { toast("请输入项目名称"); return; }
  const button = $("#createWorkspace"); button.disabled = true; button.textContent = "创建中…";
  try {
    const workspace = await api("/api/v1/project-workspaces", { method: "POST", body: JSON.stringify({ name }) });
    state.workspaces.unshift(workspace); state.workspace = workspace; state.stage = null; renderWorkspace();
    if (!automatic) toast("项目工作区已创建，可以开始对话梳理。");
  } catch (error) { toast(error.message); }
  finally { button.disabled = false; button.textContent = "新建梳理"; }
}

async function sendMessage(message) {
  if (!state.workspace || !message.trim()) return;
  const button = $("#sendMessage"); button.disabled = true; button.textContent = "Agent 梳理中…";
  const temporary = { message_id: "pending", role: "user", content: message.trim(), created_at: new Date().toISOString() };
  state.workspace.messages.push(temporary); renderChat();
  $("#chatThread").insertAdjacentHTML("beforeend", `<article class="chat-message assistant thinking"><span>AE</span><div><p>正在读取授权资产并更新项目 Brief…</p></div></article>`);
  $("#chatThread").scrollTop = $("#chatThread").scrollHeight;
  try {
    const updated = await api(`/api/v1/project-workspaces/${encodeURIComponent(state.workspace.workspace_id)}/messages`, { method: "POST", body: JSON.stringify({ message: message.trim() }) });
    state.workspace = updated;
    state.workspaces = [updated, ...state.workspaces.filter((item) => item.workspace_id !== updated.workspace_id)];
    $("#chatInput").value = ""; renderWorkspace(); toast("项目 Brief 已更新");
  } catch (error) {
    state.workspace.messages = state.workspace.messages.filter((item) => item !== temporary); renderChat(); toast(error.message);
  } finally { button.disabled = false; button.textContent = "发送并更新 Brief"; }
}

async function runStageExperiment() {
  if (!state.workspace || !state.stage?.prompt_editable) return;
  const prompt = $("#stageCandidate").value.trim();
  if (!prompt) { toast("Candidate Prompt 不能为空"); return; }
  const button = $("#runStageExperiment"); button.disabled = true; button.textContent = "回放 + 双 Judge 运行中…";
  try {
    const experiment = await api(`/api/v1/project-workspaces/${encodeURIComponent(state.workspace.workspace_id)}/stage-experiments`, { method: "POST", body: JSON.stringify({ stage_id: state.stage.stage_id, candidate_prompt: prompt, dataset_split: $("#stageDatasetSplit").value, case_limit: Number($("#stageCaseLimit").value) }) });
    state.experiments.unshift(experiment); renderStageResult(experiment); renderHistory(); toast("阶段 Prompt 对照完成，未修改目标 Agent。" );
  } catch (error) { toast(error.message); }
  finally { button.disabled = false; button.textContent = "运行阶段对照"; }
}

async function login(event) {
  event.preventDefault(); $("#loginError").textContent = "";
  try {
    state.session = await api("/api/v1/session/login", { method: "POST", body: JSON.stringify({ email: $("#email").value, password: $("#password").value }) }, false);
    localStorage.setItem(SESSION_KEY, JSON.stringify(state.session));
    await loadStudio(); $("#loginLayer").classList.add("hidden"); renderIdentity();
  } catch (error) { $("#loginError").textContent = error.message; }
}

function renderIdentity() {
  $("#identityBox").innerHTML = `<b>${h(state.session.identity.subject)}</b><small>${h(state.session.identity.tenant_id)} · ${h(state.session.identity.roles.join(" / "))}</small><button id="logout">退出</button>`;
  $("#logout").addEventListener("click", () => { localStorage.removeItem(SESSION_KEY); location.reload(); });
}

$("#loginForm").addEventListener("submit", login);
$("#createWorkspace").addEventListener("click", () => createWorkspace(false));
$("#workspaceSelect").addEventListener("change", (event) => { state.workspace = state.workspaces.find((item) => item.workspace_id === event.target.value) || null; state.stage = null; renderWorkspace(); });
$("#chatForm").addEventListener("submit", (event) => { event.preventDefault(); sendMessage($("#chatInput").value); });
$("#starterPrompts").addEventListener("click", (event) => { const button = event.target.closest("[data-message]"); if (button) sendMessage(button.dataset.message); });
$("#evaluationChain").addEventListener("click", (event) => { const button = event.target.closest("[data-stage]"); if (button) selectStage(button.dataset.stage); });
$("#runStageExperiment").addEventListener("click", runStageExperiment);
$("#stageHistory").addEventListener("click", (event) => { const button = event.target.closest("[data-experiment]"); const item = state.experiments.find((experiment) => experiment.stage_experiment_id === button?.dataset.experiment); if (item) { selectStage(item.stage_id); $("#stageCandidate").value = item.candidate_prompt; $("#stageDatasetSplit").value = item.dataset_split || "development"; renderStageResult(item); $("#promptLab").scrollIntoView({ behavior: "smooth" }); } });

await checkHealth();
try {
  const cached = JSON.parse(localStorage.getItem(SESSION_KEY) || "null");
  if (cached?.access_token) { state.session = cached; await loadStudio(); $("#loginLayer").classList.add("hidden"); renderIdentity(); }
} catch { localStorage.removeItem(SESSION_KEY); }
