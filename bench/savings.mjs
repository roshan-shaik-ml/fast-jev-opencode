import { createServer } from "node:http"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"


const live = process.argv.includes("--live")
const THRESHOLDS = [0.5, 0.3, 0.15]

const TASK =
  "After the last deploy, POST /login returns 500 for some users. Find the cause and fix it. Do not change the public API."

const FILE_SESSION = `import { randomUUID } from "node:crypto"
import { db } from "../db"
import { config } from "../config/env"
import type { Session } from "./types"

const TTL_MS = 1000 * 60 * 60 * 24
const MAX_SESSIONS_PER_USER = 20

export async function createSession(userId: string): Promise<Session> {
  const id = randomUUID()
  const expiresAt = Date.now() + TTL_MS
  const existing = await db.find("sessions", { userId, revoked: false })
  if (existing.length >= MAX_SESSIONS_PER_USER) {
    const oldest = existing.sort((a, b) => a.expiresAt - b.expiresAt)[0]
    await db.update("sessions", { id: oldest.id }, { revoked: true })
  }
  await db.insert("sessions", { id, userId, expiresAt, revoked: false })
  return { id, userId, expiresAt }
}

export async function loadSession(id: string): Promise<Session | null> {
  const row = await db.findOne("sessions", { id })
  if (!row) return null
  if (row.revoked) return null
  if (row.expiresAt < Date.now()) {
    await db.update("sessions", { id }, { revoked: true })
    return null
  }
  return { id: row.id, userId: row.userId, expiresAt: row.expiresAt }
}

export async function touchSession(id: string): Promise<void> {
  const session = await loadSession(id)
  if (!session) return
  const expiresAt = Date.now() + TTL_MS
  await db.update("sessions", { id: session.id }, { expiresAt })
}

export function sessionCookie(session: Session, secure = true): string {
  const flags = ["HttpOnly", "SameSite=Lax", "Path=/"]
  if (secure) flags.push("Secure")
  return \`sid=\${session.id}; \${flags.join("; ")}\`
}`

const GREP = `src/auth/session.ts:4:const TTL_MS = 1000 * 60 * 60 * 24
src/auth/session.ts:14:  const expiresAt = Date.now() + TTL_MS
src/auth/session.ts:22:  return { id, userId, expiresAt }
src/auth/session.ts:31:  if (row.expiresAt < Date.now()) {
src/auth/session.ts:40:  const expiresAt = Date.now() + TTL_MS
src/auth/session.ts:41:  await db.update("sessions", { id: session.id }, { expiresAt })
src/auth/middleware.ts:12:  const session = await loadSession(req.cookies.sid)
src/auth/middleware.ts:13:  if (!session) return res.status(401).end()
src/auth/middleware.ts:18:  req.session = session`

const TEST_FAIL = ` FAIL  test/auth/login.test.ts > POST /login > returns 200 with valid credentials
AssertionError: expected 500 to be 200
  at test/auth/login.test.ts:24:31
  at processTicksAndRejections (node:internal/process/task_queues:95:5)

 FAIL  test/auth/login.test.ts > POST /login > sets a session cookie
TypeError: Cannot read properties of undefined (reading 'expiresAt')
  at loadSession (src/auth/session.ts:31:13)
  at middleware (src/auth/middleware.ts:12:22)
  at test/auth/login.test.ts:41:18

 FAIL  test/auth/session.test.ts > touchSession > extends expiry
AssertionError: expected 1758998400000 to be greater than 1758998400000

Test Files  2 failed (2)
     Tests  3 failed | 12 passed (15)
  Duration  2.84s`

const ENV_FILE = `import { z } from "zod"

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().url(),
  SESSION_TTL_HOURS: z.coerce.number().int().positive().default(24),
  SESSION_COOKIE_SECURE: z.coerce.boolean().default(true),
})

export const config = schema.parse(process.env)`

const EDIT_INPUT = {
  filePath: "src/auth/session.ts",
  oldString:
    '  const expiresAt = Date.now() + TTL_MS\n  await db.update("sessions", { id: session.id }, { expiresAt })',
  newString:
    '  const expiresAt = Date.now() + config.SESSION_TTL_HOURS * 60 * 60 * 1000\n  await db.update("sessions", { id: session.id }, { expiresAt })',
}

const TEST_PASS = ` ✓ test/auth/session.test.ts (6)
 ✓ test/auth/login.test.ts (9)

Test Files  2 passed (2)
     Tests  15 passed (15)
  Duration  1.92s`

const SOURCE = [
  { role: "user", text: TASK, tools: [] },
  {
    role: "assistant",
    text: "",
    tools: [
      {
        callID: "c1",
        tool: "read",
        input: { filePath: "src/auth/session.ts" },
        output: FILE_SESSION,
      },
    ],
  },
  {
    role: "assistant",
    text: "",
    tools: [
      { callID: "c2", tool: "grep", input: { pattern: "expiresAt", path: "src" }, output: GREP },
    ],
  },
  {
    role: "assistant",
    text: "",
    tools: [
      { callID: "c3", tool: "bash", input: { command: "npm test -- auth" }, output: TEST_FAIL },
    ],
  },
  {
    role: "assistant",
    text: "",
    tools: [
      { callID: "c4", tool: "read", input: { filePath: "src/config/env.ts" }, output: ENV_FILE },
    ],
  },
  {
    role: "assistant",
    text: "",
    tools: [
      {
        callID: "c5",
        tool: "edit",
        input: EDIT_INPUT,
        output: "Applied 1 edit to src/auth/session.ts",
      },
    ],
  },
  {
    role: "assistant",
    text: "",
    tools: [
      { callID: "c6", tool: "bash", input: { command: "npm test -- auth" }, output: TEST_PASS },
    ],
  },
  {
    role: "user",
    text: "Use SESSION_TTL_HOURS from config instead of the hardcoded constant.",
    tools: [],
  },
  { role: "assistant", text: "Applied the config-based TTL and re-ran the auth tests.", tools: [] },
  { role: "user", text: "thanks", tools: [] },
  { role: "assistant", text: "tail 1", tools: [] },
  { role: "user", text: "tail 2", tools: [] },
  { role: "assistant", text: "tail 3", tools: [] },
  { role: "user", text: "tail 4", tools: [] },
]

const REPLAY = [
  { keepCall: 0.9, keepResult: 0.2 },
  { keepCall: 0.1, keepResult: 0.1 },
  { keepCall: 0.1, keepResult: 0.1 },
  { keepCall: 0.9, keepResult: 0.9 },
  { keepCall: 0.9, keepResult: 0.9 },
  { keepCall: 0.9, keepResult: 0.9 },
]

function opencodeMessages(source) {
  return source.map((m) => ({
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

function requestTokens(messages) {
  let total = 0
  for (const m of messages) {
    for (const p of m.parts) {
      if (p.type === "text") total += estimateTokens(p.text)
      else if (p.type === "tool") {
        total += estimateTokens(JSON.stringify(p.state.input ?? {}))
        total += estimateTokens(p.state.output ?? p.state.error ?? "")
      }
    }
  }
  return total
}

function callTokens(messages) {
  const map = new Map()
  for (const m of messages) {
    for (const p of m.parts) {
      if (p.type !== "tool") continue
      map.set(
        p.callID,
        estimateTokens(JSON.stringify(p.state.input ?? {})) + estimateTokens(p.state.output ?? ""),
      )
    }
  }
  return map
}

function actions(messages) {
  const seen = new Map()
  for (const m of messages) for (const p of m.parts) if (p.type === "tool") seen.set(p.callID, p)
  return SOURCE.flatMap((m) => m.tools.map((t) => t.callID)).map((id) => {
    const part = seen.get(id)
    if (!part) return "drop_call"

      ? "drop_result"
      : "keep"
  })
}

let requestCount = 0
const mock = createServer((req, res) => {
  let body = ""
  req.on("data", (chunk) => (body += chunk))
  req.on("end", () => {
    requestCount += 1
    const parsed = JSON.parse(body)
    const answers = {}
    for (const [name, question] of Object.entries(parsed.questions ?? {})) {
      if (question.type !== "noul") continue
      const index = Number(name.match(/_t(\d+)$/)?.[1] ?? "1") - 1
      const replay = REPLAY[index] ?? { keepCall: 1, keepResult: 1 }
      answers[name] = { noul: name.startsWith("call_") ? replay.keepCall : replay.keepResult }
    }
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ answers }))
  })
})

let baseUrl
if (!live) {
  await new Promise((resolve) => mock.listen(0, "127.0.0.1", resolve))
  baseUrl = `http://127.0.0.1:${mock.address().port}`
}

const home = mkdtempSync(join(tmpdir(), "fast-jev-savings-"))
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
  preserveRecentMessages: 6,
  keepThreshold: 0.5,
  truncateHeadChars: 300,
  minResultChars: 0,
  rejudgeAfterMs: 600000,
  timeoutMs: 60000,
  log: true,
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
const logs = []
const hooks = await plugin({
  client: { app: { log: async ({ body }) => logs.push(body) } },
  directory: home,
  worktree: home,
})
const transform = hooks["experimental.chat.messages.transform"]

const baseline = requestTokens(opencodeMessages(SOURCE))

console.log(`\nmode: ${live ? "live (real TypeSafe Jev)" : "offline (stubbed Jev answers)"}`)
console.log(`task: ${TASK}\n`)
console.log(`transcript     ${SOURCE.length} messages, 6 tool calls`)
console.log(`without Jev    ${baseline} tokens\n`)

let defaultDetail = null
console.log("with Jev, by keepThreshold:")
console.log("  threshold   tokens   saved     actions")
for (const threshold of THRESHOLDS) {
  writeCfg({ keepThreshold: threshold })
  const messages = opencodeMessages(SOURCE)
  const beforeCalls = callTokens(messages)
  await transform({}, { messages })
  const after = requestTokens(messages)
  const afterCalls = callTokens(messages)
  const list = actions(messages)
  const counts = {
    keep: list.filter((a) => a === "keep").length,
    drop_result: list.filter((a) => a === "drop_result").length,
    drop_call: list.filter((a) => a === "drop_call").length,
  }
  const saving = (((baseline - after) / baseline) * 100).toFixed(1)
  console.log(
    `  ${threshold.toFixed(2)}        ${String(after).padStart(5)}    -${saving.padStart(5)}%   ` +
      `keep=${counts.keep} drop_result=${counts.drop_result} drop_call=${counts.drop_call}`,
  )
  if (defaultDetail === null) {
    defaultDetail = { beforeCalls, afterCalls, list }
  }
}

console.log("\nper call (keepThreshold 0.50):")
const { beforeCalls, afterCalls, list } = defaultDetail
SOURCE.forEach((m, index) => {
  m.tools.forEach((t, toolIndex) => {
    const position = SOURCE.slice(0, index).reduce((sum, s) => sum + s.tools.length, 0) + toolIndex
    const was = beforeCalls.get(t.callID) ?? 0
    const now = afterCalls.get(t.callID) ?? 0
    console.log(
      `  ${`${t.callID} ${t.tool}`.padEnd(12)} ${list[position].padEnd(12)} ${String(was - now).padStart(4)} tokens saved`,
    )
  })
})

console.log(`\njev requests   ${requestCount} (answers cached across thresholds)`)
for (const entry of logs) {
  console.log(
    `log [${entry.level}] ${entry.message}`,
    entry.extra ? JSON.stringify(entry.extra) : "",
  )
}
console.log(
  "\nnote: tokens are estimated with the same estimator the plugin uses to plan requests, not provider-billed tokens\n",
)

if (!live) await new Promise((resolve) => mock.close(resolve))
rmSync(home, { recursive: true, force: true })
