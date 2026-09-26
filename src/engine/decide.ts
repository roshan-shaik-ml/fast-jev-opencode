import type { CallAnswer, Decision, Thresholds, ToolCall } from "./types.ts"

/**
 * Defaults deliberately asymmetric.
 *
 * Jev scores a call and its output on different scales: an output is far more
 * likely to be judged expendable than the fact that the call happened. Using one
 * number for both makes the result bar far too strict — with a single 0.5 an
 * entire transcript can be removed, including the edit and the passing test run
 * that actually finished the work.
 */
export const DEFAULT_THRESHOLDS: Thresholds = { keepCall: 0.5, keepResult: 0.25 }

export function decide(call: ToolCall, answer: CallAnswer, thresholds: Thresholds): Decision {
  const base = {
    id: call.id,
    tool: call.tool,
    keepCall: answer.keepCall,
    keepResult: answer.keepResult,
  }
  if (call.pinned) return { ...base, action: "keep", reason: "pinned" }
  if (answer.keepResult >= thresholds.keepResult) return { ...base, action: "keep", reason: "kept" }
  if (answer.keepCall >= thresholds.keepCall) {
    return { ...base, action: "drop_result", reason: "result_truncated" }
  }
  return { ...base, action: "drop_call", reason: "call_removed" }
}

/**
 * True when a pass scored enough calls and kept none of them — in which case the
 * pass carries no keep signal and should not be applied. A blanket removal is
 * almost always a bad request or a bad state, not a real answer.
 */
export function lacksKeepSignal(decisions: readonly Decision[], minScored = 8): boolean {
  const scored = decisions.filter((decision) => decision.reason !== "pinned")
  if (scored.length < minScored) return false
  return scored.every((decision) => decision.action !== "keep")
}
