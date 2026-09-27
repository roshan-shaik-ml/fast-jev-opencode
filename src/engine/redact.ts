const MARKER = "[REDACTED]"

const CREDENTIAL_KEY =
  /(?:^|[_-])(?:token|password|passwd|pwd|secret|authorization|cookie|credential|api[_-]?key|access[_-]?key|private[_-]?key|session[_-]?id|client[_-]?secret)(?:$|[_-])/i

const SECRET_SHAPES: RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+/-]{8,}={0,2}/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
]

const KEY_VALUE_SECRET =
  /\b([A-Za-z0-9_-]{0,32}(?:token|password|passwd|secret|api[_-]?key|access[_-]?key|client[_-]?secret)[A-Za-z0-9_-]{0,32})\s*[=:]\s*("[^"]{6,}"|'[^']{6,}'|[^\s,;}"']{6,})/gi

/** Mask secret-shaped strings inside free text. Conservative: never expands a match. */
export function redactText(text: string): string {
  if (!text) return text
  let out = text
  for (const shape of SECRET_SHAPES) out = out.replace(shape, MARKER)
  out = out.replace(KEY_VALUE_SECRET, (_match, key: string) => `${key}=${MARKER}`)
  return out
}

/** True when a field name looks like it carries a credential. */
export function isCredentialKey(key: string): boolean {
  return CREDENTIAL_KEY.test(key)
}

function redactValue(value: unknown, depth: number): unknown {
  if (typeof value === "string") return redactText(value)
  if (Array.isArray(value)) return value.slice(0, 32).map((entry) => redactValue(entry, depth + 1))
  if (value && typeof value === "object")
    return redactInput(value as Record<string, unknown>, depth)
  return value
}

/** Deep-copy a tool input with credential-named fields and secret-shaped values masked. */
export function redactInput(input: Record<string, unknown>, depth = 0): Record<string, unknown> {
  if (depth > 4) return {}
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input ?? {})) {
    if (isCredentialKey(key)) {
      out[key] = MARKER
      continue
    }
    out[key] = redactValue(value, depth + 1)
  }
  return out
}
