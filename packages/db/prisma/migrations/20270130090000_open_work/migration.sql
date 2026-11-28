-- Fork (FORK.md 1.33, long-task continuity): open work of an agent in a chat. Additive: the previous
-- release ignores the new column and never reads the new table, so it can be rolled back by
-- redeploying the previous image.
--
-- "scratchpad_items"."threadId": the chat the agent added an item in. Rows written before this
-- migration keep NULL and never count as a chat's open work.
--
-- "open_work_states": one row per agent and chat, what the open-work rule last did there.
--
-- Idempotent, like the fork's other migrations, so a rebased branch can re-run it safely.
ALTER TABLE "scratchpad_items" ADD COLUMN IF NOT EXISTS "threadId" TEXT;
CREATE INDEX IF NOT EXISTS "scratchpad_items_threadId_botId_status_idx" ON "scratchpad_items"("threadId", "botId", "status");

CREATE TABLE IF NOT EXISTS "open_work_states" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "continuations" INTEGER NOT NULL DEFAULT 0,
    "lastContinuationRunId" TEXT,
    "stalledAt" TIMESTAMP(3),
    "stalledReason" TEXT,
    "stalledRunId" TEXT,
    "openCount" INTEGER NOT NULL DEFAULT 0,
    "noticeMessageId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "open_work_states_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "open_work_states_threadId_botId_key" ON "open_work_states"("threadId", "botId");
CREATE INDEX IF NOT EXISTS "open_work_states_spaceId_botId_idx" ON "open_work_states"("spaceId", "botId");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'open_work_states_spaceId_fkey') THEN
    ALTER TABLE "open_work_states" ADD CONSTRAINT "open_work_states_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'open_work_states_botId_fkey') THEN
    ALTER TABLE "open_work_states" ADD CONSTRAINT "open_work_states_botId_fkey" FOREIGN KEY ("botId") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'open_work_states_threadId_fkey') THEN
    ALTER TABLE "open_work_states" ADD CONSTRAINT "open_work_states_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "threads"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

ALTER TABLE "open_work_states" ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'open_work_states' AND policyname = 'open_work_states_system') THEN
    CREATE POLICY open_work_states_system ON "open_work_states" USING ((SELECT app_rls_bypass()));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'open_work_states' AND policyname = 'open_work_states_tenant') THEN
    CREATE POLICY open_work_states_tenant ON "open_work_states"
      USING ("spaceId" = NULLIF(current_setting('app.space_id', true), ''));
  END IF;
END $$;
