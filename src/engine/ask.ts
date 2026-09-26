import type { JevAsker, JevQuestions } from "./types.ts"

export const DEFAULT_ENDPOINT = "https://api.typesafe.ai/v1/systemone"
export const DEFAULT_MODEL = "jev-latest"

export interface JevClientOptions {
  apiKey: string
  model?: string
  baseUrl?: string
  timeoutMs?: number
  fetch?: typeof fetch
}

/**
 * Asked answers are probabilities in [0, 1]. A question the endpoint did not
 * answer is treated as 1 ("keep") rather than an error: keeping content is the
 * safe direction, and a partial answer should never become a silent deletion.
 */
function parseAnswers(text: string, names: string[]): Record<string, number> {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error("Jev returned malformed JSON")
  }
  const answers = (parsed as { answers?: unknown } | null)?.answers
  if (!answers || typeof answers !== "object") {
    throw new Error("Jev response is missing answers")
  }
  const record = answers as Record<string, { noul?: unknown } | undefined>
  const out: Record<string, number> = {}
  for (const name of names) {
    const value = record[name]?.noul
    out[name] = typeof value === "number" && Number.isFinite(value) ? value : 1
  }
  return out
}

/** Asks System One for keep/drop probabilities. Owns its own deadline. */
export class JevClient implements JevAsker {
  private readonly apiKey: string
  private readonly model: string
  private readonly baseUrl: string
  private readonly timeoutMs: number
  private readonly fetcher: typeof fetch

  constructor(options: JevClientOptions) {
    this.apiKey = options.apiKey
    this.model = options.model || DEFAULT_MODEL
    this.baseUrl = options.baseUrl || DEFAULT_ENDPOINT
    this.timeoutMs = options.timeoutMs ?? 30_000
    this.fetcher = options.fetch ?? fetch
  }

  async ask(state: unknown, questions: JevQuestions): Promise<Record<string, number>> {
    if (!this.apiKey) throw new Error("no Jev API key configured")

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const response = await this.fetcher(this.baseUrl, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: this.model, state, questions }),
        signal: controller.signal,
      })
      const text = await response.text()
      if (!response.ok) {
        throw new Error(`Jev request failed (${response.status}): ${text.slice(0, 200)}`)
      }
      return parseAnswers(text, Object.keys(questions))
    } finally {
      clearTimeout(timer)
    }
  }
}
