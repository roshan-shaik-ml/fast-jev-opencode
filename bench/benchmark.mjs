import { createServer } from "node:http"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"


const live = process.argv.includes("--live")
const PRESERVE = 6
const THRESHOLD = 0.5
const HEAD_CHARS = 300

function probability(name) {
  const n = Number(name.match(/_t(\d+)$/)?.[1] ?? "1")
  const isCall = name.startsWith("call_")
  if (isCall) return n % 3 === 2 ? 0.2 : 0.9
  return n % 3 === 1 ? 0.2 : 0.9
}

function answersFor(questions) {
  const answers = {}
  for (const [name, question] of Object.entries(questions ?? {})) {
    if (question.type !== "noul") continue
    answers[name] = { noul: live ? 1 : probability(name) }
  }
  return answers
}

let requestCount = 0
const mock = createServer((req, res) => {
  let body = ""
  req.on("data", (chunk) => (body += chunk))
  req.on("end", () => {
    requestCount += 1
    const parsed = JSON.parse(body)
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ answers: answersFor(parsed.questions) }))
  })
})

let baseUrl
if (!live) {
  await new Promise((resolve) => mock.listen(0, "127.0.0.1", resolve))
  baseUrl = `http://127.0.0.1:${mock.address().port}`
}

function spec() {
  const messages = [
    {
      role: "user",
      text: "Fix the failing test in src/app.ts. Never edit src/generated. Keep the public API stable.",
      tools: [],
    },
  ]
  for (let i = 0; i < 24; i++) {
    const tool = ["read", "bash", "grep", "edit"][i % 4]
    messages.push({
      role: "assistant",
      text: "",
      tools: [
        {
          callID: `c${i + 1}`,
          tool,
          input: {
            path: `src/file${i}.ts`,
            pattern: "needle",
            command: `rg needle src/file${i}.ts`,
          },
          output: `result for call ${i + 1}\n${"x".repeat(4000)}`,
        },
      ],
    })
  }
  for (let i = 0; i < PRESERVE; i++) {
    messages.push({ role: i % 2 ? "user" : "assistant", text: `tail step ${i}`, tools: [] })
  }
  return messages
}

function claudeMessages(messages) {
  return messages.map((m) => {
    const message = { role: m.role, text: m.text, toolUses: [] }
    if (m.tools.length > 0) {
      message.toolUses = m.tools.map((t) => ({
        tool_use_id: t.callID,
        tool: t.tool,
        input: t.input,
      }))
      message.toolResults = m.tools.map((t) => ({
        tool_use_id: t.callID,
        text: t.output,
        isError: false,
      }))
    }
    return message
  })
}

function opencodeMessages(messages) {
  return messages.map((m) => ({
    info: { id: `m${Math.random()}`, sessionID: "s", role: m.role },
    parts: [
      ...(m.text
        ? [{ id: `t${Math.random()}`, sessionID: "s", messageID: "m", type: "text", text: m.text }]
        : []),
      ...m.tools.map((t) => ({
        id: `${t.callID}-p`,
        sessionID: "s",
        messageID: "m",
        type: "tool",
        callID: t.callID,
        tool: t.tool,
        state: {
          status: "completed",
          input: t.input,
          output: t.output,
          title: t.tool,
          metadata: {},
          time: { start: 1, end: 2 },
        },
      })),
    ],
  }))
}

function claudeChars(messages) {
  let total = 0
  for (const m of messages) {
    total += m.text.length
    for (const t of m.toolUses) total += JSON.stringify(t.input).length
    for (const r of m.toolResults ?? []) total += r.text.length
  }
  return total
}

function opencodeChars(messages) {
  let total = 0
  for (const m of messages) {
    for (const p of m.parts) {
      if (p.type === "text") total += p.text.length
      else if (p.type === "tool") {
        total += JSON.stringify(p.state.input ?? {}).length
        total += (p.state.output ?? p.state.error ?? "").length
      }
    }
  }
  return total
}

function actionCounts(actions) {
  return {
    keep: actions.filter((a) => a === "keep").length,
    drop_result: actions.filter((a) => a === "drop_result").length,
    drop_call: actions.filter((a) => a === "drop_call").length,
  }
}

const pct = (before, after) => (((before - after) / before) * 100).toFixed(1)

const source = spec()
const claude = claudeMessages(source)
const opencode = opencodeMessages(source)

console.log(`\nmode: ${live ? "live (real TypeSafe endpoint)" : "offline (mock endpoint)"}`)
console.log(`transcript: ${source.length} messages, 24 tool calls, ${claudeChars(claude)} chars\n`)

console.log("Claude Code path  (library compact(), the upstream port's engine)")
const tA = Date.now()
const result = await compact(
  claude,
  { ask: async (_state, questions) => ({ answers: answersFor(questions) }) },
  {
    preserveRecentMessages: PRESERVE,
    keepThreshold: THRESHOLD,
    truncateHeadChars: HEAD_CHARS,
  },
)
const msA = Date.now() - tA
const actionsA = result.decisions.filter((d) => d.reason !== "pinned").map((d) => d.action)
console.log(`  calls judged   ${result.decisions.length}`)
console.log(`  actions        ${JSON.stringify(actionCounts(actionsA))}`)
console.log(
  `  chars          ${result.stats.charsBefore} -> ${result.stats.charsAfter} (-${pct(result.stats.charsBefore, result.stats.charsAfter)}%)`,
)
console.log(`  messages       ${result.stats.messagesBefore} -> ${result.stats.messagesAfter}`)
console.log(`  jev requests   ${result.stats.requests}`)
console.log(`  time           ${msA} ms\n`)

const home = mkdtempSync(join(tmpdir(), "fast-jev-bench-"))
const cfgPath = join(home, "fast-jev.json")
const envPath = join(home, ".env")
process.env.FAST_JEV_CONFIG = cfgPath
process.env.FAST_JEV_ENV = envPath

const baseCfg = {
  enabled: true,
  dryRun: false,
  provider: "custom",
  baseUrl: baseUrl ?? "https://api.typesafe.ai/v1/systemone",
  apiKeyEnv: "TYPESAFE_API_KEY",
  preserveRecentMessages: PRESERVE,
  keepThreshold: THRESHOLD,
  truncateHeadChars: HEAD_CHARS,
  minResultChars: 0,
  rejudgeAfterMs: 600000,
  timeoutMs: 60000,
  log: false,
}
const writeCfg = (overrides = {}) =>
  writeFileSync(cfgPath, JSON.stringify({ ...baseCfg, ...overrides }))
writeCfg()

if (live) {
  const key = process.env.TYPESAFE_API_KEY
  if (!key) {
    console.error("--live requires TYPESAFE_API_KEY in the environment")
    process.exitCode = 1
    process.exit()
  }
  writeFileSync(envPath, `TYPESAFE_API_KEY=${key}\n`)
} else {
  process.env.TYPESAFE_API_KEY = "bench-offline-key"
}

const pluginPath = pathToFileURL(join(process.cwd(), "plugins", "fast-jev.ts")).href
const { default: plugin } = await import(pluginPath)
const hooks = await plugin({
  client: { app: { log: async () => {} } },
  directory: home,
  worktree: home,
})
const transform = hooks["experimental.chat.messages.transform"]

const beforeChars = opencodeChars(opencode)
const callIDs = source.flatMap((m) => m.tools.map((t) => t.callID))
requestCount = 0
const tB = Date.now()
await transform({}, { messages: opencode })
const msB = Date.now() - tB
const afterChars = opencodeChars(opencode)

const seen = new Map()
for (const m of opencode) for (const p of m.parts) if (p.type === "tool") seen.set(p.callID, p)
const actionsB = callIDs.map((id) => {
  const part = seen.get(id)
  if (!part) return "drop_call"

    ? "drop_result"
    : "keep"
})
const requestsB = requestCount

console.log("OpenCode v1 path  (experimental.chat.messages.transform)")
console.log(`  calls judged   ${actionsB.length}`)
console.log(`  actions        ${JSON.stringify(actionCounts(actionsB))}`)
console.log(`  chars          ${beforeChars} -> ${afterChars} (-${pct(beforeChars, afterChars)}%)`)
console.log(`  messages       ${source.length} -> ${opencode.length}`)
console.log(`  jev requests   ${requestsB}`)
console.log(`  time           ${msB} ms\n`)

const parity = JSON.stringify(actionsA) === JSON.stringify(actionsB)
console.log(`parity          actions identical: ${parity} (${actionsA.length}/${actionsB.length})`)
console.log(`                chars after identical: ${result.stats.charsAfter === afterChars}`)
console.log(
  `                message count identical: ${result.stats.messagesAfter === opencode.length}`,
)

const cached = opencodeMessages(source)
requestCount = 0
const tC = Date.now()
await transform({}, { messages: cached })
const msC = Date.now() - tC
console.log(`cache           second request: ${requestCount} jev request(s), ${msC} ms`)

writeCfg({ minResultChars: 100000000 })
const idle = opencodeMessages(source)
const tD = Date.now()
await transform({}, { messages: idle })
const msD = Date.now() - tD
console.log(`overhead        no eligible calls: ${msD} ms (mapping only, no Jev call)\n`)

if (!live) await new Promise((resolve) => mock.close(resolve))
rmSync(home, { recursive: true, force: true })

console.log(
  parity ? "RESULT: parity with the Claude Code port\n" : "RESULT: DIVERGENCE - investigate\n",
)
process.exitCode = parity ? 0 : 1
