const KEEP = 0.9
const DROP = 0.05

function bucket(name) {
  return Number(name.match(/_(\d+)$/)?.[1] ?? "1") % 3
}

/**
 * Stub readings for the two `noul` questions, shaped for thresholds 0.25 / 0.15:
 * slot%3===0 keeps, 1 truncates the result, 2 drops the call.
 */
export function noulProbability(name) {
  const b = bucket(name)
  if (name.startsWith("call_")) return b === 2 ? DROP : KEEP
  return b === 0 ? KEEP : DROP
}

/** The same three outcomes expressed as one `choice` question. */
export function choiceProbabilities(name) {
  const b = bucket(name)
  if (b === 0) return { keep: KEEP, truncate: DROP, drop: DROP }
  if (b === 1) return { keep: DROP, truncate: KEEP, drop: DROP }
  return { keep: DROP, truncate: DROP, drop: KEEP }
}

/**
 * Answer a question in whatever shape it was asked. A stub that only speaks one
 * shape silently answers the other one wrong, which is how three benchmarks
 * quietly stopped measuring anything.
 */
export function answer(name, type) {
  return type === "choice"
    ? { probabilities: choiceProbabilities(name) }
    : { noul: noulProbability(name) }
}
