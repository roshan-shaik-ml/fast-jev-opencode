import { createServer } from "node:http"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { collectCalls } from "../src/engine/index.ts"
import { SOURCE, toTranscript, toV1Messages } from "./fixture.mjs"

const PRESERVE = 6
const TRUNCATE_HEAD = 300
const TOKEN = /[A-Za-z0-9_./-]{6,}/g

function salientTokens(text) {
  const out = new Set()
  for (const match of text.matchAll(TOKEN)) out.add(match[0].toLowerCase())
  return out
}

function laterText(index) {
  const parts = []
  for (let i = index + 1; i < SOURCE.length; i++) {
    parts.push(SOURCE[i].text)
    for (const tool of SOURCE[i].tools) parts.push(JSON.stringify(tool.input))
  }
  return parts.join("\n").toLowerCase()
}

// Which tool outputs hold something the session later referred to, and where.
const needed = []
SOURCE.forEach((message, index) => {
  for (const tool of message.tools) {
    const later = laterText(index)
    const tokens = [...salientTokens(tool.output)].filter((token) => later.includes(token))
    if (tokens.length > 0) needed.push({ callID: tool.callID, tokens, output: tool.output })
  }
})
const neededIDs = new Set(needed.map((entry) => entry.callID))
const totalNeededTokens = needed.reduce((sum, entry) => sum + entry.tokens.length, 0)

function probability(name) {
  const slot = Number(name.match(/_(\d+)$/)?.[1] ?? "1")
  const bucket = slot % 3
  if (name.startsWith("call_")) return bucket === 2 ? 0.2 : 0.9
  return bucket === 0 ? 0.9 : 0.2
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
      if (question.type === "noul") answers[name] = { noul: probability(name) }
    }
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ answers }))
  })
})
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))

const home = mkdtempSync(join(tmpdir(), "fast-jev-baseline-"))
const cfgPath = join(home, "fast-jev.json")
process.env.FAST_JEV_CONFIG = cfgPath
process.env.FAST_JEV_ENV = join(home, ".env")
process.env.TYPESAFE_API_KEY = "bench-offline-key"
writeFileSync(
  cfgPath,
  JSON.stringify({
    enabled: true,
    dryRun: false,
    provider: "custom",
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    apiKeyEnv: "TYPESAFE_API_KEY",
    preserveRecentMessages: PRESERVE,
    minResultChars: 0,
    truncateHeadChars: TRUNCATE_HEAD,
    minScored: 1000,
    log: false,
  }),
)

const { default: plugin } = await import(pathToFileURL(join(process.cwd(), "src", "v1.ts")).href)
const hooks = await plugin({ client: { app: { log: async () => {} } } })
const transform = hooks["experimental.chat.messages.transform"]

const messages = toV1Messages(SOURCE)
await transform({}, { messages })

const retainedByCall = new Map()
for (const message of messages) {
  for (const part of message.parts) {
    if (part.type !== "tool") continue
    retainedByCall.set(part.callID, part.state.output ?? part.state.error ?? "")
  }
}
const oursRetained = retainedByCall

const transcript = toTranscript(SOURCE)
const calls = collectCalls(transcript, PRESERVE)
const eligible = calls.filter((call) => !call.pinned)
const originalPool = eligible.reduce((sum, call) => sum + call.resultChars, 0)
const oursPool = eligible.reduce((sum, call) => sum + (oursRetained.get(call.id) ?? "").length, 0)

// Head+tail gets the same budget, spread evenly across the same calls.
const fraction = originalPool === 0 ? 1 : Math.min(1, oursPool / originalPool)
const baselineRetained = new Map()
for (const call of eligible) {
  const source = SOURCE.flatMap((message) => message.tools).find((tool) => tool.callID === call.id)
  const text = source?.output ?? ""
  const keep = Math.max(0, Math.floor(fraction * text.length))
  if (keep >= text.length) {
    baselineRetained.set(call.id, text)
    continue
  }
  const head = Math.ceil(keep * 0.6)
  const tail = keep - head
  baselineRetained.set(call.id, `${text.slice(0, head)}${text.slice(text.length - tail)}`)
}

function score(table) {
  let callsIntact = 0
  let tokensKept = 0
  for (const entry of needed) {
    const retained = (table.get(entry.callID) ?? "").toLowerCase()
    const kept = entry.tokens.filter((token) => retained.includes(token)).length
    tokensKept += kept
    if (kept === entry.tokens.length) callsIntact += 1
  }
  return { callsIntact, tokensKept }
}

const ours = score(oursRetained)
const baseline = score(baselineRetained)

console.log("\nmode: offline (stubbed Jev answers)")
console.log(
  `transcript: ${SOURCE.length} messages, ${calls.length} calls, ${eligible.length} eligible` +
    ` | ${needed.length} hold something referred to later (${totalNeededTokens} evidence tokens)\n`,
)
console.log(`pool        original ${originalPool} chars`)
console.log(`            ours      ${oursPool} chars`)
console.log(
  `            baseline  ${eligible.reduce((sum, c) => sum + (baselineRetained.get(c.id) ?? "").length, 0)} chars  (equalised at ${(fraction * 100).toFixed(1)}%)\n`,
)
console.log(`            needed calls intact   evidence tokens kept`)
console.log(
  `ours           ${String(ours.callsIntact).padStart(2)}/${needed.length}                  ${String(ours.tokensKept).padStart(3)}/${totalNeededTokens}`,
)
console.log(
  `head+tail      ${String(baseline.callsIntact).padStart(2)}/${needed.length}                  ${String(baseline.tokensKept).padStart(3)}/${totalNeededTokens}`,
)

if (fraction >= 1) {
  console.log("\nnote: Jev kept everything here, so head+tail had nothing to prove.")
} else if (ours.tokensKept > baseline.tokensKept) {
  console.log("\nRESULT: Jev keeps more of what the session later used, at the same size.")
} else if (ours.tokensKept < baseline.tokensKept) {
  console.log(
    "\nRESULT: plain head+tail keeps MORE evidence at the same size - selection adds nothing here.",
  )
} else {
  console.log("\nRESULT: tied on evidence at the same size.")
}
console.log(`\njev requests ${requestCount}\n`)

await new Promise((resolve) => server.close(resolve))
rmSync(home, { recursive: true, force: true })
