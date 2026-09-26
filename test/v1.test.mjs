import { createServer } from "node:http"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

const home = mkdtempSync(join(tmpdir(), "fast-jev-test-"))
const cfgPath = join(home, "fast-jev.json")
process.env.FAST_JEV_CONFIG = cfgPath
process.env.FAST_JEV_ENV = join(home, ".env")
process.env.TYPESAFE_API_KEY = "test-key"

let answerer = () => 1
let requestCount = 0
let lastModel = null
let lastQuestions = null
let lastState = null

const server = createServer((req, res) => {
  let body = ""
  req.on("data", (chunk) => (body += chunk))
  req.on("end", () => {
    requestCount += 1
    const parsed = JSON.parse(body)
    lastModel = parsed.model
    lastQuestions = parsed.questions
    lastState = parsed.state
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

function writeCfg(overrides = {}) {
  writeFileSync(cfgPath, JSON.stringify({ ...baseCfg, ...overrides }))
}

writeCfg()

const pluginUrl = pathToFileURL(join(process.cwd(), "src", "v1.ts")).href
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
      : {
          status,
          input: { q: callID },
          output,
          title: "",
          metadata: {},
          time: { start: 1, end: 2 },
        }
  return {
    id: `${callID}-p`,
    sessionID: "s",
    messageID: "m",
    type: "tool",
    callID,
    tool: name,
    state,
  }
}
const text = (value) => ({
  id: `t${Math.random()}`,
  sessionID: "s",
  messageID: "m",
  type: "text",
  text: value,
})
const message = (role, parts) => ({
  info: { id: `m${Math.random()}`, sessionID: "s", role },
  parts,
})
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
check(
  "question carries an output preview",
  typeof lastQuestions?.result_1?.instructions === "string" &&
    lastQuestions.result_1.instructions.includes("Output preview:"),
)

console.log("\n[stub (default)]")
const stubbed = await run("stub", () => 0)
const stubbedTools = stubbed.flatMap((m) => m.parts).filter((p) => p.type === "tool")
check("stub: message count unchanged", stubbed.length === 10, `got ${stubbed.length}`)
check("stub: tool parts kept", stubbedTools.length === 3, `got ${stubbedTools.length}`)
check(
  "stub: outputs cleared with note",
  stubbedTools.every((p) => p.state.output.includes("fast-jev cleared")),
)
check(
  "stub: narration keeps its evidence",
  stubbedTools.some((p) => p.callID === "stub-3"),
)

console.log("\n[delete mode]")
writeCfg({ removedCallStyle: "delete" })
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
writeCfg()

const truncated = await run("dropresult", (name) => (name.startsWith("call_") ? 0.9 : 0.1))
const tools = truncated.flatMap((m) => m.parts).filter((p) => p.type === "tool")
check("drop_result: tool parts kept", tools.length === 3, `got ${tools.length}`)
check(
  "drop_result: outputs truncated with note",
  tools.every((p) => p.state.output.includes("fast-jev pruned")),
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
  errTool.state.error.includes("fast-jev pruned") && errTool.state.error.includes("(error)"),
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

console.log("\n[pinning]")
writeCfg({ removedCallStyle: "delete" })
answerer = () => 0
const pinned = fixture("pin")
pinned[8] = message("assistant", [tool("pin-8", "read", BIG)])
await transform({}, { messages: pinned })
const pinParts = pinned.flatMap((m) => m.parts).filter((p) => p.type === "tool")
check(
  "pinning: call inside newest window kept",
  pinParts.some((p) => p.callID === "pin-8" && p.state.output.length === 5000),
)
check(
  "pinning: calls outside window dropped",
  !pinParts.some((p) => p.callID === "pin-1" || p.callID === "pin-2" || p.callID === "pin-3"),
)
writeCfg()

console.log("\n[preserveRecentMessages]")
writeCfg({ preserveRecentMessages: 10 })
answerer = () => 0
requestCount = 0
const allPinned = fixture("allpin")
const allPinnedBefore = JSON.stringify(allPinned)
await transform({}, { messages: allPinned })
check("all pinned: nothing pruned", JSON.stringify(allPinned) === allPinnedBefore)
check("all pinned: no Jev request", requestCount === 0, `got ${requestCount}`)
writeCfg()

console.log("\n[protectTools]")
writeCfg({ protectTools: ["bash"], removedCallStyle: "delete" })
answerer = () => 0
const protectedMsgs = fixture("prot")
await transform({}, { messages: protectedMsgs })
const protectedParts = protectedMsgs.flatMap((m) => m.parts).filter((p) => p.type === "tool")
check(
  "protectTools: bash call kept",
  protectedParts.some((p) => p.callID === "prot-2"),
)
check("protectTools: other calls dropped", !protectedParts.some((p) => p.callID === "prot-1"))
writeCfg()

console.log("\n[pending state]")
answerer = () => 0
const pendingMsgs = fixture("pend")
pendingMsgs[1] = message("assistant", [
  {
    id: "pend-1-p",
    sessionID: "s",
    messageID: "m",
    type: "tool",
    callID: "pend-1",
    tool: "read",
    state: { status: "running", input: {}, time: { start: 1 } },
  },
])
const pendingBefore = JSON.stringify(pendingMsgs[1])
await transform({}, { messages: pendingMsgs })
check("pending part untouched", JSON.stringify(pendingMsgs[1]) === pendingBefore)

console.log("\n[partial answers]")
answerer = (name) => (name.startsWith("call_") ? 0 : undefined)
requestCount = 0
const partial = fixture("part")
const partialBefore = JSON.stringify(partial)
await transform({}, { messages: partial })
check(
  "partial answers: missing result answer falls back to keep",
  JSON.stringify(partial) === partialBefore,
)
check("partial answers: request still made", requestCount > 0, `got ${requestCount}`)

console.log("\n[unfittable state]")
writeCfg({ maxStateTokens: 50, maxRequestTokens: 60 })
answerer = () => 0
requestCount = 0
const huge = fixture("huge")
const hugeBefore = JSON.stringify(huge)
await transform({}, { messages: huge })
check("unfittable history: fail-open untouched", JSON.stringify(huge) === hugeBefore)
check("unfittable history: no request sent", requestCount === 0, `got ${requestCount}`)
writeCfg()

console.log("\n[keep-signal guard]")
writeCfg()
answerer = () => 0
const guarded = (() => {
  const messages = fixture("guard")
  for (let i = 0; i < 6; i++)
    messages.push(message("assistant", [tool(`guard-${i + 4}`, "read", BIG)]))
  messages.push(
    message("user", [text("tail")]),
    message("assistant", [text("tail")]),
    message("user", [text("tail")]),
    message("assistant", [text("tail")]),
    message("user", [text("tail")]),
    message("assistant", [text("tail")]),
  )
  return messages
})()
const guardedBefore = JSON.stringify(guarded)
await transform({}, { messages: guarded })
check("guard: nothing pruned when no call is kept", JSON.stringify(guarded) === guardedBefore)

console.log("\n[multi-batch]")
writeCfg({
  maxStateTokens: 3000,
  maxRequestTokens: 3600,
  minScored: 1000,
  removedCallStyle: "delete",
})
answerer = () => 0
requestCount = 0
const many = [message("user", [text("task")])]
for (let i = 0; i < 40; i++) many.push(message("assistant", [tool(`mb-${i}`, "read", BIG)]))
for (let i = 0; i < 6; i++) many.push(message("assistant", [text(`tail ${i}`)]))
await transform({}, { messages: many })
check("multi-batch: split into several requests", requestCount >= 2, `got ${requestCount}`)
check(
  "multi-batch: all candidate calls dropped",
  !many.flatMap((m) => m.parts).some((p) => p.type === "tool"),
)
writeCfg()

console.log("\n[model defaulting]")
writeCfg()
answerer = () => 1
requestCount = 0
const noModel = fixture("nomodel")
await transform({}, { messages: noModel })
check(
  "custom provider without model: sends default model",
  lastModel === "jev-latest",
  `got ${JSON.stringify(lastModel)}`,
)
writeCfg({ model: "jev-1.13.0" })
requestCount = 0
const withModel = fixture("withmodel")
await transform({}, { messages: withModel })
check("explicit model: sent as-is", lastModel === "jev-1.13.0", `got ${JSON.stringify(lastModel)}`)
writeCfg()

const mkTool = (callID, name, input, output) => ({
  id: `${callID}-p`,
  sessionID: "s",
  messageID: "m",
  type: "tool",
  callID,
  tool: name,
  state: {
    status: "completed",
    input,
    output,
    title: name,
    metadata: {},
    time: { start: 1, end: 2 },
  },
})
const tails = () => [
  message("assistant", [text("t1")]),
  message("user", [text("t2")]),
  message("assistant", [text("t3")]),
  message("user", [text("t4")]),
  message("assistant", [text("t5")]),
  message("user", [text("t6")]),
]

console.log("\n[prefilter: superseded read]")
writeCfg({ minResultChars: 2000, rules: { duplicate: true, superseded: true, resolved: true } })
answerer = () => 1
requestCount = 0
const superseded = [
  message("user", [text("task")]),
  message("assistant", [mkTool("s1", "read", { filePath: "src/a.ts" }, BIG)]),
  message("assistant", [mkTool("s2", "edit", { filePath: "src/a.ts" }, "Applied 1 edit")]),
  ...tails(),
]
await transform({}, { messages: superseded })
const s1 = superseded.flatMap((m) => m.parts).find((p) => p.callID === "s1")
check(
  "prefilter: stale read cleared without a Jev request",
  requestCount === 0,
  `asked ${requestCount}`,
)
check("prefilter: stale read output cleared", s1.state.output.includes("fast-jev cleared"))

console.log("\n[prefilter: duplicate call]")
writeCfg()
answerer = () => 1
requestCount = 0
const duplicated = [
  message("user", [text("task")]),
  message("assistant", [mkTool("d1", "read", { filePath: "src/b.ts" }, BIG)]),
  message("assistant", [mkTool("d2", "read", { filePath: "src/b.ts" }, BIG)]),
  ...tails(),
]
await transform({}, { messages: duplicated })
const d1 = duplicated.flatMap((m) => m.parts).find((p) => p.callID === "d1")
const d2 = duplicated.flatMap((m) => m.parts).find((p) => p.callID === "d2")
check("prefilter: earlier duplicate cleared", d1.state.output.includes("fast-jev cleared"))
check(
  "prefilter: last occurrence survives",
  d2.state.output.length === 5000,
  `got ${d2.state.output.length}`,
)

console.log("\n[choice questions]")
writeCfg({ questionStyle: "choice" })

const keptByChoice = await run("choicekeep", (name, type) =>
  type === "choice" ? { probabilities: { keep: 0.9, truncate: 0.05, drop: 0.05 } } : 1,
)
check(
  "choice: keep wins",
  keptByChoice
    .flatMap((m) => m.parts)
    .filter((p) => p.type === "tool")
    .every((p) => p.state.output.length === 5000),
)
check(
  "choice: one question per call with three options",
  typeof lastQuestions?.decision_1?.instructions === "string" &&
    Object.keys(lastQuestions.decision_1.criteria).join(",") === "keep,truncate,drop",
)

const truncatedByChoice = await run("choicetrunc", (name, type) =>
  type === "choice" ? { probabilities: { keep: 0.05, truncate: 0.9, drop: 0.05 } } : 1,
)
check(
  "choice: truncate shortens without clearing",
  truncatedByChoice
    .flatMap((m) => m.parts)
    .filter((p) => p.type === "tool")
    .every((p) => p.state.output.includes("fast-jev pruned")),
)

const droppedByChoice = await run("choicedrop", (name, type) =>
  type === "choice" ? { probabilities: { keep: 0.02, truncate: 0.03, drop: 0.95 } } : 1,
)
check(
  "choice: drop clears the call",
  droppedByChoice
    .flatMap((m) => m.parts)
    .filter((p) => p.type === "tool")
    .every((p) => p.state.output.includes("fast-jev cleared")),
)
writeCfg()

console.log("\n[redaction]")
{
  writeCfg()
  answerer = () => 1
  const SECRET_KEY = "sk-live-abcdefghijklmnopqrstuvwx"
  const SECRET_PROSE = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"
  const secretive = [
    message("user", [text(`Deploy failed. AWS_SECRET_ACCESS_KEY=${SECRET_PROSE}`)]),
    message("assistant", [
      {
        id: "sec-1-p",
        sessionID: "s",
        messageID: "m",
        type: "tool",
        callID: "sec-1",
        tool: "bash",
        state: {
          status: "completed",
          input: { command: "curl", apiKey: SECRET_KEY, Authorization: `Bearer ${SECRET_KEY}` },
          output: `used ${SECRET_KEY} to call the api\n${BIG}`,
          title: "bash",
          metadata: {},
          time: { start: 1, end: 2 },
        },
      },
    ]),
    ...tails(),
  ]
  await transform({}, { messages: secretive })
  const sent = JSON.stringify(lastState ?? {}) + JSON.stringify(lastQuestions ?? {})
  check("redaction: a credential-named input never leaves", !sent.includes(SECRET_KEY))
  check("redaction: a pasted secret in prose never leaves", !sent.includes(SECRET_PROSE))
  check("redaction: the state is still sent", lastState !== null && sent.length > 100)
}

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
