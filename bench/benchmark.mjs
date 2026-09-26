import { createServer } from "node:http"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { collectCalls, decide } from "../src/engine/index.ts"

const PRESERVE = 6
const THRESHOLDS = { keepCall: 0.5, keepResult: 0.25 }

// Stub Jev: one third truncated, one third kept, one third removed.
function probability(name) {
  const slot = Number(name.match(/_(\d+)$/)?.[1] ?? "1")
  return name.startsWith("call_") ? (slot % 3 === 2 ? 0.2 : 0.9) : slot % 3 === 1 ? 0.2 : 0.9
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
const port = server.address().port

function spec() {
  const messages = [
    {
      role: "user",
      text: "Fix the failing test in src/app.ts. Never edit src/generated. Keep the public API stable.",
      tools: [],
    },
  ]
  for (let i = 0; i < 24; i++) {
    messages.push({
      role: "assistant",
      text: "",
      tools: [
        {
          callID: `c${i + 1}`,
          tool: ["read", "bash", "grep", "edit"][i % 4],
          input: { path: `src/file${i}.ts`, pattern: "needle" },
          output: `result for call ${i + 1}\n${"x".repeat(4000)}`,
        },
      ],
    })
  }
  for (let i = 0; i < PRESERVE; i++) {
    messages.push({ role: i % 2 ? "user" : "assistant", text: `tail step ${i}`, tools: [] })
  }
  return messages
}

function toTranscript(messages) {
  return messages.map((message) => {
    if (message.tools.length === 0) {
      return { role: message.role, text: message.text, toolUses: [] }
    }
    return {
      role: message.role,
      text: message.text,
      toolUses: message.tools.map((tool) => ({
        id: tool.callID,
        name: tool.tool,
        input: tool.input,
      })),
      toolResults: message.tools.map((tool) => ({
        id: tool.callID,
        text: tool.output,
        isError: false,
      })),
    }
  })
}

function toV1Messages(messages) {
  return messages.map((message) => ({
    info: { id: `m${Math.random()}`, sessionID: "s", role: message.role },
    parts: [
      ...(message.text
        ? [
            {
              id: `t${Math.random()}`,
              sessionID: "s",
              messageID: "m",
              type: "text",
              text: message.text,
            },
          ]
        : []),
      ...message.tools.map((tool) => ({
        id: `${tool.callID}-p`,
        sessionID: "s",
        messageID: "m",
        type: "tool",
        callID: tool.callID,
        tool: tool.tool,
        state: {
          status: "completed",
          input: tool.input,
          output: tool.output,
          title: tool.tool,
          metadata: {},
          time: { start: 1, end: 2 },
        },
      })),
    ],
  }))
}

function v1Chars(messages) {
  let total = 0
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type === "text") total += part.text.length
      else if (part.type === "tool") {
        total += JSON.stringify(part.state.input ?? {}).length
        total += (part.state.output ?? part.state.error ?? "").length
      }
    }
  }
  return total
}

const actionCounts = (list) => ({
  keep: list.filter((a) => a === "keep").length,
  drop_result: list.filter((a) => a === "drop_result").length,
  drop_call: list.filter((a) => a === "drop_call").length,
})

const source = spec()
const transcript = toTranscript(source)
const calls = collectCalls(transcript, PRESERVE)

console.log("\nmode: offline (stubbed Jev answers)")
console.log(`transcript: ${source.length} messages, ${calls.length} tool calls\n`)

console.log("engine reference  (collectCalls -> decide)")
const actionsA = calls
  .filter((call) => !call.pinned)
  .map((call) =>
    decide(
      call,
      {
        keepCall: probability(`call_${call.slot}`),
        keepResult: probability(`result_${call.slot}`),
      },
      THRESHOLDS,
    ),
  )
  .map((decision) => decision.action)
console.log(`  actions        ${JSON.stringify(actionCounts(actionsA))}\n`)

const home = mkdtempSync(join(tmpdir(), "fast-jev-bench-"))
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
    baseUrl: `http://127.0.0.1:${port}`,
    apiKeyEnv: "TYPESAFE_API_KEY",
    preserveRecentMessages: PRESERVE,
    minResultChars: 0,
    rejudgeAfterMs: 600000,
    timeoutMs: 30000,
    minScored: 1000,
    log: false,
  }),
)

const { default: plugin } = await import(pathToFileURL(join(process.cwd(), "src", "v1.ts")).href)
const hooks = await plugin({ client: { app: { log: async () => {} } } })
const transform = hooks["experimental.chat.messages.transform"]

const messages = toV1Messages(source)
const beforeChars = v1Chars(messages)
const callIDs = source.flatMap((message) => message.tools.map((tool) => tool.callID))
requestCount = 0
const started = Date.now()
await transform({}, { messages })
const elapsed = Date.now() - started
const afterChars = v1Chars(messages)

const seen = new Map()
for (const message of messages) {
  for (const part of message.parts) if (part.type === "tool") seen.set(part.callID, part)
}
const actionsB = callIDs.map((id) => {
  const part = seen.get(id)
  if (!part) return "drop_call"
  return (part.state.output ?? "").includes("fast-jev pruned") ? "drop_result" : "keep"
})

console.log("adapter          (v1 hook, same stub answers)")
console.log(
  `  actions        ${JSON.stringify(actionCounts(actionsB.filter((a) => a !== "keep" || true)))}`,
)
console.log(`  chars          ${beforeChars} -> ${afterChars}`)
console.log(`  jev requests   ${requestCount}`)
console.log(`  time           ${elapsed} ms\n`)

const parity = JSON.stringify(actionsA) === JSON.stringify(actionsB)
console.log(`consistency      actions identical: ${parity} (${actionsA.length}/${actionsB.length})`)

const cached = toV1Messages(source)
requestCount = 0
const cachedStart = Date.now()
await transform({}, { messages: cached })
console.log(
  `cache            second request: ${requestCount} jev request(s), ${Date.now() - cachedStart} ms`,
)

writeFileSync(cfgPath, JSON.stringify({ enabled: true, minResultChars: 100000000, log: false }))
const idle = toV1Messages(source)
const idleStart = Date.now()
await transform({}, { messages: idle })
console.log(
  `overhead         no eligible calls: ${Date.now() - idleStart} ms (mapping only, no Jev call)\n`,
)

await new Promise((resolve) => server.close(resolve))
rmSync(home, { recursive: true, force: true })
console.log(parity ? "RESULT: adapter matches the engine\n" : "RESULT: DIVERGENCE - investigate\n")
process.exitCode = parity ? 0 : 1
