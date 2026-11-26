-- Memory ledger idempotency (fork, additive; the previous release ignores both columns).
--
-- "textKey": a hash of the fact's words (memory-ledger/text.ts textKey). At most one LIVE fact
-- per Space may carry a key, so two writers that pass the duplicate check at the same moment
-- cannot both insert the same fact. Rows written before this migration keep NULL and are
-- matched by the writer's own text comparison (ops/memory-ledger-dedupe.py retires the copies
-- that already exist).
ALTER TABLE "memory_facts" ADD COLUMN IF NOT EXISTS "textKey" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "memory_facts_live_text_key"
  ON "memory_facts"("spaceId", "textKey")
  WHERE "textKey" IS NOT NULL AND "status" IN ('tentative', 'confirmed', 'disputed');

-- "wroteAt": set in the same transaction as a job's facts. A later attempt of the same job (it
-- failed or timed out after that commit) sees it and writes nothing.
ALTER TABLE "memory_ledger_jobs" ADD COLUMN IF NOT EXISTS "wroteAt" TIMESTAMP(3);
