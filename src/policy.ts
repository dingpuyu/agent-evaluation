export const EVALUATION_TOOL_ALLOWLIST = new Set([
  "get_bad_case",
  "get_bad_case_attempts",
  "replay_bad_case",
  "get_replay_trace",
  "finish_diagnosis",
]);

export class ToolPolicy {
  private toolCalls = 0;
  private replayCalls = 0;

  constructor(private readonly maxToolCalls: number) {}

  authorize(name: string): { allowed: true } | { allowed: false; reason: string; terminate: boolean } {
    if (!EVALUATION_TOOL_ALLOWLIST.has(name)) {
      return { allowed: false, reason: `tool ${name} is not in the evaluation allowlist`, terminate: true };
    }
    this.toolCalls += 1;
    if (this.toolCalls > this.maxToolCalls) {
      return { allowed: false, reason: "evaluation tool budget exceeded", terminate: true };
    }
    if (name === "replay_bad_case") {
      this.replayCalls += 1;
      if (this.replayCalls > 1) {
        return { allowed: false, reason: "an evaluation may replay the system under test only once", terminate: true };
      }
    }
    return { allowed: true };
  }
}
