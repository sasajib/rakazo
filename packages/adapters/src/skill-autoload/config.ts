/**
 * Fork: settings of skill auto-load and Space-pinned skills. Both are ON unless switched off:
 *
 *   SKILL_AUTOLOAD=0                 no skill body is matched to the task (catalog + skill_read stay)
 *   SKILL_AUTOLOAD_MAX_BYTES         bytes of matched skill bodies per run (default 12288)
 *   SKILL_AUTOLOAD_MAX_SKILLS        most skills loaded per run (default 3)
 *   SKILL_AUTOLOAD_MIN_SCORE         lexical score a skill needs (default 2)
 *   SKILL_AUTOLOAD_EMBEDDINGS=0      never use the embeddings endpoint (lexical only)
 *   SKILL_AUTOLOAD_EMBEDDINGS_MIN    cosine similarity that counts as a match (default 0.6)
 *   SKILL_AUTOLOAD_TIMEOUT_MS        longest wait for the task's embedding (default 700)
 *   SKILL_PINNED=0                   Space-pinned skills are not put in the prompt
 *   SKILL_PINNED_MAX_BYTES           bytes of pinned skill bodies per run (default 16384)
 *
 * The embeddings endpoint is the memory ledger's (MEMORY_EMBEDDINGS_URL, else
 * STANDING_EMBEDDINGS_URL); without one, matching is lexical only.
 */
import type { LedgerConfig } from "../memory-ledger/config.js";
import { ledgerConfig } from "../memory-ledger/config.js";

type Env = Record<string, string | undefined>;

export interface SkillAutoloadConfig {
  enabled: boolean;
  maxBytes: number;
  maxSkills: number;
  minScore: number;
  embeddings: {
    enabled: boolean;
    minSimilarity: number;
    timeoutMs: number;
    endpoint: LedgerConfig["embeddings"];
  };
  pinned: { enabled: boolean; maxBytes: number };
}

/** On unless the value says off: a missing or empty key keeps the feature on. */
const notOff = (value: string | undefined) => !/^(0|false|off|no|none)$/i.test(value?.trim() ?? "");

function int(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

function float(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number.parseFloat(value ?? "");
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

export function skillAutoloadConfig(env: Env = process.env): SkillAutoloadConfig {
  const endpoint = ledgerConfig(env).embeddings;
  return {
    enabled: notOff(env.SKILL_AUTOLOAD),
    maxBytes: int(env.SKILL_AUTOLOAD_MAX_BYTES, 12 * 1024, 1024, 128 * 1024),
    maxSkills: int(env.SKILL_AUTOLOAD_MAX_SKILLS, 3, 1, 8),
    minScore: float(env.SKILL_AUTOLOAD_MIN_SCORE, 2, 0.5, 20),
    embeddings: {
      enabled: notOff(env.SKILL_AUTOLOAD_EMBEDDINGS) && Boolean(endpoint.url),
      minSimilarity: float(env.SKILL_AUTOLOAD_EMBEDDINGS_MIN, 0.6, 0.1, 0.99),
      timeoutMs: int(env.SKILL_AUTOLOAD_TIMEOUT_MS, 700, 50, 5_000),
      endpoint,
    },
    pinned: {
      enabled: notOff(env.SKILL_PINNED),
      maxBytes: int(env.SKILL_PINNED_MAX_BYTES, 16 * 1024, 1024, 128 * 1024),
    },
  };
}
