import { clip } from "./estimate.ts"
import { redactText } from "./redact.ts"
import type { JevAnswer, JevQuestions } from "./types.ts"

/**
 * The host's own effort ladder, ordered from least to most. Providers express
 * different slices of it - OpenAI has `none`/`minimal`, Moonshot tops out at
 * `max`, some protocols want a boolean and a budget instead of a word - so the
 * ladder we offer Jev is always computed for the target model, and the host's
 * protocol driver is what turns the chosen word into that provider's dialect.
 */
export const EFFORT_LADDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const

export type EffortLevel = (typeof EFFORT_LADDER)[number]

/**
 * Offered when a model declares no variants of its own. These three are the
 * slice essentially every provider expresses, so the choice is always
 * expressible without knowing which protocol is in play.
 */
export const DEFAULT_EFFORT_LEVELS: readonly EffortLevel[] = ["low", "medium", "high"]

const DESCRIPTIONS: Record<EffortLevel, string> = {
  none: "no deliberate reasoning: recall or repeat something already known",
  minimal: "one obvious step with no planning",
  low: "a short, well-specified change or a direct question",
  medium: "several steps, some judgement, or unfamiliar code",
  high: "multi-file work, debugging, or a design decision",
  xhigh: "hard reasoning where a wrong answer costs a rework",
  max: "the hardest work: novel design, deep debugging, long chains",
}

export function isEffortLevel(value: unknown): value is EffortLevel {
  return typeof value === "string" && (EFFORT_LADDER as readonly string[]).includes(value)
}

/** Deduplicates and orders levels by ladder position. */
export function orderLevels(levels: readonly string[]): EffortLevel[] {
  const unique = [...new Set(levels.filter(isEffortLevel))]
  return unique.sort((a, b) => EFFORT_LADDER.indexOf(a) - EFFORT_LADDER.indexOf(b))
}

/** Snaps an unoffered level onto the nearest offered one, by ladder position. */
export function nearestLevel(
  level: string,
  levels: readonly EffortLevel[],
): EffortLevel | undefined {
  if (levels.length === 0) return undefined
  if ((levels as readonly string[]).includes(level)) return level as EffortLevel
  const target = (EFFORT_LADDER as readonly string[]).indexOf(level)
  if (target < 0) return undefined
  let best = levels[0] as EffortLevel
  let distance = Number.MAX_SAFE_INTEGER
  for (const candidate of levels) {
    const candidateDistance = Math.abs(EFFORT_LADDER.indexOf(candidate) - target)
    if (candidateDistance < distance) {
      best = candidate
      distance = candidateDistance
    }
  }
  return best
}

/** One question over the offered levels. The lowest sufficient level wins. */
export function effortQuestion(levels: readonly EffortLevel[], digest: string): JevQuestions {
  const criteria: Record<string, string> = {}
  for (const level of levels) criteria[level] = DESCRIPTIONS[level]
  return {
    effort: {
      type: "choice",
      instructions: `Decide how much reasoning effort the next model request needs. Choose the lowest level that is sufficient for it.\n${digest}`,
      criteria,
    },
  }
}

/** The chosen level, or undefined when the answer says nothing usable. */
export function effortFromAnswer(
  answer: JevAnswer | undefined,
  levels: readonly EffortLevel[],
): EffortLevel | undefined {
  if (!answer) return undefined
  let best: EffortLevel | undefined
  let bestProbability = -1
  for (const level of levels) {
    const probability = answer.probabilities?.[level]
    if (typeof probability === "number" && probability > bestProbability) {
      best = level
      bestProbability = probability
    }
  }
  if (best) return best
  return answer.choice ? nearestLevel(answer.choice, levels) : undefined
}

/** A digest small enough to charge to every question. */
export function effortDigest(
  input: { task: string; messages: number; toolCalls: number; chars: number },
  chars: number,
): string {
  const task = clip(redactText(input.task).replace(/\s+/g, " ").trim(), chars)
  return `Task: ${task}\nTranscript: ${input.messages} messages, ${input.toolCalls} tool calls, ${input.chars} characters`
}
