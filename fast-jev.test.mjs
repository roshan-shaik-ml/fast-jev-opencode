import { createServer } from "node:http"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

const home = mkdtempSync(join(tmpdir(), "fast-jev-test-"))
mkdirSync(join(home, ".config", "opencode"), { recursive: true })
process.env.USERPROFILE = home
process.env.HOME = home
process.env.TYPESAFE_API_KEY = "test-key"

let answerer = () => 1
let requestCount = 0

const server = createServer((req, res) => {
  let body = ""
  req.on("data", (chunk) => (body += chunk))
  req.on("end", () => {
    requestCount += 1
    const parsed = JSON.parse(body)
    const answers = {}
    for (const [name, question] of Object.entries(parsed.questions ?? {})) {
      const p = answerer(name, question.type)
      if (question.type === "noul") answers[name] = { noul: p }
    }
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ answers }))
  })
})

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
const port = server.address().port

const baseCfg = {
  enabled: true,
  dryRun: false,
  provider: "custom",
  baseUrl: `http://127.0.0.1:${port}`,
  apiKeyEnv: "TYPESAFE_API_KEY",
  preserveRecentMessages: 6,
  minResultChars: 0,
  rejudgeAfterMs: 600000,
  truncateHeadChars: 300,
  timeoutMs: 30000,
  log: false,
}

function writeCfg(overrides = {}) {
  writeFileSync(
    join(home, ".config", "opencode", "fast-jev.json"),
    JSON.stringify({ ...baseCfg, ...overrides }),
  )
}

writeCfg()

const pluginUrl = pathToFileURL(join(process.cwd(), "plugins", "fast-jev.ts")).href
const mod = await import(pluginUrl)
const plugin = mod.default
if (typeof plugin !== "function") throw new Error("default export is not a plugin function")

const hooks = await plugin({
  client: { app: { log: async () => {} } },
  directory: home,
  worktree: home,
})
const transform = hooks["experimental.chat.messages.transform"]
if (typeof transform !== "function") throw new Error("transform hook not registered")

function tool(callID, name, output, status = "completed") {
  const state =
    status === "error"
      ? { status, input: { q: callID }, error: output, time: { start: 1, end: 2 } }
      : { status, input: { q: callID }, output, title: "", metadata: {}, time: { start: 1, end: 2 } }
  return { id: `${callID}-p`, sessionID: "s", messageID: "m", type: "tool", callID, tool: name, state }
}
const text = (value) => ({ id: `t${Math.random()}`, sessionID: "s", messageID: "m", type: "text", text: value })
const message = (role, parts) => ({ info: { id: `m${Math.random()}`, sessionID: "s", role }, parts })
const BIG = "X".repeat(5000)

function fixture(tag) {
  return [
    message("user", [text("Fix the failing test. Never edit src/generated.")]),
    message("assistant", [tool(`${tag}-1`, "read", BIG)]),
    message("assistant", [tool(`${tag}-2`, "bash", BIG)]),
    message("assistant", [text("found it"), tool(`${tag}-3`, "write", BIG)]),
    message("user", [text("ok continue")]),
    message("assistant", [text("step 5")]),
    message("user", [text("step 6")]),
    message("assistant", [text("step 7")]),
    message("user", [text("step 8")]),
    message("assistant", [text("step 9")]),
  ]
}

let failures = 0
function check(name, condition, detail = "") {
  if (condition) console.log(`  ok   ${name}`)
  else {
    failures += 1
    console.log(`  FAIL ${name} ${detail}`)
  }
}

async function run(label, fn) {
  console.log(`\n[${label}]`)
  answerer = fn
  const messages = fixture(label)
  await transform({}, { messages })
  return messages
}

const kept = await run("keep", () => 1)
check("keep: message count unchanged", kept.length === 10, `got ${kept.length}`)
check(
  "keep: tool outputs untouched",
  kept[1].parts[0].state.output.length === 5000 && kept[2].parts[0].state.output.length === 5000,
)

const dropped = await run("dropcall", () => 0)
check("drop_call: message count reduced to 8", dropped.length === 8, `got ${dropped.length}`)
check(
  "drop_call: no tool parts remain",
  dropped.every((m) => m.parts.every((p) => p.type !== "tool")),
)
check(
  "drop_call: text-only sibling survives",
  dropped.some((m) => m.parts.some((p) => p.type === "text" && p.text === "found it")),
)

const truncated = await run("dropresult", (name) => (name.startsWith("call_") ? 0.9 : 0.1))
const tools = truncated.flatMap((m) => m.parts).filter((p) => p.type === "tool")
check("drop_result: tool parts kept", tools.length === 3, `got ${tools.length}`)
check(
  "drop_result: outputs truncated with note",
  tools.every((p) => p.state.output.includes("fast-jev truncated")),
)
check(
  "drop_result: head preserved",
  tools.every((p) => p.state.output.startsWith("X".repeat(300))),
)
check("drop_result: message count unchanged", truncated.length === 10, `got ${truncated.length}`)
check(
  "drop_result: does not set time.compacted",
  tools.every((p) => p.state.time.compacted === undefined),
)

console.log("\n[error result]")
answerer = (name) => (name.startsWith("call_") ? 0.9 : 0.1)
const errMessages = fixture("err")
errMessages[1] = message("assistant", [tool("err-1", "bash", BIG, "error")])
await transform({}, { messages: errMessages })
const errTool = errMessages
  .flatMap((m) => m.parts)
  .find((p) => p.type === "tool" && p.callID === "err-1")
check(
  "error result: truncated with (error) note",
  errTool.state.error.includes("fast-jev truncated") && errTool.state.error.includes("(error)"),
)

console.log("\n[cache]")
answerer = () => 1
requestCount = 0
const cachedMessages = fixture("cache")
await transform({}, { messages: cachedMessages })
await transform({}, { messages: cachedMessages })
check("cache: second request reuses decisions", requestCount === 1, `got ${requestCount}`)

console.log("\n[rejudgeAfterMs 0]")
writeCfg({ rejudgeAfterMs: 0 })
answerer = () => 1
requestCount = 0
const rejudged = fixture("rejudge")
await transform({}, { messages: rejudged })
await transform({}, { messages: rejudged })
check("rejudgeAfterMs 0: re-scores every request", requestCount === 2, `got ${requestCount}`)
writeCfg({ rejudgeAfterMs: 600000 })

console.log("\n[dryRun]")
writeCfg({ dryRun: true })
answerer = () => 0
requestCount = 0
const dry = fixture("dry")
const dryBefore = JSON.stringify(dry)
await transform({}, { messages: dry })
check("dryRun: messages unchanged", JSON.stringify(dry) === dryBefore)
check("dryRun: still scored via Jev", requestCount > 0, `got ${requestCount}`)
writeCfg({ dryRun: false })

console.log("\n[timeout fail-open]")
const hang = createServer(() => {})
await new Promise((resolve) => hang.listen(0, "127.0.0.1", resolve))
writeCfg({ baseUrl: `http://127.0.0.1:${hang.address().port}`, timeoutMs: 500 })
const stuck = fixture("stuck")
const stuckBefore = JSON.stringify(stuck)
const started = Date.now()
await transform({}, { messages: stuck })
const elapsed = Date.now() - started
check("timeout: request untouched", JSON.stringify(stuck) === stuckBefore)
check("timeout: returns within 5s", elapsed < 5000, `took ${elapsed}ms`)
hang.closeAllConnections?.()
hang.close()
writeCfg({ baseUrl: `http://127.0.0.1:${port}`, timeoutMs: 30000 })

console.log("\n[no-key fail-open]")
delete process.env.TYPESAFE_API_KEY
const noKey = fixture("nokey")
const before = JSON.stringify(noKey)
await transform({}, { messages: noKey })
check("no key: request untouched", JSON.stringify(noKey) === before)

await new Promise((resolve) => server.close(resolve))
rmSync(home, { recursive: true, force: true })
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`)
process.exitCode = failures === 0 ? 0 : 1
