import { estimateTokens } from "./estimate.ts"
import type { JevQuestions, ToolCall } from "./types.ts"

/** Requests are not allowed to exceed this, whatever the token estimate says. */
const OVERHEAD_TOKENS = 32

/**
 * Two questions per call, asked together so one request covers a whole batch.
 *
 * The criteria exist because a bare instruction invites the model to answer the
 * same way for both questions. Stating what true and false mean keeps the two
 * judgements independent.
 */
export function questionsFor(call: ToolCall): JevQuestions {
  return {
    [`call_${call.slot}`]: {
      type: "noul",
      instructions: `Keep tool call ${call.slot} (${call.tool}) in the history: knowing this call happened, with its input, still matters for what happens next.`,
      criteria: {
        true: "The call and its input are still needed to understand or continue the work.",
        false: "The work has moved past this call, or a later call supersedes it.",
      },
    },
    [`result_${call.slot}`]: {
      type: "noul",
      instructions: `Keep the full output of tool call ${call.slot} (${call.tool}, ${call.resultChars} characters) word for word: the contents are still needed and re-running the tool would not do.`,
      criteria: {
        true: "The exact output is still the source of truth for something, and re-running the tool would not reproduce it.",
        false:
          "The output is bulky, superseded by a later result, or trivially re-obtained by re-running the tool.",
      },
    },
  }
}

/**
 * Split candidates into batches that fit one request alongside the state. The
 * state is re-sent with every batch, so its size is charged to each one.
 */
export function batchCalls(
  calls: readonly ToolCall[],
  stateTokens: number,
  maxRequestTokens: number,
): ToolCall[][] {
  const budget = maxRequestTokens - stateTokens - OVERHEAD_TOKENS
  const batches: ToolCall[][] = []
  let current: ToolCall[] = []
  let used = 0

  for (const call of calls) {
    const cost = estimateTokens(JSON.stringify(questionsFor(call)))
    if (current.length > 0 && used + cost > budget) {
      batches.push(current)
      current = []
      used = 0
    }
    if (current.length === 0 && cost > budget) {
      throw new Error(
        `state leaves no room for questions (~${stateTokens} of ${maxRequestTokens} tokens)`,
      )
    }
    current.push(call)
    used += cost
  }

  if (current.length > 0) batches.push(current)
  return batches
}
