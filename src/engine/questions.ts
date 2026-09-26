import { estimateTokens } from "./estimate.ts"
import { redactText } from "./redact.ts"
import type { JevQuestions, ToolCall } from "./types.ts"

/** Requests are not allowed to exceed this, whatever the token estimate says. */
const OVERHEAD_TOKENS = 32

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim()
}

/**
 * A head/tail excerpt of the output, redacted.
 *
 * It belongs in the question rather than the shared state: the state is re-sent
 * with every batch, so a preview there is paid for once per batch and is subject
 * to the fitting ladder, which can strip it exactly when the history is large
 * enough to need the judgement most.
 */
export function outputPreview(call: ToolCall, chars: number): string {
  if (chars <= 0 || call.resultChars <= chars * 2 + 16) return ""
  // Redact first, then slice. Slicing first can cut a credential in half and
  // leave a fragment that no longer matches a secret pattern.
  const safe = redactText(call.resultText)
  const head = collapse(safe.slice(0, chars))
  const tail = collapse(safe.slice(-chars))
  return `\nOutput preview: ${head} … ${tail}`
}

/**
 * Two questions per call, asked together so one request covers a whole batch.
 *
 * The criteria exist because a bare instruction invites the model to answer the
 * same way for both questions. Stating what true and false mean keeps the two
 * judgements independent.
 */
export function questionsFor(call: ToolCall, previewChars = 0): JevQuestions {
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
      instructions: `Keep the full output of tool call ${call.slot} (${call.tool}, ${call.resultChars} characters) word for word: the contents are still needed and re-running the tool would not do.${outputPreview(call, previewChars)}`,
      criteria: {
        true: "The exact output is still the source of truth for something, and re-running the tool would not reproduce it.",
        false:
          "The output is bulky, superseded by a later result, or trivially re-obtained by re-running the tool.",
      },
    },
  }
}

export type QuestionStyle = "noul" | "choice"

/**
 * One three-way question instead of two independent ones.
 *
 * `noul` readings are absolute and can sit low for every question at once, which
 * is why one threshold over them cannot work: the call and its result need
 * separate thresholds. A `choice` answers what to *do* with the call, with the
 * options competing against each other, so no calibration is needed to read it.
 */
export function choiceQuestionFor(call: ToolCall, previewChars = 0): JevQuestions {
  return {
    [`decision_${call.slot}`]: {
      type: "choice",
      instructions: `Tool call ${call.slot} (${call.tool}, ${call.resultChars} characters of output) is in the conversation history. Decide what the next step still needs from it.${outputPreview(call, previewChars)}`,
      criteria: {
        keep: "Both the call and its full output are still needed, and re-running the tool would not reproduce the output.",
        truncate:
          "The call still matters, but only a short head of its output does. The rest can go.",
        drop: "Neither the call nor its output matters for the next step; it is stale or superseded.",
      },
    },
  }
}

export function questionsForStyle(
  call: ToolCall,
  style: QuestionStyle,
  previewChars = 0,
): JevQuestions {
  return style === "choice"
    ? choiceQuestionFor(call, previewChars)
    : questionsFor(call, previewChars)
}

/**
 * Split candidates into batches that fit one request alongside the state. The
 * state is re-sent with every batch, so its size is charged to each one.
 */
export function batchCalls(
  calls: readonly ToolCall[],
  stateTokens: number,
  maxRequestTokens: number,
  previewChars = 0,
  style: QuestionStyle = "noul",
): ToolCall[][] {
  const budget = maxRequestTokens - stateTokens - OVERHEAD_TOKENS
  const batches: ToolCall[][] = []
  let current: ToolCall[] = []
  let used = 0

  for (const call of calls) {
    const cost = estimateTokens(JSON.stringify(questionsForStyle(call, style, previewChars)))
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
