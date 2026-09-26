export const TASK =
  "After the last deploy, POST /login returns 500 for some users. Find the cause and fix it. Do not change the public API."

const FILE_SESSION = `import { randomUUID } from "node:crypto"
import { db } from "../db"
import { config } from "../config/env"
import type { Session } from "./types"

const TTL_MS = 1000 * 60 * 60 * 24
const MAX_SESSIONS_PER_USER = 20

export async function createSession(userId: string): Promise<Session> {
  const id = randomUUID()
  const expiresAt = Date.now() + TTL_MS
  const existing = await db.find("sessions", { userId, revoked: false })
  if (existing.length >= MAX_SESSIONS_PER_USER) {
    const oldest = existing.sort((a, b) => a.expiresAt - b.expiresAt)[0]
    await db.update("sessions", { id: oldest.id }, { revoked: true })
  }
  await db.insert("sessions", { id, userId, expiresAt, revoked: false })
  return { id, userId, expiresAt }
}

export async function loadSession(id: string): Promise<Session | null> {
  const row = await db.findOne("sessions", { id })
  if (!row) return null
  if (row.revoked) return null
  if (row.expiresAt < Date.now()) {
    await db.update("sessions", { id }, { revoked: true })
    return null
  }
  return { id: row.id, userId: row.userId, expiresAt: row.expiresAt }
}

export async function touchSession(id: string): Promise<void> {
  const session = await loadSession(id)
  if (!session) return
  const expiresAt = Date.now() + TTL_MS
  await db.update("sessions", { id: session.id }, { expiresAt })
}

export function sessionCookie(session: Session, secure = true): string {
  const flags = ["HttpOnly", "SameSite=Lax", "Path=/"]
  if (secure) flags.push("Secure")
  return \`sid=\${session.id}; \${flags.join("; ")}\`
}`

const GREP = `src/auth/session.ts:4:const TTL_MS = 1000 * 60 * 60 * 24
src/auth/session.ts:14:  const expiresAt = Date.now() + TTL_MS
src/auth/session.ts:22:  return { id, userId, expiresAt }
src/auth/session.ts:31:  if (row.expiresAt < Date.now()) {
src/auth/session.ts:40:  const expiresAt = Date.now() + TTL_MS
src/auth/session.ts:41:  await db.update("sessions", { id: session.id }, { expiresAt })
src/auth/middleware.ts:12:  const session = await loadSession(req.cookies.sid)
src/auth/middleware.ts:13:  if (!session) return res.status(401).end()
src/auth/middleware.ts:18:  req.session = session`

const TEST_FAIL = ` FAIL  test/auth/login.test.ts > POST /login > returns 200 with valid credentials
AssertionError: expected 500 to be 200
  at test/auth/login.test.ts:24:31
  at processTicksAndRejections (node:internal/process/task_queues:95:5)

 FAIL  test/auth/login.test.ts > POST /login > sets a session cookie
TypeError: Cannot read properties of undefined (reading 'expiresAt')
  at loadSession (src/auth/session.ts:31:13)
  at middleware (src/auth/middleware.ts:12:22)
  at test/auth/login.test.ts:41:18

 FAIL  test/auth/session.test.ts > touchSession > extends expiry
AssertionError: expected 1758998400000 to be greater than 1758998400000

Test Files  2 failed (2)
     Tests  3 failed | 12 passed (15)
  Duration  2.84s`

const ENV_FILE = `import { z } from "zod"

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().url(),
  SESSION_TTL_HOURS: z.coerce.number().int().positive().default(24),
  SESSION_COOKIE_SECURE: z.coerce.boolean().default(true),
})

export const config = schema.parse(process.env)`

const EDIT_INPUT = {
  filePath: "src/auth/session.ts",
  oldString:
    '  const expiresAt = Date.now() + TTL_MS\n  await db.update("sessions", { id: session.id }, { expiresAt })',
  newString:
    '  const expiresAt = Date.now() + config.SESSION_TTL_HOURS * 60 * 60 * 1000\n  await db.update("sessions", { id: session.id }, { expiresAt })',
}

const TEST_PASS = ` ✓ test/auth/session.test.ts (6)
 ✓ test/auth/login.test.ts (9)

Test Files  2 passed (2)
     Tests  15 passed (15)
  Duration  1.92s`

/** A small realistic session: read, grep, a failing test run, config read, edit, passing test run. */
export const SOURCE = [
  { role: "user", text: TASK, tools: [] },
  {
    role: "assistant",
    text: "",
    tools: [
      {
        callID: "c1",
        tool: "read",
        input: { filePath: "src/auth/session.ts" },
        output: FILE_SESSION,
      },
    ],
  },
  {
    role: "assistant",
    text: "",
    tools: [
      { callID: "c2", tool: "grep", input: { pattern: "expiresAt", path: "src" }, output: GREP },
    ],
  },
  {
    role: "assistant",
    text: "",
    tools: [
      { callID: "c3", tool: "bash", input: { command: "npm test -- auth" }, output: TEST_FAIL },
    ],
  },
  {
    role: "assistant",
    text: "",
    tools: [
      { callID: "c4", tool: "read", input: { filePath: "src/config/env.ts" }, output: ENV_FILE },
    ],
  },
  {
    role: "assistant",
    text: "",
    tools: [
      {
        callID: "c5",
        tool: "edit",
        input: EDIT_INPUT,
        output: "Applied 1 edit to src/auth/session.ts",
      },
    ],
  },
  {
    role: "assistant",
    text: "",
    tools: [
      { callID: "c6", tool: "bash", input: { command: "npm test -- auth" }, output: TEST_PASS },
    ],
  },
  {
    role: "user",
    text: "Use SESSION_TTL_HOURS from config instead of the hardcoded constant.",
    tools: [],
  },
  { role: "assistant", text: "Applied the config-based TTL and re-ran the auth tests.", tools: [] },
  { role: "user", text: "thanks", tools: [] },
  { role: "assistant", text: "tail 1", tools: [] },
  { role: "user", text: "tail 2", tools: [] },
  { role: "assistant", text: "tail 3", tools: [] },
  { role: "user", text: "tail 4", tools: [] },
]

export function toTranscript(source) {
  return source.map((message) => {
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

export function toV1Messages(source) {
  return source.map((message) => ({
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
