import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { Plugin } from "@opencode-ai/plugin"
import {
  JevClient,
  batchCalls,
  collectToolCalls,
  decideCall,
  fitState,
  questionsFor,
  resolveOptions,
  type CallAction,
  type CallAnswer,
  type JevAsker,
  type JevQuestion,
  type JevState,


type Provider = "typesafe" | "zen" | "openrouter" | "custom"

interface Config {
  enabled: boolean
  dryRun: boolean
  provider: Provider
  apiKey: string
  apiKeyEnv: string
  apiKeyFile: string
  baseUrl: string
  model: string
  keepThreshold: number
  preserveRecentMessages: number
  maxStateTokens: number
  maxRequestTokens: number
  truncateHeadChars: number
  minResultChars: number
  protectTools: string[]
  rejudgeAfterMs: number
  log: boolean
}

const PRESETS: Record<Exclude<Provider, "custom">, { baseUrl: string; model: string; apiKeyEnv: string }> = {
  typesafe: {
    baseUrl: "https://api.typesafe.ai/v1/systemone",
    model: "jev-latest",
    apiKeyEnv: "TYPESAFE_API_KEY",
  },
  zen: {
    baseUrl: "https://opencode.ai/zen/v1/systemone",
    model: "jev-1.13-free",
    apiKeyEnv: "OPENCODE_API_KEY",
  },
  openrouter: {
    baseUrl: "https://openrouter.ai/api/v1/systemone",
    model: "typesafe/jev-1.13",
    apiKeyEnv: "OPENROUTER_API_KEY",
  },
}

const DEFAULTS: Omit<Config, "provider" | "apiKeyEnv" | "baseUrl" | "model"> & {
  provider: Provider
} = {
  enabled: true,
  dryRun: true,
  provider: "typesafe",
  apiKey: "",
  apiKeyEnv: "",
  apiKeyFile: "",
  baseUrl: "",
  model: "",
  keepThreshold: 0.5,
  preserveRecentMessages: 6,
  maxStateTokens: 25000,
  maxRequestTokens: 30000,
  truncateHeadChars: 300,
  minResultChars: 2000,
  protectTools: [],
  rejudgeAfterMs: 600000,
  log: true,
}

const CONFIG_PATH = join(homedir(), ".config", "opencode", "fast-jev.json")
const ENV_PATH = join(homedir(), ".config", "opencode", ".env")

function readConfigFile(): Partial<Config> {
  for (const path of [CONFIG_PATH, join(homedir(), ".config", "opencode", "fast-jev.jsonc")]) {
    try {
      const raw = readFileSync(path, "utf8")
      const parsed = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, ""))
      if (parsed && typeof parsed === "object") return parsed as Partial<Config>
    } catch {
      continue
    }
  }
  return {}
}

function readEnvFile(name: string): string {
  if (!name) return ""
  try {
    const raw = readFileSync(ENV_PATH, "utf8")
    for (const line of raw.split(/\r?\n/)) {
      const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/)
      if (match && match[1] === name) {
        return match[2].replace(/^["']|["']$/g, "")
      }
    }
  } catch {
    return ""
  }
  return ""
}

function pick<T>(value: T | undefined, fallback: T): T {
  return value === undefined || value === null || value === "" ? fallback : value
}

function loadConfig(): Config {
  const file = readConfigFile()
  const provider: Provider = pick(file.provider, DEFAULTS.provider)
  const preset = provider === "custom" ? undefined : PRESETS[provider] ?? PRESETS.typesafe
  return {
    enabled: pick(file.enabled, DEFAULTS.enabled),
    dryRun: pick(file.dryRun, DEFAULTS.dryRun),
    provider,
    apiKey: pick(file.apiKey, DEFAULTS.apiKey),
    apiKeyEnv: pick(file.apiKeyEnv, preset?.apiKeyEnv ?? ""),
    apiKeyFile: pick(file.apiKeyFile, DEFAULTS.apiKeyFile),
    baseUrl: pick(file.baseUrl, preset?.baseUrl ?? ""),
    model: pick(file.model, preset?.model ?? ""),
    keepThreshold: pick(file.keepThreshold, DEFAULTS.keepThreshold),
    preserveRecentMessages: pick(file.preserveRecentMessages, DEFAULTS.preserveRecentMessages),
    maxStateTokens: pick(file.maxStateTokens, DEFAULTS.maxStateTokens),
    maxRequestTokens: pick(file.maxRequestTokens, DEFAULTS.maxRequestTokens),
    truncateHeadChars: pick(file.truncateHeadChars, DEFAULTS.truncateHeadChars),
    minResultChars: pick(file.minResultChars, DEFAULTS.minResultChars),
    protectTools: Array.isArray(file.protectTools) ? file.protectTools : DEFAULTS.protectTools,
    rejudgeAfterMs: pick(file.rejudgeAfterMs, DEFAULTS.rejudgeAfterMs),
    log: pick(file.log, DEFAULTS.log),
  }
}

function resolveApiKey(cfg: Config): string {
  if (cfg.apiKey) return cfg.apiKey
  if (cfg.apiKeyEnv && process.env[cfg.apiKeyEnv]) return process.env[cfg.apiKeyEnv] as string
  const fromEnvFile = readEnvFile(cfg.apiKeyEnv)
  if (fromEnvFile) return fromEnvFile
  if (cfg.apiKeyFile) {
    try {
      return readFileSync(cfg.apiKeyFile, "utf8").trim()
    } catch {
      return ""
    }
  }
  return ""
}

interface OpenCodePart {
  type?: string
  text?: string
  callID?: string
  tool?: string
  state?: {
    status?: string
    input?: Record<string, unknown>
    output?: string
    error?: string
    time?: { compacted?: number }
  }
}

interface OpenCodeMessage {
  info?: { role?: string }
  parts: OpenCodePart[]
}

interface JevMessage {
  role: "user" | "assistant"
  text: string
  toolUses: { tool_use_id: string; tool: string; input: Record<string, unknown> }[]
  toolResults?: { tool_use_id: string; text: string; isError?: boolean }[]
}

function toJevMessages(messages: OpenCodeMessage[]): JevMessage[] {
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

function truncatedResultText(text: string, isError: boolean, headChars: number): string {
  if (text.length <= headChars + 120) return text
  const head = headChars > 0 ? `${text.slice(0, headChars)}\n` : ""
  return `${head}[fast-jev truncated ${text.length - headChars} chars of this tool result${
    isError ? " (error)" : ""
  }; re-run the tool if needed]`
}

function noul(answers: Record<string, unknown>, name: string): number {
  const answer = answers[name] as { noul?: unknown } | undefined
  return answer && typeof answer.noul === "number" && Number.isFinite(answer.noul) ? answer.noul : 1
}

interface DecisionCacheEntry {
  answer: CallAnswer
  at: number
}

const cache = new Map<string, DecisionCacheEntry>()

function pruneCache(now: number, ttl: number): void {
  if (cache.size < 5000) return
  for (const [key, entry] of cache) {
    if (ttl <= 0 || now - entry.at > ttl) cache.delete(key)
  }
}

interface Plan {
  actions: Map<string, CallAction>
  calls: number
  candidates: number
  requests: number
  stateTokens: number
}

async function plan(
  messages: OpenCodeMessage[],
  cfg: Config,
  asker: JevAsker,
): Promise<Plan> {
  const options = resolveOptions({
    keepThreshold: cfg.keepThreshold,
    preserveRecentMessages: cfg.preserveRecentMessages,
    maxStateTokens: cfg.maxStateTokens,
    maxRequestTokens: cfg.maxRequestTokens,
    truncateHeadChars: cfg.truncateHeadChars,
  })
  const jev = toJevMessages(messages)
  const calls = collectToolCalls(jev, options.preserveRecentMessages)
  const now = Date.now()
  pruneCache(now, cfg.rejudgeAfterMs)

  const protectedTool = (tool: string): boolean => cfg.protectTools.includes(tool)
  const stale = (id: string): boolean => {
    const entry = cache.get(id)
    return !entry || (cfg.rejudgeAfterMs > 0 && now - entry.at >= cfg.rejudgeAfterMs)
  }

  const needed = calls.filter(
    (call) =>
      !call.pinned &&
      !protectedTool(call.tool) &&
      call.resultChars >= cfg.minResultChars &&
      stale(call.tool_use_id),
  )

  let requests = 0
  let stateTokens = 0
  if (needed.length > 0) {
    const fitted = fitState(jev, calls, options)
    stateTokens = fitted.tokens
    const batches = batchCalls(needed, fitted.tokens, options)
    for (const batch of batches) {
      const questions = Object.assign({}, ...batch.map((call) => questionsFor(call))) as Record<
        string,
        JevQuestion
      >
      const response = await asker.ask(fitted.state as JevState, questions)
      requests += 1
      const answers = (response.answers ?? {}) as Record<string, unknown>
      for (const call of batch) {
        cache.set(call.tool_use_id, {
          answer: {
            keepCall: noul(answers, `call_${call.id}`),
            keepResult: noul(answers, `result_${call.id}`),
          },
          at: now,
        })
      }
    }
  }

  const actions = new Map<string, CallAction>()
  for (const call of calls) {
    if (call.pinned || protectedTool(call.tool)) continue
    const entry = cache.get(call.tool_use_id)
    if (!entry) continue
    const decision = decideCall(call, entry.answer, options)
    if (decision.action !== "keep") actions.set(call.tool_use_id, decision.action)
  }

  return { actions, calls: calls.length, candidates: needed.length, requests, stateTokens }
}

function applyActions(
  messages: OpenCodeMessage[],
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
            if (state.time) state.time.compacted = Date.now()
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

export const FastJev: Plugin = async ({ client }) => {
  const log = (level: "debug" | "info" | "warn" | "error", message: string, extra?: unknown) => {
    try {
      void client?.app?.log({ body: { service: "fast-jev", level, message, extra } })
    } catch {
      /* fail-open */
    }
  }

  return {
    "experimental.chat.messages.transform": async (_input, output) => {
      try {
        const cfg = loadConfig()
        if (!cfg.enabled) return
        const messages = output.messages as unknown as OpenCodeMessage[]
        if (!Array.isArray(messages) || messages.length === 0) return

        const apiKey = resolveApiKey(cfg)
        if (!apiKey) {
          if (cfg.log) log("warn", "no Jev API key configured; leaving request untouched")
          return
        }
        const asker = new JevClient({ apiKey, model: cfg.model, baseUrl: cfg.baseUrl })
        const result = await plan(messages, cfg, asker)
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

export default FastJev
