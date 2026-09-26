import { abridge, clip, estimateTokens } from "./estimate.ts"
import { redactInput, redactText } from "./redact.ts"
import type {
  FittedState,
  JevState,
  StateEntry,
  StateToolCall,
  ToolCall,
  TranscriptMessage,
} from "./types.ts"

const INPUT_CAPS = [1200, 240, 80] as const
const TEXT_HEAD = 400
const TEXT_TAIL = 150
const TASK_PROMPTS = 3

export function isPinned(index: number, total: number, preserveRecentMessages: number): boolean {
  return index === 0 || index >= total - preserveRecentMessages
}

/**
 * Pair every assistant tool call with its result. Calls without a result are not
 * candidates — there is nothing to remove yet.
 */
export function collectCalls(
  messages: readonly TranscriptMessage[],
  preserveRecentMessages: number,
): ToolCall[] {
  const results = new Map<string, { index: number; text: string; isError: boolean }>()
  messages.forEach((message, index) => {
    for (const result of message.toolResults ?? []) {
      results.set(result.id, { index, text: result.text, isError: result.isError })
    }
  })
  const calls: ToolCall[] = []
  messages.forEach((message, messageIndex) => {
    for (const use of message.toolUses) {
      const found = results.get(use.id)
      if (!found) continue
      calls.push({
        slot: calls.length + 1,
        id: use.id,
        tool: use.name,
        input: use.input,
        messageIndex,
        resultIndex: found.index,
        resultChars: found.text.length,
        resultText: found.text,
        isError: found.isError,
        pinned:
          isPinned(messageIndex, messages.length, preserveRecentMessages) ||
          isPinned(found.index, messages.length, preserveRecentMessages),
      })
    }
  })
  return calls
}

interface Stage {
  inputCap: number
  peek: number
  abridgeOld: boolean
  collapseOld: boolean
  dropOldTextless: boolean
}

export interface StateOptions {
  maxStateTokens: number
  preserveRecentMessages: number
  peekChars: number
  task?: string
}

function taskText(messages: readonly TranscriptMessage[]): string {
  return messages
    .filter(
      (message) =>
        message.role === "user" &&
        message.text.trim().length > 0 &&
        (message.toolResults ?? []).length === 0,
    )
    .slice(-TASK_PROMPTS)
    .map((message) => redactText(clip(message.text, 500)))
    .join("\n")
}

function renderText(text: string, pinned: boolean, stage: Stage): string {
  if (!text) return ""
  if (!pinned && stage.collapseOld) return `[… ${text.length} chars omitted …]`
  if (!pinned && stage.abridgeOld) return abridge(text, TEXT_HEAD, TEXT_TAIL)
  return text
}

/**
 * A call as Jev sees it. Results are summarised by size plus a head and tail
 * excerpt, so the judgement is made on what the output actually contained rather
 * than on a byte count. Inputs are redacted before they leave the process.
 */
function renderCall(call: ToolCall, stage: Stage): StateToolCall {
  const rendered: StateToolCall = {
    n: call.slot,
    tool: call.tool,
    input: redactText(clip(JSON.stringify(redactInput(call.input)), stage.inputCap)),
    outcome: call.isError ? "error" : "ok",
    bytes: call.resultChars,
  }
  if (stage.peek > 0 && call.resultChars > stage.peek * 2 + 16) {
    rendered.head = redactText(call.resultText.slice(0, stage.peek))
    rendered.tail = redactText(call.resultText.slice(-stage.peek))
  }
  return rendered
}

/**
 * Build the state Jev judges against, shrinking it in stages until it fits
 * `maxStateTokens`. Throws when even the last stage does not fit; the caller
 * treats that as fail-open.
 */
export function buildState(
  messages: readonly TranscriptMessage[],
  calls: readonly ToolCall[],
  options: StateOptions,
): FittedState {
  const task = options.task?.trim() || taskText(messages)
  const byMessage = new Map<number, ToolCall[]>()
  for (const call of calls) {
    const list = byMessage.get(call.messageIndex) ?? []
    list.push(call)
    byMessage.set(call.messageIndex, list)
  }

  const attempt = (stage: Stage, label: string): FittedState => {
    const history: StateEntry[] = []
    messages.forEach((message, index) => {
      const pinned = isPinned(index, messages.length, options.preserveRecentMessages)
      const text = renderText(message.text, pinned, stage)
      const own = byMessage.get(index) ?? []
      if (!text && own.length === 0) return
      if (!pinned && !text && stage.dropOldTextless) return
      const entry: StateEntry = { role: message.role, text }
      if (own.length > 0) entry.calls = own.map((call) => renderCall(call, stage))
      history.push(entry)
    })
    const state: JevState = { task, history }
    return { state, tokens: estimateTokens(JSON.stringify(state)), stage: label }
  }

  const base: Stage = {
    inputCap: INPUT_CAPS[0],
    peek: options.peekChars,
    abridgeOld: false,
    collapseOld: false,
    dropOldTextless: false,
  }
  const ladder: Array<[Stage, string]> = [
    [base, "full"],
    [{ ...base, inputCap: INPUT_CAPS[1] }, `inputs<=${INPUT_CAPS[1]}`],
    [{ ...base, inputCap: INPUT_CAPS[2] }, `inputs<=${INPUT_CAPS[2]}`],
    [{ ...base, inputCap: INPUT_CAPS[2], peek: 0 }, "peeks dropped"],
    [{ ...base, inputCap: INPUT_CAPS[2], peek: 0, abridgeOld: true }, "old texts abridged"],
    [
      { ...base, inputCap: INPUT_CAPS[2], peek: 0, abridgeOld: true, collapseOld: true },
      "old messages collapsed",
    ],
    [
      {
        ...base,
        inputCap: INPUT_CAPS[2],
        peek: 0,
        abridgeOld: true,
        collapseOld: true,
        dropOldTextless: true,
      },
      "old textless dropped",
    ],
  ]

  let last = 0
  for (const [stage, label] of ladder) {
    const fitted = attempt(stage, label)
    last = fitted.tokens
    if (fitted.tokens <= options.maxStateTokens) return fitted
  }
  throw new Error(
    `history too large for Jev (~${last} tokens after every stage, limit ${options.maxStateTokens})`,
  )
}
