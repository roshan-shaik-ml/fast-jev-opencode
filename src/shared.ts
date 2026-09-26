import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import {
  JevClient,
  batchCalls,
  buildState,
  collectCalls,
  decide,
  DEFAULT_RULES,
  lacksKeepSignal,
  prefilter,
  questionsForStyle,
  type JevAnswer,
  type QuestionStyle,
  type RuleSet,
  type CallAction,
  type CallAnswer,
  type Decision,
  type JevAsker,
  type Thresholds,
  type ToolCall,
  type TranscriptMessage,
} from "./engine/index.ts"

export type Provider = "typesafe" | "zen" | "openrouter" | "custom"

/**
 * What to do with a call Jev rates as no longer needed.
 *
 * `stub` keeps the call in place with its output cut short. `delete` removes it
 * entirely. Deleting is smaller, but it leaves the assistant's narration with no
 * evidence attached — and a model that sees its own past turns narrate work with
 * no tool calls will imitate that shape and report work it never did.
 */
export type RemovedCallStyle = "stub" | "delete"

export interface Config {
  enabled: boolean
  dryRun: boolean
  provider: Provider
  apiKey: string
  apiKeyEnv: string
  apiKeyFile: string
  baseUrl: string
  model: string
  keepCallThreshold: number
  keepResultThreshold: number
  legacyKeepThreshold?: number
  preserveRecentMessages: number
  maxStateTokens: number
  maxRequestTokens: number
  truncateHeadChars: number
  minResultChars: number
  peekChars: number
  minScored: number
  removedCallStyle: RemovedCallStyle
  questionStyle: QuestionStyle
  inputPrice: number
  cachedInputPrice: number
  cacheAware: boolean
  verbatimCheckpoint: boolean
  verbatimCheckpointMaxChars: number
  rules: RuleSet
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

const DEFAULTS = {
  enabled: true,
  dryRun: true,
  provider: "typesafe" as Provider,
  apiKey: "",
  apiKeyEnv: "",
  apiKeyFile: "",
  baseUrl: "",
  model: "",
  keepCallThreshold: 0.25,
  keepResultThreshold: 0.15,
  preserveRecentMessages: 6,
  maxStateTokens: 25000,
  maxRequestTokens: 30000,
  truncateHeadChars: 300,
  minResultChars: 2000,
  peekChars: 200,
  minScored: 8,
  removedCallStyle: "stub" as RemovedCallStyle,
  questionStyle: "choice" as QuestionStyle,
  inputPrice: 0,
  cachedInputPrice: 0,
  cacheAware: false,
  verbatimCheckpoint: false,
  verbatimCheckpointMaxChars: 200000,
  rules: { ...DEFAULT_RULES },
  protectTools: [] as string[],
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

/** A config file may still carry the pre-split `keepThreshold` key. */
type ConfigFile = Partial<Config> & { keepThreshold?: number }

function readConfigFile(): ConfigFile {
  configIssues = []
  for (const path of CONFIG_CANDIDATES) {
    try {
      const raw = readFileSync(path, "utf8")
      const parsed = JSON.parse(stripJsonComments(raw))
      if (parsed && typeof parsed === "object") return parsed as ConfigFile
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
  const legacyValue = file.keepThreshold ?? file.legacyKeepThreshold
  const legacy =
    typeof legacyValue === "number" && Number.isFinite(legacyValue)
      ? Math.min(1, Math.max(0, legacyValue))
      : undefined
  return {
    enabled: pickBool(file.enabled, DEFAULTS.enabled),
    dryRun: pickBool(file.dryRun, DEFAULTS.dryRun),
    provider,
    apiKey: pick(file.apiKey, DEFAULTS.apiKey),
    apiKeyEnv: pick(file.apiKeyEnv, preset?.apiKeyEnv ?? ""),
    apiKeyFile: pick(file.apiKeyFile, DEFAULTS.apiKeyFile),
    baseUrl: pick(file.baseUrl, preset?.baseUrl ?? ""),
    model: pick(file.model, preset?.model ?? ""),
    keepCallThreshold: pickNum(file.keepCallThreshold, DEFAULTS.keepCallThreshold, 0, 1),
    keepResultThreshold: pickNum(file.keepResultThreshold, DEFAULTS.keepResultThreshold, 0, 1),
    legacyKeepThreshold: legacy,
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
    peekChars: pickNum(file.peekChars, DEFAULTS.peekChars, 0, 4000),
    minScored: pickNum(file.minScored, DEFAULTS.minScored, 0, 10000),
    removedCallStyle:
      file.removedCallStyle === "delete" || file.removedCallStyle === "stub"
        ? file.removedCallStyle
        : DEFAULTS.removedCallStyle,
    questionStyle:
      file.questionStyle === "choice" || file.questionStyle === "noul"
        ? file.questionStyle
        : DEFAULTS.questionStyle,
    inputPrice: pickNum(file.inputPrice, DEFAULTS.inputPrice, 0, 10000),
    cachedInputPrice: pickNum(file.cachedInputPrice, DEFAULTS.cachedInputPrice, 0, 10000),
    cacheAware: pickBool(file.cacheAware, DEFAULTS.cacheAware),
    verbatimCheckpoint: pickBool(file.verbatimCheckpoint, DEFAULTS.verbatimCheckpoint),
    verbatimCheckpointMaxChars: pickNum(
      file.verbatimCheckpointMaxChars,
      DEFAULTS.verbatimCheckpointMaxChars,
      1000,
      2000000,
    ),
    rules: {
      duplicate: pickBool(file.rules?.duplicate, DEFAULTS.rules.duplicate),
      superseded: pickBool(file.rules?.superseded, DEFAULTS.rules.superseded),
      resolved: pickBool(file.rules?.resolved, DEFAULTS.rules.resolved),
    },
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

export function resolveThresholds(cfg: Config): Thresholds {
  if (cfg.legacyKeepThreshold !== undefined) {
    return { keepCall: cfg.legacyKeepThreshold, keepResult: cfg.legacyKeepThreshold }
  }
  return { keepCall: cfg.keepCallThreshold, keepResult: cfg.keepResultThreshold }
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
    timeoutMs: cfg.timeoutMs,
  })
}

/** The note left in place of a pruned result. Ours, not upstream's. */
export function truncatedResultText(text: string, isError: boolean, headChars: number): string {
  if (text.length <= headChars + 120) return text
  const head = headChars > 0 ? `${text.slice(0, headChars)}\n` : ""
  return `${head}[fast-jev pruned ${text.length - headChars} chars of this tool result${
    isError ? " (error)" : ""
  }; re-run the tool if needed]`
}

/**
 * Cut the oversized string values out of a call's input.
 *
 * A cleared call keeps its place, but its payload is often the biggest thing in
 * the request: an edit carries the old and new text of a file, a shell call
 * carries a whole heredoc. Clearing the output while shipping the input is only
 * half a removal.
 */
export function shrinkInput(
  input: Record<string, unknown>,
  headChars: number,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input ?? {})) {
    if (typeof value === "string" && value.length > headChars) {
      out[key] = `${value.slice(0, headChars)}…[fast-jev cleared ${value.length - headChars} chars]`
    } else {
      out[key] = value
    }
  }
  return out
}

/**
 * Normalise either question shape into the same pair of numbers.
 *
 * A `choice` answer competes its options against each other, so its probabilities
 * sum to one. Mapping "truncate" onto the call and "keep" onto the result lets
 * the same thresholds decide either shape: `keepResult` is how likely the full
 * output is still wanted, `keepCall` how likely the call is worth keeping at all.
 */
function answerFrom(
  slot: number,
  answers: Record<string, JevAnswer>,
  style: QuestionStyle,
): CallAnswer {
  if (style === "choice") {
    const probabilities = answers[`decision_${slot}`]?.probabilities
    // An answer without probabilities is a missing answer, not a "drop". The
    // client's contract says a partial answer must never become a deletion.
    if (!probabilities || Object.keys(probabilities).length === 0) {
      return { keepCall: 1, keepResult: 1 }
    }
    const keep = typeof probabilities.keep === "number" ? probabilities.keep : 0
    const truncate = typeof probabilities.truncate === "number" ? probabilities.truncate : 0
    return { keepCall: keep + truncate, keepResult: keep }
  }
  return {
    keepCall: answers[`call_${slot}`]?.noul ?? 1,
    keepResult: answers[`result_${slot}`]?.noul ?? 1,
  }
}

/** The note left when a call is stubbed rather than deleted. */
export function stubbedResultText(text: string, isError: boolean, headChars: number): string {
  if (text.length <= headChars + 120) return text
  const head = headChars > 0 ? `${text.slice(0, headChars)}\n` : ""
  return `${head}[fast-jev cleared ${text.length - headChars} chars of this tool result${
    isError ? " (error)" : ""
  }; re-run the tool if needed]`
}

interface CacheEntry {
  answer: CallAnswer
  at: number
}

const cache = new Map<string, CacheEntry>()

function pruneCache(now: number, ttl: number): void {
  if (cache.size < 5000) return
  for (const [key, entry] of cache) {
    if (ttl <= 0 || now - entry.at > ttl) cache.delete(key)
  }
}

export interface Plan {
  decisions: Decision[]
  actions: Map<string, CallAction>
  calls: number
  candidates: number
  ruleDrops: number
  requests: number
  stateTokens: number
  stage: string
  blocked: boolean
  blockedReason?: "no-keep-signal" | "cache-cost"
  /** Estimated Jev spend for this pass, in USD. Zero unless `inputPrice` is set. */
  estimatedCostUsd: number
}

/** Characters from `index` onward — the part of the request a prune invalidates. */
function transcriptCharsFrom(transcript: readonly TranscriptMessage[], index: number): number {
  let total = 0
  for (let i = index; i < transcript.length; i++) {
    const message = transcript[i] as TranscriptMessage
    total += message.text.length
    for (const use of message.toolUses) {
      try {
        total += JSON.stringify(use.input).length
      } catch {
        total += 20
      }
    }
    for (const result of message.toolResults ?? []) total += result.text.length
  }
  return total
}

export async function plan(
  transcript: TranscriptMessage[],
  cfg: Config,
  asker: JevAsker,
): Promise<Plan> {
  const thresholds = resolveThresholds(cfg)
  const calls = collectCalls(transcript, cfg.preserveRecentMessages)
  const byId = new Map(calls.map((call) => [call.id, call]))
  const ruleHits = prefilter(calls, cfg.rules)
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
      !ruleHits.has(call.id) &&
      stale(call.id),
  )

  let requests = 0
  let stateTokens = 0
  let stage = ""
  if (needed.length > 0) {
    const fitted = buildState(transcript, calls, {
      maxStateTokens: cfg.maxStateTokens,
      preserveRecentMessages: cfg.preserveRecentMessages,
    })
    stateTokens = fitted.tokens
    stage = fitted.stage
    for (const batch of batchCalls(
      needed,
      fitted.tokens,
      cfg.maxRequestTokens,
      cfg.peekChars,
      cfg.questionStyle,
    )) {
      const questions = Object.assign(
        {},
        ...batch.map((call) => questionsForStyle(call, cfg.questionStyle, cfg.peekChars)),
      )
      const answers = await asker.ask(fitted.state, questions)
      requests += 1
      for (const call of batch) {
        cache.set(call.id, { answer: answerFrom(call.slot, answers, cfg.questionStyle), at: now })
      }
    }
  }

  const decisions = calls.map((call: ToolCall) => {
    const answer = cache.get(call.id)?.answer ?? { keepCall: 1, keepResult: 1 }
    return decide(call, answer, thresholds)
  })

  const actions = new Map<string, CallAction>()
  const eligible = (call: ToolCall | undefined): call is ToolCall =>
    Boolean(call) &&
    !call!.pinned &&
    !protectedTool(call!.tool) &&
    call!.resultChars >= cfg.minResultChars

  for (const id of ruleHits.keys()) {
    const call = byId.get(id)
    if (!eligible(call)) continue
    actions.set(id, "drop_call")
  }
  for (const decision of decisions) {
    if (decision.action === "keep" || ruleHits.has(decision.id)) continue
    const call = byId.get(decision.id)
    if (!eligible(call)) continue
    actions.set(decision.id, decision.action)
  }

  // Only calls that were actually judged may feed the guard. Calls that were
  // never scored (below the size floor, protected, rule-hit, cached) default to
  // "keep", and one of those would mask a blanket removal of every scored call.
  const judged = decisions.filter((decision) => {
    const call = byId.get(decision.id)
    return (
      call !== undefined &&
      !call.pinned &&
      !protectedTool(call.tool) &&
      call.resultChars >= cfg.minResultChars &&
      !ruleHits.has(call.id)
    )
  })
  const keepSignalBlocked = cfg.minScored > 0 && lacksKeepSignal(judged, cfg.minScored)

  // A prune rewrites the prefix, so the provider re-reads the suffix at full
  // price while the removed tokens were only worth the cached-read price. When
  // prices are configured, refuse a pass that does not pay for itself.
  const prunedChars = [...actions.keys()].reduce((sum, id) => {
    const call = byId.get(id)
    return sum + (call ? Math.max(0, call.resultChars - cfg.truncateHeadChars) : 0)
  }, 0)
  const firstIndex = [...actions.keys()].reduce(
    (min, id) => Math.min(min, byId.get(id)?.messageIndex ?? Number.MAX_SAFE_INTEGER),
    Number.MAX_SAFE_INTEGER,
  )
  const suffixTokens = Number.isFinite(firstIndex)
    ? Math.ceil(transcriptCharsFrom(transcript, firstIndex) / 4)
    : 0
  const cacheBlocked =
    cfg.cacheAware &&
    cfg.inputPrice > 0 &&
    prunedChars > 0 &&
    Math.ceil(prunedChars / 4) * cfg.cachedInputPrice -
      suffixTokens * Math.max(0, cfg.inputPrice - cfg.cachedInputPrice) <=
      0

  const blocked = keepSignalBlocked || cacheBlocked
  if (blocked) actions.clear()

  return {
    decisions,
    actions,
    calls: calls.length,
    candidates: needed.length,
    ruleDrops: ruleHits.size,
    requests,
    stateTokens,
    stage,
    blocked,
    blockedReason: keepSignalBlocked ? "no-keep-signal" : cacheBlocked ? "cache-cost" : undefined,
    estimatedCostUsd: (stateTokens * requests * cfg.inputPrice) / 1_000_000,
  }
}

export type { CallAction, Decision, ToolCall, TranscriptMessage }
