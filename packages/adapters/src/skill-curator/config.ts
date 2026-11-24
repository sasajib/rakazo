/**
 * Fork: the skill curator's settings. Off unless SKILL_CURATOR is on. The model is the memory
 * ledger's (MEMORY_LEDGER_MODEL_URL / _MODEL / _API_KEY, or the owner's matching connection)
 * unless SKILL_CURATOR_MODEL_URL / SKILL_CURATOR_MODEL / SKILL_CURATOR_MODEL_API_KEY override it.
 */

import type { LedgerConfig } from "../memory-ledger/config.js";
import { ledgerConfig } from "../memory-ledger/config.js";

export interface CuratorConfig {
  enabled: boolean;
  /** A run with at least this many tool calls is worth a look even without a correction. */
  minToolCalls: number;
  model: LedgerConfig["model"];
}

type Env = Record<string, string | undefined>;

const on = (value: string | undefined) => /^(1|true|on|yes)$/i.test(value?.trim() ?? "");
const text = (value: string | undefined) => value?.trim() || undefined;

export function curatorEnabled(env: Env = process.env): boolean {
  return on(env.SKILL_CURATOR);
}

export function curatorConfig(env: Env = process.env): CuratorConfig {
  const ledger = ledgerConfig(env).model;
  const parsed = Number.parseInt(env.SKILL_CURATOR_MIN_TOOL_CALLS ?? "", 10);
  const url = text(env.SKILL_CURATOR_MODEL_URL);
  return {
    enabled: curatorEnabled(env),
    minToolCalls: Number.isFinite(parsed) ? Math.min(100, Math.max(1, parsed)) : 6,
    model: {
      ...ledger,
      url: url ?? ledger.url,
      apiKey: text(env.SKILL_CURATOR_MODEL_API_KEY) ?? ledger.apiKey,
      model: text(env.SKILL_CURATOR_MODEL) ?? ledger.model,
      // A procedure is longer to write than a fact: give the reasoning model room.
      timeoutMs: Math.max(ledger.timeoutMs, 90_000),
      disabled: url ? /^(0|off|false|no|none)$/i.test(url) : ledger.disabled,
    },
  };
}
