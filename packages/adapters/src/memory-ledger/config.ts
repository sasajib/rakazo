import { readFileSync } from "node:fs";

/**
 * Everything the ledger reads from the environment. Both the memory model and the embedding
 * service are optional: without the model only explicit "remember …" sentences are learned, and
 * without embeddings search is full-text only. Neither ever blocks a run.
 */
export interface LedgerConfig {
  enabled: boolean;
  model: {
    /** OpenAI-compatible base URL (…/v1). When absent, an instance connection is used. */
    url: string | undefined;
    apiKey: string | undefined;
    model: string;
    /** Label or provider id of the owner's OpenAI-compatible connection to call instead. */
    connection: string | undefined;
    timeoutMs: number;
    /** Set to "off" to skip the model even when one is reachable. */
    disabled: boolean;
  };
  embeddings: {
    url: string | undefined;
    model: string;
    apiKey: string | undefined;
    timeoutMs: number;
  };
  /** Work-start pack budget; past it the run starts with the core block only. */
  packBudgetMs: number;
  coreMaxBytes: number;
  packMaxBytes: number;
  packLimit: number;
  /** Talk lane and voice calls get a smaller pack. */
  fastPackLimit: number;
}

export const DEFAULT_MEMORY_MODEL = "glm/glm-5.3-flash";
export const DEFAULT_EMBEDDINGS_MODEL = "bge-m3";

type Env = Record<string, string | undefined>;

const on = (value: string | undefined) => /^(1|true|on|yes)$/i.test(value?.trim() ?? "");
const text = (value: string | undefined) => value?.trim() || undefined;
const int = (value: string | undefined, fallback: number, min: number, max: number) => {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
};

/** A key from its variable, else from the file its `_FILE` twin names. Literal names keep the
 * compose allowlist test able to see which settings are read. */
function keyFrom(value: string | undefined, fileValue: string | undefined): string | undefined {
  const direct = text(value);
  if (direct) return direct;
  const file = text(fileValue);
  if (!file) return undefined;
  try {
    return readFileSync(file, "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

export function ledgerConfig(env: Env = process.env): LedgerConfig {
  return {
    enabled: on(env.MEMORY_LEDGER),
    model: {
      url: text(env.MEMORY_LEDGER_MODEL_URL),
      apiKey: keyFrom(env.MEMORY_LEDGER_MODEL_API_KEY, env.MEMORY_LEDGER_MODEL_API_KEY_FILE),
      model: text(env.MEMORY_LEDGER_MODEL) ?? DEFAULT_MEMORY_MODEL,
      connection: text(env.MEMORY_LEDGER_MODEL_CONNECTION),
      timeoutMs: int(env.MEMORY_LEDGER_MODEL_TIMEOUT_MS, 30_000, 1_000, 120_000),
      disabled: /^(0|off|false|no|none)$/i.test(env.MEMORY_LEDGER_MODEL_URL?.trim() ?? ""),
    },
    embeddings: {
      url: text(env.MEMORY_EMBEDDINGS_URL) ?? text(env.STANDING_EMBEDDINGS_URL),
      model: text(env.MEMORY_EMBEDDINGS_MODEL) ?? DEFAULT_EMBEDDINGS_MODEL,
      apiKey: keyFrom(env.MEMORY_EMBEDDINGS_API_KEY, env.MEMORY_EMBEDDINGS_API_KEY_FILE),
      timeoutMs: int(env.MEMORY_EMBEDDINGS_TIMEOUT_MS, 5_000, 100, 60_000),
    },
    packBudgetMs: int(env.MEMORY_LEDGER_PACK_BUDGET_MS, 400, 20, 5_000),
    coreMaxBytes: int(env.MEMORY_LEDGER_CORE_MAX_BYTES, 6 * 1024, 512, 32 * 1024),
    packMaxBytes: int(env.MEMORY_LEDGER_PACK_MAX_BYTES, 4 * 1024, 512, 32 * 1024),
    packLimit: int(env.MEMORY_LEDGER_PACK_LIMIT, 12, 1, 50),
    fastPackLimit: int(env.MEMORY_LEDGER_FAST_PACK_LIMIT, 5, 0, 50),
  };
}

export function ledgerEnabled(env: Env = process.env): boolean {
  return on(env.MEMORY_LEDGER);
}
