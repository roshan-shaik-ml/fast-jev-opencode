import { createServer } from "node:http"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

// The payload shapes below were captured from a live OpenCode 2.0.18 session.
// An earlier revision of this suite fed the adapter a shape that never occurs,
// which is why a broken adapter passed every check.
const user = (text) => ({ role: "user", content: [{ type: "text", text }] })
const assistant = (parts) => ({ role: "assistant", content: parts })
const tool = (results) => ({ role: "tool", content: results })
const say = (text) => ({ type: "text", text })
const call = (id, name, input = {}) => ({ type: "tool-call", id, name, input })
const result = (id, name, value, isError = false) => ({
  type: "tool-result",
  id,
  name,
  result: { type: isError ? "error" : "text", value },
})

const home = mkdtempSync(join(tmpdir(), "fast-jev-v2-"))
const cfgPath = join(home, "fast-jev.json")
process.env.FAST_JEV_CONFIG = cfgPath
process.env.FAST_JEV_ENV = join(home, ".env")
process.env.TYPESAFE_API_KEY = "test-key"

let answerer = () => 1
let requestCount = 0
let effortRequests = 0
let lastModel = null

const server = createServer((req, res) => {
  let body = ""
  req.on("data", (chunk) => (body += chunk))
  req.on("end", () => {
    requestCount += 1
    const parsed = JSON.parse(body)
    lastModel = parsed.model
    if (parsed.questions && "effort" in parsed.questions) effortRequests += 1
    const answers = {}
    for (const [name, question] of Object.entries(parsed.questions ?? {})) {
      const p = answerer(name, question.type)
      if (typeof p === "number") {
        if (question.type === "noul") answers[name] = { noul: p }
      } else if (p && typeof p === "object") {
        answers[name] = p
      }
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
  questionStyle: "noul",
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

const hooksByName = {}
const modelInfos = {}
const ctx = {
  session: {
    hook: async (name, callback) => {
      hooksByName[name] = callback
      return { dispose: async () => {} }
    },
  },
  app: { log: async () => {} },
  model: {
    get: (providerID, modelID) => modelInfos[`${providerID}/${modelID}`],
  },
}
await definition.setup(ctx)
check("v2: registers the context hook", typeof hooksByName.context === "function")
check("v2: registers the compaction hook", typeof hooksByName.compaction === "function")
const transform = hooksByName.context

const BIG = "X".repeat(5000)

function fixture(tag) {
  return [
    user(`Fix the failing test. Never edit src/generated. [${tag}]`),
    assistant([call(`${tag}-1`, "read", { filePath: "a.ts" })]),
    tool([result(`${tag}-1`, "read", BIG)]),
    assistant([call(`${tag}-2`, "bash", { command: "npm test" })]),
    tool([result(`${tag}-2`, "bash", BIG)]),
    assistant([say("found it"), call(`${tag}-3`, "write", { filePath: "b.ts" })]),
    tool([result(`${tag}-3`, "write", BIG)]),
    user("ok continue"),
    assistant([say("step")]),
    user("step"),
    assistant([say("step")]),
    user("step"),
    assistant([say("step")]),
    user("step"),
  ]
}

const callsOf = (messages) =>
  messages.flatMap((message) => (message.content ?? []).filter((part) => part.type === "tool-call"))
const resultsOf = (messages) =>
  messages.flatMap((message) =>
    (message.content ?? []).filter((part) => part.type === "tool-result"),
  )
const textOf = (message) =>
  (message.content ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
const charsOf = (messages) =>
  messages.reduce(
    (sum, message) =>
      sum +
      textOf(message).length +
      (message.content ?? []).reduce((inner, part) => {
        if (part.type === "tool-call") return inner + JSON.stringify(part.input ?? {}).length
        if (part.type === "tool-result") {
          const value = part.result?.value
          return inner + (typeof value === "string" ? value.length : 0)
        }
        return inner
      }, 0),
    0,
  )

async function run(label, fn) {
  console.log(`\n[${label}]`)
  answerer = fn
  const messages = fixture(label)
  const before = charsOf(messages)
  await transform({ messages, system: [], tools: {}, options: {}, sessionID: "s" })
  return { messages, before, after: charsOf(messages) }
}

const kept = await run("keep", () => 1)
check("keep: message count unchanged", kept.messages.length === 14, `got ${kept.messages.length}`)
check(
  "keep: tool results untouched",
  resultsOf(kept.messages).every((part) => part.result.value.length === 5000),
)
check("keep: nothing removed", kept.after === kept.before, `${kept.before} -> ${kept.after}`)

const stubbed = await run("stub", () => 0)
check(
  "stub: calls kept in place",
  callsOf(stubbed.messages).length === 3,
  `got ${callsOf(stubbed.messages).length}`,
)
check(
  "stub: results cleared with a note",
  resultsOf(stubbed.messages).every((part) =>
    String(part.result.value).includes("fast-jev cleared"),
  ),
)
check(
  "stub: oversized call inputs cut",
  callsOf(stubbed.messages).every((part) => JSON.stringify(part.input ?? {}).length < 400),
)
check(
  "stub: prose untouched",
  stubbed.messages.some((m) => textOf(m).includes("Never edit src/generated")),
)

writeCfg({ removedCallStyle: "delete" })
const deleted = await run("delete", () => 0)
check(
  "delete: tool calls removed",
  callsOf(deleted.messages).length === 0,
  `got ${callsOf(deleted.messages).length}`,
)
check("delete: tool results removed", resultsOf(deleted.messages).length === 0)
check("delete: messages dropped", deleted.messages.length < 14, `got ${deleted.messages.length}`)
writeCfg()

const truncated = await run("dropresult", (name) => (name.startsWith("call_") ? 0.9 : 0.1))
check("drop_result: calls kept", callsOf(truncated.messages).length === 3)
check(
  "drop_result: results truncated with a note",
  resultsOf(truncated.messages).every((part) =>
    String(part.result.value).includes("fast-jev pruned"),
  ),
)
check(
  "drop_result: head preserved",
  resultsOf(truncated.messages).every((part) =>
    String(part.result.value).startsWith("X".repeat(300)),
  ),
)

console.log("\n[unmatched call]")
writeCfg()
answerer = () => 0
const orphan = [
  user("task"),
  assistant([call("orphan-1", "read", { filePath: "a.ts" })]),
  user("ok"),
  assistant([say("step")]),
  user("step"),
  assistant([say("step")]),
  user("step"),
  assistant([say("step")]),
  user("step"),
]
await transform({ messages: orphan, system: [], tools: {}, options: {}, sessionID: "s" })
check("a call with no result is left alone", callsOf(orphan).length === 1)

console.log("\n[error result]")
answerer = (name) => (name.startsWith("call_") ? 0.9 : 0.1)
const errored = fixture("err")
errored[2] = tool([result("err-1", "bash", BIG, true)])
await transform({ messages: errored, system: [], tools: {}, options: {}, sessionID: "s" })
const errResult = resultsOf(errored).find((part) => part.id === "err-1")
check(
  "error result: truncated with an (error) note",
  String(errResult.result.value).includes("fast-jev pruned") &&
    String(errResult.result.value).includes("(error)"),
)

console.log("\n[dryRun]")
writeCfg({ dryRun: true })
answerer = () => 0
requestCount = 0
const dry = fixture("dry")
const dryBefore = charsOf(dry)
await transform({ messages: dry, system: [], tools: {}, options: {}, sessionID: "s" })
check("dryRun: nothing changed", charsOf(dry) === dryBefore)
check("dryRun: still scored via Jev", requestCount > 0, `got ${requestCount}`)
writeCfg({ dryRun: false })

console.log("\n[model defaulting]")
writeCfg()
answerer = () => 1
const noModel = fixture("nomodel")
await transform({ messages: noModel, system: [], tools: {}, options: {}, sessionID: "s" })
check(
  "custom provider without model: sends default model",
  lastModel === "jev-latest",
  `got ${JSON.stringify(lastModel)}`,
)

console.log("\n[verbatim checkpoint]")
{
  const { renderCheckpoint } = await import(
    pathToFileURL(join(process.cwd(), "src", "checkpoint.ts")).href
  )
  const rendered = renderCheckpoint(
    [
      { role: "user", text: "Fix the failing test", toolUses: [] },
      {
        role: "assistant",
        text: "",
        toolUses: [{ id: "c1", name: "read", input: { filePath: "a.ts" } }],
        toolResults: [{ id: "c1", text: BIG, isError: false }],
      },
    ],
    { truncateHeadChars: 100, maxChars: 100000 },
  )
  check(
    "checkpoint: renders prose verbatim",
    typeof rendered === "string" && rendered.includes("Fix the failing test"),
  )
  check(
    "checkpoint: cuts bulky output",
    typeof rendered === "string" && rendered.includes("head kept"),
  )
  check(
    "checkpoint: refuses to oversize",
    renderCheckpoint([{ role: "user", text: "x", toolUses: [] }], {
      truncateHeadChars: 100,
      maxChars: 5,
    }) === undefined,
  )
}

console.log("\n[effort]")
{
  const effortParts = (messages) =>
    messages.flatMap((message) => message.content ?? []).filter((part) => part.type === "effort")
  const model = { providerID: "opencode-go", id: "qwen3.8-max" }
  const runEffort = async (messages, sessionID = "s") =>
    transform({ messages, system: [], tools: {}, options: {}, sessionID, model })

  writeCfg()
  answerer = () => 1
  const off = fixture("eff-off")
  await runEffort(off)
  check("effort: off by default, nothing injected", effortParts(off).length === 0)

  writeCfg({ effortEnabled: true, rejudgeAfterMs: 0 })
  answerer = (name) =>
    name === "effort" ? { probabilities: { low: 0.05, medium: 0.1, high: 0.85 } } : 1
  const on = fixture("eff-on")
  await runEffort(on)
  const injected = effortParts(on)
  check("effort: one part injected", injected.length === 1, `got ${injected.length}`)
  check(
    "effort: the most probable level is chosen",
    injected[0]?.effort === "high",
    `got ${injected[0]?.effort}`,
  )
  check("effort: no previous when none was in force", injected[0]?.previous === undefined)
  check(
    "effort: attaches to the newest user message",
    (on[on.length - 1].content ?? []).includes(injected[0]),
  )
  check(
    "effort: a part the host would read, not a rewrite of the prose",
    on[on.length - 1].content[0].type === "text",
  )

  modelInfos["opencode-go/qwen3.8-max"] = {
    variants: [{ id: "high" }, { id: "max" }],
    compatibility: { supportsEffortUpdates: true },
  }
  answerer = (name) => (name === "effort" ? { probabilities: { max: 0.9, high: 0.05 } } : 1)
  const laddered = fixture("eff-ladder")
  await runEffort(laddered)
  check(
    "effort: the model's own ladder is offered",
    effortParts(laddered)[0]?.effort === "max",
    `got ${effortParts(laddered)[0]?.effort}`,
  )

  modelInfos["opencode-go/qwen3.8-max"] = {
    variants: [{ id: "max" }],
    compatibility: { supportsEffortUpdates: false },
  }
  const unsupported = fixture("eff-skip")
  await runEffort(unsupported)
  check(
    "effort: a model refusing effort updates is left alone",
    effortParts(unsupported).length === 0,
  )

  delete modelInfos["opencode-go/qwen3.8-max"]
  answerer = () => 1
  const silent = fixture("eff-silent")
  await runEffort(silent)
  check("effort: an unusable answer injects nothing", effortParts(silent).length === 0)

  answerer = (name) =>
    name === "effort" ? { probabilities: { high: 0.9, low: 0.05, medium: 0.05 } } : 1
  const twice = fixture("eff-twice")
  await runEffort(twice)
  await runEffort(twice)
  check("effort: a repeat pass keeps a single part", effortParts(twice).length === 1)

  writeCfg({ effortEnabled: true })
  const before = effortRequests
  const shared = fixture("eff-shared")
  await runEffort(shared)
  const firstPass = effortRequests - before
  await runEffort(shared)
  const secondPass = effortRequests - before - firstPass
  await runEffort(shared, "other")
  const otherSession = effortRequests - before - firstPass - secondPass
  check("effort: a fresh digest asks once", firstPass === 1, `got ${firstPass}`)
  check("effort: a cached decision asks nothing", secondPass === 0, `got ${secondPass}`)
  check("effort: another session is scored separately", otherSession === 1, `got ${otherSession}`)

  writeCfg({ effortEnabled: true, dryRun: true })
  const dryEffort = fixture("eff-dry")
  await runEffort(dryEffort)
  check("effort: dryRun injects nothing", effortParts(dryEffort).length === 0)
  writeCfg()
}

console.log("\n[no-key fail-open]")
delete process.env.TYPESAFE_API_KEY
const noKey = fixture("nokey")
const before = charsOf(noKey)
await transform({ messages: noKey, system: [], tools: {}, options: {}, sessionID: "s" })
check("no key: request untouched", charsOf(noKey) === before)

await new Promise((resolve) => server.close(resolve))
rmSync(home, { recursive: true, force: true })
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`)
process.exitCode = failures === 0 ? 0 : 1
