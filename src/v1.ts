import type { Plugin } from "@opencode-ai/plugin"
import {
  getConfigIssues,
  loadConfig,
  makeAsker,
  plan,
  resolveApiKey,
  shouldWarnConfig,
  truncatedResultText,
  type CallAction,
  type JevMessage,
} from "./shared.ts"

interface V1Part {
  type?: string
  text?: string
  callID?: string
  tool?: string
  state?: {
    status?: string
    input?: Record<string, unknown>
    output?: string
    error?: string
  }
}

interface V1Message {
  info?: { role?: string }
  parts: V1Part[]
}

export function toJevMessages(messages: V1Message[]): JevMessage[] {
  const out: JevMessage[] = []
  for (const message of messages) {
    let text = ""
    const toolUses: JevMessage["toolUses"] = []
    const toolResults: NonNullable<JevMessage["toolResults"]> = []
    for (const part of message.parts ?? []) {
      if (!part || typeof part !== "object") continue
      if (part.type === "text" && typeof part.text === "string") {
        text = text ? `${text}\n${part.text}` : part.text
      } else if (part.type === "tool") {
        const state = part.state ?? {}
        const id = String(part.callID ?? "")
        if (!id) continue
        toolUses.push({ tool_use_id: id, tool: String(part.tool ?? ""), input: state.input ?? {} })
        if (state.status === "completed") {
          toolResults.push({ tool_use_id: id, text: String(state.output ?? ""), isError: false })
        } else if (state.status === "error") {
          toolResults.push({ tool_use_id: id, text: String(state.error ?? ""), isError: true })
        }
      }
    }
    const jev: JevMessage = {
      role: message.info?.role === "assistant" ? "assistant" : "user",
      text,
      toolUses,
    }
    if (toolResults.length > 0) jev.toolResults = toolResults
    out.push(jev)
  }
  return out
}

export function applyActions(
  messages: V1Message[],
  actions: Map<string, CallAction>,
  headChars: number,
): { droppedCalls: number; droppedResults: number; removedMessages: number } {
  let droppedCalls = 0
  let droppedResults = 0
  let removedMessages = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    const parts = message.parts ?? []
    const onlyTools = parts.length > 0 && parts.every((part) => part && part.type === "tool")
    for (let j = parts.length - 1; j >= 0; j--) {
      const part = parts[j]
      if (!part || part.type !== "tool") continue
      const action = actions.get(String(part.callID ?? ""))
      if (action === "drop_call") {
        parts.splice(j, 1)
        droppedCalls += 1
        continue
      }
      if (action === "drop_result") {
        const state = part.state
        if (!state) continue
        if (state.status === "completed" && typeof state.output === "string") {
          const next = truncatedResultText(state.output, false, headChars)
          if (next !== state.output) {
            state.output = next
            droppedResults += 1
          }
        } else if (state.status === "error" && typeof state.error === "string") {
          const next = truncatedResultText(state.error, true, headChars)
          if (next !== state.error) {
            state.error = next
            droppedResults += 1
          }
        }
      }
    }
    if (onlyTools && parts.length === 0) {
      messages.splice(i, 1)
      removedMessages += 1
    }
  }
  return { droppedCalls, droppedResults, removedMessages }
}

export const FastJevV1: Plugin = async ({ client }) => {
  const log = (level: "debug" | "info" | "warn" | "error", message: string, extra?: unknown) => {
    try {
      const result = client?.app?.log({ body: { service: "fast-jev", level, message, extra } })
      void Promise.resolve(result).catch(() => {})
    } catch {
      /* fail-open */
    }
  }

  return {
    "experimental.chat.messages.transform": async (_input, output) => {
      try {
        const cfg = loadConfig()
        if (shouldWarnConfig()) log("warn", `config: ${getConfigIssues().join("; ")}`)
        if (!cfg.enabled) return
        const messages = output.messages as unknown as V1Message[]
        if (!Array.isArray(messages) || messages.length === 0) return

        const apiKey = resolveApiKey(cfg)
        if (!apiKey) {
          if (cfg.log) log("warn", "no Jev API key configured; leaving request untouched")
          return
        }
        const result = await plan(toJevMessages(messages), cfg, makeAsker(cfg, apiKey))
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
        const applied = applyActions(messages, result.actions, cfg.truncateHeadChars)
        if (cfg.log)
          log("info", "pruned outgoing request", {
            ...applied,
            requests: result.requests,
            stateTokens: result.stateTokens,
          })
      } catch (error) {
        try {
          log("warn", `fail-open: ${error instanceof Error ? error.message : String(error)}`)
        } catch {
          /* fail-open */
        }
      }
    },
  }
}

export default FastJevV1
