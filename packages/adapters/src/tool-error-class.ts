/**
 * A coarse, enum-like cause for a failed tool call, for the audit log. The failure text itself is
 * stored sealed, so the class is what lets an operator tell a timeout from a refusal from a bad
 * argument without reading content.
 */
export const TOOL_ERROR_CLASSES = [
  "timeout",
  "validation",
  "tool_disabled",
  "memory_full",
  "auth",
  "rate_limited",
  "upstream_4xx",
  "upstream_5xx",
  "mcp_error",
  "network",
  "unknown",
] as const;

export type ToolErrorClass = (typeof TOOL_ERROR_CLASSES)[number];

/** The HTTP status an error object carries, when it carries one. */
function statusOfError(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const record = error as {
    status?: unknown;
    statusCode?: unknown;
    response?: { status?: unknown };
  };
  for (const candidate of [record.status, record.statusCode, record.response?.status]) {
    if (typeof candidate === "number" && candidate >= 100 && candidate <= 599) return candidate;
  }
  return undefined;
}

/** A status written into the text: "HTTP 503", "status: 429", "request failed: 409", "404 Not Found". */
function statusInText(text: string): number | undefined {
  const contextual =
    /(?:\bhttp\/?[\d.]*\s*|\bstatus(?:\s+code)?\W{0,3}|\bfailed\W{1,3}|\berror\W{0,3}|\bcode\W{0,3}|\bresponded with\s+)([45]\d\d)(?!\d)/i.exec(
      text,
    );
  if (contextual) return Number(contextual[1]);
  const leading =
    /^\W{0,3}([45]\d\d)(?!\d)\W{0,3}(?:[A-Za-z]|$)/.exec(text) ??
    /(?:^|\s)([45]\d\d)\s+(?:bad request|unauthorized|forbidden|not found|conflict|gone|unprocessable|too many|internal server|bad gateway|service unavailable|gateway)/i.exec(
      text,
    );
  return leading ? Number(leading[1]) : undefined;
}

/**
 * Names the cause of a failed call. `message` is the failure's text, `error` the thrown value or
 * result error when there is one (for its `status`), `tool` the tool that failed, `refusal` the
 * code a refused call was tagged with.
 */
export function classifyToolError(input: {
  message: string;
  error?: unknown;
  tool?: string;
  refusal?: string;
}): ToolErrorClass {
  const text = input.message;
  const lower = text.toLowerCase();
  const status = statusOfError(input.error) ?? statusInText(text);

  if (
    input.refusal === "tool_disabled" ||
    /\b(?:this tool is disabled|disabled for this bot|tool is disabled)\b/.test(lower)
  ) {
    return "tool_disabled";
  }
  if (/\bmemory is full\b/.test(lower)) return "memory_full";
  if (status === 429 || /\brate[ -]?limit|too many requests|quota exceeded|\b429\b/.test(lower)) {
    return "rate_limited";
  }
  if (
    status === 401 ||
    status === 403 ||
    /\bunauthori[sz]ed\b|\bforbidden\b|invalid (?:api[ -]?)?(?:key|token|credentials?)|token (?:has )?expired|\bnot authenticated\b|authentication (?:failed|required)|permission denied|access denied|insufficient (?:scope|permission)/.test(
      lower,
    )
  ) {
    return "auth";
  }
  if (
    /\btimed? ?out\b|\btimeout\b|\betimedout\b|deadline exceeded|\baborterror\b|operation was aborted due to/.test(
      lower,
    )
  ) {
    return "timeout";
  }
  if (
    /econnrefused|econnreset|enotfound|eai_again|ehostunreach|enetunreach|epipe|socket hang up|fetch failed|network (?:error|is unreachable)|\bunreachable\b|connection (?:refused|reset|closed|lost)|getaddrinfo|tls |certificate/.test(
      lower,
    )
  ) {
    return "network";
  }
  if (
    (status !== undefined && status >= 500) ||
    /internal server error|bad gateway|service unavailable|gateway time-?out/.test(lower)
  ) {
    return "upstream_5xx";
  }
  if (status !== undefined && status >= 400) return "upstream_4xx";
  if (
    /\binvalid\b|validation|\brequired\b|expected (?:string|number|object|array|boolean|integer)|\bmust (?:be|not|have)\b|unrecognized key|malformed|no entry contains|matches more than one|unknown (?:argument|field|parameter)|is not a valid/.test(
      lower,
    )
  ) {
    return "validation";
  }
  if (
    input.tool?.startsWith("mcp__") ||
    /\bmcp\b|json-?rpc|-32\d{3}\b|tool reported an error result|mcp server/.test(lower)
  ) {
    return "mcp_error";
  }
  if (/\bnot found\b|\bconflict\b|unprocessable/.test(lower)) return "upstream_4xx";
  return "unknown";
}
