export type Role = "user" | "assistant"

export interface ToolUse {
  id: string
  name: string
  input: Record<string, unknown>
}

export interface ToolResult {
  id: string
  text: string
  isError: boolean
}

export interface TranscriptMessage {
  role: Role
  text: string
  toolUses: ToolUse[]
  toolResults?: ToolResult[]
}

export interface ToolCall {
  slot: number
  id: string
  tool: string
  input: Record<string, unknown>
  messageIndex: number
  resultIndex: number
  resultChars: number
  resultText: string
  isError: boolean
  pinned: boolean
}

export interface CallAnswer {
  keepCall: number
  keepResult: number
}

export type CallAction = "keep" | "drop_result" | "drop_call"

export type DecisionReason = "pinned" | "kept" | "result_truncated" | "call_removed"

export interface Decision {
  id: string
  tool: string
  action: CallAction
  reason: DecisionReason
  keepCall: number
  keepResult: number
}

export interface NoulQuestion {
  type: "noul"
  instructions: string
  criteria?: { true?: string; false?: string }
}

/**
 * A question with named options. Preferred over `noul` where the options are
 * mutually exclusive: the probabilities are relative, so they cannot drift onto
 * a scale of their own the way an independent `noul` reading can.
 */
export interface ChoiceQuestion {
  type: "choice"
  instructions: string
  criteria: Record<string, string>
}

export type JevQuestion = NoulQuestion | ChoiceQuestion

export type JevQuestions = Record<string, JevQuestion>

export interface JevAnswer {
  noul?: number
  choice?: string
  confidence?: number
  probabilities?: Record<string, number>
}

export interface JevAsker {
  ask(state: unknown, questions: JevQuestions): Promise<Record<string, JevAnswer>>
}

export interface Thresholds {
  keepCall: number
  keepResult: number
}

export interface StateToolCall {
  n: number
  tool: string
  input: string
  outcome: "ok" | "error"
  bytes: number
}

export interface StateEntry {
  role: Role
  text: string
  /** Structured per call, or one compact line per call once the state must shrink. */
  calls?: Array<StateToolCall | string>
}

export interface JevState {
  task: string
  history: StateEntry[]
}

export interface FittedState {
  state: JevState
  tokens: number
  stage: string
}
