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

function buildMessages() {
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
      total += outputOf(part).length
    }
  }
  return total
}

const template = buildMessages()
const textChars = template.reduce((sum, message) => sum + textOf(message).length, 0)
const inputChars = template.reduce(
  (sum, message) =>
    sum +
    partsOf(message).reduce((inner, part) => {
      try {
        return inner + JSON.stringify(part.state?.input ?? {}).length
      } catch {
        return inner + 20
      }
    }, 0),
  0,
)
const outputChars = template.reduce(
  (sum, message) =>
    sum + partsOf(message).reduce((inner, part) => inner + outputOf(part).length, 0),
  0,
)
const callChars = inputChars + outputChars
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
const calls = collectCalls(transcript, PRESERVE)
const eligible = calls.filter((call) => !call.pinned)
const ruleHits = prefilter(calls, { duplicate: true, superseded: true, resolved: true })
const byReason = new Map()
for (const reason of ruleHits.values()) byReason.set(reason, (byReason.get(reason) ?? 0) + 1)

console.log("")
console.log(`session      ${session.title}`)
console.log(`messages     ${template.length} (last ${MAX_MESSAGES} of the session)`)
console.log(
  `chars        ${charsOf(template)} total = ${textChars} prose + ${inputChars} tool inputs + ${outputChars} tool outputs`,
)
console.log(`tool calls   ${calls.length} total, ${eligible.length} eligible`)
console.log(
  `             ${eligible.filter((c) => c.resultChars >= 2000).length} eligible with output >= 2000 chars`,
)
console.log(
  `             ${eligible.reduce((sum, c) => sum + c.resultChars, 0)} chars of output in those calls`,
)
console.log(
  `rules        ${ruleHits.size} calls provable without Jev  (${[...byReason].map(([r, n]) => `${r}:${n}`).join(", ") || "none"})`,
)

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
process.env.FAST_KEV_CONFIG = cfgPath
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

const { default: plugin } = await import(pathToFileURL(join(process.cwd(), "src", "v1.ts")).href)
const hooks = await plugin({ client: { app: { log: async () => {} } } })
const transform = hooks["experimental.chat.messages.transform"]

const scenarios = [
  {
    name: "ours (safe defaults)",
    cfg: {
      minResultChars: 2000,
      truncateHeadChars: 300,
      keepCallThreshold: 0.5,
      keepResultThreshold: 0.25,
      removedCallStyle: "stub",
      rules: { duplicate: true, superseded: false, resolved: true },
    },
  },
  {
    name: "theirs (drop everything)",
    cfg: {
      minResultChars: 0,
      truncateHeadChars: 120,
      keepThreshold: 0.5,
      removedCallStyle: "delete",
      rules: { duplicate: false, superseded: false, resolved: false },
    },
  },
  {
    name: "aggressive but sane",
    cfg: {
      minResultChars: 0,
      truncateHeadChars: 300,
      keepCallThreshold: 0.5,
      keepResultThreshold: 0.25,
      removedCallStyle: "delete",
      rules: { duplicate: true, superseded: true, resolved: true },
    },
  },
]

console.log("")
console.log("                chars before      after     saved   jev   cleared  shortened  kept")
for (const scenario of scenarios) {
  writeFileSync(cfgPath, JSON.stringify({ ...base, ...scenario.cfg }))
  const messages = buildMessages()
  const before = charsOf(messages)
  requests = 0
  await transform({}, { messages })
  const after = charsOf(messages)

  let cleared = 0
  let shortened = 0
  let kept = 0
  for (const message of messages) {
    for (const part of partsOf(message)) {
      const output = outputOf(part)
      if (output.includes("fast-jev cleared")) cleared += 1
      else if (output.includes("fast-jev pruned")) shortened += 1
      else kept += 1
    }
  }
  const saved = (((before - after) / before) * 100).toFixed(1)
  console.log(
    `${scenario.name.padEnd(24)} ${String(before).padStart(9)} ${String(after).padStart(10)} ${(saved + "%").padStart(8)} ${String(requests).padStart(4)} ${String(cleared).padStart(8)} ${String(shortened).padStart(10)} ${String(kept).padStart(5)}`,
  )
}

console.log("")
console.log("this session, as the provider saw it:")
console.log(
  `  input ${session.tokens_input.toLocaleString()} | cache read ${session.tokens_cache_read.toLocaleString()} (${(session.tokens_cache_read / Math.max(1, session.tokens_input)).toFixed(1)}x) | output ${session.tokens_output.toLocaleString()} | $${(session.cost ?? 0).toFixed(3)}`,
)
console.log("")

await new Promise((resolve) => server.close(resolve))
rmSync(home, { recursive: true, force: true })
