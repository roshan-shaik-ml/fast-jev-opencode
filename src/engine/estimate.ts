const PIECE = /[A-Za-z]+|\d+|[^\sA-Za-z\d]/g

/**
 * Token estimate with no tokenizer.
 *
 * Word cost assumes ~4 letters per token (typical BPE for English), digits cost
 * about half a token each, and every other symbol costs a full token. The
 * intent is to land slightly *above* the provider's real count: overshooting
 * makes us trim the state more than strictly necessary, which is safe, whereas
 * undershooting risks a rejected request.
 */
export function estimateTokens(text: string): number {
  let tokens = 0
  for (const match of text.matchAll(PIECE)) {
    const piece = match[0]
    const first = piece.charCodeAt(0)
    if (first >= 48 && first <= 57) {
      tokens += Math.max(1, Math.ceil(piece.length / 2))
    } else if ((first >= 65 && first <= 90) || (first >= 97 && first <= 122)) {
      tokens += Math.max(1, Math.ceil(piece.length / 4))
    } else {
      tokens += 1
    }
  }
  return Math.ceil(tokens)
}

export function clip(text: string, limit: number): string {
  if (limit <= 0) return ""
  return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}…`
}

export function abridge(text: string, head: number, tail: number): string {
  if (text.length <= head + tail + 32) return text
  const omitted = text.length - head - tail
  return `${text.slice(0, head)}\n[… ${omitted} chars omitted …]\n${text.slice(-tail)}`
}
