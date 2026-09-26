import { DatabaseSync } from "node:sqlite"
import { createServer } from "node:http"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

const args = process.argv.slice(2)
const argOf = (name) => {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args[index + 1]
}
const DB = "C:/Users/Shaik faizan/.local/share/opencode/opencode.db"
const PRESERVE = 6
const MAX_MESSAGES = Number(argOf("--messages") ?? 400)
const TOKEN = /[A-Za-z0-9_./-]{8,}/g

const db = new DatabaseSync(DB, { readOnly: true })

const sessionId =
  argOf("--session") ??
  db
    .prepare(
      `SELECT id FROM session WHERE parent_id IS NULL
       ORDER BY (tokens_input + tokens_cache_read) DESC LIMIT 1`,
    )
    .get().id

const session = db.prepare(`SELECT * FROM session WHERE id = ?`).get(sessionId)
const rows = db
  .prepare(
    `SELECT m.id AS message_id, m.data AS message_data, p.data AS part_data, p.rowid AS seq
     FROM message m LEFT JOIN part p ON p.message_id = m.id
     WHERE m.session_id = ?
     ORDER BY m.time_created, m.rowid, p.rowid`,
  )
  .all(sessionId)

// Build OpenCode-shaped messages from the stored rows.
const byMessage = new Map()
for (const row of rows) {
  if (!byMessage.has(row.message_id)) {
    const data = JSON.parse(row.message_data)
    byMessage.set(row.message_id, { info: { id: row.message_id, role: data.role }, parts: [] })
  }
  if (row.part_data) byMessage.get(row.message_id).parts.push(JSON.parse(row.part_data))
}
let messages = [...byMessage.values()].filter((message) => message.parts.length > 0)
const skipped = Math.max(0, messages.length - MAX_MESSAGES)
if (skipped > 0) messages = messages.slice(-MAX_MESSAGES)

function textOf(message) {
  return message.parts
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
}
function partsOf(message) {
  return message.parts.filter((part) => part.type === "tool" && part.callID)
}

// One lowercased haystack, with each message's start offset, so "was this used
// later" is an indexOf rather than a copy per call.
const chunks = []
const offsets = []
let cursor = 0
for (const message of messages) {
  offsets.push(cursor)
  const chunk = [
    textOf(message),
    ...partsOf(message).map((p) => JSON.stringify(p.state?.input ?? {})),
  ]
    .join("\n")
    .toLowerCase()
  chunks.push(chunk)
  cursor += chunk.length + 1
}
const haystack = chunks.join("\n")

function charsOf(list) {
  let total = 0
  for (const message of list) {
    total += textOf(message).length
    for (const part of partsOf(message)) {
      try {
        total += JSON.stringify(part.state?.input ?? {}).length
      } catch {
        total += 20
      }
      total += (part.state?.output ?? part.state?.error ?? "").length
    }
  }
  return total
}

const calls = messages.flatMap((message, index) =>
  partsOf(message).map((part) => ({ message, index, part })),
)
const eligible = calls.filter((call) => call.index >= 0 && call.index < messages.length - PRESERVE)

const needed = []
for (const call of eligible) {
  const output = String(call.part.state?.output ?? call.part.state?.error ?? "")
  const from = offsets[call.index + 1] ?? haystack.length
  const tokens = []
  for (const match of output.matchAll(TOKEN)) {
    if (tokens.length >= 200) break
    const token = match[0].toLowerCase()
    if (!tokens.includes(token) && haystack.indexOf(token, from) !== -1) tokens.push(token)
  }
  if (tokens.length > 0) needed.push({ call, tokens, output })
}

let requestCount = 0
const server = createServer((req, res) => {
  let body = ""
  req.on("data", (chunk) => (body += chunk))
  req.on("end", () => {
    requestCount += 1
    const parsed = JSON.parse(body)
    const answers = {}
    for (const [name, question] of Object.entries(parsed.questions ?? {})) {
      if (question.type !== "noul") continue
      const slot = Number(name.match(/_(\d+)$/)?.[1] ?? "1")
      answers[name] = {
        noul: name.startsWith("call_") ? (slot % 3 === 2 ? 0.2 : 0.9) : slot % 3 === 1 ? 0.2 : 0.9,
      }
    }
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
writeFileSync(
  cfgPath,
  JSON.stringify({
    enabled: true,
    dryRun: false,
    provider: "custom",
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    apiKeyEnv: "TYPESAFE_API_KEY",
    preserveRecentMessages: PRESERVE,
    minResultChars: 2000,
    truncateHeadChars: 300,
    minScored: 1000,
    removedCallStyle: "stub",
    log: false,
  }),
)

const { default: plugin } = await import(pathToFileURL(join(process.cwd(), "src", "v1.ts")).href)
const hooks = await plugin({ client: { app: { log: async () => {} } } })
const transform = hooks["experimental.chat.messages.transform"]

const before = charsOf(messages)
const started = Date.now()
await transform({}, { messages })
const elapsed = Date.now() - started
const after = charsOf(messages)

function retainedText(call) {
  const part = call.message.parts.find((p) => p.callID === call.part.callID)
  return String(part?.state?.output ?? part?.state?.error ?? "")
}

const originalPool = eligible.reduce(
  (sum, call) => sum + String(call.part.state?.output ?? "").length,
  0,
)
const oursPool = eligible.reduce(
  (sum, call) =>
    sum +
    (call.message.parts.find((p) => p.callID === call.part.callID) ? retainedText(call).length : 0),
  0,
)
const fraction = originalPool === 0 ? 1 : Math.min(1, oursPool / originalPool)

const score = (table) => {
  let callIntact = 0
  let tokensKept = 0
  let tokensTotal = 0
  for (const entry of needed) {
    const text = (table(entry.call) ?? "").toLowerCase()
    const kept = entry.tokens.filter((token) => text.includes(token)).length
    tokensKept += kept
    tokensTotal += entry.tokens.length
    if (kept === entry.tokens.length) callIntact += 1
  }
  return { callIntact, tokensKept, tokensTotal }
}

const ours = score(retainedText)
const baseline = score((call) => {
  const text = String(call.part.state?.output ?? "")
  const keep = Math.max(0, Math.floor(fraction * text.length))
  if (keep >= text.length) return text
  const head = Math.ceil(keep * 0.6)
  const tail = keep - head
  return `${text.slice(0, head)}${text.slice(text.length - tail)}`
})

const pct = (a, b) => (a === 0 ? "0.0" : (((a - b) / a) * 100).toFixed(1))

console.log("")
console.log(`session      ${session.title} (${sessionId.slice(0, 20)})`)
console.log(
  `messages     ${messages.length}${skipped ? ` (last ${MAX_MESSAGES} of ${messages.length + skipped})` : ""}`,
)
console.log(`tool calls   ${calls.length} total, ${eligible.length} eligible`)
console.log(`chars        ${before} -> ${after}  (-${pct(before, after)}%)`)
console.log(`jev requests ${requestCount}   time ${elapsed} ms`)
console.log("")
console.log(`this session, as the provider saw it:`)
console.log(`  input        ${session.tokens_input.toLocaleString()}`)
console.log(
  `  cache read   ${session.tokens_cache_read.toLocaleString()}  (${(session.tokens_cache_read / Math.max(1, session.tokens_input)).toFixed(1)}x input)`,
)
console.log(`  cache write  ${session.tokens_cache_write.toLocaleString()}`)
console.log(`  output       ${session.tokens_output.toLocaleString()}`)
console.log(`  cost         $${(session.cost ?? 0).toFixed(3)}`)
console.log("")
console.log(`             needed calls intact   evidence tokens kept`)
console.log(
  `ours             ${String(ours.callIntact).padStart(3)}/${needed.length}                 ${String(ours.tokensKept).padStart(4)}/${ours.tokensTotal}`,
)
console.log(
  `head+tail        ${String(baseline.callIntact).padStart(3)}/${needed.length}                 ${String(baseline.tokensKept).padStart(4)}/${baseline.tokensTotal}`,
)
console.log("")

await new Promise((resolve) => server.close(resolve))
rmSync(home, { recursive: true, force: true })
