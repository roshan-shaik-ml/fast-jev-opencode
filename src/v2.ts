import { Plugin } from "@opencode/plugin"
import { renderCheckpoint } from "./checkpoint.ts"
import {
  getConfigIssues,
  loadConfig,
  makeAsker,
  plan,
  resolveApiKey,
  shouldWarnConfig,
  shrinkInput,
  stubbedResultText,
  truncatedResultText,
  type CallAction,
  type RemovedCallStyle,
  type TranscriptMessage,
} from "./shared.ts"

/**
 * The payload `ctx.session.hook("context", ...)` actually receives, captured from
 * a live 2.0.18 session:
 *
 *   role=user       content: [ {type:"text", text} ]
 *   role=assistant  content: [ {type:"reasoning"}, {type:"tool-call", id, name, input} ]
 *   role=tool       content: [ {type:"tool-result", id, name, result:{type,value}} ]
 *   role=system     content: [ {type:"text", text} ]
 *
 * Calls and results live in separate messages, so they are paired here by id
 * exactly as the engine expects. An earlier revision of this file assumed a
 * single `type:"tool"` part carrying `state.input`/`state.content` — a shape that
 * never occurs — which made the whole adapter a silent no-op. Anything that does
 * not match the shapes below is counted and reported rather than ignored.
 */
interface V2ResultValue {
  type?: string
  value?: unknown
}

interface V2Part {
  type?: string
  text?: string
  id?: string
  name?: string
  input?: unknown
  result?: V2ResultValue
}

interface V2Message {
  role?: string
  content?: V2Part[]
}

const KNOWN_PARTS = new Set(["text", "reasoning", "tool-call", "tool-result"])

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function resultText(result: V2ResultValue | undefined): string {
  if (!result) return ""
  const value = result.value
  if (result.type === "content" && Array.isArray(value)) {
    return value
      .map((entry) =>
        entry && typeof entry === "object" && typeof (entry as { text?: unknown }).text === "string"
          ? (entry as { text: string }).text
          : "",
      )
      .filter(Boolean)
      .join("\n")
  }
  if (typeof value === "string") return value
  if (value === undefined || value === null) return ""
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

export function toTranscriptMessages(messages: V2Message[]): TranscriptMessage[] {
  return messages.map((message) => {
    const parts = Array.isArray(message.content) ? message.content : []
    const text = parts
      .filter((part) => part?.type === "text" && typeof part.text === "string")
      .map((part) => part.text as string)
      .join("\n")
    const toolUses = parts
      .filter((part) => part?.type === "tool-call" && part.id)
      .map((part) => ({
        id: String(part.id),
        name: String(part.name ?? ""),
        input: asRecord(part.input),
      }))
    const toolResults = parts
      .filter((part) => part?.type === "tool-result" && part.id)
      .map((part) => ({
        id: String(part.id),
        text: resultText(part.result),
        isError: part.result?.type === "error",
      }))
    const transcript: TranscriptMessage = {
      role: message.role === "assistant" ? "assistant" : "user",
      text,
      toolUses,
    }
    if (toolResults.length > 0) transcript.toolResults = toolResults
    return transcript
  })
}

/** Counts parts we recognise, so an unexpected payload can be reported. */
export function countKnownParts(messages: V2Message[]): { known: number; total: number } {
  let known = 0
  let total = 0
  for (const message of messages) {
    for (const part of message.content ?? []) {
      total += 1
      if (part?.type && KNOWN_PARTS.has(part.type)) known += 1
    }
  }
  return { known, total }
}

interface Located {
  message: V2Message
  part: V2Part
}

function locate(messages: V2Message[]): Map<string, { call?: Located; result?: Located }> {
  const byId = new Map<string, { call?: Located; result?: Located }>()
  for (const message of messages) {
    for (const part of message.content ?? []) {
      if (!part?.id) continue
      const key = String(part.id)
      const entry = byId.get(key) ?? {}
      if (part.type === "tool-call") entry.call = { message, part }
      else if (part.type === "tool-result") entry.result = { message, part }
      byId.set(key, entry)
    }
  }
  return byId
}

function dropPart(located: Located | undefined): number {
  if (!located) return 0
  const content = located.message.content
  if (!Array.isArray(content)) return 0
  const index = content.indexOf(located.part)
  if (index === -1) return 0
  content.splice(index, 1)
  return 1
}

function truncateResult(located: Located | undefined, headChars: number, stub: boolean): number {
  const result = located?.part.result
  if (!result) return 0
  const current = resultText(result)
  const next = stub
    ? stubbedResultText(current, result.type === "error", headChars)
    : truncatedResultText(current, result.type === "error", headChars)
  if (next === current) return 0
  result.type = "text"
  result.value = next
  return 1
}

export function applyActions(
  messages: V2Message[],
  actions: Map<string, CallAction>,
  headChars: number,
  style: RemovedCallStyle,
): {
  droppedCalls: number
  stubbedCalls: number
  droppedResults: number
  removedMessages: number
} {
  const index = locate(messages)
  let droppedCalls = 0
  let stubbedCalls = 0
  let droppedResults = 0

  for (const [id, action] of actions) {
    const entry = index.get(id)
    if (!entry) continue
    if (action === "drop_call") {
      if (style === "delete") {
        droppedCalls += dropPart(entry.call)
        dropPart(entry.result)
        continue
      }
      if (entry.call && entry.call.part.input && typeof entry.call.part.input === "object") {
        entry.call.part.input = shrinkInput(asRecord(entry.call.part.input), headChars)
      }
      truncateResult(entry.result, headChars, true)
      stubbedCalls += 1
      continue
    }
    if (action === "drop_result") droppedResults += truncateResult(entry.result, headChars, false)
  }

  let removedMessages = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (Array.isArray(message.content) && message.content.length === 0) {
      messages.splice(i, 1)
      removedMessages += 1
    }
  }

  return { droppedCalls, stubbedCalls, droppedResults, removedMessages }
}

export const FastJevV2 = Plugin.define({
  id: "fast-jev",

  async setup(ctx) {
    let warnedShape = false
    const log = (level: "debug" | "info" | "warn" | "error", message: string, extra?: unknown) => {
      try {
        console.error(`[fast-jev] ${level}: ${message}`, extra ?? "")
      } catch {
        /* fail-open */
      }
    }

    const registration = await ctx.session.hook("context", async (event) => {
      try {
        const cfg = loadConfig()
        if (shouldWarnConfig()) log("warn", `config: ${getConfigIssues().join("; ")}`)
        if (!cfg.enabled) return
        const messages = event.messages as unknown as V2Message[]
        if (!Array.isArray(messages) || messages.length === 0) return

        const shape = countKnownParts(messages)
        if (!warnedShape && shape.total > 0 && shape.known === 0) {
          warnedShape = true
          log(
            "warn",
            "unrecognised message payload; leaving the request untouched (this plugin needs updating for this host version)",
            { messages: messages.length, parts: shape.total },
          )
          return
        }

        const apiKey = resolveApiKey(cfg)
        if (!apiKey) {
          if (cfg.log) log("warn", "no Jev API key configured; leaving request untouched")
          return
        }
        const result = await plan(toTranscriptMessages(messages), cfg, makeAsker(cfg, apiKey))
        if (result.blocked) {
          if (cfg.log)
            log(
              "warn",
              `keep-signal guard (${result.blockedReason}): request left untouched`,
              { candidates: result.candidates, stage: result.stage },
            )
          return
        }
        if (result.actions.size === 0) {
          if (cfg.log && result.candidates > 0)
            log("debug", "no stale tool calls to prune", { calls: result.calls })
          return
        }
        if (cfg.dryRun) {
          if (cfg.log)
            log("info", `dry-run: would prune ${result.actions.size} tool call(s)`, {
              candidates: result.candidates,
              ruleDrops: result.ruleDrops,
              requests: result.requests,
              stateTokens: result.stateTokens,
            })
          return
        }
        const applied = applyActions(messages, result.actions, cfg.truncateHeadChars, cfg.removedCallStyle)
        if (cfg.log)
          log("info", "pruned outgoing request", {
            ...applied,
            ruleDrops: result.ruleDrops,
            requests: result.requests,
            stateTokens: result.stateTokens,
            stage: result.stage,
          })
      } catch (error) {
        try {
          log("warn", `fail-open: ${error instanceof Error ? error.message : String(error)}`)
        } catch {
          /* fail-open */
        }
      }
    })

    /**
     * The host writes a summary at compaction, which is lossy by construction.
     * With `verbatimCheckpoint` the plugin records the checkpoint itself instead,
     * so what survives compaction is the messages rather than a description of
     * them. Registered unconditionally and gated inside, so flipping the option
     * takes effect without a restart; any failure leaves the host's compaction
     * alone.
     */
    const checkpoint = await ctx.session.hook("compaction", async (event) => {
      try {
        const cfg = loadConfig()
        if (!cfg.enabled || !cfg.verbatimCheckpoint) return
        const messages = (event as { messages?: unknown }).messages as unknown as V2Message[]
        if (!Array.isArray(messages) || messages.length === 0) return
        const summary = renderCheckpoint(toTranscriptMessages(messages), {
          truncateHeadChars: cfg.truncateHeadChars,
          maxChars: cfg.verbatimCheckpointMaxChars,
        })
        if (summary === undefined) return
        ;(event as { result?: unknown }).result = { summary }
      } catch {
        /* fail-open: the host's own compaction runs instead */
      }
    })

    return async () => {
      await registration.dispose()
      await checkpoint.dispose()
    }
  },
})

export default FastJevV2
