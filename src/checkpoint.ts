import { collectCalls } from "./engine/state.ts"
import { clip } from "./engine/estimate.ts"
import { redactText } from "./engine/redact.ts"
import type { TranscriptMessage } from "./engine/types.ts"

export interface CheckpointOptions {
  truncateHeadChars: number
  maxChars: number
}

/**
 * Render a transcript as the compaction checkpoint, word for word.
 *
 * The host's own compaction writes a summary, which is lossy by construction:
 * exact paths, error strings and constraints go missing. This renders the
 * messages themselves instead, with tool outputs cut to a bounded head, so the
 * checkpoint is the history rather than a description of it.
 *
 * Returns undefined when the result would be larger than `maxChars`; the caller
 * then leaves the host's own compaction alone rather than replacing it with
 * something oversized.
 */
export function renderCheckpoint(
  transcript: readonly TranscriptMessage[],
  options: CheckpointOptions,
): string | undefined {
  const calls = collectCalls(transcript, 0)
  const byMessage = new Map<number, typeof calls>()
  for (const call of calls) {
    const list = byMessage.get(call.messageIndex) ?? []
    list.push(call)
    byMessage.set(call.messageIndex, list)
  }

  const out: string[] = []
  transcript.forEach((message, index) => {
    const text = message.text.trim()
    if (text) out.push(`${message.role}: ${redactText(text)}`)
    for (const call of byMessage.get(index) ?? []) {
      const input = redactText(clip(JSON.stringify(call.input), 400))
      const outcome = call.isError ? "error" : "ok"
      const safe = redactText(call.resultText)
      if (safe.length > options.truncateHeadChars + 120) {
        const head = safe.slice(0, options.truncateHeadChars).replace(/\s+/g, " ")
        out.push(
          `${message.role}: [tool ${call.tool} ${input} -> ${outcome} ${call.resultChars}ch, head kept] ${head}`,
        )
      } else {
        out.push(`${message.role}: [tool ${call.tool} ${input} -> ${outcome}] ${safe}`)
      }
    }
  })

  const rendered = out.join("\n")
  if (rendered.length === 0 || rendered.length > options.maxChars) return undefined
  return rendered
}
