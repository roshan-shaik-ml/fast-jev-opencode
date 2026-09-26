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

interface V2Part {
  type?: string
  text?: string
  id?: string
  name?: string
  state?: {
    status?: string
    input?: Record<string, unknown> | string
    content?: Array<{ type?: string; text?: string }>
    error?: { message?: string }
  }
}

interface V2Message {
  type?: string
  id?: string
  text?: string
  content?: V2Part[]
}

function messageText(message: V2Message): string {
  if (message.type === "assistant") {
    return (message.content ?? [])
      .filter((part) => part && part.type === "text" && typeof part.text === "string")
      .map((part) => part.text as string)
      .join("\n")
  }
  return typeof message.text === "string" ? message.text : ""
}

export function toTranscriptMessages(messages: V2Message[]): TranscriptMessage[] {
  const out: TranscriptMessage[] = []
  for (const message of messages) {
    const text = messageText(message)
    const toolUses: TranscriptMessage["toolUses"] = []
    const toolResults: NonNullable<TranscriptMessage["toolResults"]> = []
    for (const part of message.content ?? []) {
      if (!part || part.type !== "tool") continue
      const state = part.state ?? {}
      const id = String(part.id ?? "")
      if (!id) continue
      const input = typeof state.input === "object" && state.input !== null ? state.input : {}
      toolUses.push({ id, name: String(part.name ?? ""), input })
      if (state.status === "completed") {
        const output = (state.content ?? [])
          .filter((entry) => entry && entry.type === "text" && typeof entry.text === "string")
          .map((entry) => entry.text as string)
          .join("\n")
        toolResults.push({ id, text: output, isError: false })
      } else if (state.status === "error") {
        toolResults.push({
          id,
          text: String(state.error?.message ?? ""),
          isError: true,
        })
      }
    }
    const jev: TranscriptMessage = {
      role: message.type === "assistant" ? "assistant" : "user",
      text,
      toolUses,
    }
    if (toolResults.length > 0) jev.toolResults = toolResults
    out.push(jev)
  }
  return out
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
  let droppedCalls = 0
  let stubbedCalls = 0
  let droppedResults = 0
  let removedMessages = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    const content = message.content
    if (!Array.isArray(content)) continue
    const onlyTools = content.length > 0 && content.every((part) => part && part.type === "tool")
    for (let j = content.length - 1; j >= 0; j--) {
      const part = content[j]
      if (!part || part.type !== "tool") continue
      const action = actions.get(String(part.id ?? ""))
      if (action === "drop_call") {
        if (style === "delete") {
          content.splice(j, 1)
          droppedCalls += 1
          continue
        }
        const state = part.state
        if (state && typeof state.input === "object" && state.input !== null) {
          state.input = shrinkInput(state.input, headChars)
        }
        if (state && state.status === "completed" && Array.isArray(state.content)) {
          for (const entry of state.content) {
            if (entry && entry.type === "text" && typeof entry.text === "string") {
              entry.text = stubbedResultText(entry.text, false, headChars)
            }
          }
        } else if (
          state &&
          state.status === "error" &&
          state.error &&
          typeof state.error.message === "string"
        ) {
          state.error.message = stubbedResultText(state.error.message, true, headChars)
        }
        stubbedCalls += 1
        continue
      }
      if (action === "drop_result") {
        const state = part.state
        if (!state) continue
        if (state.status === "completed" && Array.isArray(state.content)) {
          for (const entry of state.content) {
            if (entry && entry.type === "text" && typeof entry.text === "string") {
              const next = truncatedResultText(entry.text, false, headChars)
              if (next !== entry.text) {
                entry.text = next
                droppedResults += 1
              }
            }
          }
        } else if (
          state.status === "error" &&
          state.error &&
          typeof state.error.message === "string"
        ) {
          const next = truncatedResultText(state.error.message, true, headChars)
          if (next !== state.error.message) {
            state.error.message = next
            droppedResults += 1
          }
        }
      }
    }
    if (onlyTools && content.length === 0) {
      messages.splice(i, 1)
      removedMessages += 1
    }
  }
  return { droppedCalls, stubbedCalls, droppedResults, removedMessages }
}

export const FastJevV2 = Plugin.define({
  id: "fast-jev",

  async setup(ctx) {
    const log = (level: "debug" | "info" | "warn" | "error", message: string, extra?: unknown) => {
      try {
        const app = (ctx as { app?: { log?: (input: unknown) => unknown } }).app
        const result = app?.log?.({ body: { service: "fast-jev", level, message, extra } })
        if (result !== undefined) {
          void Promise.resolve(result).catch(() => {})
          return
        }
      } catch {
        /* fail-open */
      }
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
              `keep-signal guard: Jev scored ${result.candidates} candidate(s) and kept none; request left untouched`,
              { stage: result.stage },
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
