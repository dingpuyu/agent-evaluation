import type { BadCase, DeviceContext, Identity, LoginResult, ReplayResult, RetrievalHit } from "../contracts.js";
import { retrievalMetrics } from "../metrics.js";
import type { RetrievalSandboxRequest, RetrievalSandboxRun } from "../document-quality-platform.js";

type FetchLike = typeof fetch;

export class UpstreamError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}

function compactHit(raw: Record<string, unknown>): RetrievalHit {
  const content = String(raw.content ?? raw.excerpt ?? "");
  return {
    document_id: String(raw.document_id ?? ""),
    chunk_id: String(raw.chunk_id ?? ""),
    title: String(raw.title ?? raw.document ?? ""),
    dataset_id: String(raw.dataset_id ?? ""),
    content: content.slice(0, 500),
    distance: typeof raw.distance === "number" ? raw.distance : undefined,
    score: typeof raw.score === "number" ? raw.score : undefined,
    model_codes: Array.isArray(raw.model_codes) ? raw.model_codes.map(String).slice(0, 12) : [],
    software_version_from: String(raw.software_version_from ?? ""),
    software_version_to: String(raw.software_version_to ?? ""),
    source_file: String(raw.source_file ?? ""),
    source_page: typeof raw.source_page === "number" ? raw.source_page : 0,
    source_sheet: String(raw.source_sheet ?? ""),
    source_cell_range: String(raw.source_cell_range ?? ""),
    heading_path: Array.isArray(raw.heading_path) ? raw.heading_path.map(String).slice(0, 12) : [],
  };
}

export class RaglabAdapter {
  constructor(
    private readonly agentApiUrl: string,
    private readonly raglabApiUrl: string,
    private readonly authorization = "",
    private readonly fetchFn?: FetchLike,
  ) {}

  withAuthorization(authorization: string): RaglabAdapter {
    return new RaglabAdapter(this.agentApiUrl, this.raglabApiUrl, authorization, this.fetchFn);
  }

  private async request(base: string, path: string, init: RequestInit = {}, requireAuthorization = true): Promise<unknown> {
    const fetchFn = this.fetchFn ?? globalThis.fetch;
    if (typeof fetchFn !== "function") throw new Error("Node.js 22+ is required for the built-in fetch runtime");
    const headers: Record<string, string> = { Accept: "application/json" };
    if (requireAuthorization) headers.Authorization = this.authorization;
    if (init.body) headers["Content-Type"] = "application/json";
    const response = await fetchFn(`${base}${path}`, { ...init, headers: { ...headers, ...init.headers } });
    if (!response.ok) {
      const message = (await response.text()).slice(0, 800);
      throw new UpstreamError(response.status, `system under test returned ${response.status}: ${message}`);
    }
    return response.json();
  }

  async login(email: string, password: string): Promise<LoginResult> {
    return this.request(this.raglabApiUrl, "/api/v1/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }, false) as Promise<LoginResult>;
  }

  async identity(): Promise<Identity> {
    return this.request(this.raglabApiUrl, "/api/v1/auth/me") as Promise<Identity>;
  }

  async listBadCases(): Promise<BadCase[]> {
    const payload = await this.request(this.agentApiUrl, "/api/v1/evaluations/medical-device/bad-cases") as { cases?: BadCase[] };
    return payload.cases ?? [];
  }

  async getBadCase(badCaseID: string): Promise<BadCase> {
    const item = (await this.listBadCases()).find((candidate) => candidate.bad_case_id === badCaseID);
    if (!item) throw new UpstreamError(404, "bad case was not found or is not accessible");
    return item;
  }

  async getAttempts(badCaseID: string): Promise<unknown[]> {
    const payload = await this.request(
      this.agentApiUrl,
      `/api/v1/evaluations/medical-device/bad-cases/${encodeURIComponent(badCaseID)}/attempts`,
    ) as { attempts?: unknown[] };
    return (payload.attempts ?? []).slice(-5);
  }

  async replay(item: BadCase): Promise<ReplayResult> {
    const payload = await this.request(
      this.raglabApiUrl,
      `/api/v1/apps/${encodeURIComponent(item.app_id)}/query`,
      {
        method: "POST",
        body: JSON.stringify({
          environment_id: item.environment_id,
          query: item.query,
          top_k: 6,
          device_context: item.device_context ?? {},
        }),
      },
    ) as Record<string, unknown>;
    const result = (payload.result ?? {}) as Record<string, unknown>;
    const rawHits = Array.isArray(result.hits) ? result.hits : Array.isArray(payload.evidence) ? payload.evidence : [];
    const hits = rawHits.slice(0, 8).map((hit) => compactHit(hit as Record<string, unknown>));
    const documentIDs = hits.map((hit) => hit.document_id).filter(Boolean);
    return {
      trace_id: String(payload.trace_id ?? ""),
      decision: String(payload.decision ?? (hits.length ? "answer" : "clarify")),
      reason_code: String(payload.reason_code ?? ""),
      rewritten_query: String(payload.rewritten_query ?? item.query),
      retrieved_document_ids: documentIDs,
      hits,
      bindings: Array.isArray(payload.bindings) ? payload.bindings.slice(0, 8) : [],
      metrics: retrievalMetrics(item.expected_document_ids, documentIDs),
    };
  }

  async getTrace(item: BadCase, traceID: string): Promise<unknown> {
    if (!traceID) throw new UpstreamError(409, "replay has not produced a trace id");
    return this.request(
      this.raglabApiUrl,
      `/api/v1/apps/${encodeURIComponent(item.app_id)}/traces/${encodeURIComponent(traceID)}`,
    );
  }

  async getEvaluationContract(appID = ""): Promise<Record<string, unknown>> {
    const query = appID ? `?app_id=${encodeURIComponent(appID)}` : "";
    return this.request(this.agentApiUrl, `/api/v1/evaluations/medical-device/contract${query}`) as Promise<Record<string, unknown>>;
  }

  async promptPreview(input: {
    app_id: string;
    environment_id: string;
    query: string;
    device_context?: DeviceContext;
    prompt_overlay: string;
  }): Promise<Record<string, unknown>> {
    return this.request(this.agentApiUrl, "/api/v1/evaluations/medical-device/prompt-preview", {
      method: "POST",
      body: JSON.stringify(input),
    }) as Promise<Record<string, unknown>>;
  }

  async runDocumentRetrievalSandbox(input: RetrievalSandboxRequest): Promise<RetrievalSandboxRun> {
    return this.request(this.raglabApiUrl, "/api/v1/evaluation/retrieval-sandbox/runs", {
      method: "POST",
      body: JSON.stringify(input),
    }) as Promise<RetrievalSandboxRun>;
  }
}
