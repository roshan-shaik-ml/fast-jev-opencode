import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
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


export type Provider = "typesafe" | "zen" | "openrouter" | "custom"

export interface Config {
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
  timeoutMs: number
  log: boolean
}

export const PRESETS: Record<
  Exclude<Provider, "custom">,
  { baseUrl: string; model: string; apiKeyEnv: string }
> = {
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
  timeoutMs: 30000,
  log: true,
}

const CONFIG_CANDIDATES = process.env.FAST_JEV_CONFIG
  ? [process.env.FAST_JEV_CONFIG]
  : [
      join(homedir(), ".config", "opencode", "fast-jev.json"),
      join(homedir(), ".config", "opencode", "fast-jev.jsonc"),
    ]
const ENV_PATH = process.env.FAST_JEV_ENV || join(homedir(), ".config", "opencode", ".env")

let configIssues: string[] = []
let configWarned = false

export function getConfigIssues(): string[] {
  return configIssues
}

export function shouldWarnConfig(): boolean {
  if (configIssues.length === 0 || configWarned) return false
  configWarned = true
  return true
}

export function stripJsonComments(input: string): string {
  let out = ""
  let inString = false
  let escaped = false
  for (let i = 0; i < input.length; i++) {
    const ch = input[i] as string
    if (inString) {
      out += ch
      if (escaped) escaped = false
      else if (ch === "\\") escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      out += ch
      continue
    }
    if (ch === "/" && input[i + 1] === "/") {
      while (i < input.length && input[i] !== "\n") i++
      out += "\n"
      continue
    }
    if (ch === "/" && input[i + 1] === "*") {
      i += 2
      while (i < input.length && !(input[i] === "*" && input[i + 1] === "/")) i++
      i += 1
      continue
    }
    out += ch
  }
  return out
}

function readConfigFile(): Partial<Config> {
  configIssues = []
  for (const path of CONFIG_CANDIDATES) {
    try {
      const raw = readFileSync(path, "utf8")
      const parsed = JSON.parse(stripJsonComments(raw))
      if (parsed && typeof parsed === "object") return parsed as Partial<Config>
    } catch (error) {
      if ((error as { code?: string })?.code !== "ENOENT") {
        configIssues.push(error instanceof Error ? error.message : String(error))
      }
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

function pickBool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback
}

function pickNum(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === "number" && Number.isFinite(value) ? value : fallback
  return Math.min(max, Math.max(min, n))
}

export function loadConfig(): Config {
  const file = readConfigFile()
  const rawProvider = file.provider
  const provider: Provider =
    rawProvider === "typesafe" ||
    rawProvider === "zen" ||
    rawProvider === "openrouter" ||
    rawProvider === "custom"
      ? rawProvider
      : DEFAULTS.provider
  if (rawProvider !== undefined && rawProvider !== provider) {
    configIssues.push(`unknown provider "${String(rawProvider)}"; using "${provider}"`)
  }
  const preset = provider === "custom" ? undefined : (PRESETS[provider] ?? PRESETS.typesafe)
  return {
    enabled: pickBool(file.enabled, DEFAULTS.enabled),
    dryRun: pickBool(file.dryRun, DEFAULTS.dryRun),
    provider,
    apiKey: pick(file.apiKey, DEFAULTS.apiKey),
    apiKeyEnv: pick(file.apiKeyEnv, preset?.apiKeyEnv ?? ""),
    apiKeyFile: pick(file.apiKeyFile, DEFAULTS.apiKeyFile),
    baseUrl: pick(file.baseUrl, preset?.baseUrl ?? ""),
    model: pick(file.model, preset?.model ?? ""),
    keepThreshold: pickNum(file.keepThreshold, DEFAULTS.keepThreshold, 0, 1),
    preserveRecentMessages: pickNum(
      file.preserveRecentMessages,
      DEFAULTS.preserveRecentMessages,
      0,
      10000,
    ),
    maxStateTokens: pickNum(file.maxStateTokens, DEFAULTS.maxStateTokens, 1, 1000000),
    maxRequestTokens: pickNum(file.maxRequestTokens, DEFAULTS.maxRequestTokens, 1, 1000000),
    truncateHeadChars: pickNum(file.truncateHeadChars, DEFAULTS.truncateHeadChars, 0, 1000000),
    minResultChars: pickNum(file.minResultChars, DEFAULTS.minResultChars, 0, 1000000),
    protectTools: Array.isArray(file.protectTools)
      ? file.protectTools.filter((t) => typeof t === "string")
      : DEFAULTS.protectTools,
    rejudgeAfterMs: pickNum(
      file.rejudgeAfterMs,
      DEFAULTS.rejudgeAfterMs,
      0,
      Number.MAX_SAFE_INTEGER,
    ),
    timeoutMs: pickNum(file.timeoutMs, DEFAULTS.timeoutMs, 1000, 300000),
    log: pickBool(file.log, DEFAULTS.log),
  }
}

export function resolveApiKey(cfg: Config): string {
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

export function makeAsker(cfg: Config, apiKey: string): JevAsker {
  return new JevClient({
    apiKey,
    model: cfg.model || undefined,
    baseUrl: cfg.baseUrl || undefined,
    fetch: (input, init) => {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), cfg.timeoutMs)
      return fetch(input, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer))
    },
  })
}

export interface JevMessage {
  role: "user" | "assistant"
  text: string
  toolUses: { tool_use_id: string; tool: string; input: Record<string, unknown> }[]
  toolResults?: { tool_use_id: string; text: string; isError?: boolean }[]
}

export function truncatedResultText(text: string, isError: boolean, headChars: number): string {
  if (text.length <= headChars + 120) return text
  const head = headChars > 0 ? `${text.slice(0, headChars)}\n` : ""

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

export interface Plan {
  actions: Map<string, CallAction>
  calls: number
  candidates: number
  requests: number
  stateTokens: number
}

export async function plan(jev: JevMessage[], cfg: Config, asker: JevAsker): Promise<Plan> {
  const options = resolveOptions({
    keepThreshold: cfg.keepThreshold,
    preserveRecentMessages: cfg.preserveRecentMessages,
    maxStateTokens: cfg.maxStateTokens,
    maxRequestTokens: cfg.maxRequestTokens,
    truncateHeadChars: cfg.truncateHeadChars,
  })
  const calls = collectToolCalls(jev, options.preserveRecentMessages)
  const now = Date.now()
  pruneCache(now, cfg.rejudgeAfterMs)

  const protectedTool = (tool: string): boolean => cfg.protectTools.includes(tool)
  const stale = (id: string): boolean => {
    const entry = cache.get(id)
    return !entry || cfg.rejudgeAfterMs <= 0 || now - entry.at >= cfg.rejudgeAfterMs
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
    if (call.resultChars < cfg.minResultChars) continue
    const entry = cache.get(call.tool_use_id)
    if (!entry) continue
    const decision = decideCall(call, entry.answer, options)
    if (decision.action !== "keep") actions.set(call.tool_use_id, decision.action)
  }

  return { actions, calls: calls.length, candidates: needed.length, requests, stateTokens }
}

export type { CallAction }
