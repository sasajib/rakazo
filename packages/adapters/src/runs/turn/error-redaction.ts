import { redactSecrets } from "@rakazo/core";

/** How much of a tool failure the audit log keeps. */
export const AUDIT_ERROR_MESSAGE_MAX_CHARS = 200;

const REDACTED = "[redacted]";

/**
 * Patterns for what must never reach a log line, in the order they run. Credentials inside URLs
 * go first so the email rule does not see `user:pass@host` as an address.
 */
const PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  // scheme://user:password@host -> scheme://[redacted]@host
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@?#]+@/gi, `$1${REDACTED}@`],
  // A query string often carries the credential (?token=, ?key=, signed URLs): drop all of it.
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s?#"'<>)]*)\?[^\s"'<>)]*/gi, `$1?${REDACTED}`],
  [/\b(Bearer|Basic|Digest)\s+[A-Za-z0-9._~+/=-]{6,}/gi, `$1 ${REDACTED}`],
  // key=value / "key": "value" / Header: value, for any key that names a secret.
  [
    /\b([A-Za-z0-9_.-]*(?:password|passwd|secret|token|api[_-]?key|apikey|authorization|cookie|credential|signature|session)[A-Za-z0-9_.-]*)(["']?\s*[:=]\s*["']?)(?!\[redacted\])[^\s"',;&})]+/gi,
    `$1$2${REDACTED}`,
  ],
  // JWTs, and the shapes of the vendors' own keys.
  [/\beyJ[A-Za-z0-9_-]{5,}(?:\.[A-Za-z0-9_-]+){1,2}\b/g, REDACTED],
  [
    /\b(?:sk-(?:or-v1-|ant-|proj-)?[A-Za-z0-9_-]{8,}|oc_sk_[A-Za-z0-9_-]+|(?:ak|ck)_[A-Za-z0-9]{8,}|trg_(?:live|test)_[A-Za-z0-9_-]+|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|rkz1:[A-Za-z0-9+/=_-]+)/g,
    REDACTED,
  ],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g, "[email]"],
  // Long hex strings (hashes, keys) and long mixed letter+digit tokens.
  [/\b[0-9a-fA-F]{32,}\b/g, REDACTED],
  [/\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{32,}\b/g, REDACTED],
];

/**
 * A failure's text made safe for a log line: known run secrets, credentials, tokens, emails and
 * URL credentials/queries are replaced, whitespace collapsed, then the result is cut to
 * `maxChars`. Redaction runs before the cut so a secret is never left half-visible.
 */
export function redactErrorText(
  text: string,
  secrets: readonly string[] = [],
  maxChars = AUDIT_ERROR_MESSAGE_MAX_CHARS,
): string {
  let output = secrets.length > 0 ? redactSecrets(text, secrets) : text;
  for (const [pattern, replacement] of PATTERNS) output = output.replace(pattern, replacement);
  output = withoutControlCharacters(output)
    .replace(/\s{2,}/g, " ")
    .trim();
  return output.length > maxChars ? output.slice(0, maxChars) : output;
}

/** Control characters become spaces, so a failure cannot forge or split a log line. */
function withoutControlCharacters(text: string): string {
  let output = "";
  for (const char of text) {
    const code = char.charCodeAt(0);
    output += code < 0x20 || code === 0x7f ? " " : char;
  }
  return output;
}
