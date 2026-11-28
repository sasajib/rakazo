-- Fork (FORK.md 1.33, long-task continuity): helpers that wait for a free slot. Additive: the
-- previous release never reads this table, so it can be rolled back by redeploying the previous
-- image (a row left queued then stays a card that reads "queued"; stopping the chat settles it
-- after the next roll forward).
--
-- One row per `run_subagent` call made while every helper slot of the agent was busy. The card is
-- already in the chat; the platform starts the helper when a slot frees.
--
-- Idempotent, like the fork's other migrations, so a rebased branch can re-run it safely.
CREATE TABLE IF NOT EXISTS "queued_helpers" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "originRunId" TEXT NOT NULL,
    "cardMessageId" TEXT NOT NULL,
    "clientNonce" TEXT NOT NULL,
    "helperThreadId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "modelProvider" TEXT,
    "modelId" TEXT,
    "sourceMessageIds" TEXT[],
    "status" TEXT NOT NULL DEFAULT 'queued',
    "helperRunId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "queued_helpers_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "queued_helpers_cardMessageId_key" ON "queued_helpers"("cardMessageId");
CREATE UNIQUE INDEX IF NOT EXISTS "queued_helpers_spaceId_clientNonce_key" ON "queued_helpers"("spaceId", "clientNonce");
CREATE INDEX IF NOT EXISTS "queued_helpers_botId_status_createdAt_idx" ON "queued_helpers"("botId", "status", "createdAt");
CREATE INDEX IF NOT EXISTS "queued_helpers_threadId_status_idx" ON "queued_helpers"("threadId", "status");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'queued_helpers_spaceId_fkey') THEN
    ALTER TABLE "queued_helpers" ADD CONSTRAINT "queued_helpers_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'queued_helpers_botId_fkey') THEN
    ALTER TABLE "queued_helpers" ADD CONSTRAINT "queued_helpers_botId_fkey" FOREIGN KEY ("botId") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'queued_helpers_threadId_fkey') THEN
    ALTER TABLE "queued_helpers" ADD CONSTRAINT "queued_helpers_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "threads"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'queued_helpers_cardMessageId_fkey') THEN
    ALTER TABLE "queued_helpers" ADD CONSTRAINT "queued_helpers_cardMessageId_fkey" FOREIGN KEY ("cardMessageId") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

ALTER TABLE "queued_helpers" ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'queued_helpers' AND policyname = 'queued_helpers_system') THEN
    CREATE POLICY queued_helpers_system ON "queued_helpers" USING ((SELECT app_rls_bypass()));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'queued_helpers' AND policyname = 'queued_helpers_tenant') THEN
    CREATE POLICY queued_helpers_tenant ON "queued_helpers"
      USING ("spaceId" = NULLIF(current_setting('app.space_id', true), ''));
  END IF;
END $$;
