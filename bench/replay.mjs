import { DatabaseSync } from "node:sqlite"
import { createServer } from "node:http"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { collectCalls, prefilter } from "../src/engine/index.ts"

const args = process.argv.slice(2)
const argOf = (name) => {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args[index + 1]
}
const DB = "C:/Users/Shaik faizan/.local/share/opencode/opencode.db"
const PRESERVE = 6
const MAX_MESSAGES = Number(argOf("--messages") ?? 400)
const HOW_MANY = Number(argOf("--all") ?? 1)

const db = new DatabaseSync(DB, { readOnly: true })
const sessionIDs = db
  .prepare(
    `SELECT id FROM session WHERE parent_id IS NULL
     ORDER BY (tokens_input + tokens_cache_read) DESC LIMIT ?`,
  )
  .all(HOW_MANY)
  .map((row) => row.id)

const textOf = (message) =>
  message.parts
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
const partsOf = (message) => message.parts.filter((part) => part.type === "tool" && part.callID)
const outputOf = (part) => String(part.state?.output ?? part.state?.error ?? "")
const inputCharsOf = (part) => {
  try {
    return JSON.stringify(part.state?.input ?? {}).length
  } catch {
    return 20
  }
}

function charsOf(list) {
  let total = 0
  for (const message of list) {
    total += textOf(message).length
    for (const part of partsOf(message)) total += outputOf(part).length + inputCharsOf(part)
  }
  return total
}

function loadMessages(sessionId) {
  const rows = db
    .prepare(
      `SELECT m.id AS message_id, m.data AS message_data, p.data AS part_data
       FROM message m LEFT JOIN part p ON p.message_id = m.id
       WHERE m.session_id = ?
       ORDER BY m.time_created, m.rowid, p.rowid`,
    )
    .all(sessionId)
  const byMessage = new Map()
  for (const row of rows) {
    if (!byMessage.has(row.message_id)) {
      const data = JSON.parse(row.message_data)
      byMessage.set(row.message_id, { info: { id: row.message_id, role: data.role }, parts: [] })
    }
    if (row.part_data) byMessage.get(row.message_id).parts.push(JSON.parse(row.part_data))
  }
  let messages = [...byMessage.values()].filter((message) => message.parts.length > 0)
  if (messages.length > MAX_MESSAGES) messages = messages.slice(-MAX_MESSAGES)
  return messages
}

function probability(name) {
  const slot = Number(name.match(/_(\d+)$/)?.[1] ?? "1")
  const bucket = slot % 3
  if (name.startsWith("call_")) return bucket === 2 ? 0.2 : 0.9
  return bucket === 0 ? 0.9 : 0.2
}

let requests = 0
const server = createServer((req, res) => {
  let body = ""
  req.on("data", (chunk) => (body += chunk))
  req.on("end", () => {
    requests += 1
    const parsed = JSON.parse(body)
    const answers = {}
    for (const name of Object.keys(parsed.questions ?? {}))
      answers[name] = { noul: probability(name) }
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ answers }))
  })
})
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))

const home = mkdtempSync(join(tmpdir(), "fast-jev-replay-"))
const cfgPath = join(home, "fast-jev.json")
process.env.FAST_JEV_CONFIG = cfgPath
process.env.FAST_JEV_ENV = join(home, ".env")
process.env.TYPESAFE_API_KEY = "replay-offline-key"

const base = {
  enabled: true,
  dryRun: false,
  provider: "custom",
  baseUrl: `http://127.0.0.1:${server.address().port}`,
  apiKeyEnv: "TYPESAFE_API_KEY",
  preserveRecentMessages: PRESERVE,
  minScored: 1000,
  rejudgeAfterMs: 0,
  log: false,
}

const SAFE = {
  minResultChars: 2000,
  truncateHeadChars: 300,
  keepCallThreshold: 0.5,
  keepResultThreshold: 0.25,
  removedCallStyle: "stub",
  rules: { duplicate: true, superseded: false, resolved: true },
}
const AGGRESSIVE = {
  minResultChars: 0,
  truncateHeadChars: 300,
  keepCallThreshold: 0.5,
  keepResultThreshold: 0.25,
  removedCallStyle: "delete",
  rules: { duplicate: true, superseded: true, resolved: true },
}

const { default: plugin } = await import(pathToFileURL(join(process.cwd(), "src", "v1.ts")).href)
const hooks = await plugin({ client: { app: { log: async () => {} } } })
const transform = hooks["experimental.chat.messages.transform"]

async function measure(messages, cfg) {
  writeFileSync(cfgPath, JSON.stringify({ ...base, ...cfg }))
  const before = charsOf(messages)
  requests = 0
  await transform({}, { messages })
  const after = charsOf(messages)
  return { saved: before === 0 ? 0 : ((before - after) / before) * 100, requests }
}

console.log("")
console.log(
  "                title                              msgs  calls     sizes saved  jev | aggressive saved  jev",
)
console.log(
  "                                                                              | ours (safe defaults)     ",
)
const rows = []
for (const sessionId of sessionIDs) {
  const session = db
    .prepare(`SELECT title, tokens_input, tokens_cache_read FROM session WHERE id = ?`)
    .get(sessionId)
  const messages = loadMessages(sessionId)
  const transcript = messages.map((message) => ({
    role: message.info.role === "assistant" ? "assistant" : "user",
    text: textOf(message),
    toolUses: partsOf(message).map((part) => ({
      id: part.callID,
      name: part.tool,
      input: part.state?.input ?? {},
    })),
    toolResults: partsOf(message).map((part) => ({
      id: part.callID,
      text: outputOf(part),
      isError: part.state?.status === "error",
    })),
  }))
  const calls = collectCalls(transcript, PRESERVE).filter((call) => !call.pinned)
  const size = charsOf(messages)
  const safe = await measure(loadMessages(sessionId), SAFE)
  const aggressive = await measure(loadMessages(sessionId), AGGRESSIVE)
  const title = String(session.title ?? "").slice(0, 34)
  console.log(
    `${title.padEnd(36)}${String(messages.length).padStart(5)}${String(calls.length).padStart(6)}${String(size).padStart(10)}${(safe.saved.toFixed(1) + "%").padStart(7)}${String(safe.requests).padStart(5)} |${(aggressive.saved.toFixed(1) + "%").padStart(9)}${String(aggressive.requests).padStart(5)}`,
  )
  rows.push({
    safe: safe.saved,
    aggressive: aggressive.saved,
    cacheRead: session.tokens_cache_read,
    input: session.tokens_input,
  })
}

if (rows.length > 1) {
  const avg = (key) => (rows.reduce((sum, row) => sum + row[key], 0) / rows.length).toFixed(1)
  console.log(
    "".padEnd(36) +
      " ".padStart(5) +
      " ".padStart(6) +
      "".padStart(10) +
      `${avg("safe")}%`.padStart(7) +
      " ".padStart(4) +
      " |" +
      `${avg("aggressive")}%`.padStart(9),
  )
  const cache = rows.reduce((sum, row) => sum + row.cacheRead, 0)
  const input = rows.reduce((sum, row) => sum + row.input, 0)
  console.log("")
  console.log(
    `across ${rows.length} sessions: cache read / input = ${(cache / Math.max(1, input)).toFixed(1)}x`,
  )
}
console.log("")

await new Promise((resolve) => server.close(resolve))
rmSync(home, { recursive: true, force: true })
