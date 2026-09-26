import { createServer } from "node:http"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

const home = mkdtempSync(join(tmpdir(), "fast-jev-v2-"))
const cfgPath = join(home, "fast-jev.json")
process.env.FAST_JEV_CONFIG = cfgPath
process.env.FAST_JEV_ENV = join(home, ".env")
process.env.TYPESAFE_API_KEY = "test-key"

let answerer = () => 1
let requestCount = 0
let lastModel = null

const server = createServer((req, res) => {
  let body = ""
  req.on("data", (chunk) => (body += chunk))
  req.on("end", () => {
    requestCount += 1
    const parsed = JSON.parse(body)
    lastModel = parsed.model
    const answers = {}
    for (const [name, question] of Object.entries(parsed.questions ?? {})) {
      const p = answerer(name, question.type)
      if (question.type === "noul" && typeof p === "number") answers[name] = { noul: p }
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
const writeCfg = (overrides = {}) =>
  writeFileSync(cfgPath, JSON.stringify({ ...baseCfg, ...overrides }))
writeCfg()

const mod = await import(pathToFileURL(join(process.cwd(), "src", "index.ts")).href)
const definition = mod.default

let failures = 0
function check(name, condition, detail = "") {
  if (condition) console.log(`  ok   ${name}`)
  else {
    failures += 1
    console.log(`  FAIL ${name} ${detail}`)
  }
}

console.log("[dual export shape]")
check("v2: default carries an id", definition.id === "fast-jev", `got ${definition.id}`)
check("v2: setup is registered", typeof definition.setup === "function")
check("v1: server() is exposed", typeof definition.server === "function")
const v1Hooks = await definition.server({ client: { app: { log: async () => {} } } })
check(
  "v1: server() returns the v1 hook",
  typeof v1Hooks["experimental.chat.messages.transform"] === "function",
)

let hook = null
const ctx = {
  session: {
    hook: async (name, callback) => {
      hook = { name, callback }
      return { dispose: async () => {} }
    },
  },
  app: { log: async () => {} },
}
await definition.setup(ctx)
check("v2: registers the context hook", hook?.name === "context")
const transform = hook.callback

const toolPart = (callID, name, output, status = "completed") => ({
  type: "tool",
  id: callID,
  name,
  state:
    status === "error"
      ? { status, input: { q: callID }, error: { type: "error", message: output } }
      : { status, input: { q: callID }, content: [{ type: "text", text: output }], metadata: {} },
})
const textPart = (value) => ({ type: "text", text: value })
const BIG = "X".repeat(5000)

function fixture(tag) {
  return [
    { type: "user", id: `${tag}-m0`, text: "Fix the failing test. Never edit src/generated." },
    { type: "assistant", id: `${tag}-m1`, content: [toolPart(`${tag}-1`, "read", BIG)] },
    { type: "assistant", id: `${tag}-m2`, content: [toolPart(`${tag}-2`, "bash", BIG)] },
    {
      type: "assistant",
      id: `${tag}-m3`,
      content: [textPart("found it"), toolPart(`${tag}-3`, "write", BIG)],
    },
    { type: "user", id: `${tag}-m4`, text: "ok continue" },
    { type: "assistant", id: `${tag}-m5`, content: [textPart("step 5")] },
    { type: "user", id: `${tag}-m6`, text: "step 6" },
    { type: "assistant", id: `${tag}-m7`, content: [textPart("step 7")] },
    { type: "user", id: `${tag}-m8`, text: "step 8" },
    { type: "assistant", id: `${tag}-m9`, content: [textPart("step 9")] },
  ]
}

const event = (messages) => ({ messages, system: [], tools: {}, options: {}, sessionID: "s" })

async function run(label, fn) {
  console.log(`\n[${label}]`)
  answerer = fn
  const messages = fixture(label)
  await transform(event(messages))
  return messages
}

const kept = await run("keep", () => 1)
check("keep: message count unchanged", kept.length === 10, `got ${kept.length}`)
check("keep: tool content untouched", kept[1].content[0].state.content[0].text.length === 5000)

const dropped = await run("dropcall", () => 0)
check("drop_call: tool-only messages removed", dropped.length === 8, `got ${dropped.length}`)
check(
  "drop_call: no tool parts remain",
  dropped.every((m) => (m.content ?? []).every((p) => p.type !== "tool")),
)
check(
  "drop_call: sibling text survives",
  dropped.some((m) => (m.content ?? []).some((p) => p.type === "text" && p.text === "found it")),
)

const truncated = await run("dropresult", (name) => (name.startsWith("call_") ? 0.9 : 0.1))
const tools = truncated.flatMap((m) => m.content ?? []).filter((p) => p.type === "tool")
check("drop_result: tool parts kept", tools.length === 3, `got ${tools.length}`)
check(
  "drop_result: content truncated with note",
  tools.every((p) => p.state.content[0].text.includes("fast-jev pruned")),
)
check(
  "drop_result: head preserved",
  tools.every((p) => p.state.content[0].text.startsWith("X".repeat(300))),
)

console.log("\n[error result]")
answerer = (name) => (name.startsWith("call_") ? 0.9 : 0.1)
const errMessages = fixture("err")
errMessages[1] = {
  type: "assistant",
  id: "err-m1",
  content: [toolPart("err-1", "bash", BIG, "error")],
}
await transform(event(errMessages))
const errTool = errMessages
  .flatMap((m) => m.content ?? [])
  .find((p) => p.type === "tool" && p.id === "err-1")
check(
  "error result: message truncated with (error) note",
  errTool.state.error.message.includes("fast-jev pruned") &&
    errTool.state.error.message.includes("(error)"),
)

console.log("\n[pending state]")
answerer = () => 0
const pending = fixture("pend")
pending[1] = {
  type: "assistant",
  id: "pend-m1",
  content: [
    {
      type: "tool",
      id: "pend-1",
      name: "read",
      state: { status: "running", input: {}, metadata: {} },
    },
  ],
}
const pendingBefore = JSON.stringify(pending[1])
await transform(event(pending))
check("running part untouched", JSON.stringify(pending[1]) === pendingBefore)

console.log("\n[dryRun]")
writeCfg({ dryRun: true })
answerer = () => 0
requestCount = 0
const dry = fixture("dry")
const dryBefore = JSON.stringify(dry)
await transform(event(dry))
check("dryRun: messages unchanged", JSON.stringify(dry) === dryBefore)
check("dryRun: still scored via Jev", requestCount > 0, `got ${requestCount}`)
writeCfg({ dryRun: false })

console.log("\n[model defaulting]")
writeCfg()
answerer = () => 1
const noModel = fixture("nomodel")
await transform(event(noModel))
check(
  "custom provider without model: sends default model",
  lastModel === "jev-latest",
  `got ${JSON.stringify(lastModel)}`,
)
writeCfg()

console.log("\n[no-key fail-open]")
delete process.env.TYPESAFE_API_KEY
const noKey = fixture("nokey")
const before = JSON.stringify(noKey)
await transform(event(noKey))
check("no key: request untouched", JSON.stringify(noKey) === before)

await new Promise((resolve) => server.close(resolve))
rmSync(home, { recursive: true, force: true })
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`)
process.exitCode = failures === 0 ? 0 : 1
