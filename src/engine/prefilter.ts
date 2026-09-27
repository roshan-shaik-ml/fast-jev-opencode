import type { ToolCall } from "./types.ts"

export type RuleReason = "duplicate" | "superseded" | "resolved"

export interface RuleSet {
  duplicate: boolean
  superseded: boolean
  resolved: boolean
}

const MUTATING = /^(edit|write|patch|multiedit|notebookedit|apply_patch)$/i

/**
 * `superseded` is off by default: measurement with `bench:baseline` shows it
 * costing more later-referenced evidence than it saves requests. A read that a
 * later edit modified can still be the passage the session went on to quote. The
 * other two are provably redundant, because an identical request was made later.
 */
export const DEFAULT_RULES: RuleSet = { duplicate: true, superseded: false, resolved: true }

function fingerprint(call: ToolCall): string {
  let input = ""
  try {
    input = JSON.stringify(call.input)
  } catch {
    input = String(call.input)
  }
  return `${call.tool}\u0000${input}`
}

function pathOf(call: ToolCall): string | undefined {
  const input = call.input ?? {}
  for (const key of ["filePath", "file_path", "path", "file"]) {
    const value = input[key]
    if (typeof value === "string" && value.length > 0) return value
  }
  return undefined
}

/**
 * Drops the transcript proves by itself, so they cost no Jev request:
 *
 * - `duplicate`  an identical request was made later, so this one is redundant.
 * - `superseded` the file this read described was modified later, so the read no
 *                longer describes the file. Off by default — see above.
 * - `resolved`   an identical request succeeded later, so this error no longer
 *                describes the current state.
 *
 * Only the last occurrence of a request survives; pinned calls are never touched.
 */
export function prefilter(
  calls: readonly ToolCall[],
  rules: RuleSet = DEFAULT_RULES,
): Map<string, RuleReason> {
  const hits = new Map<string, RuleReason>()
  const candidates = calls.filter((call) => !call.pinned)

  if (!rules.duplicate && !rules.resolved && !rules.superseded) return hits

  const groups = new Map<string, ToolCall[]>()
  for (const call of candidates) {
    const key = fingerprint(call)
    const list = groups.get(key) ?? []
    list.push(call)
    groups.set(key, list)
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue
    const last = group[group.length - 1] as ToolCall
    for (const call of group.slice(0, -1)) {
      if (call.isError && !last.isError) {
        if (rules.resolved) hits.set(call.id, "resolved")
        continue
      }
      // An identical request is only redundant when the later run produced at
      // least as much output. Re-running the same command after a change yields
      // different output, and the earlier run is often the evidence of what was
      // wrong — `bench:baseline` catches this rule when it is allowed to fire on
      // a shorter later result.
      if (
        rules.duplicate &&
        !call.isError &&
        !last.isError &&
        last.resultChars >= call.resultChars
      ) {
        hits.set(call.id, "duplicate")
      }
    }
  }

  if (rules.superseded) {
    candidates.forEach((read, index) => {
      if (hits.has(read.id) || !/^read$/i.test(read.tool)) return
      const path = pathOf(read)
      if (!path) return
      const modified = candidates
        .slice(index + 1)
        .some((later) => MUTATING.test(later.tool) && pathOf(later) === path)
      if (modified) hits.set(read.id, "superseded")
    })
  }

  return hits
}
