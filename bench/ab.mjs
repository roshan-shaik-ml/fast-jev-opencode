import { DatabaseSync } from "node:sqlite"
import { createServer } from "node:http"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { collectCalls } from "../src/engine/index.ts"

const args = process.argv.slice(2)
const argOf = (name) => {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args[index + 1]
}
const KEY = process.env.TYPESAFE_API_KEY
if (!KEY) {
  console.error("A/B needs TYPESAFE_API_KEY in the environment (it makes real Jev requests).")
  process.exit(1)
}

const DB = process.env.OPENCODE_DB ?? join(homedir(), ".local/share/opencode/opencode.db")
const ENDPOINT = "https://api.typesafe.ai/v1/systemone"
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
    `SELECT m.id AS message_id, m.data AS message_data, p.data AS part_data
     FROM message m LEFT JOIN part p ON p.message_id = m.id
     WHERE m.session_id = ?
     ORDER BY m.time_created, m.rowid, p.rowid`,
  )
  .all(sessionId)

function loadMessages() {
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
const charsOf = (list) =>
  list.reduce(
    (sum, message) =>
      sum +
      textOf(message).length +
      partsOf(message).reduce(
        (inner, part) => inner + outputOf(part).length + inputCharsOf(part),
        0,
      ),
    0,
  )

const template = loadMessages()
const transcript = template.map((message) => ({
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

// Evidence the session referred to later, per call.
const chunks = []
const offsets = []
let cursor = 0
for (const message of template) {
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

const calls = collectCalls(transcript, PRESERVE).filter((call) => !call.pinned)
const needed = []
for (const call of calls) {
  const from = offsets[call.messageIndex + 1] ?? haystack.length
  const tokens = []
  for (const match of call.resultText.matchAll(TOKEN)) {
    if (tokens.length >= 200) break
    const token = match[0].toLowerCase()
    if (!tokens.includes(token) && haystack.indexOf(token, from) !== -1) tokens.push(token)
  }
  if (tokens.length > 0) needed.push({ id: call.id, tokens })
}

const recorded = []
const proxy = createServer((req, res) => {
  let body = ""
  req.on("data", (chunk) => (body += chunk))
  req.on("end", async () => {
    try {
      const upstream = await fetch(ENDPOINT, {
        method: "POST",
        headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
        body,
      })
      const text = await upstream.text()
      try {
        recorded.push({ questions: JSON.parse(body).questions, answers: JSON.parse(text).answers })
      } catch {
        /* keep going; the plugin reports transport problems itself */
      }
      res.writeHead(upstream.status, { "content-type": "application/json" })
      res.end(text)
    } catch (error) {
      res.writeHead(502, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: String(error) }))
    }
  })
})
await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve))

const home = mkdtempSync(join(tmpdir(), "fast-jev-ab-"))
const cfgPath = join(home, "fast-jev.json")
process.env.FAST_JEV_CONFIG = cfgPath
process.env.FAST_JEV_ENV = join(home, ".env")

const base = {
  enabled: true,
  dryRun: false,
  provider: "custom",
  baseUrl: `http://127.0.0.1:${proxy.address().port}`,
  apiKey: KEY,
  preserveRecentMessages: PRESERVE,
  minResultChars: 2000,
  truncateHeadChars: 300,
  keepCallThreshold: 0.5,
  keepResultThreshold: 0.25,
  removedCallStyle: "stub",
  rejudgeAfterMs: 0,
  minScored: 1000,
  timeoutMs: 120000,
  log: false,
}

const { default: plugin } = await import(pathToFileURL(join(process.cwd(), "src", "v1.ts")).href)
const hooks = await plugin({ client: { app: { log: async () => {} } } })
const transform = hooks["experimental.chat.messages.transform"]

function retention(messages) {
  let callIntact = 0
  let tokensKept = 0
  let tokensTotal = 0
  for (const entry of needed) {
    const part = messages.flatMap((m) => partsOf(m)).find((p) => p.callID === entry.id)
    const text = (part ? outputOf(part) : "").toLowerCase()
    const kept = entry.tokens.filter((token) => text.includes(token)).length
    tokensKept += kept
    tokensTotal += entry.tokens.length
    if (kept === entry.tokens.length) callIntact += 1
  }
  return { callIntact, tokensKept, tokensTotal }
}

console.log("")
console.log(`session   ${session.title} (${sessionId.slice(0, 20)})`)
console.log(
  `messages  ${template.length} | eligible calls ${calls.length} | evidence-bearing calls ${needed.length}`,
)
console.log("")

const arms = [
  {
    name: "noul   0.50/0.25",
    questionStyle: "noul",
    keepCallThreshold: 0.5,
    keepResultThreshold: 0.25,
  },
  {
    name: "choice 0.50/0.25",
    questionStyle: "choice",
    keepCallThreshold: 0.5,
    keepResultThreshold: 0.25,
  },
  {
    name: "noul   0.25/0.15",
    questionStyle: "noul",
    keepCallThreshold: 0.25,
    keepResultThreshold: 0.15,
  },
  {
    name: "choice 0.25/0.15",
    questionStyle: "choice",
    keepCallThreshold: 0.25,
    keepResultThreshold: 0.15,
  },
]

const results = []
for (const arm of arms) {
  writeFileSync(cfgPath, JSON.stringify({ ...base, ...arm }))
  const messages = loadMessages()
  const before = charsOf(messages)
  recorded.length = 0
  const started = Date.now()
  await transform({}, { messages })
  const after = charsOf(messages)
  const kept = retention(messages)
  results.push({
    name: arm.name,
    saved: ((before - after) / before) * 100,
    requests: recorded.length,
    ms: Date.now() - started,
    ...kept,
    recorded: [...recorded],
  })
}

console.log("arm                saved  requests     ms   needed calls   evidence kept")
for (const result of results) {
  console.log(
    `${result.name.padEnd(18)}${(result.saved.toFixed(1) + "%").padStart(6)}${String(result.requests).padStart(10)}${String(result.ms).padStart(7)}   ${String(result.callIntact).padStart(4)}/${needed.length}      ${String(result.tokensKept).padStart(4)}/${result.tokensTotal}  (${((result.tokensKept / result.tokensTotal) * 100).toFixed(0)}%)`,
  )
}

console.log("")
for (const result of results) {
  const values = []
  for (const call of result.recorded) {
    for (const [name, answer] of Object.entries(call.answers ?? {})) {
      if (typeof answer.noul === "number")
        values.push({
          name,
          key: name.startsWith("result_") ? "result noul" : "call noul",
          value: answer.noul,
        })
      for (const [option, probability] of Object.entries(answer.probabilities ?? {})) {
        values.push({ name, key: `choice ${option}`, value: probability })
      }
    }
  }
  const groups = new Map()
  for (const entry of values) {
    const list = groups.get(entry.key) ?? []
    list.push(entry.value)
    groups.set(entry.key, list)
  }
  console.log(`--- ${result.name}: observed answer distributions (n=${values.length}) ---`)
  for (const [key, list] of groups) {
    const sorted = [...list].sort((a, b) => a - b)
    const mean = list.reduce((sum, value) => sum + value, 0) / list.length
    const median = sorted[Math.floor(sorted.length / 2)]
    const above = (threshold) =>
      ((list.filter((value) => value >= threshold).length / list.length) * 100).toFixed(0)
    console.log(
      `  ${key.padEnd(16)} mean ${mean.toFixed(3)}  median ${median.toFixed(3)}  min ${sorted[0].toFixed(3)}  max ${sorted[sorted.length - 1].toFixed(3)}  >=0.5: ${above(0.5)}%  >=0.25: ${above(0.25)}%`,
    )
  }
}

console.log("")
await new Promise((resolve) => proxy.close(resolve))
rmSync(home, { recursive: true, force: true })
