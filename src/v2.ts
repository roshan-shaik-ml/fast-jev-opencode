import { Plugin } from "@opencode/plugin"
import { renderCheckpoint } from "./checkpoint.ts"
import {
  effortDigest,
  effortFromAnswer,
  effortQuestion,
  type EffortLevel,
  type JevAsker,
} from "./engine/index.ts"
import {
  appendLogFile,
  effortLadder,
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
  type Config,
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
  effort?: string
  previous?: string
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

/**
 * The effort already in force in these messages. The host records an effort
 * change as an `effort` part, and a later one supersedes an earlier one.
 */
function currentEffort(messages: V2Message[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    for (const part of messages[i]?.content ?? []) {
      if (part.type === "effort" && typeof part.effort === "string") return part.effort
    }
  }
  return undefined
}

/**
 * Records the chosen effort as the host's own `effort` part on the newest user
 * message, which is where the runtime's `resolveEffortUpdates` looks for it.
 * Only the outgoing request is touched; the persisted history stays as it was.
 */
function applyEffort(messages: V2Message[], level: EffortLevel): boolean {
  const previous = currentEffort(messages)
  if (previous === level) return false
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message?.role !== "user" || !Array.isArray(message.content)) continue
    message.content.push(
      previous ? { type: "effort", effort: level, previous } : { type: "effort", effort: level },
    )
    return true
  }
  return false
}

/** The newest user text plus counts — small enough to charge to every question. */
function digestForEffort(messages: V2Message[], chars: number): string {
  let task = ""
  let toolCalls = 0
  let total = 0
  for (const message of messages) {
    for (const part of message.content ?? []) {
      if (part.type === "text" && typeof part.text === "string") {
        total += part.text.length
        if (message.role === "user") task = part.text
      } else if (part.type === "tool-call") {
        toolCalls += 1
        try {
          total += JSON.stringify(part.input ?? {}).length
        } catch {
          total += 20
        }
      } else if (part.type === "tool-result") {
        total += resultText(part.result).length
      }
    }
  }
  return effortDigest({ task, messages: messages.length, toolCalls, chars: total }, chars)
}

/**
 * What the target model supports, as far as the host will say. The runtime API
 * is `model.list()` / `model.default()` (both may be async) - `model.get` from
 * the type definitions is not present on 2.0.18, so it is only tried first in
 * case a later host has it.
 */
async function modelSupport(
  ctx: { model?: unknown },
  model: { providerID?: string; id?: string } | undefined,
): Promise<{ variants: string[]; supports?: boolean }> {
  try {
    const domain = ctx.model as
      | {
          get?: (providerID: string, modelID: string) => unknown
          list?: (providerID?: string) => unknown
          default?: () => unknown
        }
      | undefined
    if (!domain) return { variants: [] }

    let providerID = model?.providerID
    let modelID = model?.id
    if ((!providerID || !modelID) && typeof domain.default === "function") {
      const fallback = (await Promise.resolve(domain.default())) as
        { providerID?: string; modelID?: string; id?: string } | undefined
      providerID = providerID ?? fallback?.providerID
      modelID = modelID ?? fallback?.modelID ?? fallback?.id
    }
    if (!providerID || !modelID) return { variants: [] }

    let info: unknown
    if (typeof domain.get === "function") info = domain.get(providerID, modelID)
    if (!info && typeof domain.list === "function") {
      const list = await Promise.resolve(domain.list())
      if (Array.isArray(list)) {
        info = list.find((entry) => {
          const candidate = entry as { providerID?: string; id?: string; modelID?: string }
          return (
            candidate?.providerID === providerID &&
            (candidate?.id === modelID || candidate?.modelID === modelID)
          )
        })
      }
    }

    const typed = info as
      | {
          variants?: Array<{ id?: unknown }>
          compatibility?: { supportsEffortUpdates?: unknown }
        }
      | undefined
    const variants = Array.isArray(typed?.variants)
      ? typed.variants
          .map((variant) => variant?.id)
          .filter((id): id is string => typeof id === "string")
      : []
    const supports = typed?.compatibility?.supportsEffortUpdates
    return { variants, supports: typeof supports === "boolean" ? supports : undefined }
  } catch {
    return { variants: [] }
  }
}

/** Effort decisions, keyed by ladder and digest, so a turn asks once. */
const effortCache = new Map<string, { level: EffortLevel; at: number }>()

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
    // Set from config on every request, so turning it on needs no restart.
    let logFile = ""
    const log = (level: "debug" | "info" | "warn" | "error", message: string, extra?: unknown) => {
      let detail = ""
      if (extra !== undefined) {
        try {
          detail = ` ${JSON.stringify(extra)}`
        } catch {
          detail = ` ${String(extra)}`
        }
      }
      const line = `[fast-jev] ${level}: ${message}${detail}`
      try {
        console.error(line)
      } catch {
        /* fail-open */
      }
      if (logFile) appendLogFile(logFile, line)
    }

    /**
     * One Jev question per request: how much reasoning does this need? The
     * levels offered are the ones the target model can express, so the answer
     * never has to be translated by us - the host's protocol driver owns the
     * provider dialect (OpenAI's `reasoning_effort`, a thinking budget, or a
     * boolean and a budget, depending on the provider).
     */
    const selectEffort = async (
      messages: V2Message[],
      cfg: Config,
      asker: JevAsker,
      model: { providerID?: string; id?: string } | undefined,
      sessionID: string | undefined,
    ): Promise<{ level: EffortLevel; ladder: EffortLevel[]; requests: number } | undefined> => {
      const support = await modelSupport(ctx, model)
      // A content part the protocol does not expect is not a no-op: an OpenAI-chat
      // request fails outright ("user messages only support text and media
      // content"), which a live run confirmed. So an explicit yes is required and
      // silence means nothing is injected.
      if (support.supports !== true) {
        if (cfg.log) log("debug", "effort: model does not declare effort support; nothing injected")
        return undefined
      }
      const ladder = effortLadder(cfg, model?.providerID, model?.id, support.variants)
      const digest = digestForEffort(messages, cfg.effortDigestChars)
      const key = `${sessionID ?? ""}|${ladder.join(",")}|${digest}`
      const cached = effortCache.get(key)
      if (cached && cfg.rejudgeAfterMs > 0 && Date.now() - cached.at < cfg.rejudgeAfterMs) {
        return { level: cached.level, ladder, requests: 0 }
      }
      const answers = await asker.ask({ task: digest }, effortQuestion(ladder, digest))
      const level = effortFromAnswer(answers.effort, ladder)
      if (!level) return undefined
      effortCache.set(key, { level, at: Date.now() })
      if (effortCache.size > 64) {
        const oldest = [...effortCache.entries()].sort((a, b) => a[1].at - b[1].at)[0]
        if (oldest) effortCache.delete(oldest[0])
      }
      return { level, ladder, requests: 1 }
    }

    const registration = await ctx.session.hook("context", async (event) => {
      try {
        const cfg = loadConfig()
        // A log file implies logging: asking for one and getting nothing is a
        // footgun, and this host cannot show plugin output anywhere else.
        if (cfg.logFile !== "" && !cfg.log) cfg.log = true
        logFile = cfg.log ? cfg.logFile : ""
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
        const asker = makeAsker(cfg, apiKey)

        // Effort first: one question, and the pruning pass below is the expensive
        // one. A failure here must never stop the prune, so it is caught locally.
        if (cfg.effortEnabled) {
          try {
            const model = (event as { model?: { providerID?: string; id?: string } }).model
            const sessionID = (event as { sessionID?: string }).sessionID
            const choice = await selectEffort(messages, cfg, asker, model, sessionID)
            if (!choice) {
              if (cfg.log) log("debug", "effort: no level selected; request left as-is")
            } else if (cfg.dryRun) {
              if (cfg.log)
                log("info", `dry-run: would set effort ${choice.level}`, {
                  ladder: choice.ladder,
                  requests: choice.requests,
                })
            } else if (applyEffort(messages, choice.level)) {
              if (cfg.log)
                log("info", "effort set", {
                  level: choice.level,
                  ladder: choice.ladder,
                  requests: choice.requests,
                })
            }
          } catch (error) {
            if (cfg.log)
              log(
                "warn",
                `effort fail-open: ${error instanceof Error ? error.message : String(error)}`,
              )
          }
        }

        const result = await plan(toTranscriptMessages(messages), cfg, asker)
        if (result.blocked) {
          if (cfg.log)
            log("warn", `keep-signal guard (${result.blockedReason}): request left untouched`, {
              candidates: result.candidates,
              stage: result.stage,
            })
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
        const applied = applyActions(
          messages,
          result.actions,
          cfg.truncateHeadChars,
          cfg.removedCallStyle,
        )
        if (cfg.log)
          log("info", "pruned outgoing request", {
            ...applied,
            ruleDrops: result.ruleDrops,
            requests: result.requests,
            stateTokens: result.stateTokens,
            estimatedCostUsd: result.estimatedCostUsd,
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
        if (cfg.logFile !== "" && !cfg.log) cfg.log = true
        logFile = cfg.log ? cfg.logFile : ""
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
